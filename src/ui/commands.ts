import * as vscode from 'vscode';
import { CODEX_DELETE_UNSUPPORTED, CODEX_NOT_FOUND } from '../core/codex';
import { formatBytes, relativeTime } from '../core/format';
import { errorMessage } from '../core/fsx';
import { CancelledError, type DeletionOutcome, type DeletionPlan, type LeftoverGroup, type SessionInfo } from '../core/types';
import { type Controller, uid } from './controller';
import { previewUri } from './preview';
import { type DeleteMode, updateSetting } from './settings';
import { type Node, PROVIDER_NAMES, busyText, conversationCount, folderName, leftoverDescription, leftoverLabel } from './tree';

export const VIEW_ID = 'sessionSweeper.sessions';

export interface CommandContext {
  controller: Controller;
  view: vscode.TreeView<Node>;
  log: vscode.LogOutputChannel;
  extensionId: string;
}

/** What the operating system calls the place deleted files go to. */
function binName(): string {
  return process.platform === 'win32' ? vscode.l10n.t('Recycle Bin') : vscode.l10n.t('Trash');
}

function titleOf(session: SessionInfo): string {
  return session.title || vscode.l10n.t('(untitled)');
}

/** Runs a task with the progress bar of the view itself. */
export function inView<T>(task: () => Promise<T>): Thenable<T> {
  return vscode.window.withProgress({ location: { viewId: VIEW_ID } }, task);
}

async function ensureLoaded(controller: Controller): Promise<void> {
  if (!controller.state.loaded) {
    await inView(() => controller.refresh());
  }
}

/** The rows a command applies to: the clicked one, or the whole selection when the clicked row is part of it. */
function targetNodes(view: vscode.TreeView<Node>, node?: Node, nodes?: readonly Node[]): readonly Node[] {
  if (node) {
    return nodes && nodes.length > 1 && nodes.includes(node) ? nodes : [node];
  }
  return view.selection;
}

/** Session rows among the targets, looked up again so that stale rows never reach a delete. */
function sessionsIn(controller: Controller, nodes: readonly Node[]): SessionInfo[] {
  const found = new Map<string, SessionInfo>();
  for (const node of nodes) {
    if (node.kind !== 'session') {
      continue;
    }
    const fresh = controller.find(node.session.provider, node.session.key);
    if (fresh) {
      found.set(uid(fresh), fresh);
    }
  }
  return [...found.values()];
}

async function pickSessions(controller: Controller): Promise<SessionInfo[]> {
  await ensureLoaded(controller);
  const all = [...controller.visible('claude'), ...controller.visible('codex')].sort((a, b) => b.modifiedAt - a.modifiedAt);
  if (all.length === 0) {
    void vscode.window.showInformationMessage(vscode.l10n.t('There are no conversations to delete.'));
    return [];
  }
  const items = all.map((session) => ({
    label: `${session.busy ? '$(lock) ' : ''}${titleOf(session)}`,
    description: [PROVIDER_NAMES[session.provider], session.cwd ? folderName(session.cwd) : ''].filter(Boolean).join(' · '),
    detail: `${relativeTime(session.modifiedAt, Date.now(), vscode.env.language)} · ${formatBytes(session.sizeBytes)}`,
    session,
  }));
  const picked = await vscode.window.showQuickPick(items, {
    canPickMany: true,
    matchOnDescription: true,
    title: vscode.l10n.t('Delete conversations'),
    placeHolder: vscode.l10n.t('Select the conversations to delete'),
  });
  return picked?.map((item) => item.session) ?? [];
}

// ------------------------------------------------------------------ deleting

interface Totals {
  items: number;
  bytes: number;
  helpers: number;
}

function totals(plans: DeletionPlan[]): Totals {
  return {
    items: plans.reduce((sum, plan) => sum + plan.items.length, 0),
    bytes: plans.reduce((sum, plan) => sum + plan.totalBytes, 0),
    helpers: plans.reduce((sum, plan) => sum + Math.max(0, (plan.threadIds?.length ?? 1) - 1), 0),
  };
}

