/**
 * Heuristics for keeping secrets out of the vault. Passive clipboard capture
 * must never index a password or API key: one leaked credential outweighs a
 * thousand remembered links. Deliberately conservative — false positives cost
 * one lost clipboard entry, false negatives cost trust.
 */

/**
 * High-confidence patterns. These are specific enough to run against long-form
 * documents (OCR'd screenshots, downloaded files, notes) without shredding
 * ordinary prose, so they drive both rejection and redaction.
 */
const SECRET_PATTERNS: { name: string; re: RegExp }[] = [
  { name: 'private key block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/ },
  { name: 'AWS access key', re: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/ },
  { name: 'GitLab token', re: /\bglpat-[A-Za-z0-9_-]{20,}\b/ },
  { name: 'Slack token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: 'Anthropic key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { name: 'OpenAI-style key', re: /\bsk-(proj-)?[A-Za-z0-9_-]{20,}\b/ },
  { name: 'Stripe secret key', re: /\b[sr]k_live_[0-9a-zA-Z]{20,}\b/ },
  { name: 'SendGrid key', re: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/ },
  { name: 'Twilio key', re: /\bSK[0-9a-fA-F]{32}\b/ },
  { name: 'npm token', re: /\bnpm_[A-Za-z0-9]{30,}\b/ },
  { name: 'JWT', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  { name: 'connection string with password', re: /\b\w+:\/\/[^\s:@/]+:[^\s@/]{4,}@[^\s@]+/ },
  { name: 'credential in URL query', re: /[?&](api_?key|access_?token|auth_?token|password|secret)=[^\s&#]{8,}/i },
  { name: 'one-time-password URI', re: /\botpauth:\/\/[^\s]+/i },
  // Broadened from the original: a bare `STRIPE_KEY=…` or `DB_PASS=…` used to
  // slip through because the name had to contain API_KEY/PRIVATE_KEY exactly.
  // The label may sit mid-line ("bank password: …"), so a free-text prefix is
  // allowed; the value must be one 8+ char token containing a digit or symbol,
  // or a 12+ char token, so prose like "reset your password: click here" is
  // left alone.
  {
    name: 'assignment of a credential',
    // No \b around the keyword: \b does not break on "_", so it would fail to
    // find PASSWORD inside DB_PASSWORD.
    re: /^[^\n=:]{0,40}?(PASSWORD|PASSWD|PASSPHRASE|SECRET|TOKEN|API_?KEY|PRIVATE_?KEY|ACCESS_?KEY|[A-Z0-9]+_KEY|CREDENTIALS?|AUTH)[A-Za-z0-9_]*[ \t]*[=:][ \t]*(?=\S{8,})(?:\S*[0-9!@#$%^&*_+=~\/-]\S*|\S{12,})/im,
  },
  // A block of SHOUTY_NAME=value lines is a .env paste. Single lines are left
  // to the rule above so ordinary config docs aren't shredded.
  { name: 'env file block', re: /(^[ \t]*[A-Z][A-Z0-9_]{2,}[ \t]*=[ \t]*\S+[ \t]*$\r?\n?){2,}/m },
  { name: 'recovery codes', re: /\b(recovery|backup)[ \t]+codes?\b[\s\S]{0,40}?\b[a-z0-9]{4,6}[- ][a-z0-9]{4,6}\b/i },
];

/**
 * A single opaque token with the shape of a generated password or key:
 * one line, no spaces, mixed character classes, no URL/prose features.
 */
function looksLikeOpaqueToken(text: string): boolean {
  const t = text.trim();
  // Upper bound raised from 128: long generated keys were skipping the check
  // entirely by being too long to consider.
  if (t.length < 20 || t.length > 512) return false;
  if (/\s/.test(t)) return false;
  if (/^https?:\/\//i.test(t)) return false;
  if (/^[/~.]/.test(t)) return false; // file paths
  if (!/^[A-Za-z0-9+/=_.~!@#$%^&*-]+$/.test(t)) return false;

  // A long hex run is a key, hash, or seed even with no case mixing. Exactly 40
  // or 7-12 hex chars is a git sha, which is not a secret.
  const hex = /^[0-9a-fA-F]+$/.test(t);
  if (hex) {
    if (t.length === 40 || t.length <= 12) return false;
    return t.length >= 32;
  }

  // Domains read as lowercase words separated by dots. Requiring lowercase and
  // an alphabetic final segment keeps this from excusing dotted credentials
  // like SG.xxxx.yyyy, which the old case-insensitive form let through.
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,24}(\/\S*)?$/.test(t)) return false;

  const hasLower = /[a-z]/.test(t);
  const hasUpper = /[A-Z]/.test(t);
  const hasDigit = /\d/.test(t);
  const hasSymbol = /[+/=_.~!@#$%^&*-]/.test(t);
  // Was `hasDigit && hasLower && …`, which excused all-uppercase and
  // digitless generated passwords.
  const classes = [hasLower, hasUpper, hasDigit, hasSymbol].filter(Boolean).length;
  return classes >= 2;
}

/**
 * Returns the reason the text looks secret, or null if it looks safe.
 * For short, atomic content (a clipboard copy, a phone ingest) where dropping
 * the whole item is the right response.
 */
export function detectSecret(text: string): string | null {
  for (const { name, re } of SECRET_PATTERNS) {
    if (re.test(text)) return name;
  }
  if (looksLikeOpaqueToken(text)) return 'opaque token';
  return null;
}

/**
 * Scrubs secrets out of long-form content — OCR'd screenshots, downloaded
 * files, Apple Notes, archived articles.
 *
 * Rejecting the whole document would throw away a 30-page PDF over one stray
 * token, so matches are replaced in place and the rest is kept. Only the named
 * patterns above are used here: the loose opaque-token heuristic is right for a
 * single clipboard copy but would eat hashes, IDs, and base64 out of ordinary
 * documents.
 */
export function redactSecrets(text: string): { text: string; reasons: string[] } {
  if (!text) return { text, reasons: [] };

  // Collect every match first, then splice once. Replacing pattern-by-pattern
  // let a later pattern match inside an earlier "[REDACTED: …]" marker and
  // produce mangled, half-redacted text.
  const ranges: { start: number; end: number; name: string }[] = [];

  for (const { name, re } of SECRET_PATTERNS) {
    // Rebuild with /g so every occurrence is found; the source regexes stay
    // non-global so they remain usable as predicates in detectSecret.
    const flags = re.flags.includes('g') ? re.flags : re.flags + 'g';
    const global = new RegExp(re.source, flags);
    let m: RegExpExecArray | null;
    while ((m = global.exec(text)) !== null) {
      if (m[0].length === 0) { global.lastIndex++; continue; }
      ranges.push({ start: m.index, end: m.index + m[0].length, name });
    }
  }

  if (ranges.length === 0) return { text, reasons: [] };

  // Widest-first at each position, then merge anything that touches.
  ranges.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: typeof ranges = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r.start <= last.end) {
      last.end = Math.max(last.end, r.end);
    } else {
      merged.push({ ...r });
    }
  }

  let out = '';
  let prev = 0;
  const reasons: string[] = [];
  for (const r of merged) {
    out += text.slice(prev, r.start) + `[REDACTED: ${r.name}]`;
    if (!reasons.includes(r.name)) reasons.push(r.name);
    prev = r.end;
  }
  out += text.slice(prev);

  return { text: out, reasons };
}

/**
 * Password managers and secret stores: anything copied while one of these is
 * frontmost is assumed to be a credential.
 */
const BLOCKED_APPS = [
  '1password', 'bitwarden', 'keepass', 'dashlane', 'lastpass', 'keeper',
  'proton pass', 'protonpass', 'enpass', 'nordpass', 'strongbox',
  'keychain access', 'passwords', // macOS Passwords.app / Keychain Access
];

export function isBlockedApp(appName: string): boolean {
  const n = appName.toLowerCase();
  return BLOCKED_APPS.some(b => n.includes(b));
}

/**
 * Well-behaved password managers mark clipboard writes with
 * org.nspasteboard.ConcealedType (see nspasteboard.org). `osascript -e
 * 'clipboard info'` output is checked for those markers.
 */
export function isConcealedClipboard(clipboardInfo: string): boolean {
  return /org\.nspasteboard\.(ConcealedType|AutoGeneratedType)/i.test(clipboardInfo);
}
