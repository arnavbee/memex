# Memex — Marketing Page Copy

---

## HERO

### Your AI finally knows what you know.

Memex is a private memory engine that runs on your Mac. It quietly remembers what you read, copy, save, and screenshot — and hands that context to any AI you talk to. Claude, ChatGPT, Cursor. No cloud. No subscription. No one else's servers.

**[Get Memex — free & open source]**  `git clone → 60 seconds to first memory`

*Sub-CTA: Works with Claude Desktop, ChatGPT, Cursor, and anything that speaks MCP.*

---

## THE PROBLEM

### Every AI conversation starts with amnesia.

You've read forty articles this month. Saved a dozen PDFs. Copied a hundred links. Screenshotted things you *knew* you'd need later.

Then you ask your AI assistant about any of it and get:

> "I don't have access to that information."

The most personal computing tool ever invented knows nothing about you. And the "memory" features the big labs are shipping? Your life, uploaded to their servers, locked to their product.

There's a better architecture.

---

## THE IDEA

### Remember everything. Share nothing.

Memex is a background daemon that passively indexes your digital activity into a local database — then serves it to every AI you use through open standards.

**Copy a YouTube link** → the transcript is indexed before you've switched tabs.
**Save a PDF** → parsed and searchable on arrival.
**Take a screenshot** → OCR'd locally with Apple's Vision framework.
**Read an article in your browser** → title and link captured within the hour.
**Jot an Apple Note** → synced automatically.
**Share from your phone** → straight into the vault over your own encrypted tunnel.

Then, days later, in any conversation:

> **You:** "What was that article about attention and focus I read last week?"
> **Claude:** "How to Do Great Work" — you read it Tuesday morning. Want the key points?

That's it. That's the product. Your memory, on tap.

---

## HOW IT WORKS

### Three moving parts. All of them yours.

1. **The daemon.** A launchd agent that watches your clipboard, Downloads, Desktop, Apple Notes, and browser history. Starts at login, restarts on crash, sips battery.

2. **The vault.** A single SQLite file in your home directory with full-text search (BM25 — the same ranking algorithm behind serious search engines). No embeddings, no GPU, no API calls. Queries return in milliseconds, fully offline.

3. **The interfaces.** An MCP server for Claude Desktop and Cursor. An authenticated HTTP API for ChatGPT Custom Actions and your phone. One vault, every AI.

```
copy · read · save · screenshot · note
              ↓
       Memex daemon (local)
              ↓
      SQLite + FTS5 (~/.omnicontext)
       ↙                    ↘
   MCP (stdio)          HTTP :4322
   Claude, Cursor       ChatGPT, Android
```

---

## FEATURES

### Built like infrastructure, not an app.

- **Total recall, ranked well.** Full-text search across everything with recency and relevance weighting. Vague queries work: "that tweet about databases" finds the tweet.
- **Rich capture, not just links.** YouTube links become transcripts. Tweets become text. Articles become full archived copies that survive link rot.
- **Live browser memory.** Safari, Chrome, Brave, Arc, Edge — every profile. Ask about a page you opened *seconds ago* and it's there.
- **Self-cleaning.** Duplicate clipboard junk collapses automatically; raw scraps expire after 30 days. Your notes, files, and articles are kept forever.
- **A "forget" button that works.** Tell your AI to forget something and it's deleted from disk. Not soft-deleted. Not retained for training. Gone.
- **Phone to vault in one tap.** Android share sheet → your Cloudflare tunnel → indexed. iPhone via Shortcuts.
- **Open formats, no lock-in.** One SQLite file you can query, back up, or walk away with. MIT licensed. Read every line of code that touches your data.

---

## PRIVACY

### "Private" isn't a setting. It's the architecture.

- **Zero cloud storage.** Your data lives in `~/.omnicontext` on your Mac. Period.
- **Zero third-party calls.** OCR runs on Apple's on-device Vision framework. Search is local SQLite. Nothing phones home — verify it with the network tab.
- **Zero accounts.** No signup, no telemetry, no analytics, no "anonymized usage data."
- **Your AI sees only what it asks for.** Assistants query the vault per-question over MCP; nothing is bulk-uploaded anywhere.
- **Auditable in an afternoon.** ~2,000 lines of TypeScript. Small enough to actually read.

If a company says "trust us with your memory," ask why the architecture requires trust at all.

---

## COMPARISON

### The memory landscape, honestly.

|  | **Memex** | ChatGPT Memory | Claude Memory | Rewind/Limitless |
|---|---|---|---|---|
| Where your data lives | **Your Mac** | Their cloud | Their cloud | Their cloud (or paid local tier) |
| Works across AI vendors | **Yes — any MCP/HTTP client** | ChatGPT only | Claude only | Own app only |
| What it captures | Clipboard, files, screenshots, notes, browser, phone | What you tell it | What you tell it | Screen/audio recording |
| Cost | **Free, open source** | Subscription | Subscription | Subscription |
| Can you read the code? | **Yes** | No | No | No |
| Can you truly delete? | **Yes — it's your disk** | Trust them | Trust them | Trust them |

---

## WHO IT'S FOR

### Built for people who live in their tools.

- **Developers** drowning in docs, repos, and half-read blog posts — who want their AI pair to know what they know.
- **Researchers & writers** who read 50 things to write one thing.
- **Multi-AI users** tired of re-explaining context to Claude that they already gave ChatGPT.
- **The privacy-conscious** who want AI memory without donating their life to a training set.

---

## GETTING STARTED

### Sixty seconds to a smarter AI.

```bash
git clone https://github.com/arnavbee/memex
cd memex && npm install && npm run build
npm run install-daemon
```

Add one block to your Claude Desktop config, restart, and ask:

> "What did I copy today?"

Watch it answer.

**[Star on GitHub]**  **[Read the docs]**  **[See the 20-second demo]**

---

## FAQ

**Does this send my data anywhere?**
No. There is no server to send it to. The optional Cloudflare tunnel exists only so *your own phone and ChatGPT account* can reach *your own Mac*, behind a bearer token you set.

**What about my passwords and sensitive stuff?**
Clipboard capture skips oversized payloads today, and password-manager exclusions are on the roadmap as shipped defaults. Meanwhile: the vault is local, browsable, and anything can be deleted instantly — including by just asking your AI to forget it.

**Will it slow down my Mac?**
It's a Node process that polls your clipboard and watches two folders. You will not notice it.

**Mac only?**
Yes, for now — capture is deeply macOS-native (Vision OCR, AppleScript, launchd). The vault format is portable SQLite.

**Why not embeddings / vector search?**
Personal recall queries are specific ("that PDF about Python interviews"), and BM25 nails those in milliseconds with zero dependencies. If fuzzy semantic recall proves necessary, the architecture leaves room for it — locally.

**Is this affiliated with any AI company?**
No. It's independent and open source. That's rather the point.

---

## CLOSING

### The best AI is the one that knows you.

The labs are racing to own your memory. You could just… keep it.

**[Get Memex]** — free, open source, yours.
