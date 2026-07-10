import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import { Database, Asset } from './db.js';

// Domains we skip — already handled by dedicated parsers or not useful as articles
const SKIP_DOMAINS = [
  'youtube.com', 'youtu.be',
  'twitter.com', 'x.com',
  'instagram.com', 'tiktok.com',
  'spotify.com', 'open.spotify.com',
  // Raw file / CDN URLs
  'github.com/blob', 'raw.githubusercontent.com',
  'pbs.twimg.com', 'video.twimg.com',
  'i.imgur.com', 'i.redd.it',
];

// File extensions that are never articles
const SKIP_EXTENSIONS = [
  '.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg',
  '.mp4', '.mp3', '.mov', '.zip', '.dmg', '.exe',
];

export function isArchivableUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;

    const hostPath = parsed.hostname + parsed.pathname;
    for (const skip of SKIP_DOMAINS) {
      if (hostPath.includes(skip)) return false;
    }

    const ext = parsed.pathname.toLowerCase().match(/\.[a-z0-9]+$/)?.[0] || '';
    if (SKIP_EXTENSIONS.includes(ext)) return false;

    return true;
  } catch {
    return false;
  }
}

export interface ArchivedPage {
  title: string;
  byline: string;
  siteName: string;
  text: string;
  excerpt: string;
  wordCount: number;
}

export async function fetchAndExtract(url: string): Promise<ArchivedPage | null> {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: AbortSignal.timeout(10000), // 10 second timeout
    });

    if (!res.ok) {
      console.error(`Webpage fetch failed for ${url}: HTTP ${res.status}`);
      return null;
    }

    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('text/html')) {
      console.error(`Skipping non-HTML content at ${url}: ${contentType}`);
      return null;
    }

    const html = await res.text();
    const dom = new JSDOM(html, { url });
    const reader = new Readability(dom.window.document);
    const article = reader.parse();

    if (!article || !article.textContent || article.textContent.trim().length < 100) {
      console.error(`Readability could not extract article from ${url}`);
      return null;
    }

    // Clean up whitespace
    const cleanText = article.textContent
      .replace(/\n{3,}/g, '\n\n')
      .replace(/[ \t]{2,}/g, ' ')
      .trim();

    const wordCount = cleanText.split(/\s+/).length;

    // Cap at 20,000 words to avoid bloating the DB
    const cappedText = wordCount > 20000
      ? cleanText.split(/\s+/).slice(0, 20000).join(' ') + '\n\n[Article truncated at 20,000 words]'
      : cleanText;

    return {
      title: article.title || 'Untitled',
      byline: article.byline || '',
      siteName: article.siteName || new URL(url).hostname,
      text: cappedText,
      excerpt: article.excerpt || cleanText.slice(0, 280),
      wordCount: Math.min(wordCount, 20000),
    };
  } catch (err: any) {
    console.error(`Failed to archive ${url}:`, err.message);
    return null;
  }
}

export async function processWebpageUrl(db: Database, url: string): Promise<boolean> {
  if (!isArchivableUrl(url)) return false;

  // Deduplicate — don't re-archive the same URL if already indexed, just update timestamp
  if (db.touchAssetByUrl(url)) {
    console.error(`Webpage already archived: ${url}. Updated timestamp to keep it fresh.`);
    return true;
  }

  console.error(`Archiving webpage: ${url}`);
  const page = await fetchAndExtract(url);

  if (page) {
    const id = `webpage-${Date.now()}`;
    const asset: Asset = {
      id,
      type: 'download',
      content: `Article: ${page.title}\nSite: ${page.siteName}${page.byline ? '\nBy: ' + page.byline : ''}\nURL: ${url}\nWords: ${page.wordCount}\n\n${page.text}`,
      metadata: {
        title: page.title,
        createdAt: new Date().toISOString(),
        sourceUrl: url,
      }
    };
    db.addAsset(asset);
    console.error(`Archived article: "${page.title}" — ${page.wordCount} words from ${page.siteName}`);
    return true;
  } else {
    // Save a stub so the link is preserved and classified as a link/download type
    const id = `webpage-stub-${Date.now()}`;
    const asset: Asset = {
      id,
      type: 'download',
      content: `URL: ${url}\n(This page contains mostly dynamic/visual content or blocked extraction)`,
      metadata: {
        title: url,
        createdAt: new Date().toISOString(),
        sourceUrl: url,
      }
    };
    db.addAsset(asset);
    console.error(`Saved URL stub for unextractable page: ${url}`);
    return true;
  }
}
