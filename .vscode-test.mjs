import { defineConfig } from '@vscode/test-cli';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Everything the tests create lives in this folder. The extension is pointed at it through the
// same environment variables Claude Code and Codex honour, so real conversations are never seen.
const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'sweeper-it-')));

export default defineConfig({
  files: 'out/test/integration/**/*.test.js',
  launchArgs: ['--disable-extensions'],
  env: {
    SESSION_SWEEPER_TEST_ROOT: root,
    CLAUDE_CONFIG_DIR: join(root, 'claude'),
    CODEX_HOME: join(root, 'codex'),
    SESSION_SWEEPER_CLAUDE_TEMP: join(root, 'temp', 'claude'),
  },
  mocha: { ui: 'tdd', timeout: 60_000 },
});
