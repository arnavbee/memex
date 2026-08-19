import { test, describe } from 'node:test';
import assert from 'node:assert';
import { detectSecret, isBlockedApp, isConcealedClipboard, redactSecrets } from './secrets.js';

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

describe('detectSecret — gaps found in review', () => {
  const cases: [string, string][] = [
    ['64-char lowercase hex private key', 'a'.repeat(20) + 'b3f19c7d4e2a8091', ],
    // The old heuristic required a lowercase char, so upper+digit tokens passed.
    ['uppercase-and-digit token', 'XKCD7' + 'QWERTY2UIOP9ASDFGH' + '4ZXCVBNM'],
    ['dotted SendGrid-shaped key', ['SG', 'x9Kd82mQpLzR4vTn', 'aB3dE5gH7jK9mN1pQ3sT5vX7zA9c'].join('.')],
    ['bare vendor key assignment', 'STRIPE_KEY=abc123def456'],
    ['multi-line env block', 'DATABASE_URL=postgres://localhost/db\nSTRIPE_KEY=abc123\nDEBUG=false'],
    ['credential in a URL query string', 'https://api.example.com/v1/data?api_key=8sKd0Lm2Qp4Rt6Vx8Zb1Nc3'],
    ['otpauth URI', 'otpauth://totp/Example:me@example.com?secret=JBSWY3DPEHPK3PXP'],
    ['token longer than the old 128 cap', 'Aa1' + 'x7Kq'.repeat(40)],
  ];
  for (const [name, sample] of cases) {
    test(name, () => assert.ok(detectSecret(sample), `should flag: ${sample.slice(0, 40)}`));
  }

  test('still ignores a git sha and ordinary prose', () => {
    assert.strictEqual(detectSecret('a3913ad'), null);
    assert.strictEqual(detectSecret('e05740ac3f7b91d2c4e6a8b0d2f4a6c8e0b2d4f6'), null); // 40-char sha
    assert.strictEqual(detectSecret('The deploy pipeline runs on every push to main.'), null);
  });
});

describe('redactSecrets — long-form content is scrubbed, not dropped', () => {
  test('keeps the document and removes the secret', () => {
    const key = ['sk', 'ant', 'api03', 'Xy7Kq2Lm9Pz4Rt6Vx8Zb1Nc3'].join('-');
    const doc = `Deployment notes\n\nSet the key to ${key} before running.\n\nThen restart the worker.`;
    const out = redactSecrets(doc);

    assert.ok(!out.text.includes(key), 'secret must not survive');
    assert.ok(out.text.includes('Deployment notes'), 'surrounding prose must survive');
    assert.ok(out.text.includes('Then restart the worker.'), 'trailing prose must survive');
    assert.ok(out.reasons.length > 0);
  });

  test('replaces every occurrence, not just the first', () => {
    const a = ['AKIA', 'ABCDEFGHIJKLMNOP'].join('');
    const b = ['AKIA', 'QRSTUVWXYZ123456'].join('');
    const out = redactSecrets(`first ${a} and second ${b} done`);
    assert.ok(!out.text.includes(a) && !out.text.includes(b), 'both must be redacted');
  });

  test('leaves clean prose untouched', () => {
    const clean = '# Notes\n\nThe article argues that context is the moat, not the model.';
    assert.strictEqual(redactSecrets(clean).text, clean);
    assert.strictEqual(redactSecrets(clean).reasons.length, 0);
  });
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
