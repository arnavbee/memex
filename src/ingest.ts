import { createServer, IncomingMessage, ServerResponse } from 'http';
import { Database } from './db.js';
import { processYoutubeLink, extractVideoId } from './youtube.js';
import { processTwitterLink, extractTweetId } from './twitter.js';
import { processWebpageUrl, isArchivableUrl } from './webpage.js';
import os from 'os';

function getLocalIp(): string {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return '127.0.0.1';
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, data: object) {
  const json = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  });
  res.end(json);
}

export function startIngestServer(db: Database, port = 4322) {
  const server = createServer(async (req, res) => {
    // CORS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization'
      });
      res.end();
      return;
    }

    const urlObj = new URL(req.url || '', `http://localhost:${port}`);
    const pathname = urlObj.pathname;

    // Authenticate endpoints queried by ChatGPT or exposed publicly
    if (pathname === '/search' || pathname === '/recent' || pathname === '/ingest') {
      const apiKey = process.env.OMNICONTEXT_API_KEY;
      if (!apiKey) {
        console.error('[Ingest] Authorization rejected: OMNICONTEXT_API_KEY is not defined in .env.');
        sendJson(res, 401, { ok: false, error: 'Authorization key not configured on server.' });
        return;
      }

      const authHeader = req.headers['authorization'] || '';
      if (authHeader !== `Bearer ${apiKey}`) {
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

        console.error(`[Ingest] Received from phone: ${content.substring(0, 60)}...`);

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
        sendJson(res, 500, { ok: false, error: err.message });
      }
    } else if (req.method === 'POST' && pathname === '/search') {
      try {
        const rawBody = await readBody(req);
        let query = '';
        let limit = 5;

        try {
          const parsed = JSON.parse(rawBody);
          query = String(parsed.query || '').trim();
          if (parsed.limit) limit = Number(parsed.limit);
        } catch {
          query = rawBody.trim();
        }

        if (!query) {
          sendJson(res, 400, { ok: false, error: 'Missing query parameter' });
          return;
        }

        console.error(`[Ingest] Searching vault for: "${query}" (limit: ${limit})`);
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
        sendJson(res, 500, { ok: false, error: err.message });
      }
    } else if (req.method === 'GET' && pathname === '/recent') {
      try {
        const limitStr = urlObj.searchParams.get('limit') || '10';
        const type = urlObj.searchParams.get('type') || 'all';
        const limit = parseInt(limitStr, 10) || 10;

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

  server.listen(port, '0.0.0.0', () => {
    const localIp = getLocalIp();
    console.error(`📱 Android ingest/ChatGPT server running at http://${localIp}:${port}/`);
    console.error(`   Configure your endpoints to point to this server.`);
  });
}
