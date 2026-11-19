import * as vscode from 'vscode';
import { formatBytes, relativeTime } from '../core/format';
import type { BusyReason, LeftoverGroup, LeftoverKind, ProviderId, SessionInfo } from '../core/types';
import type { Controller } from './controller';
import type { SortBy } from './settings';

export type Node =
  | { kind: 'provider'; provider: ProviderId }
  | { kind: 'group'; provider: ProviderId; key: string; sessions: SessionInfo[] }
  | { kind: 'session'; session: SessionInfo }
  | { kind: 'leftovers' }
  | { kind: 'leftover'; group: LeftoverGroup };

export const PROVIDER_NAMES: Record<ProviderId, string> = { claude: 'Claude Code', codex: 'Codex' };

export function conversationCount(count: number): string {
  return count === 1 ? vscode.l10n.t('1 conversation') : vscode.l10n.t('{0} conversations', count);
}

export function busyText(provider: ProviderId, reason: BusyReason): string {
  if (reason === 'recent') {
    return vscode.l10n.t('This conversation was written to a moment ago. Wait until it is idle, then refresh.');
  }
  if (provider === 'codex') {
    return vscode.l10n.t(
      'Codex still has this conversation loaded. Closing its tab is not enough: close every editor window that runs Codex, then delete the conversation before opening it in Codex again.',
    );
  }
  return vscode.l10n.t('This conversation is open in a running Claude Code session. Close its tab or terminal, then refresh.');
}

export function leftoverLabel(kind: LeftoverKind): string {
  switch (kind) {
    case 'claude.emptyTemp':
      return vscode.l10n.t('Empty temp folders');
    case 'claude.orphanTemp':
      return vscode.l10n.t('Temp files of deleted conversations');
    case 'claude.orphanData':
      return vscode.l10n.t('Data of deleted conversations');
    case 'codex.orphanThreads':
      return vscode.l10n.t('Codex helper threads of deleted conversations');
  }
}

function leftoverTooltip(kind: LeftoverKind): string {
  switch (kind) {
    case 'claude.emptyTemp':
      return vscode.l10n.t(
        'Temp folders of conversations that no longer exist, with no files inside. System cleanup tools delete the files but leave these folders.',
      );
    case 'claude.orphanTemp':
      return vscode.l10n.t('Scripts, command output and pasted images that Claude Code kept in the temp folder for conversations that no longer exist.');
    case 'claude.orphanData':
      return vscode.l10n.t('File snapshots, environment and telemetry data in the Claude Code data folder whose conversation no longer exists.');
    case 'codex.orphanThreads':
      return vscode.l10n.t('Review and sub-agent threads whose conversation was deleted. They still contain copies of what was said in it.');
  }
}

export function leftoverDescription(group: LeftoverGroup): string {
  const size = formatBytes(group.totalBytes);
  switch (group.kind) {
    case 'claude.emptyTemp':
      return String(group.items.length);
    case 'claude.orphanTemp':
      return vscode.l10n.t('{0} folders · {1}', group.items.length, size);
    case 'claude.orphanData':
      return vscode.l10n.t('{0} items · {1}', group.items.length, size);
    case 'codex.orphanThreads':
      return vscode.l10n.t('{0} threads · {1}', group.threadIds?.length ?? group.items.length, size);
  }
}

/** Last path segment, for paths written with either kind of slash. */
export function folderName(folder: string): string {
  const parts = folder.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? folder;
}

function sortSessions(sessions: SessionInfo[], sortBy: SortBy): SessionInfo[] {
  const sorted = [...sessions];
  if (sortBy === 'size') {
    sorted.sort((a, b) => b.sizeBytes - a.sizeBytes);
  } else if (sortBy === 'title') {
    sorted.sort((a, b) => a.title.localeCompare(b.title, vscode.env.language) || b.modifiedAt - a.modifiedAt);
  } else {
    sorted.sort((a, b) => b.modifiedAt - a.modifiedAt);
  }
  return sorted;
}

export class SessionTree implements vscode.TreeDataProvider<Node> {
  private readonly changed = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly subscription: vscode.Disposable;

