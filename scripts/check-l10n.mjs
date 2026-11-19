// Fails when a translation is missing, outdated, or drops a placeholder.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => JSON.parse(readFileSync(file, 'utf8'));
const placeholders = (text) => [...new Set(String(text).match(/\{\d+\}/g) ?? [])].sort().join(',');
const problems = [];

function compare(label, source, translated) {
  for (const key of Object.keys(source)) {
    if (!(key in translated)) {
      problems.push(`${label}: missing "${key}"`);
    } else if (placeholders(source[key]) !== placeholders(translated[key])) {
      problems.push(`${label}: placeholders differ in "${key}"`);
    }
  }
  for (const key of Object.keys(translated)) {
    if (!(key in source)) {
      problems.push(`${label}: no longer used "${key}"`);
    }
  }
}

// Strings in the code: extract them afresh, so the check cannot pass on a stale export.
const out = mkdtempSync(join(tmpdir(), 'sweeper-l10n-'));
try {
  const cli = join(root, 'node_modules', '@vscode', 'l10n-dev', 'dist', 'cli.js');
  execFileSync(process.execPath, [cli, 'export', '--outDir', out, join(root, 'src')], { stdio: 'pipe' });
  const exported = read(join(out, 'bundle.l10n.json'));
  const source = Object.fromEntries(Object.keys(exported).map((key) => [key, key]));
  for (const file of readdirSync(join(root, 'l10n')).filter((name) => /^bundle\.l10n\..+\.json$/.test(name))) {
    compare(`l10n/${file}`, source, read(join(root, 'l10n', file)));
  }
} finally {
  rmSync(out, { recursive: true, force: true });
}

// Strings in package.json.
const nls = read(join(root, 'package.nls.json'));
for (const file of readdirSync(root).filter((name) => /^package\.nls\..+\.json$/.test(name))) {
  compare(file, nls, read(join(root, file)));
}
const manifest = readFileSync(join(root, 'package.json'), 'utf8');
for (const [, key] of manifest.matchAll(/"%([^%"]+)%"/g)) {
  if (!(key in nls)) {
    problems.push(`package.json: "%${key}%" has no entry in package.nls.json`);
  }
}
for (const key of Object.keys(nls)) {
  if (!manifest.includes(`%${key}%`)) {
    problems.push(`package.nls.json: "${key}" is not used in package.json`);
  }
}

if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log('Translations are complete.');
