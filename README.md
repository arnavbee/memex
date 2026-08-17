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
- **Browser history** — Safari, Chrome, Arc, Brave, and Edge visits (all profiles), synced every 30 minutes with search/auth/localhost noise filtered out
- **Links from your phone** — shared directly from Android via HTTP Shortcuts → POST to local API

Clipboard noise is self-cleaning: exact duplicates are collapsed and raw clipboard entries expire after 30 days (configurable via `OMNICONTEXT_CLIPBOARD_MAX_AGE_DAYS` / `OMNICONTEXT_CLIPBOARD_MAX_COUNT`). Rich assets — notes, downloads, screenshots, history — are never pruned.

---

## How it works

```
[Screenshots / Clipboard / Notes / Downloads]
              ↓
     Memex Daemon (Node.js)
              ↓
     SQLite + FTS5 (db.sqlite)
       ↙              ↘
 MCP Server          HTTP Server :4322
 (stdio)             (Bearer auth)
     ↓                    ↓
Claude Desktop      Cloudflare Tunnel
                         ↓
                   ChatGPT Mobile /
                   Android Share Sheet
```

The database is SQLite (via Node's built-in `node:sqlite` — no native dependencies) with an FTS5 full-text index. Search is BM25 ranking over content, title, summary, and source URL, with multiplicative recency and document-type boosts — no embeddings, no API calls, fully offline. WAL mode makes concurrent access from the daemon and MCP processes safe. An existing `db.json` from older versions is migrated automatically on first start.

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
# Edit .env and set OMNICONTEXT_API_KEY (only needed for the HTTP API/tunnel)

# Start the daemon once (foreground)
npm start

# ...or install it as a launchd agent: starts at login, restarts on crash
npm run install-daemon    # logs land in ~/.omnicontext/daemon.log
npm run uninstall-daemon  # stop + remove (database untouched)

# Expose to mobile (optional)
cloudflared tunnel --url localhost:4322
```

For Safari history and Apple Notes capture, grant Full Disk Access to the `node` binary (System Settings → Privacy & Security). Chromium browsers work without it.

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

**SQLite over flat JSON** — v1 used an atomically-swapped `db.json`, which was fine until two processes (daemon + MCP server) raced on read-modify-write, and every search re-parsed the whole file. Node's built-in `node:sqlite` ships FTS5 and WAL, so the fix added zero dependencies. Old `db.json` files migrate automatically.

**BM25 over embeddings** — embeddings need either a local GPU or an API round-trip. Both break the offline-first constraint. FTS5's BM25 runs in milliseconds and works well for personal context retrieval where queries tend to be specific.

**Cloudflare Tunnel over ngrok** — no signup, no account, no bandwidth limits, and the URL persists for the session. Free ngrok rotates URLs on restart and throttles connections.
