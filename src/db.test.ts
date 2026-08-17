import { test, describe } from 'node:test';
import assert from 'node:assert';
import { Database, Asset } from './db.js';

function makeAsset(overrides: Partial<Asset> & { id: string }): Asset {
  return {
    type: 'note',
    content: 'placeholder',
    metadata: { createdAt: new Date().toISOString() },
    ...overrides,
  } as Asset;
}

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
}

describe('Database.search', () => {
  test('finds documents by keyword and ranks the relevant one first', () => {
    const db = new Database(':memory:');
    db.addAsset(makeAsset({ id: 'a', content: 'Booking a flight to Tokyo with JAL', metadata: { title: 'Travel', createdAt: daysAgo(1) } }));
    db.addAsset(makeAsset({ id: 'b', content: 'Grocery list: milk, eggs, bread', metadata: { createdAt: daysAgo(1) } }));

    const results = db.search('flight tokyo');
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].asset.id, 'a');
  });

  test('prefix-matches query tokens (flights finds flight)', () => {
    const db = new Database(':memory:');
    db.addAsset(makeAsset({ id: 'a', content: 'my flight leaves at noon', metadata: { createdAt: daysAgo(0) } }));
    const results = db.search('flight');
    assert.strictEqual(results.length, 1);
  });

  test('title matches outrank content-only matches', () => {
    const db = new Database(':memory:');
    db.addAsset(makeAsset({ id: 'content-hit', content: 'a passing mention of recipes among many other words in a longer document about cooking generally', metadata: { createdAt: daysAgo(5) } }));
    db.addAsset(makeAsset({ id: 'title-hit', content: 'short body', metadata: { title: 'Recipes collection', createdAt: daysAgo(5) } }));

    const results = db.search('recipes');
    assert.strictEqual(results[0].asset.id, 'title-hit');
  });

  test('matches against source URL', () => {
    const db = new Database(':memory:');
    db.addAsset(makeAsset({ id: 'u', type: 'download', content: 'Release notes body text', metadata: { createdAt: daysAgo(2), sourceUrl: 'https://react.dev/blog/react-19' } }));
    const results = db.search('react');
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].asset.id, 'u');
  });

  test('newer equally-relevant document ranks higher (recency boost)', () => {
    const db = new Database(':memory:');
    db.addAsset(makeAsset({ id: 'old', content: 'meeting notes about the quarterly budget', metadata: { createdAt: daysAgo(60) } }));
    db.addAsset(makeAsset({ id: 'new', content: 'meeting notes about the quarterly budget', metadata: { createdAt: daysAgo(0) } }));

    const results = db.search('quarterly budget');
    assert.strictEqual(results[0].asset.id, 'new');
  });

  test('recency alone cannot make a non-match outrank a match', () => {
    const db = new Database(':memory:');
    db.addAsset(makeAsset({ id: 'relevant-old', content: 'glassmorphism css tutorial with backdrop-filter', metadata: { createdAt: daysAgo(90) } }));
    db.addAsset(makeAsset({ id: 'fresh-junk', type: 'clipboard', content: 'totally unrelated text pasted just now', metadata: { createdAt: daysAgo(0) } }));

    const results = db.search('glassmorphism');
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].asset.id, 'relevant-old');
  });

  test('filters by type', () => {
    const db = new Database(':memory:');
    db.addAsset(makeAsset({ id: 'n', type: 'note', content: 'docker compose configuration', metadata: { createdAt: daysAgo(1) } }));
    db.addAsset(makeAsset({ id: 'c', type: 'clipboard', content: 'docker compose up -d', metadata: { createdAt: daysAgo(1) } }));

    const results = db.search('docker', 5, 'note');
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].asset.id, 'n');
  });

  test('drops clipboard entries that merely reflect the query back', () => {
    const db = new Database(':memory:');
    db.addAsset(makeAsset({ id: 'echo', type: 'clipboard', content: 'show me the flight details', metadata: { createdAt: daysAgo(0) } }));
    db.addAsset(makeAsset({ id: 'real', type: 'download', content: 'Flight details: AA100 departs JFK 9am', metadata: { createdAt: daysAgo(1) } }));

    const results = db.search('show me the flight details');
    assert.ok(results.every(r => r.asset.id !== 'echo'));
    assert.ok(results.some(r => r.asset.id === 'real'));
  });

  test('FTS operators in queries are neutralized, not executed', () => {
    const db = new Database(':memory:');
    db.addAsset(makeAsset({ id: 'a', content: 'ordinary note about cats', metadata: { createdAt: daysAgo(1) } }));
    assert.doesNotThrow(() => db.search('cats AND (dogs OR "unclosed'));
    assert.doesNotThrow(() => db.search('NEAR(a b) NOT c*'));
  });

  test('empty and stopword-only queries return nothing', () => {
    const db = new Database(':memory:');
    db.addAsset(makeAsset({ id: 'a', content: 'anything at all', metadata: { createdAt: daysAgo(1) } }));
    assert.deepStrictEqual(db.search(''), []);
    assert.deepStrictEqual(db.search('a'), []);
  });
});

