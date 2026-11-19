import * as vscode from 'vscode';
import type { CleanResult, DeletionOutcome, LeftoverGroup, SessionInfo } from './core/types';
import { VIEW_ID, inView, registerCommands } from './ui/commands';
import { Controller, uid } from './ui/controller';
import { PREVIEW_SCHEME, PreviewProvider, previewUri } from './ui/preview';
import { type DeleteMode, affectsSettings } from './ui/settings';
import { type Node, SessionTree } from './ui/tree';

/** Returned from `activate` for automated tests. Not a public API. */
export interface SweeperApi {
  refresh(): Promise<void>;
  sessions(): SessionInfo[];
  leftovers(): LeftoverGroup[];
  search(query: string): Promise<number>;
  clearSearch(): void;
  /** Deletes without asking. `ids` are `provider:key` strings. */
  deleteSessions(ids: string[], mode: DeleteMode): Promise<DeletionOutcome[]>;
  cleanLeftovers(mode: DeleteMode): Promise<CleanResult>;
  visibleTitles(): string[];
  /** The text of the preview document of a conversation. */
  preview(id: string): Promise<string>;
}

/** How long a loaded list is considered fresh when the view is shown again. */
const STALE_AFTER_MS = 15_000;

export function activate(context: vscode.ExtensionContext): SweeperApi {
  const log = vscode.window.createOutputChannel('Session Sweeper', { log: true });
  const controller = new Controller(log);
  const tree = new SessionTree(controller);
  const view = vscode.window.createTreeView<Node>(VIEW_ID, { treeDataProvider: tree, canSelectMany: true, showCollapseAll: true });
  let loadedAt = 0;

  const reload = (): Thenable<void> =>
    inView(async () => {
      await controller.refresh();
      loadedAt = Date.now();
    });

  const syncContext = (): void => {
    const state = controller.state;
    const shown = controller.visible('claude').length + controller.visible('codex').length;
    let name = 'loading';
    if (state.loaded) {
      if (!state.claude.available && !state.codex.available) {
        name = 'none';
      } else if (state.filter && shown === 0) {
        name = 'noMatch';
      } else {
        name = 'ok';
      }
    }
    void vscode.commands.executeCommand('setContext', 'sessionSweeper.state', name);
    void vscode.commands.executeCommand('setContext', 'sessionSweeper.filterActive', state.filter !== undefined);
    view.message = state.filter ? vscode.l10n.t('Conversations containing "{0}"', state.filter.query) : undefined;
  };
  /** The menus mark the active grouping and sorting; they read it from these context keys. */
  const syncOptions = (): void => {
    void vscode.commands.executeCommand('setContext', 'sessionSweeper.groupBy', controller.settings.groupBy);
    void vscode.commands.executeCommand('setContext', 'sessionSweeper.sortBy', controller.settings.sortBy);
  };
  syncContext();
  syncOptions();

  context.subscriptions.push(
    log,
    controller,
    tree,
    view,
    controller.onDidChange(syncContext),
    vscode.workspace.registerTextDocumentContentProvider(PREVIEW_SCHEME, new PreviewProvider(controller)),
    view.onDidChangeVisibility((event) => {
      if (event.visible && Date.now() - loadedAt > STALE_AFTER_MS) {
        void reload();
      }
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!affectsSettings(event)) {
        return;
      }
      if (event.affectsConfiguration('sessionSweeper.groupBy') || event.affectsConfiguration('sessionSweeper.sortBy')) {
        syncOptions();
        tree.redraw();
      } else if (controller.state.loaded) {
        void reload();
      }
    }),
    ...registerCommands({ controller, view, log, extensionId: context.extension.id }),
  );

  if (view.visible) {
    void reload();
  }

  return {
    refresh: () => controller.refresh(),
    sessions: () => [...controller.state.claude.sessions, ...controller.state.codex.sessions],
    leftovers: () => controller.state.leftovers,
    search: (query) => controller.search(query),
    clearSearch: () => controller.clearFilter(),
    deleteSessions: (ids, mode) => {
      const wanted = new Set(ids);
      const sessions = [...controller.state.claude.sessions, ...controller.state.codex.sessions].filter((session) => wanted.has(uid(session)));
      return controller.deleteSessions(sessions, mode);
    },
    cleanLeftovers: (mode) =>
      controller.cleanLeftovers(
        controller.state.leftovers.map((group) => group.kind),
        mode,
      ),
    visibleTitles: () => [...controller.visible('claude'), ...controller.visible('codex')].map((session) => session.title),
    preview: async (id) => {
      const session = [...controller.state.claude.sessions, ...controller.state.codex.sessions].find((candidate) => uid(candidate) === id);
      if (!session) {
        throw new Error(`No conversation ${id}`);
      }
      return (await vscode.workspace.openTextDocument(previewUri(session))).getText();
    },
  };
}

export function deactivate(): void {
  // Everything is disposed through the extension context.
}
