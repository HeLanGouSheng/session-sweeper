import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  dropLines,
  errorMessage,
  exists,
  isDirectory,
  isUuid,
  listDir,
  mapLimit,
  norm,
  readFirstLine,
  readHead,
  readTail,
  removeEmptyTree,
  statOrNull,
  treeStats,
  uuidsIn,
} from './fsx';
import { type ProcessTable, listProcesses, looksLikeClaude, pidAlive } from './processes';
import { asObject, asString, contentText, parseJsonObject, promptToTitle } from './text';
import type {
  BusyReason,
  CleanResult,
  DeletionOutcome,
  DeletionPlan,
  Failure,
  LeftoverGroup,
  LeftoverKind,
  PlanItem,
  Remover,
  SessionInfo,
} from './types';

const DAY_MS = 86_400_000;
/** A transcript written to this recently is treated as in use. */
const RECENT_MS = 30_000;
/** Top-level folders of the data dir that never hold per-conversation data and can be large. */
const SKIP_TOP_LEVEL = new Set(['projects', 'plugins', 'skills', 'cache', 'local', 'node_modules', '.git']);
const MAX_DEPTH = 3;
/** Claude Code re-appends the title near the end of the transcript, so the tail is read first. */
const TAIL_STEPS = [64 * 1024, 1024 * 1024, 8 * 1024 * 1024];
const HEAD_BYTES = 256 * 1024;
/** Files inside a data folder can grow without its fingerprint changing, so measurements expire. */
const SIZE_TTL_MS = 10 * 60_000;

export interface ClaudeStoreOptions {
  /** The Claude Code data folder, usually `~/.claude`. */
  home: string;
  /** Folders that hold `<project>/<conversation id>/` temp folders. */
  tempRoots: string[];
  now?: () => number;
  processes?: () => Promise<ProcessTable | undefined>;
  isAlive?: (pid: number) => boolean;
  platform?: NodeJS.Platform;
}

interface Meta {
  title: string;
  cwds: string[];
  createdAt?: number;
}

interface Located {
  slug: string;
  id: string;
  file: string;
}

/** The name Claude Code gives the storage folder of a working directory. */
export function projectFolderName(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

export function defaultClaudeTempRoots(platform: NodeJS.Platform = process.platform): string[] {
  const roots = [path.join(os.tmpdir(), 'claude')];
  if (platform !== 'win32') {
    const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
    for (const base of [os.tmpdir(), '/tmp', '/private/tmp']) {
      roots.push(path.join(base, 'claude'));
      if (uid !== undefined) {
        roots.push(path.join(base, `claude-${uid}`));
      }
    }
  }
  return [...new Set(roots)];
}

/** The last custom title and the last generated title found in a piece of transcript. */
export function scanTitles(text: string): { custom?: string; generated?: string } {
  const found: { custom?: string; generated?: string } = {};
  for (const line of text.split('\n')) {
    if (line.length > 8192 || !(line.includes('"customTitle"') || line.includes('"aiTitle"'))) {
      continue;
    }
    const entry = parseJsonObject(line);
    if (entry?.type === 'custom-title' && typeof entry.customTitle === 'string') {
      found.custom = entry.customTitle;
    } else if (entry?.type === 'ai-title' && typeof entry.aiTitle === 'string') {
      found.generated = entry.aiTitle;
    }
  }
  return found;
}

/** The first thing the user typed, as a short label. */
export function firstPrompt(text: string): string {
  for (const line of text.split('\n')) {
    if (!line.includes('"type":"user"')) {
      continue;
    }
    const entry = parseJsonObject(line);
    if (!entry || entry.type !== 'user' || entry.isMeta === true || entry.isSidechain === true) {
      continue;
    }
    const title = promptToTitle(contentText(asObject(entry.message)?.content));
    if (title) {
      return title;
    }
  }
  return '';
}

function scanCwds(text: string, into: Set<string>): void {
  for (const match of text.matchAll(/"cwd":"((?:[^"\\]|\\.)*)"/g)) {
    if (into.size >= 32) {
      return;
    }
    try {
      into.add(JSON.parse(`"${match[1]}"`) as string);
    } catch {
      // not a plain JSON string, ignore
    }
  }
}

