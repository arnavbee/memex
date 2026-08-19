import chokidar from 'chokidar';
import path from 'path';
import fs from 'fs';
import { execFile } from 'child_process';
import { Database, Asset } from './db.js';
import { performOCR, performDescription } from './ocr.js';
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

export function startWatcher(db: Database) {
  console.error(`Watching Desktop: ${DESKTOP_DIR}`);
  console.error(`Watching Downloads: ${DOWNLOADS_DIR}`);

  // 1. Watch Desktop for Screenshots
  const desktopWatcher = chokidar.watch(DESKTOP_DIR, {
    ignored: /(^|[\/\\])\../, // ignore dotfiles
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: 500,
      pollInterval: 100
    }
  });

  desktopWatcher.on('add', async (filePath) => {
    const filename = path.basename(filePath);
    const ext = path.extname(filePath).toLowerCase();

    // Check if it is a screenshot (standard macOS pattern)
    const isScreenshot = filename.includes('Screenshot') || filename.includes('Screen Shot') || filename.startsWith('ss-');
    const isImage = ['.png', '.jpg', '.jpeg'].includes(ext);

    if (isScreenshot && isImage) {
      console.error(`New Screenshot detected: ${filename}`);
      const descText = await performDescription(filePath);
      const id = `screenshot-${Date.now()}`;
      const asset: Asset = {
        id,
        type: 'screenshot',
        filePath,
        content: descText || '[No text or features detected in screenshot]',
        metadata: {
          title: filename,
          createdAt: new Date().toISOString()
        }
      };
      db.addAsset(asset);
      console.error(`Screenshot indexed: ${filename} (${(descText || '').length} chars)`);
    }
  });

  desktopWatcher.on('error', (err) => {
    console.error(`Desktop Watcher error:`, err);
  });

  // 2. Watch Downloads for rich files
  const downloadsWatcher = chokidar.watch(DOWNLOADS_DIR, {
    ignored: /(^|[\/\\])\../,
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: 500,
      pollInterval: 100
    }
  });

  downloadsWatcher.on('add', async (filePath) => {
    const filename = path.basename(filePath);
    const ext = path.extname(filePath).toLowerCase();

    if (['.png', '.jpg', '.jpeg'].includes(ext)) {
      console.error(`New Image Download detected: ${filename}`);
      const descText = await performDescription(filePath);
      const id = `download-img-${Date.now()}`;
      const asset: Asset = {
        id,
        type: 'download',
        filePath,
        content: descText || '[No text or features detected in image]',
        metadata: {
          title: filename,
          createdAt: new Date().toISOString(),
          mimeType: `image/${ext.substring(1)}`
        }
      };
      db.addAsset(asset);
      console.error(`Downloaded image indexed: ${filename} (${(descText || '').length} chars)`);
    } else if (ext === '.pdf') {
      console.error(`New PDF Download detected: ${filename}`);
      const pdfText = await extractPdfText(filePath);
      if (pdfText) {
        const id = `download-pdf-${Date.now()}`;
        const asset: Asset = {
          id,
          type: 'download',
          filePath,
          content: pdfText,
          metadata: {
            title: filename,
            createdAt: new Date().toISOString(),
            mimeType: 'application/pdf'
          }
        };
        db.addAsset(asset);
        console.error(`Downloaded PDF indexed: ${filename} (${pdfText.length} chars)`);
      }
    } else if (['.txt', '.md', '.csv', '.json'].includes(ext)) {
      console.error(`New Text Download detected: ${filename}`);
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const id = `download-txt-${Date.now()}`;
        const asset: Asset = {
          id,
          type: 'download',
          filePath,
          content,
          metadata: {
            title: filename,
            createdAt: new Date().toISOString(),
            mimeType: 'text/plain'
          }
        };
        db.addAsset(asset);
        console.error(`Downloaded text file indexed: ${filename}`);
      } catch (e) {
        console.error(`Failed to read downloaded file ${filePath}:`, e);
      }
    }
  });

  downloadsWatcher.on('error', (err) => {
    console.error(`Downloads Watcher error:`, err);
  });
}
