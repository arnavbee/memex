import dotenv from 'dotenv';
import os from 'os';
import path from 'path';

/**
 * Where a Homebrew install keeps its configuration.
 *
 * The git-clone flow puts `.env` next to the source, which `dotenv.config()`
 * finds via the working directory. Homebrew users have no such directory: the
 * launchd service runs with its working directory inside `libexec`, and
 * `brew upgrade` replaces that tree wholesale, so anything written there is
 * silently destroyed on the next upgrade. Config therefore lives beside the
 * vault, which is the one directory that belongs to the user and survives.
 */
export const USER_ENV_PATH = path.join(os.homedir(), '.omnicontext', '.env');

/**
 * Load configuration from both locations.
 *
 * dotenv never overwrites a variable that is already set, so precedence runs:
 * real environment variables, then a repo-local `.env`, then the user file.
 * That keeps the development flow behaving exactly as it did before.
 */
export function loadEnv(): void {
  dotenv.config();
  dotenv.config({ path: USER_ENV_PATH });
}
