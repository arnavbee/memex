import { createServer, IncomingMessage, ServerResponse } from 'http';
import { timingSafeEqual } from 'crypto';
import { Database } from './db.js';
import { processYoutubeLink, extractVideoId } from './youtube.js';
import { processTwitterLink, extractTweetId } from './twitter.js';
import { processWebpageUrl, isArchivableUrl } from './webpage.js';
import { detectSecret } from './secrets.js';

const MAX_BODY_BYTES = 1024 * 1024; // 1MB — this endpoint is exposed via a public tunnel
const MAX_LIMIT = 100;

// A tunnel makes this endpoint reachable from the internet, so a weak or
// placeholder key is the same as no key at all. Refuse to listen rather than
// serve the vault behind a guessable token.
const MIN_KEY_LENGTH = 32;
const PLACEHOLDER_KEYS = new Set(['change-me', 'changeme', 'secret', 'password', 'test', 'key']);

function validateApiKey(key: string | undefined): string | null {
  if (!key) {
    return 'OMNICONTEXT_API_KEY is not set. Copy .env.example to .env and set it.';
  }
  if (PLACEHOLDER_KEYS.has(key.toLowerCase())) {
    return `OMNICONTEXT_API_KEY is still the placeholder value "${key}".`;
  }
  if (key.length < MIN_KEY_LENGTH) {
    return `OMNICONTEXT_API_KEY is only ${key.length} characters; at least ${MIN_KEY_LENGTH} are required.`;
  }
  return null;
}

// Bounded so a caller cannot ask for the entire vault in one request, and so a
// negative value can't reach SQLite (where LIMIT -1 means unlimited).
function clampLimit(value: unknown, fallback: number): number {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(n, MAX_LIMIT);
}

// Failed-auth throttle. Keyed by socket address; the tunnel collapses every
// remote caller onto one address, which is the conservative direction — a
// remote guesser gets rate limited alongside everyone else behind it.
const MAX_FAILURES = 10;
const FAILURE_WINDOW_MS = 60_000;
const authFailures = new Map<string, { count: number; first: number }>();

function recordAuthFailure(addr: string): void {
  const now = Date.now();
  const entry = authFailures.get(addr);
  if (!entry || now - entry.first > FAILURE_WINDOW_MS) {
    authFailures.set(addr, { count: 1, first: now });
    return;
  }
  entry.count++;
}