  constructor(private readonly controller: Controller) {
    this.subscription = controller.onDidChange(() => this.changed.fire(undefined));
  }

  dispose(): void {
    this.subscription.dispose();
    this.changed.dispose();
  }

  /** Redraws without reloading, e.g. after the grouping or sorting setting changed. */
  redraw(): void {
    this.changed.fire(undefined);
  }

  getChildren(node?: Node): Node[] {
    const state = this.controller.state;
    const settings = this.controller.settings;
    if (!node) {
      if (!state.loaded) {
        return [];
      }
      const roots: Node[] = [];
      for (const provider of ['claude', 'codex'] as const) {
        if (state[provider].available && (!state.filter || this.controller.visible(provider).length > 0)) {
          roots.push({ kind: 'provider', provider });
        }
      }
      if (state.leftovers.length > 0 && !state.filter) {
        roots.push({ kind: 'leftovers' });
      }
      return roots;
    }
    switch (node.kind) {
      case 'provider': {
        const sessions = sortSessions(this.controller.visible(node.provider), settings.sortBy);
        if (settings.groupBy === 'none') {
          return sessions.map((session) => ({ kind: 'session', session }));
        }
        const groups = new Map<string, SessionInfo[]>();
        for (const session of sessions) {
          const list = groups.get(session.groupKey);
          if (list) {
            list.push(session);
          } else {
            groups.set(session.groupKey, [session]);
          }
        }
        // Folders in the order of their most recently used conversation.
        return [...groups.entries()]
          .map(([key, list]): Node => ({ kind: 'group', provider: node.provider, key, sessions: list }))
          .sort((a, b) => newest(b) - newest(a));
      }
      case 'group':
        return node.sessions.map((session) => ({ kind: 'session', session }));
      case 'leftovers':
        return state.leftovers.map((group) => ({ kind: 'leftover', group }));
      default:
        return [];
    }
  }

  getTreeItem(node: Node): vscode.TreeItem {
    switch (node.kind) {
      case 'provider':
        return this.providerItem(node.provider);
      case 'group':
        return this.groupItem(node);
      case 'session':
        return this.sessionItem(node.session);
      case 'leftovers':
        return this.leftoversItem();
      case 'leftover':
        return this.leftoverItem(node.group);
    }
  }

  private providerItem(provider: ProviderId): vscode.TreeItem {
    const all = this.controller.state[provider].sessions;
    const shown = this.controller.visible(provider);
    const item = new vscode.TreeItem(PROVIDER_NAMES[provider], vscode.TreeItemCollapsibleState.Expanded);
    item.id = `provider:${provider}`;
    item.contextValue = 'provider';
    item.iconPath = new vscode.ThemeIcon(provider === 'claude' ? 'sparkle' : 'terminal');
    const size = formatBytes(shown.reduce((sum, session) => sum + session.sizeBytes, 0));
    item.description = this.controller.state.filter
      ? vscode.l10n.t('{0} of {1} · {2}', shown.length, all.length, size)
      : `${conversationCount(all.length)} · ${size}`;
    item.tooltip = provider === 'claude' ? this.controller.settings.claudeHome : this.controller.settings.codexHome;
    return item;
  }

