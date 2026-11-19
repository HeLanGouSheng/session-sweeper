import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { defaultClaudeTempRoots } from '../core/claude';

export type DeleteMode = 'trash' | 'permanent';
export type GroupBy = 'folder' | 'none';
export type SortBy = 'modified' | 'size' | 'title';

export interface Settings {
  deleteMode: DeleteMode;
  groupBy: GroupBy;
  sortBy: SortBy;
  claudeHome: string;
  codexHome: string;
  codexExecutable?: string;
  claudeTempRoots: string[];
}

const SECTION = 'sessionSweeper';

function expandHome(value: string): string {
  const trimmed = value.trim();
  if (trimmed === '~') {
    return os.homedir();
  }
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return path.join(os.homedir(), trimmed.slice(2));
  }
  return trimmed;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

/**
 * Data folders follow the tools' own rules: an explicit setting, then the
 * environment variable the tool itself honours, then the default in the home folder.
 */
export function readSettings(): Settings {
  const config = vscode.workspace.getConfiguration(SECTION);
  const claudeHome = expandHome(config.get<string>('claude.dataDir', '')) || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const codexHome = expandHome(config.get<string>('codex.dataDir', '')) || process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const codexExecutable = expandHome(config.get<string>('codex.executablePath', ''));
  // Only meant for automated tests, which must never look at the real temp folder.
  const tempOverride = process.env.SESSION_SWEEPER_CLAUDE_TEMP;
  const settings: Settings = {
    deleteMode: oneOf(config.get('deleteMode'), ['trash', 'permanent'] as const, 'trash'),
    groupBy: oneOf(config.get('groupBy'), ['folder', 'none'] as const, 'folder'),
    sortBy: oneOf(config.get('sortBy'), ['modified', 'size', 'title'] as const, 'modified'),
    claudeHome: path.resolve(claudeHome),
    codexHome: path.resolve(codexHome),
    claudeTempRoots: tempOverride ? tempOverride.split(path.delimiter).filter(Boolean) : defaultClaudeTempRoots(),
  };
  if (codexExecutable) {
    settings.codexExecutable = codexExecutable;
  }
  return settings;
}

export async function updateSetting(key: 'groupBy' | 'sortBy', value: string): Promise<void> {
  await vscode.workspace.getConfiguration(SECTION).update(key, value, vscode.ConfigurationTarget.Global);
}

export function affectsSettings(event: vscode.ConfigurationChangeEvent): boolean {
  return event.affectsConfiguration(SECTION);
}