/** Asks before anything is deleted. Returns how to delete, or undefined when the user backed out. */
async function confirmDeletion(plans: DeletionPlan[], mode: DeleteMode, skipped: number): Promise<DeleteMode | undefined> {
  const claude = plans.filter((plan) => plan.session.provider === 'claude');
  const codex = plans.filter((plan) => plan.session.provider === 'codex');
  const single = plans.length === 1;
  const first = plans[0] as DeletionPlan;
  const message = single ? vscode.l10n.t('Delete "{0}"?', titleOf(first.session)) : vscode.l10n.t('Delete {0}?', conversationCount(plans.length));
  const lines: string[] = [];
  if (claude.length) {
    const sum = totals(claude);
    lines.push(
      single
        ? vscode.l10n.t(
            '{0} items ({1}): the transcript, sub-agent logs, file snapshots and temp folders of this conversation.',
            sum.items,
            formatBytes(sum.bytes),
          )
        : vscode.l10n.t('Claude Code: {0}, {1} items ({2}).', conversationCount(claude.length), sum.items, formatBytes(sum.bytes)),
    );
    if (claude.some((plan) => plan.session.otherCopies)) {
      lines.push(
        vscode.l10n.t('Copies of a conversation in other project folders are not touched. Data shared between copies is removed together with the last copy.'),
      );
    }
    lines.push(mode === 'trash' ? vscode.l10n.t('They are moved to the {0}.', binName()) : vscode.l10n.t('They are deleted permanently.'));
  }
  if (codex.length) {
    const sum = totals(codex);
    lines.push(
      single
        ? vscode.l10n.t('The conversation and {0} helper threads Codex created for it ({1}).', sum.helpers, formatBytes(sum.bytes))
        : vscode.l10n.t('Codex: {0} and {1} helper threads ({2}).', conversationCount(codex.length), sum.helpers, formatBytes(sum.bytes)),
    );
    lines.push(vscode.l10n.t('Codex deletes them itself, permanently. This cannot be undone.'));
  }
  if (skipped > 0) {
    lines.push(vscode.l10n.t('{0} selected conversation(s) are in use and will be skipped.', skipped));
  }

  const permanently = vscode.l10n.t('Delete Permanently');
  let buttons: string[];
  if (claude.length && mode === 'trash') {
    buttons = [codex.length ? vscode.l10n.t('Delete') : vscode.l10n.t('Move to {0}', binName()), permanently];
  } else {
    buttons = [permanently];
  }
  const choice = await vscode.window.showWarningMessage(message, { modal: true, detail: lines.join('\n\n') }, ...buttons);
  if (!choice) {
    return undefined;
  }
  return choice === permanently ? 'permanent' : 'trash';
}

function explainTrouble(outcome: DeletionOutcome): string {
  const title = titleOf(outcome.session);
  if (outcome.session.provider === 'codex') {
    const reason = outcome.failures[0]?.message ?? '';
    if (reason === CODEX_NOT_FOUND) {
      return vscode.l10n.t('The Codex command-line program was not found. Set "Session Sweeper › Codex: Executable Path" to its location.');
    }
    if (reason === CODEX_DELETE_UNSUPPORTED) {
      return vscode.l10n.t('This version of Codex has no "codex delete" command. Update Codex and try again.');
    }
    if (outcome.status === 'failed') {
      return vscode.l10n.t(
        'Codex refused to delete "{0}" ({1}). If it is open in Codex, close every editor window that runs Codex and try again.',
        title,
        reason || vscode.l10n.t('no details given'),
      );
    }
  }
  return vscode.l10n.t('"{0}" could not be deleted completely; {1} item(s) are still there.', title, Math.max(outcome.leftovers.length, outcome.failures.length));
}

async function reportOutcomes(context: CommandContext, outcomes: DeletionOutcome[], mode: DeleteMode): Promise<void> {
  const deleted = outcomes.filter((outcome) => outcome.status === 'deleted');
  const busy = outcomes.filter((outcome) => outcome.status === 'busy');
  const trouble = outcomes.filter((outcome) => outcome.status === 'partial' || outcome.status === 'failed');
  if (busy.length === 0 && trouble.length === 0) {
    if (deleted.length === 1) {
      void vscode.window.showInformationMessage(vscode.l10n.t('Deleted "{0}". Nothing was left behind.', titleOf((deleted[0] as DeletionOutcome).session)));
    } else if (deleted.length > 1) {
      void vscode.window.showInformationMessage(vscode.l10n.t('Deleted {0}. Nothing was left behind.', conversationCount(deleted.length)));
    }
    return;
  }
  const parts: string[] = [];
  if (deleted.length) {
    parts.push(vscode.l10n.t('Deleted {0}.', conversationCount(deleted.length)));
  }
  if (busy.length === 1) {
    const only = busy[0] as DeletionOutcome;
    parts.push(vscode.l10n.t('"{0}" was skipped: {1}', titleOf(only.session), busyText(only.session.provider, only.busy ?? 'process')));
  } else if (busy.length > 1) {
    parts.push(vscode.l10n.t('{0} were skipped because they are in use.', conversationCount(busy.length)));
  }
  if (trouble.length === 1) {
    parts.push(explainTrouble(trouble[0] as DeletionOutcome));
  } else if (trouble.length > 1) {
    parts.push(vscode.l10n.t('{0} could not be deleted completely.', conversationCount(trouble.length)));
  }
  const showLog = vscode.l10n.t('Show Log');
  const permanently = vscode.l10n.t('Delete Permanently');
  const retryable = mode === 'trash' ? trouble.filter((outcome) => outcome.session.provider === 'claude') : [];
  const actions = trouble.length ? (retryable.length ? [permanently, showLog] : [showLog]) : [];
  const choice = await vscode.window.showWarningMessage(parts.join(' '), ...actions);
  if (choice === showLog) {
    context.log.show();
  } else if (choice === permanently) {
    // Moving to the bin can fail where a permanent delete works, e.g. on remote machines without one.
    const again = retryable
      .map((outcome) => context.controller.find(outcome.session.provider, outcome.session.key))
      .filter((session): session is SessionInfo => session !== undefined);
    if (again.length) {
      await runDeletion(context, again, 'permanent');
    }
  }
}

