import fs from 'fs';
import path from 'path';
import { Database, Asset } from './db.js';
import { performOCR, performDescription } from './ocr.js';
import { execFile } from 'child_process';
import { fileURLToPath } from 'url';

const HOME = process.env.HOME || '';
const DESKTOP_DIR = path.join(HOME, 'Desktop');
const DOWNLOADS_DIR = path.join(HOME, 'Downloads');

// fileURLToPath, not .pathname: the raw pathname keeps percent-encoding, so a
// clone under a path with a space resolved to a directory that doesn't exist.
const SCRIPTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../scripts');
const PDF_SWIFT = path.join(SCRIPTS_DIR, 'pdf2text.swift');

function extractPdfText(pdfPath: string): Promise<string> {
  return new Promise((resolve) => {
    execFile('swift', [PDF_SWIFT, pdfPath], { maxBuffer: 1024 * 1024 * 20 }, (error, stdout, stderr) => {
      if (error) {
        console.error(`Failed to extract text from PDF ${pdfPath}:`, error, stderr);
        resolve('');
        return;
      }
      resolve(stdout.trim());
    });
  });
}

export async function scanRecentFiles(db: Database, type: 'screenshot' | 'download', limit = 10): Promise<string> {
  const dir = type === 'screenshot' ? DESKTOP_DIR : DOWNLOADS_DIR;
  
  if (!fs.existsSync(dir)) {
    return `Error: Directory ${dir} does not exist.`;
  }

  try {
    const files = fs.readdirSync(dir);
    const fileStats = files
      .map(file => {
        const filePath = path.join(dir, file);
        try {
          const stat = fs.statSync(filePath);
          return { file, filePath, stat };
        } catch (e) {
          return null;
        }
      })
      .filter((item): item is NonNullable<typeof item> => item !== null && item.stat.isFile());

    // Sort descending by modified time (newest first)
    fileStats.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);

    let processedCount = 0;
    let skippedCount = 0;

    const existingPaths = new Set(db.getRecent(1000, type).map(a => a.filePath));

    for (const item of fileStats) {
      if (processedCount >= limit) break;

      const ext = path.extname(item.file).toLowerCase();
      
      // Skip if already in database
      if (existingPaths.has(item.filePath)) {
        skippedCount++;
        continue;
      }

      if (type === 'screenshot') {
        const isScreenshot = item.file.includes('Screenshot') || item.file.includes('Screen Shot') || item.file.startsWith('ss-');
        const isImage = ['.png', '.jpg', '.jpeg'].includes(ext);

        if (isScreenshot && isImage) {
          console.error(`Scanning historical screenshot: ${item.file}`);
          const descText = await performDescription(item.filePath);
          const asset: Asset = {
            id: `screenshot-hist-${Date.now()}-${processedCount}`,
            type: 'screenshot',
            filePath: item.filePath,
            content: descText || '[No text or features detected in screenshot]',
            metadata: {
              title: item.file,
              createdAt: item.stat.mtime.toISOString()
            }
          };
          db.addAsset(asset);
          processedCount++;
        }
      } else if (type === 'download') {
        if (['.png', '.jpg', '.jpeg'].includes(ext)) {
          console.error(`Scanning historical image download: ${item.file}`);
          const descText = await performDescription(item.filePath);
          const asset: Asset = {
            id: `download-img-hist-${Date.now()}-${processedCount}`,
            type: 'download',
            filePath: item.filePath,
            content: descText || '[No text or features detected in image]',
            metadata: {
              title: item.file,
              createdAt: item.stat.mtime.toISOString(),
              mimeType: `image/${ext.substring(1)}`
            }
          };
          db.addAsset(asset);
          processedCount++;
        } else if (ext === '.pdf') {
          console.error(`Scanning historical PDF download: ${item.file}`);
          const pdfText = await extractPdfText(item.filePath);
          if (pdfText) {
            const asset: Asset = {
              id: `download-pdf-hist-${Date.now()}-${processedCount}`,
              type: 'download',
              filePath: item.filePath,
              content: pdfText,
              metadata: {
                title: item.file,
                createdAt: item.stat.mtime.toISOString(),
                mimeType: 'application/pdf'
              }
            };
            db.addAsset(asset);
            processedCount++;
          }
        } else if (['.txt', '.md', '.csv', '.json'].includes(ext)) {
          console.error(`Scanning historical text download: ${item.file}`);
          try {
            const content = fs.readFileSync(item.filePath, 'utf-8');
            const asset: Asset = {
              id: `download-txt-hist-${Date.now()}-${processedCount}`,
              type: 'download',
              filePath: item.filePath,
              content,
              metadata: {
                title: item.file,
                createdAt: item.stat.mtime.toISOString(),
                mimeType: 'text/plain'
              }
            };
            db.addAsset(asset);
            processedCount++;
          } catch (e) {
            // Ignore failed reads
          }
        }
      }
    }

    return `Scan completed for ${type}s. Processed ${processedCount} new files. Skipped ${skippedCount} already-indexed files.`;
  } catch (e: any) {
    return `Error scanning directory: ${e.message}`;
  }
}
