import fs from 'fs';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { redactSecrets } from './secrets.js';

export interface Asset {
  id: string;
  type: 'screenshot' | 'download' | 'note' | 'clipboard' | 'history';
  filePath?: string;
  content: string;
  summary?: string;
  metadata: {
    title?: string;
    createdAt: string;
    sourceUrl?: string;
    colors?: string[];
    mimeType?: string;
    localMediaPaths?: string[];
  };
}

const DB_DIR = path.join(process.env.HOME || '', '.omnicontext');
const SQLITE_FILE = path.join(DB_DIR, 'db.sqlite');

interface AssetRow {
  id: string;
  type: string;
  filePath: string | null;
  content: string;
  summary: string | null;
  metadata: string;
  createdAt: string;
}

function rowToAsset(row: AssetRow): Asset {
  let metadata: Asset['metadata'];
  try {
    metadata = JSON.parse(row.metadata);
  } catch {
    metadata = { createdAt: row.createdAt };
  }
  const asset: Asset = {
    id: row.id,
    type: row.type as Asset['type'],
    content: row.content,
    metadata,
  };
  if (row.filePath) asset.filePath = row.filePath;
  if (row.summary) asset.summary = row.summary;
  return asset;
}

export class Database {
  private db: DatabaseSync;

  constructor(dbPath?: string) {
    if (!dbPath) {
      // 0700: the vault holds clipboard history, OCR'd screenshots and notes.
      // It defaulted to 0755, readable by every other account on the machine
      // and by any backup or sync tool with home-directory access.
      if (!fs.existsSync(DB_DIR)) {
        fs.mkdirSync(DB_DIR, { recursive: true, mode: 0o700 });
      } else {
        try { fs.chmodSync(DB_DIR, 0o700); } catch {}
      }
      dbPath = SQLITE_FILE;
    }
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA busy_timeout = 5000');
    // The -wal and -shm siblings carry the same content as the database itself.
    if (dbPath !== ':memory:') {
      for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
        try { if (fs.existsSync(f)) fs.chmodSync(f, 0o600); } catch {}
      }
    }
    this.createSchema();
    if (dbPath !== ':memory:') {
      this.migrateFromLegacyJson(path.join(path.dirname(dbPath), 'db.json'));
    }
  }

  private createSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS assets (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        filePath TEXT,
        content TEXT NOT NULL,
        summary TEXT,
        title TEXT,
        sourceUrl TEXT,
        createdAt TEXT NOT NULL,
        metadata TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_assets_type_created ON assets(type, createdAt);
      CREATE INDEX IF NOT EXISTS idx_assets_sourceUrl ON assets(sourceUrl);
      CREATE INDEX IF NOT EXISTS idx_assets_filePath ON assets(filePath);

      CREATE VIRTUAL TABLE IF NOT EXISTS assets_fts USING fts5(
        content, title, summary, url,
        content='assets', content_rowid='rowid'
      );

      CREATE TRIGGER IF NOT EXISTS assets_ai AFTER INSERT ON assets BEGIN
        INSERT INTO assets_fts(rowid, content, title, summary, url)
        VALUES (new.rowid, new.content, new.title, new.summary, new.sourceUrl);
      END;
      CREATE TRIGGER IF NOT EXISTS assets_ad AFTER DELETE ON assets BEGIN
        INSERT INTO assets_fts(assets_fts, rowid, content, title, summary, url)
        VALUES ('delete', old.rowid, old.content, old.title, old.summary, old.sourceUrl);
      END;
      CREATE TRIGGER IF NOT EXISTS assets_au AFTER UPDATE ON assets BEGIN
        INSERT INTO assets_fts(assets_fts, rowid, content, title, summary, url)
        VALUES ('delete', old.rowid, old.content, old.title, old.summary, old.sourceUrl);
        INSERT INTO assets_fts(rowid, content, title, summary, url)
        VALUES (new.rowid, new.content, new.title, new.summary, new.sourceUrl);
      END;
    `);
  }

  private migrateFromLegacyJson(legacyFile: string) {
    if (!fs.existsSync(legacyFile)) return;
    const count = this.db.prepare('SELECT COUNT(*) AS n FROM assets').get() as { n: number };
    if (count.n > 0) return;

    try {
      const legacy: Asset[] = JSON.parse(fs.readFileSync(legacyFile, 'utf-8'));
      this.db.exec('BEGIN');
      for (const asset of legacy) {
        this.insertAsset(asset);
      }
      this.db.exec('COMMIT');
      fs.renameSync(legacyFile, legacyFile + '.migrated');
      console.error(`Migrated ${legacy.length} assets from db.json to SQLite (backup kept at db.json.migrated).`);
    } catch (e) {
      try { this.db.exec('ROLLBACK'); } catch {}
      console.error('Legacy db.json migration failed; keeping db.json untouched:', e);
    }
  }

  private insertAsset(asset: Asset) {
    this.db.prepare(`
      INSERT OR REPLACE INTO assets (id, type, filePath, content, summary, title, sourceUrl, createdAt, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      asset.id,
      asset.type,
      asset.filePath ?? null,
      asset.content,
      asset.summary ?? null,
      asset.metadata.title ?? null,
      asset.metadata.sourceUrl ?? null,
      asset.metadata.createdAt,
      JSON.stringify(asset.metadata)
    );
  }

  // Kept for API compatibility with the old JSON-file implementation; SQLite
  // reads always see the latest committed state, so there is nothing to do.
  public reload() {}
  public save() {}

  public close() {
    this.db.close();
  }

  public addAsset(asset: Asset) {
    // Every capture path lands here — clipboard, screenshot OCR, downloads,
    // Apple Notes, browser history, archived articles, transcripts. Scrubbing
    // at this choke point is what makes "secrets don't enter the vault" true
    // for all of them instead of just the clipboard, and it cannot be bypassed
    // by a new caller that forgets to filter.
    const scrubbed = redactSecrets(asset.content || '');
    if (scrubbed.reasons.length > 0) {
      console.error(
        `[Secrets] Redacted ${scrubbed.reasons.length} secret pattern(s) from ${asset.type} asset: ${scrubbed.reasons.join(', ')}`
      );
      asset = { ...asset, content: scrubbed.text };
    }

    this.db.exec('BEGIN');
    try {
      if (asset.filePath) {
        this.db.prepare('DELETE FROM assets WHERE filePath = ?').run(asset.filePath);
      }
      this.insertAsset(asset);
      this.db.exec('COMMIT');
    } catch (e) {
      try { this.db.exec('ROLLBACK'); } catch {}
      console.error('Failed to add asset:', e);
    }
  }

  public getById(id: string): Asset | null {
    const row = this.db.prepare(
      'SELECT id, type, filePath, content, summary, metadata, createdAt FROM assets WHERE id = ?'
    ).get(id) as AssetRow | undefined;
    return row ? rowToAsset(row) : null;
  }

  public deleteAsset(id: string): boolean {
    const result = this.db.prepare('DELETE FROM assets WHERE id = ?').run(id);
    return Number(result.changes) > 0;
  }

  public findByUrl(url: string): Asset | null {
    const row = this.db.prepare(
      'SELECT id, type, filePath, content, summary, metadata, createdAt FROM assets WHERE sourceUrl = ? ORDER BY createdAt DESC LIMIT 1'
    ).get(url) as AssetRow | undefined;
    return row ? rowToAsset(row) : null;
  }

  public touchAssetByUrl(url: string): boolean {
    const row = this.db.prepare(
      "SELECT id, metadata FROM assets WHERE type = 'download' AND sourceUrl = ? LIMIT 1"
    ).get(url) as { id: string; metadata: string } | undefined;
    if (!row) return false;

    const now = new Date().toISOString();
    let metadata: Asset['metadata'];
    try {
      metadata = JSON.parse(row.metadata);
    } catch {
      metadata = { createdAt: now };
    }
    metadata.createdAt = now;
    this.db.prepare('UPDATE assets SET createdAt = ?, metadata = ? WHERE id = ?')
      .run(now, JSON.stringify(metadata), row.id);
    return true;
  }

  public getRecent(limit = 10, type?: string): Asset[] {
    const params: (string | number)[] = [];
    let where = '';
    if (type && type !== 'all') {
      where = 'WHERE type = ?';
      params.push(type);
    }
    params.push(limit);
    const rows = this.db.prepare(
      `SELECT id, type, filePath, content, summary, metadata, createdAt FROM assets ${where} ORDER BY createdAt DESC LIMIT ?`
    ).all(...params) as unknown as AssetRow[];
    return rows.map(rowToAsset);
  }

  public count(type?: string): number {
    if (type && type !== 'all') {
      const row = this.db.prepare('SELECT COUNT(*) AS n FROM assets WHERE type = ?').get(type) as { n: number };
      return row.n;
    }
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM assets').get() as { n: number };
    return row.n;
  }

  /**
   * Noise control for passive clipboard capture:
   * 1. Collapse exact-duplicate clipboard contents, keeping only the newest copy.
   * 2. Delete raw clipboard items older than maxAgeDays.
   * 3. Keep at most maxCount raw clipboard items (newest win).
   * Rich assets (downloads, notes, screenshots, history) are never pruned.
   */
  public pruneClipboard(maxAgeDays = 30, maxCount = 2000): number {
    let removed = 0;

    const dupes = this.db.prepare(`
      DELETE FROM assets WHERE type = 'clipboard' AND rowid NOT IN (
        SELECT MAX(rowid) FROM assets WHERE type = 'clipboard' GROUP BY content
      )
    `).run();
    removed += Number(dupes.changes);

    const cutoff = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000).toISOString();
    const aged = this.db.prepare(
      "DELETE FROM assets WHERE type = 'clipboard' AND createdAt < ?"
    ).run(cutoff);
    removed += Number(aged.changes);

    const overflow = this.db.prepare(`
      DELETE FROM assets WHERE type = 'clipboard' AND id NOT IN (
        SELECT id FROM assets WHERE type = 'clipboard' ORDER BY createdAt DESC LIMIT ?
      )
    `).run(maxCount);
    removed += Number(overflow.changes);

    return removed;
  }

  /**
   * Browser history is the fastest-growing type (every visit, every 30 minutes,
   * forever) and the least useful once stale. Everything else — notes,
   * downloads, screenshots, archived articles — is deliberately kept, since
   * remembering them is the point of the product.
   */
  public pruneHistory(maxAgeDays = 90): number {
    const cutoff = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000).toISOString();
    const res = this.db.prepare(
      "DELETE FROM assets WHERE type = 'history' AND createdAt < ?"
    ).run(cutoff);
    return Number(res.changes);
  }

  /**
   * Fold the write-ahead log back into the database. Without this the -wal file
   * grows unbounded whenever a long-lived reader (the standalone MCP server)
   * keeps a connection open — it had reached 57MB against a 68MB database.
   */
  public checkpoint(): void {
    try {
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch (e) {
      console.error('[DB] WAL checkpoint failed:', e);
    }
  }

  /** Total on-disk footprint of the vault, for `npm run vault:status`. */
  public stats(): { total: number; byType: Record<string, number> } {
    const rows = this.db.prepare('SELECT type, COUNT(*) AS n FROM assets GROUP BY type').all() as any[];
    const byType: Record<string, number> = {};
    let total = 0;
    for (const r of rows) {
      byType[String(r.type)] = Number(r.n);
      total += Number(r.n);
    }
    return { total, byType };
  }

  /** Deletes every asset, optionally of a single type. Used by `vault:purge`. */
  public purge(type?: string): number {
    const res = type
      ? this.db.prepare('DELETE FROM assets WHERE type = ?').run(type)
      : this.db.prepare('DELETE FROM assets').run();
    this.db.exec('VACUUM');
    return Number(res.changes);
  }

  public search(query: string, limit = 5, type?: string): { asset: Asset; score: number }[] {
    const tokens = (query.toLowerCase().match(/[a-z0-9]+/g) || []).filter(t => t.length > 1);
    if (tokens.length === 0) return [];

    // Prefix-match every token ("flight" also finds "flights") — quoted to
    // neutralize FTS5 query operators in user input.
    const matchQuery = tokens.map(t => `"${t}"*`).join(' OR ');

    const params: (string | number)[] = [matchQuery];
    let typeFilter = '';
    if (type && type !== 'all') {
      typeFilter = 'AND a.type = ?';
      params.push(type);
    }

    let rows: (AssetRow & { rank: number })[];
    try {
      // bm25 weights follow fts column order: content, title, summary, url.
      rows = this.db.prepare(`
        SELECT a.id, a.type, a.filePath, a.content, a.summary, a.metadata, a.createdAt,
               bm25(assets_fts, 1.0, 3.0, 2.0, 2.5) AS rank
        FROM assets_fts
        JOIN assets a ON a.rowid = assets_fts.rowid
        WHERE assets_fts MATCH ? ${typeFilter}
        ORDER BY rank
        LIMIT 100
      `).all(...params) as unknown as (AssetRow & { rank: number })[];
    } catch (e) {
      console.error('FTS query failed:', e);
      return [];
    }

    const qClean = query.toLowerCase().replace(/[^\w\s]/g, '').trim();

    const results = rows
      .filter(row => {
        // Drop clipboard entries that are just the query itself reflected back
        // (e.g. the user copied their own question into an AI chat).
        if (row.type !== 'clipboard') return true;
        const cClean = row.content.toLowerCase().replace(/[^\w\s]/g, '').trim();
        return !(cClean === qClean || (qClean.length > 2 && cClean.includes(qClean) && cClean.length < qClean.length + 20));
      })
      .map(row => {
        const relevance = -row.rank; // bm25 is negative, lower = better

        // Multiplicative boosts: they reorder genuine matches but can never
        // promote a non-match, unlike the old additive scheme.
        const ageInDays = (Date.now() - new Date(row.createdAt).getTime()) / (1000 * 60 * 60 * 24);
        const recencyMult = 1 + 0.5 * Math.exp(-ageInDays * 2.0);
        const richTypes = new Set(['download', 'note', 'screenshot', 'history']);
        const typeMult = richTypes.has(row.type) ? 1.15 : 1.0;

        return { asset: rowToAsset(row), score: relevance * recencyMult * typeMult };
      })
      .filter(r => r.score > 0);

    return results.sort((a, b) => b.score - a.score).slice(0, limit);
  }
}
