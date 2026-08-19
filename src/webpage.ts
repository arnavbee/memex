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

/**
 * Hosts that resolve to the machine itself or to the local network. The daemon
 * fetches URLs on its own initiative (any copied link triggers an archive), so
 * without this it is a request proxy into the user's LAN, router admin pages,
 * and cloud metadata endpoints — with the response body stored in the vault and
 * readable over the tunnel.
 */
function isInternalHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');

  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) {
    return true;
  }
  // IPv6 loopback / link-local / unique-local
  if (h === '::1' || h === '::' || h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd')) {
    return true;
  }

  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 127 || a === 0 || a === 10) return true;              // loopback, this-host, private
    if (a === 172 && b >= 16 && b <= 31) return true;               // private
    if (a === 192 && b === 168) return true;                        // private
    if (a === 169 && b === 254) return true;                        // link-local + cloud metadata
    if (a === 100 && b >= 64 && b <= 127) return true;              // carrier-grade NAT
    if (a >= 224) return true;                                      // multicast / reserved
  }

  return false;
}

export function isArchivableUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    if (isInternalHost(parsed.hostname)) return false;

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

const MAX_REDIRECTS = 5;

/**
 * Log hostnames, not full URLs. Paths and query strings routinely carry tokens
 * and identifiers, and daemon.log is plaintext and long-lived.
 */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '(unparseable url)';
  }
}

export async function fetchAndExtract(url: string, redirectDepth = 0): Promise<ArchivedPage | null> {
  try {
    if (!isArchivableUrl(url)) {
      console.error(`Refusing to fetch non-archivable or internal URL.`);
      return null;
    }

    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      redirect: 'manual', // a 302 to 169.254.169.254 would otherwise bypass the check above
      signal: AbortSignal.timeout(10000), // 10 second timeout
    });

    // Follow redirects ourselves so every hop is re-validated.
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) return null;
      const next = new URL(location, url).toString();
      if (!isArchivableUrl(next)) {
        console.error(`Refusing to follow redirect to a non-archivable or internal URL.`);
        return null;
      }
      if (redirectDepth >= MAX_REDIRECTS) {
        console.error('Too many redirects.');
        return null;
      }
      return fetchAndExtract(next, redirectDepth + 1);
    }

    if (!res.ok) {
      console.error(`Webpage fetch failed for ${hostOf(url)}: HTTP ${res.status}`);
      return null;
    }

    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('text/html')) {
      console.error(`Skipping non-HTML content at ${hostOf(url)}: ${contentType}`);
      return null;
    }

    const html = await res.text();
    const dom = new JSDOM(html, { url });
    const reader = new Readability(dom.window.document);
    const article = reader.parse();

    if (!article || !article.textContent || article.textContent.trim().length < 100) {
      console.error(`Readability could not extract article from ${hostOf(url)}`);
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
    console.error(`Failed to archive ${hostOf(url)}:`, err.message);
    return null;
  }
}

export async function processWebpageUrl(db: Database, url: string): Promise<boolean> {
  if (!isArchivableUrl(url)) return false;

  // Deduplicate — don't re-archive the same URL if already indexed, just update timestamp
  if (db.touchAssetByUrl(url)) {
    console.error(`Webpage already archived: ${hostOf(url)}. Updated timestamp to keep it fresh.`);
    return true;
  }

  console.error(`Archiving webpage: ${hostOf(url)}`);
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
    console.error(`Saved URL stub for unextractable page: ${hostOf(url)}`);
    return true;
  }
}
