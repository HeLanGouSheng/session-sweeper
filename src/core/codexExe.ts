import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { listDir, statOrNull } from './fsx';

export interface FindCodexOptions {
  /** A path configured by the user. When set, nothing else is tried. */
  override?: string;
  /** Install folders of the Codex editor extension known to the caller, tried first. */
  extensionDirs?: string[];
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  home?: string;
}

/** Folders in which editors based on VS Code keep their extensions. */
const EDITOR_FOLDERS = [
  '.vscode',
  '.vscode-insiders',
  '.vscode-server',
  '.vscode-server-insiders',
  '.vscode-oss',
  '.cursor',
  '.cursor-server',
  '.windsurf',
  '.windsurf-server',
];

async function isFile(target: string): Promise<boolean> {
  try {
    // Follows symlinks on purpose: package managers install the CLI as a link.
    return (await fsp.stat(target)).isFile();
  } catch {
    return false;
  }
}

/** The Codex binaries bundled in one extension folder: `bin/<platform>/codex[.exe]`. */
async function bundledIn(extensionDir: string, binary: string): Promise<{ file: string; mtimeMs: number }[]> {
  const found: { file: string; mtimeMs: number }[] = [];
  for (const target of await listDir(path.join(extensionDir, 'bin'))) {
    if (!target.isDirectory()) {
      continue;
    }
    const file = path.join(extensionDir, 'bin', target.name, binary);
    const st = await statOrNull(file);
    if (st?.isFile()) {
      found.push({ file, mtimeMs: st.mtimeMs });
    }
  }
  return found;
}

/**
 * Locates the Codex command-line program: the user's setting, then the copy bundled
 * with the Codex editor extension (newest first), then the desktop app, then PATH.
 */
export async function findCodexExecutable(options: FindCodexOptions = {}): Promise<string | undefined> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const home = options.home ?? os.homedir();
  const binary = platform === 'win32' ? 'codex.exe' : 'codex';

  if (options.override) {
    return (await isFile(options.override)) ? options.override : undefined;
  }

  for (const dir of options.extensionDirs ?? []) {
    const [first] = await bundledIn(dir, binary);
    if (first) {
      return first.file;
    }
  }

  const bundled: { file: string; mtimeMs: number }[] = [];
  for (const editor of EDITOR_FOLDERS) {
    const extensions = path.join(home, editor, 'extensions');
    for (const entry of await listDir(extensions)) {
      if (entry.isDirectory() && entry.name.toLowerCase().startsWith('openai.chatgpt-')) {
        bundled.push(...(await bundledIn(path.join(extensions, entry.name), binary)));
      }
    }
  }
  if (bundled.length) {
    return bundled.sort((a, b) => b.mtimeMs - a.mtimeMs)[0]?.file;
  }

  if (platform === 'win32' && env.LOCALAPPDATA) {
    const appBin = path.join(env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin');
    const versions: { file: string; mtimeMs: number }[] = [];
    for (const entry of await listDir(appBin)) {
      const file = path.join(appBin, entry.name, binary);
      const st = entry.isDirectory() ? await statOrNull(file) : null;
      if (st?.isFile()) {
        versions.push({ file, mtimeMs: st.mtimeMs });
      }
    }
    if (versions.length) {
      return versions.sort((a, b) => b.mtimeMs - a.mtimeMs)[0]?.file;
    }
  }

  const names = platform === 'win32' ? ['codex.exe', 'codex.cmd', 'codex.bat'] : ['codex'];
  const searchPath = env.PATH ?? env.Path ?? '';
  for (const dir of searchPath.split(platform === 'win32' ? ';' : ':')) {
    if (!dir) {
      continue;
    }
    for (const name of names) {
      const file = path.join(dir, name);
      if (await isFile(file)) {
        return file;
      }
    }
  }
  return undefined;
}
