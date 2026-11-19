import * as fsp from 'fs/promises';
import * as vscode from 'vscode';
import { ClaudeStore } from '../core/claude';
import { CodexStore } from '../core/codex';
import { findCodexExecutable } from '../core/codexExe';
import { formatBytes } from '../core/format';
import { errorMessage, mapLimit } from '../core/fsx';
import { conversationContains, textContains } from '../core/search';
import {
  CancelledError,
  type CleanResult,
  type DeletionOutcome,
  type DeletionPlan,
  type LeftoverGroup,
  type LeftoverKind,
  type ProviderId,
  type Remover,
  type SessionInfo,
} from '../core/types';
import { type DeleteMode, type Settings, readSettings } from './settings';

export interface ProviderState {
  available: boolean;
  sessions: SessionInfo[];
}

export interface Filter {
  query: string;
  /** `uid()` of every conversation that matched. */
  matches: Set<string>;
}

export interface State {
  loaded: boolean;
  claude: ProviderState;
  codex: ProviderState;
  leftovers: LeftoverGroup[];
  filter?: Filter;
}

/** Identifies a row across both tools. */
export function uid(session: SessionInfo): string {
  return `${session.provider}:${session.key}`;
}

interface Stores {
  signature: string;
  settings: Settings;
  claude: ClaudeStore;
  codex: CodexStore;
}

