import { execFile } from 'child_process';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { dropLines, errorMessage, exists, isDirectory, isUuid, listDir, mapLimit, norm, readFirstLine, readHead, statOrNull } from './fsx';
import { asObject, asString, contentText, parseJsonObject, promptToTitle } from './text';
import type { BusyReason, CleanResult, DeletionOutcome, DeletionPlan, Failure, LeftoverGroup, PlanItem, SessionInfo } from './types';

const DAY_MS = 86_400_000;
const RECENT_MS = 30_000;

/** `Failure.message` values the UI translates instead of showing verbatim. */
export const CODEX_NOT_FOUND = 'CODEX_NOT_FOUND';
export const CODEX_DELETE_UNSUPPORTED = 'CODEX_DELETE_UNSUPPORTED';

export interface CommandResult {
  code: number;
  output: string;
}

export type CodexRunner = (executable: string, args: string[], env: NodeJS.ProcessEnv) => Promise<CommandResult>;

export interface CodexStoreOptions {
  /** The Codex data folder, usually `~/.codex`. */
  home: string;
  findExecutable: () => Promise<string | undefined>;
  run?: CodexRunner;
  isLocked?: (lockFile: string) => Promise<boolean>;
  now?: () => number;
}

interface RolloutFile {
  path: string;
  size: number;
  mtimeMs: number;
}

interface Header {
  id: string;
  /** The conversation this thread belongs to. Equal to `id` for a conversation itself. */
  rootId: string;
  parentId?: string;
  /** Review ("guardian") and sub-agent threads: created by Codex, not shown in its conversation list. */
  helper: boolean;
  cwd?: string;
  createdAt?: number;
}

interface Thread extends Header {
  files: RolloutFile[];
  archived: boolean;
}

/** Runs the Codex CLI. Arguments are passed without a shell, except for `.cmd` shims on Windows. */
export const runCodex: CodexRunner = (executable, args, env) =>
  new Promise((resolve) => {
    const viaCmd = process.platform === 'win32' && /\.(cmd|bat)$/i.test(executable);
    if (viaCmd && args.some((arg) => !/^[\w.-]+$/.test(arg))) {
      resolve({ code: 1, output: 'Refusing to pass unusual arguments through cmd.exe' });
      return;
    }
    const file = viaCmd ? (process.env.ComSpec ?? 'cmd.exe') : executable;
    const argv = viaCmd ? ['/d', '/s', '/c', `""${executable}" ${args.join(' ')}"`] : args;
    execFile(
      file,
      argv,
      { env, windowsHide: true, timeout: 120_000, maxBuffer: 4 * 1024 * 1024, windowsVerbatimArguments: viaCmd },
      (error, stdout, stderr) => {
        const output = `${stdout}\n${stderr}`.trim();
        if (!error) {
          resolve({ code: 0, output });
          return;
        }
        const code = typeof error.code === 'number' && error.code !== 0 ? error.code : 1;
        resolve({ code, output: output || error.message });
      },
    );
  });

/**
 * Whether another process holds the writer lock of a thread. On Windows a locked
 * region makes reads fail; elsewhere locks are advisory and cannot be observed
 * this way, so this returns false there.
 */
