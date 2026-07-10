import { execFile } from 'child_process';
import { Database, Asset } from './db.js';
import { processYoutubeLink, extractVideoId } from './youtube.js';
import { processTwitterLink, extractTweetId } from './twitter.js';
import { processWebpageUrl, isArchivableUrl } from './webpage.js';

let lastClipboardText = '';

function getClipboardText(): Promise<string> {
  return new Promise((resolve) => {
    // pbpaste handles reading plain text from the macOS Clipboard
    execFile('pbpaste', [], (error, stdout) => {
      if (error) {
        resolve('');
        return;
      }
      resolve(stdout);
    });
  });
}

export function startClipboardTracker(db: Database, intervalMs = 1500) {
  console.error('Clipboard tracker started.');

  // Initialize with current clipboard content so we do not log historic copies immediately
  getClipboardText().then((text) => {
    lastClipboardText = text;
  });

  setInterval(async () => {
    const text = await getClipboardText();
    const trimmed = text.trim();

    // Only log if it changed, is not empty, and is distinct from last log
    if (trimmed && text !== lastClipboardText) {
      lastClipboardText = text;
      
      // Limit clipboard item size to avoid bloating database with massive files
      if (trimmed.length > 50000) {
        return;
      }

      // Check if it is a YouTube URL first
      const videoId = extractVideoId(trimmed);
      if (videoId) {
        processYoutubeLink(db, trimmed).catch(err => 
          console.error(`Failed to process YouTube link:`, err)
        );
      }

      // Check if it is a Twitter/X URL
      const tweetId = extractTweetId(trimmed);
      if (tweetId) {
        processTwitterLink(db, trimmed).catch(err =>
          console.error(`Failed to process Twitter link:`, err)
        );
      }

      // Check if it is any other archivable webpage URL (not YouTube or Twitter)
      if (!videoId && !tweetId && isArchivableUrl(trimmed)) {
        processWebpageUrl(db, trimmed).catch(err =>
          console.error(`Failed to archive webpage:`, err)
        );
      }

      console.error(`Clipboard copy detected (${trimmed.substring(0, 30)}...)`);

      const id = `clipboard-${Date.now()}`;
      const asset: Asset = {
        id,
        type: 'clipboard',
        content: text,
        metadata: {
          createdAt: new Date().toISOString()
        }
      };

      db.addAsset(asset);
    }
  }, intervalMs);
}
