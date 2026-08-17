// Thin launcher: verify the runtime before loading anything that imports
// node:sqlite, so old Node gets a clear message instead of a resolution error.
import { checkNodeVersion } from './preflight.js';

checkNodeVersion();
await import('./daemon.js');