async function runDeletion(context: CommandContext, sessions: SessionInfo[], mode: DeleteMode): Promise<void> {
  const outcomes = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Deleting conversations…'), cancellable: sessions.length > 1 },
    (progress, token) => context.controller.deleteSessions(sessions, mode, (message) => progress.report({ message }), token),
  );
  await reportOutcomes(context, outcomes, mode);
}

async function deleteCommand(context: CommandContext, forcePermanent: boolean, node?: Node, nodes?: readonly Node[]): Promise<void> {
  const { controller, view } = context;
  const chosen = targetNodes(view, node, nodes);
  const sessions = chosen.length ? sessionsIn(controller, chosen) : await pickSessions(controller);
  if (sessions.length === 0) {
    return;
  }
  const idle = sessions.filter((session) => !session.busy);
  const busy = sessions.filter((session) => session.busy);
  if (idle.length === 0) {
    const only = busy[0] as SessionInfo;
    void vscode.window.showInformationMessage(
      busy.length === 1
        ? busyText(only.provider, only.busy ?? 'process')
        : vscode.l10n.t('All selected conversations are in use. Close them first, then refresh.'),
    );
    return;
  }
  let plans: DeletionPlan[];
  try {
    plans = await inView(() => controller.plan(idle));
  } catch (error) {
    void vscode.window.showErrorMessage(vscode.l10n.t('Could not work out what to delete: {0}', errorMessage(error)));
    await controller.refresh();
    return;
  }
  const mode = await confirmDeletion(plans, forcePermanent ? 'permanent' : controller.settings.deleteMode, busy.length);
  if (mode) {
    await runDeletion(context, idle, mode);
  }
}

// ------------------------------------------------------------------ leftovers

async function cleanLeftoversCommand(context: CommandContext, node?: Node): Promise<void> {
  const { controller } = context;
  await ensureLoaded(controller);
  const groups: LeftoverGroup[] = node?.kind === 'leftover' ? [node.group] : controller.state.leftovers;
  if (groups.length === 0) {
    void vscode.window.showInformationMessage(vscode.l10n.t('There is nothing to clean up.'));
    return;
  }
  const mode = controller.settings.deleteMode;
  const lines = groups.map((group) => `${leftoverLabel(group.kind)}: ${leftoverDescription(group)}`);
  lines.push(vscode.l10n.t('All of this belongs to conversations that no longer exist. Anything changed within the last day is left alone.'));
  if (groups.some((group) => group.kind === 'claude.orphanTemp' || group.kind === 'claude.orphanData')) {
    lines.push(mode === 'trash' ? vscode.l10n.t('Files are moved to the {0}; empty folders are simply removed.', binName()) : vscode.l10n.t('Files are deleted permanently.'));
  }
  if (groups.some((group) => group.kind === 'codex.orphanThreads')) {
    lines.push(vscode.l10n.t('Codex deletes its threads itself, permanently.'));
  }
  const cleanUp = vscode.l10n.t('Clean Up');
  const choice = await vscode.window.showWarningMessage(vscode.l10n.t('Clean up leftovers?'), { modal: true, detail: lines.join('\n\n') }, cleanUp);
  if (choice !== cleanUp) {
    return;
  }
  const result = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Cleaning up leftovers…') },
    (progress) =>
      controller.cleanLeftovers(
        groups.map((group) => group.kind),
        mode,
        (message) => progress.report({ message }),
      ),
  );
  if (result.failures.length === 0) {
    void vscode.window.showInformationMessage(vscode.l10n.t('Removed {0} leftover item(s).', result.removed));
    return;
  }
  const showLog = vscode.l10n.t('Show Log');
  const picked = await vscode.window.showWarningMessage(
    vscode.l10n.t('Removed {0} leftover item(s); {1} could not be removed.', result.removed, result.failures.length),
    showLog,
  );
  if (picked === showLog) {
    context.log.show();
  }
}

