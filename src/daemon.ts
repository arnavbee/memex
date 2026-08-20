import fs from 'fs';
import path from 'path';
import { Database } from './db.js';
import { startWatcher } from './watcher.js';
import { startClipboardTracker } from './clipboard.js';
import { syncNotes } from './notes.js';
import { startMcpServer } from './mcp.js';
import { startIngestServer } from './ingest.js';
import { scanRecentFiles } from './historical.js';
import { processWebpageUrl } from './webpage.js';
import { syncBrowserHistory } from './browser.js';
import { loadEnv } from './env.js';

loadEnv();

const DATA_DIR = path.join(process.env.HOME || '', '.omnicontext');
const LOG_FILE = path.join(DATA_DIR, 'daemon.log');
const MAX_LOG_BYTES = 5 * 1024 * 1024;

/**
 * launchd appends to daemon.log forever. Roll it once at startup so it can't
 * grow without bound, and keep it owner-only — it records the daemon's activity
 * on the user's machine.
 */
function rotateLogIfLarge(): void {
  try {
    if (!fs.existsSync(LOG_FILE)) return;
    fs.chmodSync(LOG_FILE, 0o600);
    if (fs.statSync(LOG_FILE).size > MAX_LOG_BYTES) {
      fs.renameSync(LOG_FILE, `${LOG_FILE}.1`);
      fs.chmodSync(`${LOG_FILE}.1`, 0o600);
      console.error('[Daemon] Rotated daemon.log (previous log kept as daemon.log.1).');
    }
  } catch {
    // Logging must never take the daemon down.
  }
}

async function retroactiveUrlArchive(db: Database) {
  console.error('Checking for unarchived URLs in database...');
  db.reload();
  const assets = db.getRecent(500, 'all');
  
  const urlAssets = assets.filter(a => {
    if (a.type !== 'clipboard') return false;
    const content = a.content.trim();
    return content.startsWith('http') && !/\s/.test(content);
  });

  console.error(`Found ${urlAssets.length} raw URL items in database.`);
  
  for (const asset of urlAssets) {
    const url = asset.content.trim();
    const isArchived = assets.some(a => a.type === 'download' && a.metadata.sourceUrl === url);
    if (!isArchived) {
      console.error(`Retroactively archiving: ${(() => { try { return new URL(url).hostname; } catch { return "(url)"; } })()}`);
      try {
        await processWebpageUrl(db, url);
      } catch (err: any) {
        console.error(`Failed to retroactively archive a URL:`, err.message);
      }
    }
  }
}

async function main() {
  rotateLogIfLarge();
  console.error('Starting OmniContext background services...');
  
  // 1. Initialize Database
  const db = new Database();

  // 2. Perform initial sync of Apple Notes (non-blocking)
  console.error('Triggering initial Apple Notes sync in background...');
  syncNotes(db).catch(err => console.error('Initial Apple Notes sync failed:', err));

  // 3. Set up periodic Notes Sync (every 30 minutes)
  const THIRTY_MINUTES = 30 * 60 * 1000;
  setInterval(async () => {
    console.error('Running periodic Apple Notes sync...');
    await syncNotes(db);
  }, THIRTY_MINUTES);

  // 4. Start folder watcher (Desktop/Screenshots & Downloads)
  startWatcher(db);

  // 5. Start clipboard polling tracker
  startClipboardTracker(db);

  // 6. Start the Model Context Protocol (MCP) server
  startMcpServer(db);

  // 7. Start the Android phone ingest HTTP server
  startIngestServer(db, 4322);

  // 8. Run initial historical scans (non-blocking) to self-heal and index missed files
  console.error('Running startup files scan...');
  scanRecentFiles(db, 'screenshot', 30).catch(err => console.error('Startup screenshot scan failed:', err));
  scanRecentFiles(db, 'download', 30).catch(err => console.error('Startup download scan failed:', err));

  // 9. Retroactively archive raw clipboard links (non-blocking)
  retroactiveUrlArchive(db).catch(err => console.error('Retroactive URL archiver failed:', err));

  // 10. Sync browser history (Safari/Chrome/Arc/Brave/Edge) now and every 30 minutes
  syncBrowserHistory(db).catch(err => console.error('Browser history sync failed:', err));
  setInterval(() => {
    syncBrowserHistory(db).catch(err => console.error('Browser history sync failed:', err));
  }, THIRTY_MINUTES);

  // 11. Prune noise and keep the on-disk footprint bounded: at startup, then daily.
  const maxAgeDays = Number(process.env.OMNICONTEXT_CLIPBOARD_MAX_AGE_DAYS) || 30;
  const maxCount = Number(process.env.OMNICONTEXT_CLIPBOARD_MAX_COUNT) || 2000;
  const historyMaxAgeDays = Number(process.env.OMNICONTEXT_HISTORY_MAX_AGE_DAYS) || 90;
  const runPrune = () => {
    try {
      const removed = db.pruneClipboard(maxAgeDays, maxCount);
      if (removed > 0) console.error(`Clipboard prune: removed ${removed} stale/duplicate items.`);
    } catch (err) {
      console.error('Clipboard prune failed:', err);
    }
    try {
      const removed = db.pruneHistory(historyMaxAgeDays);
      if (removed > 0) console.error(`History prune: removed ${removed} visits older than ${historyMaxAgeDays} days.`);
    } catch (err) {
      console.error('History prune failed:', err);
    }
    // Fold the WAL back in; it had grown to 57MB alongside a 68MB database
    // because the standalone MCP server holds a read connection open.
    db.checkpoint();
  };
  runPrune();
  setInterval(runPrune, 24 * 60 * 60 * 1000);

  console.error('OmniContext background daemon initialized successfully.');
}

main().catch((err) => {
  console.error('Fatal initialization error:', err);
  process.exit(1);
});
