// Runs before anything that touches node:sqlite. Static imports of the app
// would fail at module *resolution* on old Node (ERR_UNKNOWN_BUILTIN_MODULE)
// before any guard code executes, so entrypoints import this file first and
// then dynamic-import the rest.
const REQUIRED = [22, 5] as const;

export function checkNodeVersion() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major > REQUIRED[0] || (major === REQUIRED[0] && minor >= REQUIRED[1])) return;
  console.error(
    `\nMemex requires Node.js >= ${REQUIRED.join('.')} — it uses the built-in node:sqlite module.\n` +
    `You are running Node ${process.versions.node}.\n\n` +
    `Fix:  nvm install 22   (or download from https://nodejs.org)\n`
  );
  process.exit(1);
}
