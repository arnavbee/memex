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

**Secrets never enter the vault.** Copies from password managers (1Password, Bitwarden, KeePass, …) are skipped via app detection and the `org.nspasteboard.ConcealedType` marker, and secret-shaped content — AWS keys, GitHub/Slack/Stripe tokens, JWTs, private key blocks, `PASSWORD=` assignments, generated-password-shaped strings — is filtered before storage.

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

**Requirements:** macOS (capture is macOS-native: Vision OCR, AppleScript, launchd) and **Node.js ≥ 22.5** (Memex uses the built-in `node:sqlite`; on older Node it exits with a clear message).

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

**Permissions** (System Settings → Privacy & Security): grant the `node` binary **Full Disk Access** for Safari history, and **Automation → Notes** for Apple Notes sync. Chromium browsers (Chrome, Brave, Arc, Edge) work without any of this.

**Claude Desktop** — add to `~/Library/Application Support/Claude/claude_desktop_config.json`, then restart Claude Desktop:
```json
{
  "mcpServers": {
    "memex": {
      "command": "node",
      "args": ["/path/to/memex/dist/mcp-standalone.js"]
    }
  }
}
```

> Use `mcp-standalone.js`, not `index.js` — Claude Desktop only needs the query interface. `index.js` is the full capture daemon; running it twice double-captures your clipboard and fights over port 4322. The same config works for Cursor and any MCP client.

**ChatGPT Custom Actions** — import `openapi.json` from the repo into your GPT's action schema, pointing the server URL at your Cloudflare tunnel, with `Authorization: Bearer <your OMNICONTEXT_API_KEY>`.

**Android share sheet** — in [HTTP Shortcuts](https://http-shortcuts.rmy.ch/), create a POST to `https://<your-tunnel>/ingest` with that same bearer header and the shared text as the body, and add it to the share menu. Anything you share from your phone lands in the vault.

---

## Using it

There are no commands to learn. Once the daemon is running, just live your digital life — copy links, take screenshots, download PDFs — then ask your AI about it later, in plain language:

- *"What was that article about attention I read last week?"*
- *"Find the PDF I downloaded about Python interviews"*
- *"What did I copy this morning?"*
- *"Did that Karpathy video cover fine-tuning?"* (YouTube links auto-index their transcripts)
- *"Delete that clipboard entry with my address in it"*

Claude discovers these tools over MCP and calls them on its own: `search_vault`, `get_recent_assets`, `get_asset_by_id`, `delete_asset`, `sync_browser_history`, `sync_notes_now`, `sync_recent_files`. The one habit that makes the vault valuable: when you see something you'll want later, **copy it** — that's the entire filing system.

Verify it's working: `npm test` runs the suite; `tail -f ~/.omnicontext/daemon.log` shows captures as they happen; and asking Claude *"what did I just copy?"* right after copying something is the end-to-end check.

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
