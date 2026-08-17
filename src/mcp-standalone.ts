// Slim entrypoint for MCP clients (Claude Desktop, Cursor): serves the vault
// over stdio only. Capture (watchers, clipboard, history, HTTP ingest) is the
// launchd daemon's job — running both from index.js would double-capture and
// fight over port 4322. WAL mode makes sharing the SQLite file safe.
import dotenv from 'dotenv';
import { Database } from './db.js';
import { startMcpServer } from './mcp.js';

dotenv.config();
startMcpServer(new Database());
