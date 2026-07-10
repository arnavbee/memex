import { execFile } from 'child_process';
import path from 'path';
import fs from 'fs';

const PROJECT_ROOT = path.resolve(process.env.HOME || '', '.omnicontext'); // we can also store scripts in the project directory, let's use the local script location.
const SCRIPTS_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../scripts');
const OCR_BIN = path.join(SCRIPTS_DIR, 'ocr');
const OCR_SWIFT = path.join(SCRIPTS_DIR, 'ocr.swift');

export function performOCR(imagePath: string): Promise<string> {
  return new Promise((resolve) => {
    // Check if compiled binary exists, otherwise run via swift interpreter
    const cmd = fs.existsSync(OCR_BIN) ? OCR_BIN : 'swift';
    const args = fs.existsSync(OCR_BIN) ? [imagePath] : [OCR_SWIFT, imagePath];

    execFile(cmd, args, { maxBuffer: 1024 * 1024 * 10 }, (error, stdout, stderr) => {
      if (error) {
        console.error(`OCR Execution failed for ${imagePath}:`, error, stderr);
        resolve('');
        return;
      }
      resolve(stdout.trim());
    });
  });
}

const VIDEO_OCR_SWIFT = path.join(SCRIPTS_DIR, 'video_ocr.swift');
const DESCRIBE_BIN = path.join(SCRIPTS_DIR, 'describe');
const DESCRIBE_SWIFT = path.join(SCRIPTS_DIR, 'describe.swift');

export function performDescription(imagePath: string): Promise<string> {
  return new Promise((resolve) => {
    const cmd = fs.existsSync(DESCRIBE_BIN) ? DESCRIBE_BIN : 'swift';
    const args = fs.existsSync(DESCRIBE_BIN) ? [imagePath] : [DESCRIBE_SWIFT, imagePath];

    execFile(cmd, args, { maxBuffer: 1024 * 1024 * 10 }, (error, stdout, stderr) => {
      if (error) {
        console.error(`Describe Execution failed for ${imagePath}:`, error, stderr);
        // Fallback to plain OCR if describe fails
        performOCR(imagePath).then(resolve);
        return;
      }
      resolve(stdout.trim());
    });
  });
}

export function performVideoOCR(videoPath: string, intervalSeconds = 5): Promise<string> {
  return new Promise((resolve) => {
    const cmd = 'swift';
    const args = [VIDEO_OCR_SWIFT, videoPath, String(intervalSeconds)];

    execFile(cmd, args, { maxBuffer: 1024 * 1024 * 10 }, (error, stdout, stderr) => {
      if (error) {
        console.error(`Video OCR Execution failed for ${videoPath}:`, error, stderr);
        resolve('');
        return;
      }
      resolve(stdout.trim());
    });
  });
}
