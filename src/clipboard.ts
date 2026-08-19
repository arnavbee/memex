import { execFile } from 'child_process';
import { Database, Asset } from './db.js';
import { processYoutubeLink, extractVideoId } from './youtube.js';
import { processTwitterLink, extractTweetId } from './twitter.js';
import { processWebpageUrl, isArchivableUrl } from './webpage.js';
import { detectSecret, isBlockedApp, isConcealedClipboard } from './secrets.js';

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

function getClipboardInfo(): Promise<string> {
  return new Promise((resolve) => {
    execFile('osascript', ['-e', 'clipboard info'], { timeout: 3000 }, (error, stdout) => {
      resolve(error ? '' : stdout);
    });
  });
}

function getFrontmostApp(): Promise<string> {
  return new Promise((resolve) => {
    // lsappinfo needs no privacy permissions, unlike System Events
    execFile('lsappinfo', ['info', '-only', 'name', 'front'], { timeout: 3000 }, (error, stdout) => {
      if (error) {
        resolve('');
        return;
      }
      const match = stdout.match(/"LSDisplayName"\s*=\s*"([^"]+)"/);
      resolve(match ? match[1] : stdout.trim());
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

      // Secret protection, three layers — a credential must never reach the vault:
      // 1. Password managers mark copies with org.nspasteboard.ConcealedType
      // 2. Anything copied while a password manager is frontmost is a credential
      // 3. Content that looks like a key/token/password, wherever it came from
      const [clipInfo, frontApp] = await Promise.all([getClipboardInfo(), getFrontmostApp()]);
      if (isConcealedClipboard(clipInfo)) {
        console.error('[Clipboard] Skipped concealed clipboard content (password manager).');
        return;
      }
      if (frontApp && isBlockedApp(frontApp)) {
        console.error(`[Clipboard] Skipped copy from ${frontApp} (secret store).`);
        return;
      }
      const secretReason = detectSecret(trimmed);
      if (secretReason) {
        console.error(`[Clipboard] Skipped secret-looking content (${secretReason}).`);
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

      // Log the shape, never the content: daemon.log is a plaintext file that
      // outlives the vault's own protections and used to hold a running
      // transcript of everything the user copied.
      console.error(`Clipboard copy detected (${trimmed.length} chars).`);

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
