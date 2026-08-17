import fs from 'fs';
import os from 'os';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { Database, Asset } from './db.js';

const HOME = process.env.HOME || '';

interface BrowserSource {
  name: string;
  historyPath: string;
  kind: 'safari' | 'chromium';
}

const CHROMIUM_ROOTS: { name: string; root: string }[] = [
  { name: 'Chrome', root: path.join(HOME, 'Library/Application Support/Google/Chrome') },
  { name: 'Arc', root: path.join(HOME, 'Library/Application Support/Arc/User Data') },
  { name: 'Brave', root: path.join(HOME, 'Library/Application Support/BraveSoftware/Brave-Browser') },
  { name: 'Edge', root: path.join(HOME, 'Library/Application Support/Microsoft Edge') },
];

function discoverSources(): BrowserSource[] {
  const sources: BrowserSource[] = [
    { name: 'Safari', historyPath: path.join(HOME, 'Library/Safari/History.db'), kind: 'safari' },
  ];
  for (const { name, root } of CHROMIUM_ROOTS) {
    if (!fs.existsSync(root)) continue;
    let profiles: string[] = [];
    try {
      profiles = fs.readdirSync(root).filter(d => d === 'Default' || d.startsWith('Profile '));
    } catch {
      continue;
    }
    for (const profile of profiles) {
      const historyPath = path.join(root, profile, 'History');
      if (fs.existsSync(historyPath)) {
        sources.push({ name: `${name}/${profile}`, historyPath, kind: 'chromium' });
      }
    }
  }
  return sources;
}

interface Visit {
  url: string;
  title: string;
  lastVisitIso: string;
}

// Low-signal URLs that would flood the vault without helping recall.
const SKIP_PATTERNS = [
  /^https?:\/\/(www\.)?google\.[a-z.]+\/search/,
  /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)/,
  /^(chrome|arc|brave|edge|about|file|safari-resource):/,
  /accounts\.google\.com/,
  /\/(login|signin|logout|auth|oauth|callback)([/?#]|$)/,
];

function isNoise(url: string): boolean {
  return SKIP_PATTERNS.some(p => p.test(url));
}

function urlId(url: string): string {
  // Stable per-URL id so re-syncs update the existing asset instead of duplicating.
  let hash = 0;
  for (let i = 0; i < url.length; i++) {
    hash = ((hash << 5) - hash + url.charCodeAt(i)) | 0;
  }
  return `history-${(hash >>> 0).toString(36)}-${url.length}`;
}

/**
 * Browsers keep their history SQLite locked while running, so we copy the file
 * (plus its WAL, if any) to a temp location and read the copy.
 */
function copyAndOpen(historyPath: string): DatabaseSync | null {
  const tempPath = path.join(os.tmpdir(), `omnicontext-history-${Date.now()}-${Math.random().toString(36).substring(7)}.db`);
  try {
    fs.copyFileSync(historyPath, tempPath);
    for (const suffix of ['-wal', '-shm']) {
      if (fs.existsSync(historyPath + suffix)) {
        try { fs.copyFileSync(historyPath + suffix, tempPath + suffix); } catch {}
      }
    }
    return new DatabaseSync(tempPath);
  } catch {
    cleanupTemp(tempPath);
    return null;
  }
}

function cleanupTemp(tempPath: string) {
  for (const p of [tempPath, tempPath + '-wal', tempPath + '-shm']) {
    try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch {}
  }
}

function readChromiumHistory(db: DatabaseSync, sinceMs: number, maxRows: number): Visit[] {
  // Chromium stores microseconds since 1601-01-01. Cast to REAL: the raw
  // integers overflow node:sqlite's safe-integer bounds.
  const CHROMIUM_EPOCH_OFFSET_MS = 11644473600000;
  const sinceChromium = (sinceMs + CHROMIUM_EPOCH_OFFSET_MS) * 1000;
  const rows = db.prepare(`
    SELECT url, title, CAST(last_visit_time AS REAL) AS lastVisit
    FROM urls
    WHERE CAST(last_visit_time AS REAL) > ? AND title != ''
    ORDER BY last_visit_time DESC
    LIMIT ?
  `).all(sinceChromium, maxRows) as unknown as { url: string; title: string; lastVisit: number }[];

  return rows.map(r => ({
    url: r.url,
    title: r.title,
    lastVisitIso: new Date(r.lastVisit / 1000 - CHROMIUM_EPOCH_OFFSET_MS).toISOString(),
  }));
}

function readSafariHistory(db: DatabaseSync, sinceMs: number, maxRows: number): Visit[] {
  // Safari stores seconds since 2001-01-01 (Core Data epoch).
  const SAFARI_EPOCH_OFFSET_MS = 978307200000;
  const sinceSafari = (sinceMs - SAFARI_EPOCH_OFFSET_MS) / 1000;
  const rows = db.prepare(`
    SELECT i.url AS url, v.title AS title, MAX(v.visit_time) AS lastVisit
    FROM history_visits v
    JOIN history_items i ON i.id = v.history_item
    WHERE v.visit_time > ? AND v.title IS NOT NULL AND v.title != ''
    GROUP BY i.url
    ORDER BY lastVisit DESC
    LIMIT ?
  `).all(sinceSafari, maxRows) as unknown as { url: string; title: string; lastVisit: number }[];

  return rows.map(r => ({
    url: r.url,
    title: r.title,
    lastVisitIso: new Date(r.lastVisit * 1000 + SAFARI_EPOCH_OFFSET_MS).toISOString(),
  }));
}

let warnedSources = new Set<string>();

export async function syncBrowserHistory(db: Database, lookbackHours = 24): Promise<number> {
  const sinceMs = Date.now() - lookbackHours * 60 * 60 * 1000;
  // Deep backfills need more rows than the steady-state half-hourly sync.
  const maxRows = lookbackHours <= 48 ? 200 : 5000;
  let indexed = 0;

  for (const source of discoverSources()) {
    if (!fs.existsSync(source.historyPath)) continue;

    const historyDb = copyAndOpen(source.historyPath);
    if (!historyDb) {
      if (!warnedSources.has(source.name)) {
        warnedSources.add(source.name);
        console.error(`[History] Cannot read ${source.name} history (grant Full Disk Access to the daemon's terminal/launcher to enable).`);
      }
      continue;
    }

    try {
      const visits = source.kind === 'safari'
        ? readSafariHistory(historyDb, sinceMs, maxRows)
        : readChromiumHistory(historyDb, sinceMs, maxRows);

      for (const visit of visits) {
        if (isNoise(visit.url)) continue;
        const asset: Asset = {
          id: urlId(visit.url),
          type: 'history',
          content: `${visit.title}\n${visit.url}`,
          metadata: {
            title: visit.title,
            createdAt: visit.lastVisitIso,
            sourceUrl: visit.url,
          },
        };
        db.addAsset(asset);
        indexed++;
      }
      console.error(`[History] ${source.name}: indexed ${visits.length} recent pages.`);
    } catch (e: any) {
      console.error(`[History] Failed to read ${source.name} history:`, e.message);
    } finally {
      const location = historyDb.location();
      historyDb.close();
      if (location) cleanupTemp(location);
    }
  }

  return indexed;
}
