import * as vscode from 'vscode';
import { formatBytes } from '../core/format';
import { errorMessage } from '../core/fsx';
import { type Preview, type PreviewMessage, readPreview } from '../core/preview';
import type { ProviderId, SessionInfo } from '../core/types';
import type { Controller } from './controller';
import { PROVIDER_NAMES } from './tree';

export const PREVIEW_SCHEME = 'session-sweeper';

/** A read-only document showing what was said in a conversation. Nothing is rendered or fetched; it is plain text. */
export function previewUri(session: SessionInfo): vscode.Uri {
  const name = (session.title || session.id).replace(/[\\/:*?"<>|#%\r\n]+/g, ' ').trim().slice(0, 60) || session.id;
  return vscode.Uri.from({
    scheme: PREVIEW_SCHEME,
    path: `/${name}.md`,
    // The modification time makes a changed conversation a new document instead of a cached one.
    query: new URLSearchParams({ provider: session.provider, key: session.key, at: String(Math.round(session.modifiedAt)) }).toString(),
  });
}

function clock(time: number | undefined): string {
  return time === undefined ? '' : ` · ${new Date(time).toLocaleString(vscode.env.language)}`;
}

function tally(tools: string[]): string {
  const counts = new Map<string, number>();
  for (const tool of tools) {
    counts.set(tool, (counts.get(tool) ?? 0) + 1);
  }
  return [...counts].map(([name, count]) => (count > 1 ? `${name} ×${count}` : name)).join(', ');
}

function renderMessage(message: PreviewMessage, provider: ProviderId): string {
  const who = message.role === 'user' ? vscode.l10n.t('You') : PROVIDER_NAMES[provider];
  const parts = [`**${who}**${clock(message.time)}`];
  if (message.text) {
    parts.push(message.text);
  }
  if (message.tools.length) {
    parts.push(`*${vscode.l10n.t('Tools used: {0}', tally(message.tools))}*`);
  }
  return parts.join('\n\n');
}

export function renderPreview(session: SessionInfo, preview: Preview): string {
  const facts = [PROVIDER_NAMES[session.provider]];
  if (session.cwd) {
    facts.push(session.cwd);
  }
  facts.push(vscode.l10n.t('{0} messages', preview.total), formatBytes(session.sizeBytes));
  facts.push(vscode.l10n.t('last used {0}', new Date(session.modifiedAt).toLocaleString(vscode.env.language)));
  const blocks = [`# ${session.title || vscode.l10n.t('(untitled)')}`, facts.join(' · ')];
  if (preview.total === 0) {
    blocks.push(vscode.l10n.t('No readable messages were found in this conversation.'));
    return `${blocks.join('\n\n')}\n`;
  }
  blocks.push('---');
  blocks.push(...preview.head.map((message) => renderMessage(message, session.provider)));
  const hidden = preview.total - preview.head.length - preview.tail.length;
  if (hidden > 0) {
    blocks.push('---', `*${vscode.l10n.t('{0} messages in between are not shown.', hidden)}*`, '---');
  }
  blocks.push(...preview.tail.map((message) => renderMessage(message, session.provider)));
  return `${blocks.join('\n\n')}\n`;
}

export class PreviewProvider implements vscode.TextDocumentContentProvider {
  constructor(private readonly controller: Controller) {}

  async provideTextDocumentContent(uri: vscode.Uri, token: vscode.CancellationToken): Promise<string> {
    const params = new URLSearchParams(uri.query);
    const provider = params.get('provider') === 'codex' ? 'codex' : 'claude';
    const session = this.controller.find(provider, params.get('key') ?? '');
    if (!session) {
      return vscode.l10n.t('This conversation no longer exists.');
    }
    const abort = new AbortController();
    const subscription = token.onCancellationRequested(() => abort.abort());
    try {
      return renderPreview(session, await readPreview(session, { signal: abort.signal }));
    } catch (error) {
      return vscode.l10n.t('The conversation could not be read: {0}', errorMessage(error));
    } finally {
      subscription.dispose();
    }
  }
}