export class ClaudeStore {
  private readonly metaCache = new Map<string, { size: number; mtimeMs: number; meta: Meta }>();
  private readonly legacyOwner = new Map<string, string | null>();
  private readonly dataSizes = new Map<string, { signature: string; bytes: number; at: number }>();

  constructor(private readonly options: ClaudeStoreOptions) {}

  get home(): string {
    return this.options.home;
  }

  private get projects(): string {
    return path.join(this.options.home, 'projects');
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  async available(): Promise<boolean> {
    return isDirectory(this.projects);
  }

  // ---------------------------------------------------------------- listing

  async list(): Promise<SessionInfo[]> {
    const { busy } = await this.inUse();
    const found: Located[] = [];
    for (const slug of await this.projectFolders()) {
      for (const entry of await listDir(path.join(this.projects, slug))) {
        if (!entry.isFile() || !entry.name.endsWith('.jsonl')) {
          continue;
        }
        const id = entry.name.slice(0, -'.jsonl'.length);
        if (isUuid(id)) {
          found.push({ slug, id, file: path.join(this.projects, slug, entry.name) });
        }
      }
    }
    const copies = new Map<string, number>();
    for (const item of found) {
      copies.set(norm(item.id), (copies.get(norm(item.id)) ?? 0) + 1);
    }
    const now = this.now();
    const sessions = await mapLimit(found, 8, async (item): Promise<SessionInfo | undefined> => {
      const st = await statOrNull(item.file);
      if (!st) {
        return undefined;
      }
      const meta = await this.meta(item.file, st.size, st.mtimeMs);
      const slugLower = item.slug.toLowerCase();
      const session: SessionInfo = {
        provider: 'claude',
        key: `${item.slug}/${item.id}`,
        id: item.id,
        title: meta.title,
        groupKey: item.slug,
        modifiedAt: st.mtimeMs,
        sizeBytes: st.size,
        transcripts: [item.file],
      };
      const cwd = meta.cwds.find((candidate) => projectFolderName(candidate).toLowerCase() === slugLower);
      if (cwd) {
        session.cwd = cwd;
      }
      const createdAt = meta.createdAt ?? (st.birthtimeMs > 0 ? st.birthtimeMs : undefined);
      if (createdAt !== undefined) {
        session.createdAt = createdAt;
      }
      const data = await this.dataFolderSize(item.file);
      if (data === undefined) {
        session.sizePending = true;
      } else {
        session.sizeBytes += data;
      }
      const reason = busy.get(norm(item.id)) ?? (now - st.mtimeMs < RECENT_MS ? 'recent' : undefined);
      if (reason) {
        session.busy = reason;
      }
      const others = (copies.get(norm(item.id)) ?? 1) - 1;
      if (others > 0) {
        session.otherCopies = others;
      }
      return session;
    });
    return sessions.filter((session): session is SessionInfo => session !== undefined);
  }

  private async projectFolders(): Promise<string[]> {
    return (await listDir(this.projects)).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  }

  /**
   * A cheap fingerprint of a conversation's data folder: it changes whenever something
   * is added to or removed from the folder or one of its direct sub-folders.
   */
  private async dataFolderSignature(folder: string): Promise<string | null> {
    const top = await statOrNull(folder);
    if (!top?.isDirectory()) {
      return null;
    }
    const parts = [String(top.mtimeMs)];
    for (const entry of await listDir(folder)) {
      const st = await statOrNull(path.join(folder, entry.name));
      parts.push(`${entry.name}:${st?.mtimeMs ?? 0}:${st?.size ?? 0}`);
    }
    return parts.join('|');
  }

  /** Size of the data folder next to a transcript: 0 when there is none, undefined when it still has to be measured. */
  private async dataFolderSize(transcript: string): Promise<number | undefined> {
    const folder = transcript.slice(0, -'.jsonl'.length);
    const signature = await this.dataFolderSignature(folder);
    if (signature === null) {
      return 0;
    }
    const cached = this.dataSizes.get(folder);
    return cached && cached.signature === signature && this.now() - cached.at < SIZE_TTL_MS ? cached.bytes : undefined;
  }

  /**
   * Measures the data folder of a row listed with `sizePending` and returns the row's full size.
   * Kept out of `list()` because such a folder can hold thousands of files.
   */
  async measure(session: SessionInfo): Promise<number> {
    const { file } = this.locate(session);
    const folder = file.slice(0, -'.jsonl'.length);
    const signature = await this.dataFolderSignature(folder);
    const transcript = (await statOrNull(file))?.size ?? 0;
    if (signature === null) {
      return transcript;
    }
    const bytes = (await treeStats(folder))?.bytes ?? 0;
    this.dataSizes.set(folder, { signature, bytes, at: this.now() });
    return transcript + bytes;
  }

  private async meta(file: string, size: number, mtimeMs: number): Promise<Meta> {
    const cached = this.metaCache.get(file);
    if (cached && cached.size === size && cached.mtimeMs === mtimeMs) {
      return cached.meta;
    }
    const meta: Meta = { title: '', cwds: [] };
    try {
      const cwds = new Set<string>();
      let recentText = '';
      for (const [index, bytes] of TAIL_STEPS.entries()) {
        const text = (await readTail(file, bytes)).toString('utf8');
        if (index === 0) {
          recentText = text;
        }
        const titles = scanTitles(text);
        meta.title = titles.custom || titles.generated || '';
        if (meta.title || bytes >= size) {
          break;
        }
      }
      const headText = (await readHead(file, HEAD_BYTES)).toString('utf8');
      if (!meta.title) {
        const titles = scanTitles(headText);
        meta.title = titles.custom || titles.generated || firstPrompt(headText);
      }
      // Recent lines first: a transcript copied to another folder still starts with the old folder's lines.
      scanCwds(recentText, cwds);
      scanCwds(headText, cwds);
      meta.cwds = [...cwds];
      const timestamp = /"timestamp":"(\d{4}-\d{2}-\d{2}T[^"]+)"/.exec(headText);
      const created = timestamp ? Date.parse(timestamp[1] as string) : NaN;
      if (!Number.isNaN(created)) {
        meta.createdAt = created;
      }
    } catch {
      // The file vanished or cannot be read; it is listed without details.
    }
    this.metaCache.set(file, { size, mtimeMs, meta });
    return meta;
  }

  // ------------------------------------------------------------------ in use

  /**
   * `busy`: conversations a running Claude Code process has open.
   * `registered`: every conversation some live process id is registered for, even
   * if that process does not look like Claude Code. Used to stay clear of them when sweeping leftovers.
   */
  private async inUse(): Promise<{ busy: Map<string, BusyReason>; registered: Set<string> }> {
    const busy = new Map<string, BusyReason>();
    const registered = new Set<string>();
    const isAlive = this.options.isAlive ?? pidAlive;
    const alive: { pid: number; sessionId: string }[] = [];
    for (const entry of await listDir(path.join(this.options.home, 'sessions'))) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) {
        continue;
      }
      try {
        const raw = await fsp.readFile(path.join(this.options.home, 'sessions', entry.name), 'utf8');
        const data = asObject(JSON.parse(raw) as unknown);
        const pid = data?.pid;
        const sessionId = asString(data?.sessionId);
        if (typeof pid === 'number' && sessionId && isAlive(pid)) {
          alive.push({ pid, sessionId: norm(sessionId) });
        }
      } catch {
        // unreadable registration, ignore
      }
    }
    if (alive.length === 0) {
      return { busy, registered };
    }
    const platform = this.options.platform ?? process.platform;
    const table = await (this.options.processes ?? (() => listProcesses(platform)))();
    for (const { pid, sessionId } of alive) {
      registered.add(sessionId);
      const description = table?.get(pid);
      if (table && description === undefined) {
        continue; // exited in the meantime
      }
      if (!table || looksLikeClaude(description as string, platform)) {
        busy.set(sessionId, 'process');
      }
    }
    return { busy, registered };
  }

  private async busyReason(id: string, file: string): Promise<BusyReason | undefined> {
    const { busy } = await this.inUse();
    const reason = busy.get(norm(id));
    if (reason) {
      return reason;
    }
    const st = await statOrNull(file);
    return st && this.now() - st.mtimeMs < RECENT_MS ? 'recent' : undefined;
  }

  // ---------------------------------------------------------------- planning

  private locate(session: SessionInfo): Located {
    const file = session.transcripts[0];
    if (session.provider !== 'claude' || !file) {
      throw new Error('Not a Claude Code conversation');
    }
    const folder = path.dirname(file);
    if (path.dirname(folder) !== this.projects || path.basename(file) !== `${session.id}.jsonl` || !isUuid(session.id)) {
      throw new Error(`Unexpected transcript location: ${file}`);
    }
    return { slug: path.basename(folder), id: session.id, file };
  }

  /**
   * What goes away with this row.
   * `alreadyGone` lists rows that will have been deleted before this one in the same
   * batch, so that data shared between copies is attributed to the last copy.
   */
  async plan(session: SessionInfo, alreadyGone: readonly SessionInfo[] = []): Promise<DeletionPlan> {
    const { slug, id } = this.locate(session);
    const gone = new Set(alreadyGone.filter((other) => other.provider === 'claude').map((other) => other.key));
    const paths = await this.artifactPaths(slug, id, gone);
    const items = (
      await mapLimit(paths, 8, async (target): Promise<PlanItem | undefined> => {
        const stats = await treeStats(target);
        return stats ? { path: target, isDir: stats.isDir, bytes: stats.bytes, files: stats.files } : undefined;
      })
    ).filter((item): item is PlanItem => item !== undefined);
    return {
      session,
      items,
      totalBytes: items.reduce((sum, item) => sum + item.bytes, 0),
      totalFiles: items.reduce((sum, item) => sum + item.files, 0),
    };
  }

  private async artifactPaths(slug: string, id: string, gone: ReadonlySet<string> = new Set()): Promise<string[]> {
    const wanted = norm(id);
    const found = new Set<string>();
    const folders = await this.projectFolders();
    await this.collectInProject(slug, wanted, found);
    let otherCopy = false;
    for (const other of folders) {
      if (other !== slug && !gone.has(`${other}/${id}`) && (await exists(path.join(this.projects, other, `${id}.jsonl`)))) {
        otherCopy = true;
      }
    }
    if (!otherCopy) {
      // Last copy: everything else that carries this conversation's id goes too.
      for (const other of folders) {
        if (other !== slug && !gone.has(`${other}/${id}`)) {
          await this.collectInProject(other, wanted, found);
        }
      }
      await this.collectInHome(this.options.home, 1, wanted, found);
      for (const root of await this.tempRoots()) {
        for (const project of await listDir(root)) {
          if (!project.isDirectory()) {
            continue;
          }
          for (const entry of await listDir(path.join(root, project.name))) {
            if (entry.isDirectory() && norm(entry.name) === wanted) {
              found.add(path.join(root, project.name, entry.name));
            }
          }
        }
      }
    }
    return [...found].sort();
  }

  private async collectInProject(slug: string, wanted: string, found: Set<string>): Promise<void> {
    const folder = path.join(this.projects, slug);
    for (const entry of await listDir(folder)) {
      const full = path.join(folder, entry.name);
      if (uuidsIn(entry.name).includes(wanted)) {
        found.add(full);
      } else if (entry.isFile() && /^agent-.+\.jsonl$/i.test(entry.name) && (await this.ownerOfLegacyAgentFile(full)) === wanted) {
        // Older Claude Code versions kept sub-agent transcripts next to the main one.
        found.add(full);
      }
    }
  }

  private async ownerOfLegacyAgentFile(file: string): Promise<string | null> {
    const cached = this.legacyOwner.get(file);
    if (cached !== undefined) {
      return cached;
    }
    let owner: string | null = null;
    try {
      const first = await readFirstLine(file, 1024 * 1024);
      const sessionId = asString(parseJsonObject(first ?? '')?.sessionId);
      owner = sessionId && isUuid(sessionId) ? norm(sessionId) : null;
    } catch {
      owner = null;
    }
    this.legacyOwner.set(file, owner);
    return owner;
  }

  private async collectInHome(dir: string, depth: number, wanted: string, found: Set<string>): Promise<void> {
    for (const entry of await listDir(dir)) {
      if (depth === 1 && SKIP_TOP_LEVEL.has(entry.name)) {
        continue;
      }
      const full = path.join(dir, entry.name);
      if (uuidsIn(entry.name).includes(wanted)) {
        found.add(full);
      } else if (entry.isDirectory() && depth < MAX_DEPTH) {
        await this.collectInHome(full, depth + 1, wanted, found);
      }
    }
  }

  /** Existing temp roots, each listed once even when reachable under two names. */
  private async tempRoots(): Promise<string[]> {
    const roots = new Set<string>();
    for (const root of this.options.tempRoots) {
      try {
        if (await isDirectory(root)) {
          roots.add(await fsp.realpath(root));
        }
      } catch {
        // not there, skip
      }
    }
    return [...roots];
  }

  // ---------------------------------------------------------------- deleting

  async execute(plan: DeletionPlan, remove: Remover): Promise<DeletionOutcome> {
    const { session } = plan;
    const { slug, id, file } = this.locate(session);
    const outcome: DeletionOutcome = { session, status: 'deleted', removed: 0, failures: [], leftovers: [] };
    const busy = await this.busyReason(id, file);
    if (busy) {
      return { ...outcome, status: 'busy', busy };
    }
    // Looked up again on purpose: another copy may have been deleted since the plan was made,
    // which makes this the last copy and the shared data part of the job.
    const paths = await this.artifactPaths(slug, id);
    const sharedIncluded = !(await this.hasOtherCopy(slug, id));
    // The transcript goes last, so an interrupted run leaves a row that can simply be deleted again.
    paths.sort((a, b) => Number(a === file) - Number(b === file));
    for (const target of paths) {
      const st = await statOrNull(target);
      if (!st) {
        continue;
      }
      await this.attempt(target, () => remove(target, st.isDirectory()), outcome);
    }
    await this.attempt(path.join(this.projects, slug, 'sessions-index.json'), () => this.forgetInIndex(slug, id), outcome, false);
    if (sharedIncluded) {
      const history = path.join(this.options.home, 'history.jsonl');
      const wanted = norm(id);
      await this.attempt(
        history,
        () => dropLines(history, (line) => norm(asString(parseJsonObject(line)?.sessionId) ?? '') === wanted),
        outcome,
        false,
      );
    }
    this.metaCache.delete(file);
    outcome.leftovers = await this.artifactPaths(slug, id);
    if (outcome.leftovers.length || outcome.failures.length) {
      outcome.status = outcome.removed > 0 ? 'partial' : 'failed';
    }
    return outcome;
  }

  private async attempt(target: string, action: () => Promise<unknown>, outcome: DeletionOutcome, counts = true): Promise<void> {
    try {
      await action();
      if (counts) {
        outcome.removed += 1;
      }
    } catch (error) {
      if (counts && !(await exists(target))) {
        outcome.removed += 1;
      } else {
        outcome.failures.push({ target, message: errorMessage(error) });
      }
    }
  }

  private async hasOtherCopy(slug: string, id: string): Promise<boolean> {
    for (const other of await this.projectFolders()) {
      if (other !== slug && (await exists(path.join(this.projects, other, `${id}.jsonl`)))) {
        return true;
      }
    }
    return false;
  }

  /** Older Claude Code versions kept a per-project index with each conversation's first prompt and summary. */
  private async forgetInIndex(slug: string, id: string): Promise<void> {
    const file = path.join(this.projects, slug, 'sessions-index.json');
    if (!(await exists(file))) {
      return;
    }
    const raw = await fsp.readFile(file, 'utf8');
    const index = asObject(JSON.parse(raw) as unknown);
    if (!index || !Array.isArray(index.entries)) {
      return;
    }
    const wanted = norm(id);
    const kept = index.entries.filter((entry: unknown) => norm(asString(asObject(entry)?.sessionId) ?? '') !== wanted);
    if (kept.length === index.entries.length) {
      return;
    }
    index.entries = kept;
    const temp = `${file}.sweeper-${process.pid}.tmp`;
    await fsp.writeFile(temp, JSON.stringify(index, null, raw.includes('\n') ? 2 : undefined));
    await fsp.rename(temp, file);
  }

  // --------------------------------------------------------------- leftovers

  /** Things left behind by conversations that no longer exist. Nothing younger than a day is reported. */
  async leftovers(): Promise<LeftoverGroup[]> {
    const live = await this.liveIds();
    const now = this.now();
    const isOld = (mtimeMs: number): boolean => now - mtimeMs > DAY_MS;
    const groups: Record<'claude.emptyTemp' | 'claude.orphanTemp' | 'claude.orphanData', PlanItem[]> = {
      'claude.emptyTemp': [],
      'claude.orphanTemp': [],
      'claude.orphanData': [],
    };
    const consider = async (target: string, emptyKind: 'claude.emptyTemp' | undefined, kind: 'claude.orphanTemp' | 'claude.orphanData') => {
      const stats = await treeStats(target);
      if (!stats || !isOld(stats.newestMtimeMs)) {
        return;
      }
      const item: PlanItem = { path: target, isDir: stats.isDir, bytes: stats.bytes, files: stats.files };
      groups[emptyKind && stats.isDir && stats.files === 0 ? emptyKind : kind].push(item);
    };

    for (const root of await this.tempRoots()) {
      for (const project of await listDir(root)) {
        if (!project.isDirectory()) {
          continue;
        }
        const projectPath = path.join(root, project.name);
        const entries = await listDir(projectPath);
        if (entries.length === 0) {
          await consider(projectPath, 'claude.emptyTemp', 'claude.orphanTemp');
          continue;
        }
        for (const entry of entries) {
          if (entry.isDirectory() && isUuid(entry.name) && !live.has(norm(entry.name))) {
            await consider(path.join(projectPath, entry.name), 'claude.emptyTemp', 'claude.orphanTemp');
          }
        }
      }
    }

    for (const folder of ['file-history', 'session-env']) {
      for (const entry of await listDir(path.join(this.options.home, folder))) {
        if (isUuid(entry.name) && !live.has(norm(entry.name))) {
          await consider(path.join(this.options.home, folder, entry.name), undefined, 'claude.orphanData');
        }
      }
    }
    for (const entry of await listDir(path.join(this.options.home, 'telemetry'))) {
      const ids = uuidsIn(entry.name);
      if (entry.isFile() && ids.length > 0 && !ids.some((id) => live.has(id))) {
        await consider(path.join(this.options.home, 'telemetry', entry.name), undefined, 'claude.orphanData');
      }
    }
    for (const slug of await this.projectFolders()) {
      for (const entry of await listDir(path.join(this.projects, slug))) {
        if (entry.isDirectory() && isUuid(entry.name) && !live.has(norm(entry.name))) {
          await consider(path.join(this.projects, slug, entry.name), undefined, 'claude.orphanData');
        }
      }
    }

    return (Object.keys(groups) as (keyof typeof groups)[])
      .filter((kind) => groups[kind].length > 0)
      .map((kind) => ({
        kind,
        items: groups[kind],
        totalBytes: groups[kind].reduce((sum, item) => sum + item.bytes, 0),
        totalFiles: groups[kind].reduce((sum, item) => sum + item.files, 0),
      }));
  }

  /** Ids of every conversation that still has a transcript, plus the ones a live process is registered for. */
  private async liveIds(): Promise<Set<string>> {
    const { registered } = await this.inUse();
    const live = new Set(registered);
    for (const slug of await this.projectFolders()) {
      for (const entry of await listDir(path.join(this.projects, slug))) {
        if (entry.name.endsWith('.jsonl')) {
          for (const id of uuidsIn(entry.name)) {
            live.add(id);
          }
        }
      }
    }
    return live;
  }

  async cleanLeftovers(kind: LeftoverKind, remove: Remover, onProgress?: (done: number, total: number) => void): Promise<CleanResult> {
    const failures: Failure[] = [];
    let removed = 0;
    // Detected again right before acting, so nothing that came back to life is touched.
    const group = (await this.leftovers()).find((candidate) => candidate.kind === kind);
    if (!group) {
      return { removed, failures };
    }
    for (const [index, item] of group.items.entries()) {
      onProgress?.(index, group.items.length);
      try {
        if (kind === 'claude.emptyTemp') {
          if (!(await removeEmptyTree(item.path))) {
            throw new Error('The folder is no longer empty');
          }
        } else {
          await remove(item.path, item.isDir);
        }
        removed += 1;
      } catch (error) {
        if (await exists(item.path)) {
          failures.push({ target: item.path, message: errorMessage(error) });
        } else {
          removed += 1;
        }
      }
    }
    if (kind !== 'claude.orphanData') {
      // Project-level temp folders that are empty now can go as well. `rmdir` refuses anything non-empty.
      const roots = await this.tempRoots();
      for (const parent of new Set(group.items.map((item) => path.dirname(item.path)))) {
        if (roots.includes(path.dirname(parent))) {
          await fsp.rmdir(parent).catch(() => undefined);
        }
      }
    }
    return { removed, failures };
  }
}