function isThrottled(addr: string): boolean {
  const entry = authFailures.get(addr);
  if (!entry) return false;
  if (Date.now() - entry.first > FAILURE_WINDOW_MS) {
    authFailures.delete(addr);
    return false;
  }
  return entry.count >= MAX_FAILURES;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    let rejected = false;
    req.on('data', chunk => {
      if (rejected) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        // Stop buffering but keep the socket alive so the caller can still
        // answer with a 413 instead of an abrupt connection reset.
        rejected = true;
        chunks.length = 0;
        req.pause();
        reject(new Error('Request body too large (max 1MB)'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

function isAuthorized(authHeader: string, apiKey: string): boolean {
  const expected = Buffer.from(`Bearer ${apiKey}`);
  const provided = Buffer.from(authHeader);
  // timingSafeEqual requires equal lengths; length comparison leaks only the
  // key's length, not its contents.
  if (expected.length !== provided.length) return false;
  return timingSafeEqual(expected, provided);
}

// No CORS headers on purpose: the clients (ChatGPT Actions, HTTP Shortcuts,
// curl) are not browsers, and a wildcard origin would let any webpage the
// user visits probe the tunnel.
function sendJson(res: ServerResponse, status: number, data: object) {
  const json = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(json);
}

/**
 * Defence in depth against DNS rebinding. The bearer token already stops a
 * rebinding attacker, but a stray Host is never legitimate here. Cloudflare
 * forwards the tunnel hostname, so those are allowed too; add your own with
 * OMNICONTEXT_ALLOWED_HOSTS (comma-separated).
 */
function isAllowedHost(hostHeader: string, port: number): boolean {
  if (!hostHeader) return false;
  const host = hostHeader.replace(/:\d+$/, '').toLowerCase().replace(/^\[|\]$/g, '');

  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return true;
  if (host.endsWith('.trycloudflare.com') || host.endsWith('.cfargotunnel.com')) return true;

  const extra = (process.env.OMNICONTEXT_ALLOWED_HOSTS || '')
    .split(',')
    .map(h => h.trim().toLowerCase())
    .filter(Boolean);
  return extra.includes(host);
}

export function startIngestServer(db: Database, port = 4322) {
  const server = createServer(async (req, res) => {
    const urlObj = new URL(req.url || '', `http://localhost:${port}`);
    const pathname = urlObj.pathname;

    if (!isAllowedHost(String(req.headers['host'] || ''), port)) {
      sendJson(res, 403, { ok: false, error: 'Forbidden: unexpected Host header.' });
      return;
    }

    // Authenticate endpoints queried by ChatGPT or exposed publicly
    if (pathname === '/search' || pathname === '/recent' || pathname === '/ingest') {
      const remote = req.socket.remoteAddress || 'unknown';

      if (isThrottled(remote)) {
        sendJson(res, 429, { ok: false, error: 'Too many failed attempts. Try again later.' });
        return;
      }

      // Re-read each request so a key rotated in .env takes effect on restart
      // without changing the fail-closed behaviour here.
      const apiKey = process.env.OMNICONTEXT_API_KEY;
      const keyProblem = validateApiKey(apiKey);
      if (keyProblem) {
        console.error(`[Ingest] Authorization rejected: ${keyProblem}`);
        sendJson(res, 401, { ok: false, error: 'Authorization key not configured on server.' });
        return;
      }

      const authHeader = String(req.headers['authorization'] || '');
      if (!isAuthorized(authHeader, apiKey!)) {
        recordAuthFailure(remote);
        console.error('[Ingest] Authorization failed: Invalid or missing token.');
        sendJson(res, 401, { ok: false, error: 'Unauthorized. Invalid API Key.' });
        return;
      }
    }

    if (req.method === 'POST' && pathname === '/ingest') {
      try {
        const rawBody = await readBody(req);
        let content = '';

        // Accept both { "content": "..." } and plain text body
        try {
          const parsed = JSON.parse(rawBody);
          content = String(parsed.content || parsed.text || parsed.url || '').trim();
        } catch {
          content = rawBody.trim();
        }

        if (!content) {
          sendJson(res, 400, { ok: false, error: 'No content provided' });
          return;
        }

        console.error(`[Ingest] Received ${content.length} chars from phone.`);

        // Screen before anything is fetched or stored. This used to run only in
        // the plain-text branch below, so a secret in URL shape was archived
        // before the filter was ever consulted.
        const secretReason = detectSecret(content);
        if (secretReason) {
          console.error(`[Ingest] Rejected secret-looking content (${secretReason}).`);
          sendJson(res, 200, { ok: false, message: `Not saved: looks like a secret (${secretReason}).` });
          return;
        }

        let handled = false;
        let message = 'Saved to clipboard';

        // Run through the same pipeline as the clipboard tracker
        const videoId = extractVideoId(content);
        if (videoId) {
          await processYoutubeLink(db, content);
          handled = true;
          message = 'YouTube video transcript indexed';
        }

        const tweetId = extractTweetId(content);
        if (tweetId) {
          await processTwitterLink(db, content);
          handled = true;
          message = 'Tweet indexed';
        }

        if (!handled && isArchivableUrl(content)) {
          const ok = await processWebpageUrl(db, content);
          handled = ok;
          message = ok ? 'Article archived' : 'Could not extract article';
        }

        if (!handled) {
          // Plain text — save as clipboard item
          db.addAsset({
            id: `phone-${Date.now()}`,
            type: 'clipboard',
            content,
            metadata: {
              title: '[From Android]',
              createdAt: new Date().toISOString(),
            }
          });
          message = 'Text saved';
        }

        sendJson(res, 200, { ok: true, message });
      } catch (err: any) {
        console.error('[Ingest] Error:', err.message);
        sendJson(res, err.message.includes('too large') ? 413 : 500, { ok: false, error: err.message });
      }
    } else if (req.method === 'POST' && pathname === '/search') {
      try {
        const rawBody = await readBody(req);
        let query = '';
        let limit = 5;

        try {
          const parsed = JSON.parse(rawBody);
          query = String(parsed.query || '').trim();
          if (parsed.limit !== undefined) limit = clampLimit(parsed.limit, 5);
        } catch {
          query = rawBody.trim();
        }

        if (!query) {
          sendJson(res, 400, { ok: false, error: 'Missing query parameter' });
          return;
        }

        // The query itself is user content — log only its shape.
        console.error(`[Ingest] Searching vault (query length: ${query.length}, limit: ${limit})`);
        db.reload();
        const rawResults = db.search(query, limit);

        // Strip base64 payloads to keep ChatGPT responses token-efficient
        const sanitizedResults = rawResults.map(r => {
          const assetCopy = JSON.parse(JSON.stringify(r.asset));
          if (assetCopy.metadata && assetCopy.metadata.localMediaPaths) {
            delete assetCopy.metadata.localMediaPaths;
          }
          if (assetCopy.content && assetCopy.content.length > 2000) {
            assetCopy.content = assetCopy.content.substring(0, 2000) + '... [TRUNCATED DUE TO SIZE LIMIT]';
          }
          return {
            asset: assetCopy,
            score: r.score
          };
        });

        sendJson(res, 200, { ok: true, results: sanitizedResults });
      } catch (err: any) {
        console.error('[Ingest] Search Error:', err.message);
        sendJson(res, err.message.includes('too large') ? 413 : 500, { ok: false, error: err.message });
      }
    } else if (req.method === 'GET' && pathname === '/recent') {
      try {
        const type = urlObj.searchParams.get('type') || 'all';
        // Clamped: parseInt(...) || 10 let a negative through, and SQLite reads
        // LIMIT -1 as "no limit", which dumped the whole vault in one response.
        const limit = clampLimit(urlObj.searchParams.get('limit'), 10);

        console.error(`[Ingest] Fetching recent assets (type: ${type}, limit: ${limit})`);
        db.reload();
        const rawResults = db.getRecent(limit, type);

        // Strip base64 payloads to keep ChatGPT responses token-efficient
        const sanitizedResults = rawResults.map(a => {
          const assetCopy = JSON.parse(JSON.stringify(a));
          if (assetCopy.metadata && assetCopy.metadata.localMediaPaths) {
            delete assetCopy.metadata.localMediaPaths;
          }
          if (assetCopy.content && assetCopy.content.length > 2000) {
            assetCopy.content = assetCopy.content.substring(0, 2000) + '... [TRUNCATED DUE TO SIZE LIMIT]';
          }
          return assetCopy;
        });

        sendJson(res, 200, { ok: true, assets: sanitizedResults });
      } catch (err: any) {
        console.error('[Ingest] Recent Assets Error:', err.message);
        sendJson(res, 500, { ok: false, error: err.message });
      }
    } else {
      sendJson(res, 404, { ok: false, error: 'Not found. Supported: POST /ingest, POST /search, GET /recent' });
    }
  });

  // Refuse to listen at all rather than expose the vault behind a weak token.
  const keyProblem = validateApiKey(process.env.OMNICONTEXT_API_KEY);
  if (keyProblem) {
    console.error(`\n⚠️  HTTP server not started: ${keyProblem}`);
    console.error('   Generate one with:  openssl rand -hex 32');
    console.error('   The MCP server and local capture keep running normally.\n');
    return;
  }

  // EADDRINUSE used to be an unhandled 'error' event, which killed the process;
  // under launchd's KeepAlive that became a silent infinite restart loop.
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\n⚠️  Port ${port} is already in use — another Memex instance is probably running.`);
      console.error('   Not starting a second HTTP server. Local capture continues.\n');
      return;
    }
    console.error(`[Ingest] HTTP server error: ${err.message}`);
  });

  // Loopback only. cloudflared connects to localhost, so binding 0.0.0.0 gained
  // nothing and put the vault on every network the machine joins.
  server.listen(port, '127.0.0.1', () => {
    console.error(`📱 Ingest/ChatGPT server listening on http://127.0.0.1:${port}/ (loopback only)`);
    console.error(`   To reach it from your phone, run:  cloudflared tunnel --url localhost:${port}`);
  });
}
