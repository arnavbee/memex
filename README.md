# Memex
**A local-first, privacy-first personal context engine for LLMs.**

*TypeScript · Swift · MCP · OpenAPI 3.1.0 · Cloudflare Tunnel*

---

Most AI assistants don't know anything about you. Every new conversation starts from zero — they don't know what you've been reading, what links you've saved, what notes you've written, or what files you've downloaded.

Memex fixes that. It's a background daemon that runs on your Mac and passively indexes your digital activity into a local database. That database is then made available to any LLM — Claude on your desktop, ChatGPT on your phone — through standard interfaces. No cloud storage, no accounts, no telemetry. Your vault never leaves your machine unless you deliberately expose it, and the section below spells out exactly what that means.

---

## What leaves your machine

You are about to run a daemon that watches your clipboard, screen, downloads, notes and browser
history. You should not have to take "it's local-first" on faith, so here is the precise answer.

**Your vault never leaves.** It is a SQLite file at `~/.omnicontext`. Nothing uploads it, syncs it,
or backs it up. There are no accounts, no analytics, no telemetry, and no crash reporting: grep the
source for `posthog`, `sentry`, `segment`, `analytics` and you will find nothing, because there is
nothing there. The only runtime dependencies are an MCP SDK, a readability parser, jsdom, chokidar
and dotenv.

**Memex does make outbound requests, and you should know when.** They send the URL you copied, not
your vault:

- Copy any link and it fetches that page to archive a readable copy of it
- Copy a YouTube link and it calls YouTube's player API and caption endpoint for the transcript
- Copy an x.com link and it fetches the post and its media
- On first startup it scans your last 500 clipboard items and archives any links it has not seen yet

The practical consequence: the sites you copy links to will see a request from your IP shortly after
you copy. If that is not acceptable for a given link, do not copy it while the daemon is running.

**The HTTP API is off by default.** The daemon only starts it if you set `OMNICONTEXT_API_KEY`
yourself; with no key it refuses to listen and tells you so. When it does run it binds `127.0.0.1`
only, requires a bearer token compared in constant time, throttles failed auth, and rejects
unexpected `Host` headers to blunt DNS rebinding. It is reachable from the internet only if you
personally run `cloudflared`. That is a deliberate, opt-in act, never a default.

**The MCP server is a local stdio process.** Your LLM client spawns it directly. It opens no port.

**What is never captured:** private and incognito browsing, because browsers do not write those
sessions to the history database Memex reads; clipboard copied while a password manager is
frontmost; and anything marked `org.nspasteboard.ConcealedType`. Credentials are additionally
filtered at a single choke point, with honest limits documented under Secret filtering below.

**How to verify any of this yourself:** `memex status` shows exactly what is in the vault,
`memex purge --yes` empties it, `brew services stop memex` halts all capture, and
`lsof -iTCP -sTCP:LISTEN -P | grep memex` shows whether anything is listening at all.

---

## What it captures

- **Screenshots** — OCR'd locally using Apple's Vision framework (Swift)
- **Clipboard** — monitored continuously; YouTube URLs auto-fetch transcripts, Twitter links scrape post content
- **Downloads** — PDFs, markdown files, CSVs parsed and indexed on arrival
- **Apple Notes** — synced periodically via AppleScript
- **Browser history** — Safari, Chrome, Arc, Brave, and Edge visits (all profiles), synced every 30 minutes with search/auth/localhost noise filtered out
- **Links from your phone** — shared directly from Android via HTTP Shortcuts → POST to local API

### Secret filtering

Every capture path writes through a single choke point in `db.addAsset`, so the same filter applies to clipboard, screenshots, downloads, notes, history, and archived articles alike.