  private groupItem(node: Extract<Node, { kind: 'group' }>): vscode.TreeItem {
    const folder = node.sessions.find((session) => session.cwd)?.cwd;
    const label = folder ? folderName(folder) : node.key || vscode.l10n.t('(no folder)');
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Expanded);
    item.id = `group:${node.provider}:${node.key}`;
    item.contextValue = 'group';
    item.iconPath = vscode.ThemeIcon.Folder;
    item.description = folder ? `${node.sessions.length} · ${folder}` : String(node.sessions.length);
    item.tooltip = folder ?? node.key;
    return item;
  }

  private sessionItem(session: SessionInfo): vscode.TreeItem {
    const item = new vscode.TreeItem(session.title || vscode.l10n.t('(untitled)'), vscode.TreeItemCollapsibleState.None);
    item.id = `session:${session.provider}:${session.key}`;
    item.contextValue = `session.${session.provider}.${session.busy ? 'busy' : 'idle'}`;
    item.iconPath = session.busy
      ? new vscode.ThemeIcon('lock', new vscode.ThemeColor('list.warningForeground'))
      : new vscode.ThemeIcon(session.provider === 'claude' ? 'comment-discussion' : 'comment');
    // While the data folder is still being measured, the size shown is a lower bound.
    const parts = [relativeTime(session.modifiedAt, Date.now(), vscode.env.language), `${formatBytes(session.sizeBytes)}${session.sizePending ? '+' : ''}`];
    if (this.controller.settings.groupBy === 'none' && session.cwd) {
      parts.push(folderName(session.cwd));
    }
    if (session.helperCount) {
      parts.push(vscode.l10n.t('+{0} helper threads', session.helperCount));
    }
    if (session.archived) {
      parts.push(vscode.l10n.t('archived'));
    }
    if (session.busy) {
      parts.push(vscode.l10n.t('in use'));
    }
    item.description = parts.join(' · ');
    item.tooltip = this.sessionTooltip(session);
    return item;
  }

  private sessionTooltip(session: SessionInfo): vscode.MarkdownString {
    const tooltip = new vscode.MarkdownString();
    const line = (text: string): void => {
      tooltip.appendText(text);
      tooltip.appendMarkdown('  \n');
    };
    tooltip.appendMarkdown('**');
    tooltip.appendText(session.title || vscode.l10n.t('(untitled)'));
    tooltip.appendMarkdown('**\n\n');
    line(`${PROVIDER_NAMES[session.provider]}`);
    if (session.cwd) {
      line(vscode.l10n.t('Folder: {0}', session.cwd));
    }
    line(vscode.l10n.t('Last used: {0}', new Date(session.modifiedAt).toLocaleString(vscode.env.language)));
    if (session.createdAt !== undefined) {
      line(vscode.l10n.t('Created: {0}', new Date(session.createdAt).toLocaleString(vscode.env.language)));
    }
    line(vscode.l10n.t('Size: {0}', formatBytes(session.sizeBytes)));
    line(vscode.l10n.t('ID: {0}', session.id));
    if (session.helperCount) {
      line(vscode.l10n.t('Helper threads: {0} (review and sub-agent threads Codex created for this conversation)', session.helperCount));
    }
    if (session.otherCopies) {
      line(
        vscode.l10n.t(
          'Also stored in {0} other project folder(s). Data shared between the copies is removed together with the last copy.',
          session.otherCopies,
        ),
      );
    }
    if (session.busy) {
      tooltip.appendMarkdown('\n');
      tooltip.appendText(busyText(session.provider, session.busy));
    }
    return tooltip;
  }

  private leftoversItem(): vscode.TreeItem {
    const groups = this.controller.state.leftovers;
    const item = new vscode.TreeItem(vscode.l10n.t('Leftovers'), vscode.TreeItemCollapsibleState.Expanded);
    item.id = 'leftovers';
    item.contextValue = 'leftovers';
    item.iconPath = new vscode.ThemeIcon('archive');
    const count = groups.reduce((sum, group) => sum + (group.threadIds?.length ?? group.items.length), 0);
    item.description = vscode.l10n.t('{0} items · {1}', count, formatBytes(groups.reduce((sum, group) => sum + group.totalBytes, 0)));
    item.tooltip = vscode.l10n.t('Things left behind by conversations that no longer exist. Nothing here belongs to a conversation listed above.');
    return item;
  }

  private leftoverItem(group: LeftoverGroup): vscode.TreeItem {
    const item = new vscode.TreeItem(leftoverLabel(group.kind), vscode.TreeItemCollapsibleState.None);
    item.id = `leftover:${group.kind}`;
    item.contextValue = `leftover.${group.kind}`;
    item.iconPath = new vscode.ThemeIcon(group.kind === 'claude.emptyTemp' ? 'folder' : 'file');
    item.description = leftoverDescription(group);
    item.tooltip = leftoverTooltip(group.kind);
    return item;
  }
}

function newest(node: Node): number {
  return node.kind === 'group' ? Math.max(...node.sessions.map((session) => session.modifiedAt)) : 0;
}
