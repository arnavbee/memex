# Memex
**A local-first, privacy-first personal context engine for LLMs.**

*TypeScript · Swift · MCP · OpenAPI 3.1.0 · Cloudflare Tunnel*

---

Most AI assistants don't know anything about you. Every new conversation starts from zero — they don't know what you've been reading, what links you've saved, what notes you've written, or what files you've downloaded.

Memex fixes that. It's a background daemon that runs on your Mac and passively indexes your digital activity into a local database. That database is then made available to any LLM — Claude on your desktop, ChatGPT on your phone — through standard interfaces. No cloud storage. No third-party servers. Everything stays on your machine.

---

## What it captures

- **Screenshots** — OCR'd locally using Apple's Vision framework (Swift)
- **Clipboard** — monitored continuously; YouTube URLs auto-fetch transcripts, Twitter links scrape post content
- **Downloads** — PDFs, markdown files, CSVs parsed and indexed on arrival
- **Apple Notes** — synced periodically via AppleScript
- **Links from your phone** — shared directly from Android via HTTP Shortcuts → POST to local API

---

## How it works

```
[Screenshots / Clipboard / Notes / Downloads]
              ↓
     Memex Daemon (Node.js)
              ↓
     Local JSON index (db.json)
       ↙              ↘
 MCP Server          HTTP Server :4322
 (stdio)             (Bearer auth)
     ↓                    ↓
Claude Desktop      Cloudflare Tunnel
                         ↓
                   ChatGPT Mobile /
                   Android Share Sheet
```

The database is a flat JSON file written atomically to disk. Search runs through a custom TF-IDF model — no embeddings, no API calls, fully offline. It weights keyword relevance, recency, document type, and URL path matches to return the most relevant result for any query.

Two interfaces serve the database simultaneously:
- A **local MCP server** (stdio transport) for Claude Desktop and MCP-compatible editors like Cursor
- An **HTTP server** exposed over a free Cloudflare tunnel for ChatGPT Custom Actions and mobile ingestion

---

## Setup

```bash
git clone https://github.com/arnavbee/memex
cd memex
npm install && npm run build

# Configure your API key
cp .env.example .env
# Edit .env and set API_KEY=your-secret-token

# Start the daemon
npm start

# Expose to mobile (optional)
cloudflared tunnel --url localhost:4322
```

**Claude Desktop** — add to `~/Library/Application Support/Claude/claude_desktop_config.json`:
```json
{
  "mcpServers": {
    "memex": {
      "command": "node",
      "args": ["/path/to/memex/dist/index.js"]
    }
  }
}
```

**ChatGPT Custom Actions** — import `openapi.json` from the repo into your GPT's action schema, pointing the server URL at your Cloudflare tunnel.

---

## Things that were annoying to figure out

**ChatGPT's 1MB tool result limit.** Returning full PDF text crashed the action with a `ResponseTooLargeError`. Fixed by truncating all returned content to 2,000 characters server-side.

**Claude Desktop's MCP connection dropping on startup.** Happened because the HTTP server was initializing before the MCP transport was ready. Fixed by sequencing the boot order and adding retry logging.

**Dynamic pages that block scraping.** `cosmos.so`, Instagram, login-walled portals — `@mozilla/readability` extracts nothing from them. Rather than silently failing, the system now writes a URL stub with the timestamp and source URL so the LLM can still confirm the link was saved.

**Android doesn't have Universal Clipboard.** iCloud clipboard sync only works on Apple devices. Solved by routing phone shares through HTTP Shortcuts → Cloudflare tunnel → local ingest API instead.

---

## Why certain things were built the way they are

**Flat JSON over SQLite** — the dataset is small and mostly read-heavy. Atomic file swaps give crash safety without adding a DB engine. The file is also human-readable and trivially portable.

**TF-IDF over embeddings** — embeddings need either a local GPU or an API round-trip. Both break the offline-first constraint. TF-IDF runs in microseconds and works well for personal context retrieval where queries tend to be specific.

**Cloudflare Tunnel over ngrok** — no signup, no account, no bandwidth limits, and the URL persists for the session. Free ngrok rotates URLs on restart and throttles connections.