// --------------------------------------------------------------------- search

async function searchCommand(context: CommandContext): Promise<void> {
  const { controller } = context;
  const input = await vscode.window.showInputBox({
    title: vscode.l10n.t('Search conversations'),
    prompt: vscode.l10n.t('Shows the conversations whose title, or what you and the assistant said, contains this text.'),
    placeHolder: vscode.l10n.t('A phrase you remember from the conversation'),
    value: controller.state.filter?.query ?? '',
    validateInput: (value) => (value.trim().length === 1 ? vscode.l10n.t('Type at least 2 characters.') : undefined),
  });
  if (input === undefined) {
    return;
  }
  const query = input.trim();
  if (query === '') {
    controller.clearFilter();
    return;
  }
  await ensureLoaded(controller);
  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Searching conversations…'), cancellable: true },
      (progress, token) => {
        let reported = 0;
        return controller.search(query, token, (done, total) => {
          progress.report({ message: `${done}/${total}`, increment: ((done - reported) / total) * 100 });
          reported = done;
        });
      },
    );
  } catch (error) {
    if (!(error instanceof CancelledError)) {
      void vscode.window.showErrorMessage(vscode.l10n.t('The search failed: {0}', errorMessage(error)));
    }
  }
}

// --------------------------------------------------------------- registration

export function registerCommands(context: CommandContext): vscode.Disposable[] {
  const { controller, view } = context;
  const sessionOf = (node?: Node): SessionInfo | undefined => sessionsIn(controller, node ? [node] : view.selection)[0];
  const register = (name: string, handler: (...args: never[]) => unknown): vscode.Disposable =>
    vscode.commands.registerCommand(`sessionSweeper.${name}`, handler as (...args: unknown[]) => unknown);

  return [
    register('refresh', () => inView(() => controller.refresh())),
    register('search', () => searchCommand(context)),
    register('clearSearch', () => controller.clearFilter()),
    register('delete', (node?: Node, nodes?: readonly Node[]) => deleteCommand(context, false, node, nodes)),
    register('deletePermanently', (node?: Node, nodes?: readonly Node[]) => deleteCommand(context, true, node, nodes)),
    register('preview', async (node?: Node) => {
      const session = sessionOf(node);
      if (session) {
        const document = await vscode.workspace.openTextDocument(previewUri(session));
        await vscode.window.showTextDocument(document, { preview: true });
      }
    }),
    register('revealTranscript', async (node?: Node) => {
      const file = sessionOf(node)?.transcripts[0];
      if (file) {
        await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(file));
      }
    }),
    register('copyId', async (node?: Node) => {
      const session = sessionOf(node);
      if (session) {
        await vscode.env.clipboard.writeText(session.id);
      }
    }),
    register('explainBusy', async (node?: Node) => {
      const session = sessionOf(node);
      if (!session) {
        return;
      }
      if (!session.busy) {
        void vscode.window.showInformationMessage(vscode.l10n.t('This conversation is no longer in use and can be deleted.'));
        return;
      }
      const refresh = vscode.l10n.t('Refresh');
      const choice = await vscode.window.showInformationMessage(busyText(session.provider, session.busy), refresh);
      if (choice === refresh) {
        await inView(() => controller.refresh());
      }
    }),
    register('cleanLeftovers', (node?: Node) => cleanLeftoversCommand(context, node)),
    register('groupByFolder', () => updateSetting('groupBy', 'folder')),
    register('groupByNone', () => updateSetting('groupBy', 'none')),
    register('sortByModified', () => updateSetting('sortBy', 'modified')),
    register('sortBySize', () => updateSetting('sortBy', 'size')),
    register('sortByTitle', () => updateSetting('sortBy', 'title')),
    // The menu shows these, with a check mark in the title, in place of the option that is already active.
    ...['groupByFolder', 'groupByNone', 'sortByModified', 'sortBySize', 'sortByTitle'].map((name) => register(`${name}.active`, () => undefined)),
    register('openSettings', () => vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${context.extensionId}`)),
    register('showLog', () => context.log.show()),
  ];
}
