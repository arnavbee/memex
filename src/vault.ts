/**
 * `npm run vault:status` / `npm run vault:purge` — the only way to see what the
 * vault holds and to delete it in bulk. Previously data could only be removed
 * one item at a time through the MCP delete_asset tool, and nothing documented
 * where it lived.
 */
import fs from 'fs';
import path from 'path';
import { Database } from './db.js';

const DATA_DIR = path.join(process.env.HOME || '', '.omnicontext');

function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

function dirSize(dir: string): number {
  let total = 0;
  if (!fs.existsSync(dir)) return 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    total += entry.isDirectory() ? dirSize(full) : fs.statSync(full).size;
  }
  return total;
}

function status(): void {
  console.log(`\nVault location: ${DATA_DIR}\n`);

  if (!fs.existsSync(DATA_DIR)) {
    console.log('No vault yet — nothing has been captured.\n');
    return;
  }

  const db = new Database();
  const { total, byType } = db.stats();
  db.close();

  console.log(`Items: ${total}`);
  for (const [type, n] of Object.entries(byType).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${type.padEnd(12)} ${n}`);
  }

  console.log('\nOn disk:');
  for (const entry of fs.readdirSync(DATA_DIR, { withFileTypes: true })) {
    const full = path.join(DATA_DIR, entry.name);
    const size = entry.isDirectory() ? dirSize(full) : fs.statSync(full).size;
    console.log(`  ${entry.name.padEnd(20)} ${humanBytes(size)}`);
  }
  console.log(`  ${'TOTAL'.padEnd(20)} ${humanBytes(dirSize(DATA_DIR))}\n`);
  console.log('Delete everything:      npm run vault:purge -- --yes');
  console.log('Delete one type:        npm run vault:purge -- --type screenshot --yes\n');
}

function purge(argv: string[]): void {
  const typeIdx = argv.indexOf('--type');
  const type = typeIdx !== -1 ? argv[typeIdx + 1] : undefined;
  const confirmed = argv.includes('--yes');

  if (!confirmed) {
    console.log(`\nThis permanently deletes ${type ? `all "${type}" items` : 'the entire vault'} from ${DATA_DIR}.`);
    console.log('Re-run with --yes to confirm:');
    console.log(`  npm run vault:purge -- ${type ? `--type ${type} ` : ''}--yes\n`);
    process.exit(1);
  }

  const db = new Database();
  const removed = db.purge(type);
  db.checkpoint();
  db.close();
  console.log(`Deleted ${removed} item(s)${type ? ` of type "${type}"` : ''}.`);

  if (!type) {
    const media = path.join(DATA_DIR, 'media');
    if (fs.existsSync(media)) {
      fs.rmSync(media, { recursive: true, force: true });
      console.log('Deleted downloaded media.');
    }
    const legacy = path.join(DATA_DIR, 'db.json.migrated');
    if (fs.existsSync(legacy)) {
      fs.rmSync(legacy, { force: true });
      console.log('Deleted the legacy db.json.migrated backup.');
    }
  }
}

const command = process.argv[2];
if (command === 'status') {
  status();
} else if (command === 'purge') {
  purge(process.argv.slice(3));
} else {
  console.log('Usage:\n  npm run vault:status\n  npm run vault:purge -- [--type <type>] --yes');
  process.exit(1);
}