export async function isLockHeld(lockFile: string): Promise<boolean> {
  let handle: fsp.FileHandle | undefined;
  try {
    handle = await fsp.open(lockFile, 'r');
    await handle.read(Buffer.alloc(1), 0, 1, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EBUSY';
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export class CodexStore {
  private readonly headers = new Map<string, Header | null>();
  private readonly prompts = new Map<string, string>();
  private readonly deleteSupport = new Map<string, boolean>();

  constructor(private readonly options: CodexStoreOptions) {}

  get home(): string {
    return this.options.home;
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private get locks(): string {
    return path.join(this.options.home, 'thread-writer-locks');
  }

  async available(): Promise<boolean> {
    return (await isDirectory(path.join(this.options.home, 'sessions'))) || (await isDirectory(path.join(this.options.home, 'archived_sessions')));
  }

  // ---------------------------------------------------------------- scanning

  private async rolloutFiles(dir: string, depth: number, into: string[] = []): Promise<string[]> {
    for (const entry of await listDir(dir)) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < 6) {
          await this.rolloutFiles(full, depth + 1, into);
        }
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        into.push(full);
      }
    }
    return into;
  }

  /** Identity of a rollout file, read from its first line. Null when the format is not recognised. */
  private async header(file: string): Promise<Header | null> {
    const cached = this.headers.get(file);
    if (cached !== undefined) {
      return cached;
    }
    let header: Header | null = null;
    try {
      const entry = parseJsonObject((await readFirstLine(file)) ?? '');
      const wrapped = asObject(entry?.payload);
      // Current format: {type:"session_meta", payload:{…}}. Early versions wrote the fields at the top level.
      const meta = wrapped ? (entry?.type === 'session_meta' ? wrapped : undefined) : entry?.timestamp !== undefined ? entry : undefined;
      const id = asString(meta?.id);
      if (meta && id && isUuid(id)) {
        const source = asObject(meta.source);
        const subagent = asObject(source?.subagent);
        const sessionId = asString(meta.session_id);
        const parentId = asString(meta.parent_thread_id) ?? asString(asObject(subagent?.thread_spawn)?.parent_thread_id);
        header = { id: norm(id), rootId: norm(sessionId && isUuid(sessionId) ? sessionId : id), helper: source !== undefined && 'subagent' in source };
        if (parentId && isUuid(parentId)) {
          header.parentId = norm(parentId);
        }
        const cwd = asString(meta.cwd);
        if (cwd) {
          header.cwd = cwd;
        }
        const created = Date.parse(asString(meta.timestamp) ?? asString(entry?.timestamp) ?? '');
        if (!Number.isNaN(created)) {
          header.createdAt = created;
        }
      }
    } catch {
      header = null;
    }
    this.headers.set(file, header);
    return header;
  }

  private async scan(): Promise<Map<string, Thread>> {
    const threads = new Map<string, Thread>();
    for (const [folder, archived] of [
      ['sessions', false],
      ['archived_sessions', true],
    ] as const) {
      const files = await this.rolloutFiles(path.join(this.options.home, folder), 0);
      const described = await mapLimit(files, 8, async (file) => ({ file, st: await statOrNull(file), header: await this.header(file) }));
      for (const { file, st, header } of described) {
        if (!st || !header) {
          continue;
        }
        let thread = threads.get(header.id);
        if (!thread) {
          thread = { ...header, files: [], archived: false };
          threads.set(header.id, thread);
        }
        thread.files.push({ path: file, size: st.size, mtimeMs: st.mtimeMs });
        thread.archived ||= archived;
      }
    }
    for (const thread of threads.values()) {
      // Rollout names start with their creation time, so this puts the oldest part first.
      thread.files.sort((a, b) => path.basename(a.path).localeCompare(path.basename(b.path)));
    }
    return threads;
  }

  /** Helper threads that belong to a conversation, directly or through other helpers. */
  private helpersOf(threads: Map<string, Thread>, id: string): Thread[] {
    const included = new Set([id]);
    const helpers: Thread[] = [];
    for (let grew = true; grew; ) {
      grew = false;
      for (const thread of threads.values()) {
        if (!thread.helper || included.has(thread.id)) {
          continue;
        }
        if (included.has(thread.rootId) || (thread.parentId !== undefined && included.has(thread.parentId))) {
          included.add(thread.id);
          helpers.push(thread);
          grew = true;
        }
      }
    }
    return helpers.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
  }

  private async lockedIds(): Promise<Set<string>> {
    const held = new Set<string>();
    const isLocked = this.options.isLocked ?? isLockHeld;
    for (const entry of await listDir(this.locks)) {
      const id = entry.name.replace(/\.lock$/i, '');
      if (entry.isFile() && isUuid(id) && (await isLocked(path.join(this.locks, entry.name)))) {
        held.add(norm(id));
      }
    }
    return held;
  }

  private busyReason(group: Thread[], locked: Set<string>): BusyReason | undefined {
    if (group.some((thread) => locked.has(thread.id))) {
      return 'lock';
    }
    const now = this.now();
    return group.some((thread) => thread.files.some((file) => now - file.mtimeMs < RECENT_MS)) ? 'recent' : undefined;
  }

  private async threadNames(): Promise<Map<string, string>> {
    const names = new Map<string, string>();
    try {
      const raw = await fsp.readFile(path.join(this.options.home, 'session_index.jsonl'), 'utf8');
      for (const line of raw.split('\n')) {
        const entry = parseJsonObject(line);
        const id = asString(entry?.id);
        const name = asString(entry?.thread_name);
        if (id && name) {
          names.set(norm(id), name); // later lines win
        }
      }
    } catch {
      // no index, titles fall back to the first prompt
    }
    return names;
  }

  private async firstPrompt(file: string): Promise<string> {
    const cached = this.prompts.get(file);
    if (cached !== undefined) {
      return cached;
    }
    let title = '';
    try {
      const text = (await readHead(file, 512 * 1024)).toString('utf8');
      for (const line of text.split('\n')) {
        if (!line.includes('"role":"user"')) {
          continue;
        }
        const entry = parseJsonObject(line);
        const item = asObject(entry?.payload) ?? entry;
        if (item?.type !== 'message' || item.role !== 'user') {
          continue;
        }
        const candidate = promptToTitle(contentText(item.content));
        if (candidate && !candidate.startsWith('<')) {
          title = candidate;
          break;
        }
      }
    } catch {
      title = '';
    }
    this.prompts.set(file, title);
    return title;
  }

  // ----------------------------------------------------------------- listing

  async list(): Promise<SessionInfo[]> {
    const threads = await this.scan();
    const names = await this.threadNames();
    const locked = await this.lockedIds();
    const sessions: SessionInfo[] = [];
    for (const thread of threads.values()) {
      if (thread.helper) {
        continue;
      }
      const helpers = this.helpersOf(threads, thread.id);
      const first = thread.files[0] as RolloutFile;
      const session: SessionInfo = {
        provider: 'codex',
        key: thread.id,
        id: thread.id,
        title: names.get(thread.id) || (await this.firstPrompt(first.path)),
        groupKey: (thread.cwd ?? '').toLowerCase(),
        modifiedAt: Math.max(...thread.files.map((file) => file.mtimeMs)),
        // Helper threads are deleted together with the conversation, so they count towards its size.
        sizeBytes: [thread, ...helpers].reduce((sum, member) => sum + member.files.reduce((inner, file) => inner + file.size, 0), 0),
        transcripts: thread.files.map((file) => file.path),
      };
      if (thread.cwd) {
        session.cwd = thread.cwd;
      }
      if (thread.createdAt !== undefined) {
        session.createdAt = thread.createdAt;
      }
      if (helpers.length) {
        session.helperCount = helpers.length;
      }
      if (thread.archived) {
        session.archived = true;
      }
      const busy = this.busyReason([thread, ...helpers], locked);
      if (busy) {
        session.busy = busy;
      }
      sessions.push(session);
    }
    return sessions;
  }

  // ---------------------------------------------------------------- deleting

  async plan(session: SessionInfo): Promise<DeletionPlan> {
    const threads = await this.scan();
    const thread = threads.get(norm(session.id));
    if (session.provider !== 'codex' || !thread || thread.helper) {
      throw new Error('This Codex conversation no longer exists');
    }
    const group = [thread, ...this.helpersOf(threads, thread.id)];
    const items: PlanItem[] = group.flatMap((member) => member.files.map((file) => ({ path: file.path, isDir: false, bytes: file.size, files: 1 })));
    return {
      session,
      items,
      threadIds: group.map((member) => member.id),
      totalBytes: items.reduce((sum, item) => sum + item.bytes, 0),
      totalFiles: items.length,
    };
  }

  /**
   * Deletes the conversation and its helper threads with Codex's own `codex delete`,
   * which also clears its databases. The conversation itself goes first: if Codex
   * refuses, nothing else is touched.
   */
  async execute(plan: DeletionPlan, onProgress?: (done: number, total: number) => void): Promise<DeletionOutcome> {
    const outcome: DeletionOutcome = { session: plan.session, status: 'deleted', removed: 0, failures: [], leftovers: [] };
    const threads = await this.scan();
    const root = threads.get(norm(plan.session.id));
    if (!root || root.helper) {
      return outcome; // already gone
    }
    // Looked up again on purpose: Codex may have added review threads since the plan was made.
    const group = [root, ...this.helpersOf(threads, root.id)];
    const busy = this.busyReason(group, await this.lockedIds());
    if (busy) {
      return { ...outcome, status: 'busy', busy };
    }
    const ids = group.map((thread) => thread.id);
    await this.deleteThreads(ids, threads, outcome, true, onProgress);
    outcome.leftovers = await this.remaining(ids);
    if (outcome.leftovers.length || outcome.failures.length) {
      outcome.status = outcome.removed > 0 ? 'partial' : 'failed';
    }
    return outcome;
  }

  private async cli(): Promise<{ executable: string } | { problem: string }> {
    const executable = await this.options.findExecutable();
    if (!executable) {
      return { problem: CODEX_NOT_FOUND };
    }
    let supported = this.deleteSupport.get(executable);
    if (supported === undefined) {
      const help = await this.run(executable, ['delete', '--help']);
      supported = help.code === 0 && help.output.includes('--force');
      this.deleteSupport.set(executable, supported);
    }
    return supported ? { executable } : { problem: CODEX_DELETE_UNSUPPORTED };
  }

  private run(executable: string, args: string[]): Promise<CommandResult> {
    return (this.options.run ?? runCodex)(executable, args, { ...process.env, CODEX_HOME: this.options.home });
  }

  private async deleteThreads(
    ids: string[],
    threads: Map<string, Thread>,
    sink: { removed: number; failures: Failure[] },
    stopWhenFirstFails: boolean,
    onProgress?: (done: number, total: number) => void,
  ): Promise<void> {
    const cli = await this.cli();
    if ('problem' in cli) {
      sink.failures.push({ target: 'codex', message: cli.problem });
      return;
    }
    const done: string[] = [];
    for (const [index, id] of ids.entries()) {
      onProgress?.(index, ids.length);
      const thread = threads.get(id);
      if (!thread || !isUuid(id)) {
        continue;
      }
      if (!(await this.anyFileExists(thread))) {
        // Codex removed it together with its parent.
        sink.removed += 1;
        done.push(id);
        continue;
      }
      const result = await this.run(cli.executable, ['delete', '--force', id]);
      if (result.code === 0) {
        sink.removed += 1;
        done.push(id);
        continue;
      }
      sink.failures.push({ target: id, message: result.output || `codex delete exited with code ${result.code}` });
      if (stopWhenFirstFails && index === 0) {
        break;
      }
    }
    await this.tidy(done, sink);
  }

  private async anyFileExists(thread: Thread): Promise<boolean> {
    for (const file of thread.files) {
      if (await exists(file.path)) {
        return true;
      }
    }
    return false;
  }

  /** What `codex delete` does not take care of: prompt history lines and lock files nobody holds any more. */
  private async tidy(ids: string[], sink: { failures: Failure[] }): Promise<void> {
    if (ids.length === 0) {
      return;
    }
    const history = path.join(this.options.home, 'history.jsonl');
    try {
      await dropLines(history, (line) => ids.some((id) => line.includes(id)));
    } catch (error) {
      sink.failures.push({ target: history, message: errorMessage(error) });
    }
    const isLocked = this.options.isLocked ?? isLockHeld;
    for (const id of ids) {
      const lock = path.join(this.locks, `${id}.lock`);
      if ((await exists(lock)) && !(await isLocked(lock))) {
        await fsp.rm(lock, { force: true }).catch(() => undefined);
      }
    }
    for (const [file, header] of this.headers) {
      if (header && ids.includes(header.id)) {
        this.headers.delete(file);
      }
    }
  }

  /** Verification: anything still on disk that carries one of these thread ids. */
  private async remaining(ids: string[]): Promise<string[]> {
    const left: string[] = [];
    const candidates = [
      ...(await this.rolloutFiles(path.join(this.options.home, 'sessions'), 0)),
      ...(await this.rolloutFiles(path.join(this.options.home, 'archived_sessions'), 0)),
      ...(await listDir(this.locks)).map((entry) => path.join(this.locks, entry.name)),
    ];
    for (const candidate of candidates) {
      const name = path.basename(candidate).toLowerCase();
      if (ids.some((id) => name.includes(id))) {
        left.push(candidate);
      }
    }
    try {
      const index = await fsp.readFile(path.join(this.options.home, 'session_index.jsonl'), 'utf8');
      for (const id of ids) {
        if (index.includes(id)) {
          left.push(`session_index.jsonl: ${id}`);
        }
      }
    } catch {
      // no index
    }
    return left;
  }

  // --------------------------------------------------------------- leftovers

  /** Helper threads whose conversation is gone. They still hold copies of what was said in it. */
  private orphans(threads: Map<string, Thread>, locked: Set<string>): Thread[] {
    const now = this.now();
    const orphaned = new Set<string>();
    for (let grew = true; grew; ) {
      grew = false;
      for (const thread of threads.values()) {
        if (!thread.helper || orphaned.has(thread.id) || thread.rootId === thread.id) {
          continue;
        }
        const rootGone = !threads.has(thread.rootId) || orphaned.has(thread.rootId);
        const parentGone = thread.parentId === undefined || !threads.has(thread.parentId) || orphaned.has(thread.parentId);
        if (rootGone && parentGone) {
          orphaned.add(thread.id);
          grew = true;
        }
      }
    }
    return [...threads.values()].filter(
      (thread) => orphaned.has(thread.id) && !locked.has(thread.id) && thread.files.every((file) => now - file.mtimeMs > DAY_MS),
    );
  }

  async leftovers(): Promise<LeftoverGroup[]> {
    const orphans = this.orphans(await this.scan(), await this.lockedIds());
    if (orphans.length === 0) {
      return [];
    }
    const items: PlanItem[] = orphans.flatMap((thread) => thread.files.map((file) => ({ path: file.path, isDir: false, bytes: file.size, files: 1 })));
    return [
      {
        kind: 'codex.orphanThreads',
        items,
        threadIds: orphans.map((thread) => thread.id),
        totalBytes: items.reduce((sum, item) => sum + item.bytes, 0),
        totalFiles: items.length,
      },
    ];
  }

  async cleanLeftovers(onProgress?: (done: number, total: number) => void): Promise<CleanResult> {
    const threads = await this.scan();
    const ids = this.orphans(threads, await this.lockedIds()).map((thread) => thread.id);
    const result: CleanResult = { removed: 0, failures: [] };
    if (ids.length) {
      await this.deleteThreads(ids, threads, result, false, onProgress);
    }
    return result;
  }
}