describe('Database CRUD and maintenance', () => {
  test('addAsset upserts by filePath', () => {
    const db = new Database(':memory:');
    db.addAsset(makeAsset({ id: 'v1', type: 'screenshot', filePath: '/tmp/shot.png', content: 'first ocr pass', metadata: { createdAt: daysAgo(1) } }));
    db.addAsset(makeAsset({ id: 'v2', type: 'screenshot', filePath: '/tmp/shot.png', content: 'better ocr pass', metadata: { createdAt: daysAgo(0) } }));

    assert.strictEqual(db.count(), 1);
    assert.strictEqual(db.getById('v2')?.content, 'better ocr pass');
    assert.strictEqual(db.getById('v1'), null);
  });

  test('getById returns full asset, deleteAsset removes it', () => {
    const db = new Database(':memory:');
    db.addAsset(makeAsset({ id: 'x', content: 'hello', summary: 'sum', metadata: { title: 'T', createdAt: daysAgo(1) } }));

    const asset = db.getById('x');
    assert.strictEqual(asset?.summary, 'sum');
    assert.strictEqual(asset?.metadata.title, 'T');

    assert.strictEqual(db.deleteAsset('x'), true);
    assert.strictEqual(db.deleteAsset('x'), false);
    assert.strictEqual(db.getById('x'), null);
    // FTS index must not resurrect deleted docs
    assert.deepStrictEqual(db.search('hello'), []);
  });

  test('pruneClipboard removes duplicates and stale items but never rich assets', () => {
    const db = new Database(':memory:');
    db.addAsset(makeAsset({ id: 'dup1', type: 'clipboard', content: 'same', metadata: { createdAt: daysAgo(2) } }));
    db.addAsset(makeAsset({ id: 'dup2', type: 'clipboard', content: 'same', metadata: { createdAt: daysAgo(1) } }));
    db.addAsset(makeAsset({ id: 'stale', type: 'clipboard', content: 'old junk', metadata: { createdAt: daysAgo(90) } }));
    db.addAsset(makeAsset({ id: 'note', type: 'note', content: 'old but precious', metadata: { createdAt: daysAgo(400) } }));

    const removed = db.pruneClipboard(30, 2000);
    assert.strictEqual(removed, 2);
    assert.strictEqual(db.getById('dup2')?.id, 'dup2');
    assert.strictEqual(db.getById('dup1'), null);
    assert.strictEqual(db.getById('stale'), null);
    assert.strictEqual(db.getById('note')?.id, 'note');
  });

  test('pruneClipboard enforces max count keeping newest', () => {
    const db = new Database(':memory:');
    for (let i = 0; i < 10; i++) {
      db.addAsset(makeAsset({ id: `c${i}`, type: 'clipboard', content: `item ${i}`, metadata: { createdAt: daysAgo(10 - i) } }));
    }
    db.pruneClipboard(365, 3);
    const remaining = db.getRecent(20, 'clipboard').map(a => a.id).sort();
    assert.deepStrictEqual(remaining, ['c7', 'c8', 'c9']);
  });

  test('touchAssetByUrl refreshes createdAt of downloads', () => {
    const db = new Database(':memory:');
    db.addAsset(makeAsset({ id: 'd', type: 'download', content: 'article', metadata: { createdAt: daysAgo(30), sourceUrl: 'https://example.com/a' } }));
    assert.strictEqual(db.touchAssetByUrl('https://example.com/a'), true);
    assert.strictEqual(db.touchAssetByUrl('https://example.com/missing'), false);

    const asset = db.getById('d');
    const age = Date.now() - new Date(asset!.metadata.createdAt).getTime();
    assert.ok(age < 60_000, 'createdAt should be refreshed to now');
  });

  test('getRecent sorts newest first and respects type filter', () => {
    const db = new Database(':memory:');
    db.addAsset(makeAsset({ id: 'old', content: 'x', metadata: { createdAt: daysAgo(5) } }));
    db.addAsset(makeAsset({ id: 'new', content: 'y', metadata: { createdAt: daysAgo(1) } }));
    db.addAsset(makeAsset({ id: 'clip', type: 'clipboard', content: 'z', metadata: { createdAt: daysAgo(0) } }));

    assert.deepStrictEqual(db.getRecent(10).map(a => a.id), ['clip', 'new', 'old']);
    assert.deepStrictEqual(db.getRecent(10, 'note').map(a => a.id), ['new', 'old']);
  });
});