/** Holds what the view shows and performs every operation on the stores. Knows nothing about tree items or dialogs. */
export class Controller implements vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;

  private current: State = { loaded: false, claude: { available: false, sessions: [] }, codex: { available: false, sessions: [] }, leftovers: [] };
  private stores: Stores | undefined;
  private running: Promise<void> | undefined;
  private followUp: Promise<void> | undefined;
  private generation = 0;

  constructor(private readonly log: vscode.LogOutputChannel) {}

  dispose(): void {
    this.changed.dispose();
  }

  get state(): State {
    return this.current;
  }

  get settings(): Settings {
    return this.resolve().settings;
  }

  private resolve(): Stores {
    const settings = readSettings();
    const signature = JSON.stringify([settings.claudeHome, settings.codexHome, settings.claudeTempRoots, settings.codexExecutable ?? '']);
    if (!this.stores || this.stores.signature !== signature) {
      const override = settings.codexExecutable;
      this.stores = {
        signature,
        settings,
        claude: new ClaudeStore({ home: settings.claudeHome, tempRoots: settings.claudeTempRoots }),
        codex: new CodexStore({
          home: settings.codexHome,
          findExecutable: () => findCodexExecutable(override ? { override } : { extensionDirs: codexExtensionDirs() }),
        }),
      };
      this.log.info(`Claude Code data: ${settings.claudeHome}`);
      this.log.info(`Codex data: ${settings.codexHome}`);
    } else {
      this.stores.settings = settings;
    }
    return this.stores;
  }

  /** Sessions of one tool with the search filter applied. */
  visible(provider: ProviderId): SessionInfo[] {
    const { filter } = this.current;
    const sessions = this.current[provider].sessions;
    return filter ? sessions.filter((session) => filter.matches.has(uid(session))) : sessions;
  }

  find(provider: ProviderId, key: string): SessionInfo | undefined {
    return this.current[provider].sessions.find((session) => session.key === key);
  }

  // ----------------------------------------------------------------- refresh

  /**
   * Reloads everything. A call made while a reload is running gets one fresh reload
   * afterwards, shared by everyone who asked in the meantime, so its result is never stale.
   */
  refresh(): Promise<void> {
    if (this.running) {
      this.followUp ??= this.running.then(() => {
        this.followUp = undefined;
        return this.refresh();
      });
      return this.followUp;
    }
    this.running = this.reload()
      .catch((error) => this.log.error(`Refresh failed: ${errorMessage(error)}`))
      .finally(() => {
        this.running = undefined;
      });
    return this.running;
  }

  private async reload(): Promise<void> {
    const generation = ++this.generation;
    const { claude, codex } = this.resolve();
    const load = async (store: ClaudeStore | CodexStore, name: string): Promise<ProviderState> => {
      try {
        if (!(await store.available())) {
          return { available: false, sessions: [] };
        }
        return { available: true, sessions: await store.list() };
      } catch (error) {
        this.log.error(`Listing ${name} conversations failed: ${errorMessage(error)}`);
        return { available: true, sessions: [] };
      }
    };
    const [claudeState, codexState] = await Promise.all([load(claude, 'Claude Code'), load(codex, 'Codex')]);
    this.current = { ...this.current, loaded: true, claude: claudeState, codex: codexState };
    this.changed.fire();

    // Data folders can hold thousands of files; they are measured after the list is on screen.
    const pending = claudeState.sessions.filter((session) => session.sizePending);
    if (pending.length) {
      await mapLimit(pending, 2, async (session) => {
        if (generation !== this.generation) {
          return;
        }
        try {
          session.sizeBytes = await claude.measure(session);
        } catch {
          // The conversation vanished in the meantime; the next refresh drops it.
        }
        delete session.sizePending;
      });
      if (generation === this.generation) {
        this.changed.fire();
      }
    }

    // Leftovers need a walk over the temp folders; the list should not wait for it.
    const leftovers: LeftoverGroup[] = [];
    for (const [store, available, name] of [
      [claude, claudeState.available, 'Claude Code'],
      [codex, codexState.available, 'Codex'],
    ] as const) {
      if (!available) {
        continue;
      }
      try {
        leftovers.push(...(await store.leftovers()));
      } catch (error) {
        this.log.error(`Looking for ${name} leftovers failed: ${errorMessage(error)}`);
      }
    }
    if (generation === this.generation) {
      this.current = { ...this.current, leftovers };
      this.changed.fire();
    }
  }

  // ------------------------------------------------------------------ search

  /** Keeps only conversations whose title, id or visible text contains the query. Returns the number of matches. */
  async search(query: string, token?: vscode.CancellationToken, onProgress?: (done: number, total: number) => void): Promise<number> {
    const abort = new AbortController();
    const subscription = token?.onCancellationRequested(() => abort.abort());
    try {
      const all = [...this.current.claude.sessions, ...this.current.codex.sessions];
      const matches = new Set<string>();
      let done = 0;
      await mapLimit(all, 4, async (session) => {
        if (abort.signal.aborted) {
          return;
        }
        if (textContains(session.title, query) || textContains(session.id, query) || (await conversationContains(session, query, abort.signal))) {
          matches.add(uid(session));
        }
        onProgress?.(++done, all.length);
      });
      if (abort.signal.aborted) {
        throw new CancelledError();
      }
      this.current = { ...this.current, filter: { query, matches } };
      this.changed.fire();
      return matches.size;
    } finally {
      subscription?.dispose();
    }
  }

  clearFilter(): void {
    if (this.current.filter) {
      this.current = { ...this.current, filter: undefined };
      this.changed.fire();
    }
  }

  // ---------------------------------------------------------------- deleting

  /** What deleting these rows would remove, in the order they will be deleted. */
  async plan(sessions: SessionInfo[]): Promise<DeletionPlan[]> {
    const { claude, codex } = this.resolve();
    const plans: DeletionPlan[] = [];
    for (const [index, session] of sessions.entries()) {
      plans.push(session.provider === 'claude' ? await claude.plan(session, sessions.slice(0, index)) : await codex.plan(session));
    }
    return plans;
  }

  async deleteSessions(
    sessions: SessionInfo[],
    mode: DeleteMode,
    report?: (message: string) => void,
    token?: vscode.CancellationToken,
  ): Promise<DeletionOutcome[]> {
    const { claude, codex } = this.resolve();
    const outcomes: DeletionOutcome[] = [];
    for (const session of sessions) {
      if (token?.isCancellationRequested) {
        break;
      }
      const name = session.title || session.id;
      report?.(name);
      let outcome: DeletionOutcome;
      try {
        if (session.provider === 'claude') {
          const plan = await claude.plan(session);
          this.logPlan(plan, mode);
          outcome = await claude.execute(plan, this.remover(mode));
        } else {
          const plan = await codex.plan(session);
          this.logPlan(plan, 'permanent');
          outcome = await codex.execute(plan, (done, total) => report?.(`${name} (${done + 1}/${total})`));
        }
      } catch (error) {
        outcome = { session, status: 'failed', removed: 0, failures: [{ target: session.id, message: errorMessage(error) }], leftovers: [] };
      }
      this.logOutcome(outcome);
      outcomes.push(outcome);
    }
    await this.refresh();
    return outcomes;
  }

  async cleanLeftovers(kinds: LeftoverKind[], mode: DeleteMode, report?: (message: string) => void): Promise<CleanResult> {
    const { claude, codex } = this.resolve();
    const total: CleanResult = { removed: 0, failures: [] };
    for (const kind of kinds) {
      const progress = (done: number, count: number): void => report?.(`${done + 1}/${count}`);
      try {
        const result = kind === 'codex.orphanThreads' ? await codex.cleanLeftovers(progress) : await claude.cleanLeftovers(kind, this.remover(mode), progress);
        total.removed += result.removed;
        total.failures.push(...result.failures);
        this.log.info(`Cleaned ${kind}: ${result.removed} removed, ${result.failures.length} failed`);
      } catch (error) {
        total.failures.push({ target: kind, message: errorMessage(error) });
      }
    }
    for (const failure of total.failures) {
      this.log.warn(`  could not remove ${failure.target}: ${failure.message}`);
    }
    await this.refresh();
    return total;
  }

  private remover(mode: DeleteMode): Remover {
    if (mode === 'permanent') {
      return (target) => fsp.rm(target, { recursive: true, force: true, maxRetries: 2 });
    }
    return async (target) => {
      await vscode.workspace.fs.delete(vscode.Uri.file(target), { recursive: true, useTrash: true });
    };
  }

  private logPlan(plan: DeletionPlan, mode: DeleteMode): void {
    const { session } = plan;
    this.log.info(`Deleting ${session.provider} conversation "${session.title}" [${session.id}] (${mode}), ${plan.items.length} items, ${formatBytes(plan.totalBytes)}`);
    for (const item of plan.items) {
      this.log.info(`  ${item.path}`);
    }
  }

  private logOutcome(outcome: DeletionOutcome): void {
    this.log.info(`  result: ${outcome.status}, ${outcome.removed} removed${outcome.busy ? `, in use (${outcome.busy})` : ''}`);
    for (const failure of outcome.failures) {
      this.log.warn(`  failed: ${failure.target}: ${failure.message}`);
    }
    for (const leftover of outcome.leftovers) {
      this.log.warn(`  still there: ${leftover}`);
    }
  }
}

/** Where the Codex editor extension is installed in this editor, if it is. Its bundled CLI matches the data format in use. */
function codexExtensionDirs(): string[] {
  const extension = vscode.extensions.getExtension('openai.chatgpt');
  return extension ? [extension.extensionPath] : [];
}