- **Clipboard and phone ingest** are *rejected outright* when they look like a credential. On top of the content filter, copies made while a password manager is frontmost are skipped, as is anything marked `org.nspasteboard.ConcealedType`.
- **Long-form content** (OCR'd screenshots, downloaded files, notes, articles) is *redacted in place* — the matched span becomes `[REDACTED: <reason>]` and the rest of the document is kept, since dropping a whole PDF over one stray token would be worse.

Detected: AWS/Google/Stripe/SendGrid/Twilio/npm keys, GitHub/GitLab/Slack tokens, OpenAI and Anthropic keys, JWTs, private key blocks, connection strings with passwords, credentials in URL query strings, `otpauth://` URIs, `PASSWORD=`/`*_KEY=` assignments, `.env`-shaped blocks, and generated-password-shaped strings.

**Known limits — worth reading before you trust it.** These are heuristics, not a guarantee:
- A screenshot of a credential *rendered as an image* is OCR'd to text and only then filtered, so anything the patterns don't recognise (a handwritten note, a QR code, an unusual key format) survives.
- Password-manager app detection samples the frontmost app on a 1.5s poll, so it can miss; browser-extension password managers report the browser and are not blocked at all. The content filter is the layer that actually catches most of these.
- Purely alphabetic passphrases with no digits or symbols are not detected.

If you handle secrets you cannot afford to have indexed, exclude those apps or run without screenshot capture.

### Retention

Clipboard: duplicates collapsed, entries expire after 30 days (`OMNICONTEXT_CLIPBOARD_MAX_AGE_DAYS` / `OMNICONTEXT_CLIPBOARD_MAX_COUNT`). Browser history: 90 days (`OMNICONTEXT_HISTORY_MAX_AGE_DAYS`). Notes, downloads, screenshots, and archived articles are kept indefinitely — remembering them is the point — so the vault grows over time. Check it with `npm run vault:status` and clear it with `npm run vault:purge`.

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

**Requirements:**
- macOS — capture is macOS-native (Vision OCR, AppleScript, launchd)
- **Node.js ≥ 22.5** — Memex uses the built-in `node:sqlite`; on older Node it exits with a clear message
- **Xcode Command Line Tools** (`xcode-select --install`) — the screenshot and PDF readers are Swift scripts compiled on demand. Without them, screenshots are still captured but store no text.
- `cloudflared` (`brew install cloudflared`) — only if you want phone/ChatGPT access

```bash
git clone https://github.com/arnavbee/memex
cd memex
npm install && npm run build

# Configure your API key — required for the HTTP API/tunnel.
cp .env.example .env
openssl rand -hex 32     # paste the result as OMNICONTEXT_API_KEY in .env
```

The HTTP server refuses to start on a placeholder or short key, and listens on **127.0.0.1 only** — it is never exposed to your local network. Reaching it from your phone requires the tunnel below.

Then run it **either** in the foreground **or** as an agent — not both, they fight over port 4322:

```bash
npm start                 # foreground, ctrl-C to stop

# ...or install as a launchd agent: starts at login, restarts on crash
npm run install-daemon    # logs land in ~/.omnicontext/daemon.log
npm run uninstall-daemon  # stop + remove (vault untouched)

# Expose to mobile (optional)
cloudflared tunnel --url localhost:4322
```

**Permissions** (System Settings → Privacy & Security):
- **Full Disk Access** for the `node` binary — Safari history, and reading files under `~/Desktop` / `~/Downloads`
- **Automation → Notes** — Apple Notes sync
- Chromium browsers (Chrome, Brave, Arc, Edge) need neither

Under launchd these prompts may not appear, and a denial shows up only as an error in `daemon.log` — if screenshots or notes aren't being captured, check there first. Note that Full Disk Access is granted to a specific `node` binary, so upgrading Node (or switching nvm versions) means granting it again.

**Your data** lives in `~/.omnicontext/` (mode `0700`): `db.sqlite` plus a `media/` folder. Inspect it with `npm run vault:status`, delete it with `npm run vault:purge -- --yes`, or delete a single type with `npm run vault:purge -- --type screenshot --yes`. Uninstalling the daemon deliberately leaves the vault in place.

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
