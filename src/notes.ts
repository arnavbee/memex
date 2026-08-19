import { execFile } from 'child_process';
import path from 'path';
import fs from 'fs';
import { Database, Asset } from './db.js';
import { fileURLToPath } from 'url';

// fileURLToPath, not .pathname: the raw pathname keeps percent-encoding, so a
// clone under a path with a space resolved to a directory that doesn't exist.
const SCRIPTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../scripts');
const SYNC_SCRIPT = path.join(SCRIPTS_DIR, 'sync_notes.applescript');

function stripHtml(html: string): string {
  // Replace HTML tags with spaces/newlines and decode common entities
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
}

export function syncNotes(db: Database): Promise<void> {
  return new Promise((resolve) => {
    if (!fs.existsSync(SYNC_SCRIPT)) {
      console.error(`AppleScript sync script not found at ${SYNC_SCRIPT}`);
      resolve();
      return;
    }

    execFile('osascript', [SYNC_SCRIPT], { maxBuffer: 1024 * 1024 * 50, timeout: 10000 }, (error, stdout, stderr) => {
      if (error) {
        console.error('Failed to run AppleScript notes sync:', error, stderr);
        resolve();
        return;
      }

      const noteBlocks = stdout.split('---NOTE_START---');
      let newNotesCount = 0;

      for (const block of noteBlocks) {
        if (!block.includes('---NOTE_END---')) continue;

        // Parse fields
        const titleMatch = block.match(/TITLE: (.*)/);
        const dateMatch = block.match(/DATE: (.*)/);
        const bodyStart = block.indexOf('BODY: ') + 6;
        const bodyEnd = block.indexOf('---NOTE_END---');

        if (titleMatch && dateMatch && bodyStart > 5 && bodyEnd > bodyStart) {
          const title = titleMatch[1].trim();
          const dateStr = dateMatch[1].trim();
          const rawBody = block.substring(bodyStart, bodyEnd).trim();
          const cleanBody = stripHtml(rawBody);

          // Convert date string safely (AppleScript returns local dates)
          let createdAt = new Date().toISOString();
          try {
            const parsedDate = Date.parse(dateStr);
            if (!isNaN(parsedDate)) {
              createdAt = new Date(parsedDate).toISOString();
            }
          } catch (e) {
            // Keep default ISO string
          }

          const id = `note-${title.replace(/[^a-zA-Z0-9]/g, '_')}-${createdAt}`;
          const noteAsset: Asset = {
            id,
            type: 'note',
            content: `${title}\n\n${cleanBody}`,
            metadata: {
              title,
              createdAt
            }
          };

          db.addAsset(noteAsset);
          newNotesCount++;
        }
      }

      console.error(`Synced ${newNotesCount} notes successfully.`);
      resolve();
    });
  });
}
