import dotenv from 'dotenv';
import { Database } from './db.js';
import { startWatcher } from './watcher.js';
import { startClipboardTracker } from './clipboard.js';
import { syncNotes } from './notes.js';
import { startMcpServer } from './mcp.js';
import { startIngestServer } from './ingest.js';
import { scanRecentFiles } from './historical.js';
import { processWebpageUrl } from './webpage.js';

dotenv.config();

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
      console.error(`Retroactively archiving: ${url}`);
      try {
        await processWebpageUrl(db, url);
      } catch (err: any) {
        console.error(`Failed to retroactively archive ${url}:`, err.message);
      }
    }
  }
}

async function main() {
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

  console.error('OmniContext background daemon initialized successfully.');
}

main().catch((err) => {
  console.error('Fatal initialization error:', err);
  process.exit(1);
});
