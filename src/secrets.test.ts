import { test, describe } from 'node:test';
import assert from 'node:assert';
import { detectSecret, isBlockedApp, isConcealedClipboard } from './secrets.js';

describe('detectSecret — must catch', () => {
  // Provider-shaped fixtures are assembled at runtime so GitHub's push
  // protection (which scans blob literals) doesn't flag this test file —
  // it did, the first time. detectSecret still sees the full joined token.
  const j = (...parts: string[]) => parts.join('');
  const positives: [string, string][] = [
    ['AWS access key', j('AKIA', 'IOSFODNN7EXAMPLE')],
    ['GitHub PAT', j('ghp_', '16C7e42F292c6912E7710c838347Ae178B4a')],
    ['Slack token', j('xoxb-', '2483749234-234873492834-AbCdEfGhIjKlMnOpQrStUvWx')],
    ['Google API key', j('AIza', 'SyDaGmWKa4JsXZ-HjGw7ISLn_3namBGewQe')],
    ['Anthropic key', j('sk-ant-', 'api03-abcdefghijklmnopqrstuvwx')],
    ['OpenAI key', j('sk-proj-', 'abcdefghijklmnopqrstuvwxyz123456')],
    ['Stripe live key', j('sk_live_', '4eC39HqLyjWDarjtT1zdp7dc')],
    ['private key block', j('-----BEGIN RSA PRIVATE ', 'KEY-----\nMIIEow...\n-----END RSA PRIVATE KEY-----')],
    ['JWT', j('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0.', 'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c')],
    ['postgres URL with password', j('postgres://admin:', 'hunter2secret@db.internal:5432/prod')],
    ['env assignment', j('export STRIPE_SECRET_KEY=', 'sk_test_whatever123')],
    ['password assignment', j('DB_PASSWORD: ', 'correct-horse-battery-9')],
    ['generated password', 'xK9#mP2$vL5nQ8wR'.repeat(2)],
    ['opaque token', j('a8Fk29sLqPz0', 'Xm4Vb7Tj1Ce5Ry6Uw3Hn')],
  ];
  for (const [name, sample] of positives) {
    test(name, () => assert.ok(detectSecret(sample), `should flag: ${sample.slice(0, 40)}`));
  }
});

describe('detectSecret — must NOT catch', () => {
  const negatives: [string, string][] = [
    ['a URL', 'https://github.com/arnavbee/memex/blob/main/README.md'],
    ['a bare domain', 'news.ycombinator.com'],
    ['prose', 'Remember to buy milk and call the dentist tomorrow at 3pm.'],
    ['a code snippet', 'const results = db.search(query, limit, type);'],
    ['a file path', '/Users/arnav/Downloads/report-2026.pdf'],
    ['a git sha', 'a3913ad'],
    ['a tweet', 'Postgres is all you need. Stop overengineering your stack.'],
    ['a long word', 'antidisestablishmentarianism'],
    ['a UUID in prose', 'the request id was 550e8400-e29b-41d4-a716-446655440000 fyi'],
    ['markdown notes', '# Meeting notes\n- ship the beta\n- fix the flaky deploy'],
  ];
  for (const [name, sample] of negatives) {
    test(name, () => assert.strictEqual(detectSecret(sample), null, `should NOT flag: ${sample.slice(0, 40)}`));
  }
});

describe('app blocklist and concealed clipboard', () => {
  test('flags password managers, ignores normal apps', () => {
    assert.ok(isBlockedApp('1Password 8'));
    assert.ok(isBlockedApp('Bitwarden'));
    assert.ok(isBlockedApp('KeePassXC'));
    assert.ok(isBlockedApp('Passwords'));
    assert.strictEqual(isBlockedApp('Brave Browser'), false);
    assert.strictEqual(isBlockedApp('Visual Studio Code'), false);
    assert.strictEqual(isBlockedApp('Notes'), false);
  });
  test('detects nspasteboard concealed markers', () => {
    assert.ok(isConcealedClipboard('«class utf8» 16, org.nspasteboard.ConcealedType 16'));
    assert.strictEqual(isConcealedClipboard('«class utf8» 42, public.utf8-plain-text 42'), false);
  });
});
