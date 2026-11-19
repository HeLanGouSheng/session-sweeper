import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach } from 'vitest';
import type { CodexRunner } from '../../src/core/codex';

const created: string[] = [];

/** A fresh scratch folder, removed after the test. */
export function scratch(prefix = 'sweeper-'): string {
  // The native variant also expands Windows short names (LONGNA~1), like the code under test does.
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  created.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of created.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

export const DAY = 86_400_000;

export function write(file: string, content: string): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

export function mkdir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Makes a file or folder (and everything inside it) look as if it was last touched `ms` ago. */
export function age(target: string, ms: number): void {
  const when = new Date(Date.now() - ms);
  const visit = (current: string): void => {
    if (fs.lstatSync(current).isDirectory()) {
      for (const name of fs.readdirSync(current)) {
        visit(path.join(current, name));
      }
    }
    fs.utimesSync(current, when, when);
  };
  visit(target);
}

export function tree(root: string): string[] {
  const out: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        out.push(`${path.relative(root, full).split(path.sep).join('/')}/`);
        visit(full);
      } else {
        out.push(path.relative(root, full).split(path.sep).join('/'));
      }
    }
  };
  if (fs.existsSync(root)) {
    visit(root);
  }
  return out.sort();
}

export const uuid = (n: number): string => `${String(n).padStart(8, '0')}-1111-4222-8333-444444444444`;

// --------------------------------------------------------------------- Claude

export interface ClaudeSessionSpec {
  slug: string;
  id: string;
  cwd?: string;
  prompt?: string;
  aiTitle?: string;
  customTitle?: string;
  ageMs?: number;
  reply?: string;
}

export class ClaudeFixture {
  readonly home: string;
  readonly temp: string;

  constructor() {
    const root = scratch('sweeper-claude-');
    this.home = mkdir(path.join(root, 'dot-claude'));
    this.temp = mkdir(path.join(root, 'temp', 'claude'));
    mkdir(path.join(this.home, 'projects'));
  }

  transcriptPath(slug: string, id: string): string {
    return path.join(this.home, 'projects', slug, `${id}.jsonl`);
  }

  session(spec: ClaudeSessionSpec): string {
    const cwd = spec.cwd ?? `/work/${spec.slug}`;
    const base = { isSidechain: false, cwd, sessionId: spec.id, version: '2.1.0' };
    const lines: unknown[] = [
      { type: 'queue-operation', operation: 'enqueue', timestamp: '2026-01-02T03:04:05.000Z', sessionId: spec.id },
      {
        parentUuid: null,
        ...base,
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: `<system-reminder>memory index: secret-note</system-reminder>${spec.prompt ?? 'Hello there'}` }] },
        uuid: 'u1',
        timestamp: '2026-01-02T03:04:05.100Z',
      },
      { type: 'api-request-blob', sessionId: spec.id, hash: 'h', message: { role: 'user', content: [{ type: 'text', text: 'request-bookkeeping-only' }] } },
      {
        parentUuid: 'u1',
        ...base,
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: spec.reply ?? 'General Kenobi' }] },
        uuid: 'a1',
        timestamp: '2026-01-02T03:04:06.000Z',
      },
      {
        parentUuid: 'a1',
        ...base,
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] },
        uuid: 'a2',
        timestamp: '2026-01-02T03:04:07.000Z',
      },
      {
        parentUuid: 'a2',
        ...base,
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'tool-output-only' }] },
        uuid: 'u2',
        timestamp: '2026-01-02T03:04:08.000Z',
      },
    ];
    if (spec.aiTitle !== undefined) {
      lines.push({ type: 'ai-title', aiTitle: spec.aiTitle, sessionId: spec.id });
    }
    if (spec.customTitle !== undefined) {
      lines.push({ type: 'custom-title', sessionId: spec.id, customTitle: spec.customTitle });
    }
    const file = write(this.transcriptPath(spec.slug, spec.id), `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
    age(file, spec.ageMs ?? 2 * DAY);
    return file;
  }

  /** Everything else Claude Code keeps for a conversation. */
  extras(slug: string, id: string): void {
    write(path.join(this.home, 'projects', slug, id, 'subagents', 'agent-abc.jsonl'), '{"x":1}\n');
    write(path.join(this.home, 'projects', slug, id, 'tool-results', 'out.txt'), 'output');
    write(path.join(this.home, 'file-history', id, 'deadbeef@v1'), 'old file content');
    mkdir(path.join(this.home, 'session-env', id));
    write(path.join(this.home, 'telemetry', `1p_failed_events.${id}.${uuid(999)}.json`), '[]');
  }

  tempDir(project: string, id: string, files = true): string {
    const dir = mkdir(path.join(this.temp, project, id));
    mkdir(path.join(dir, 'scratchpad'));
    mkdir(path.join(dir, 'tasks'));
    if (files) {
      write(path.join(dir, 'scratchpad', 'script.ps1'), 'x');
      write(path.join(dir, 'tasks', 'b1.output'), 'y');
    }
    return dir;
  }

  register(pid: number, sessionId: string): void {
    write(path.join(this.home, 'sessions', `${pid}.json`), JSON.stringify({ pid, sessionId, cwd: '/work', startedAt: 1 }));
  }

  memory(slug: string): string {
    return write(path.join(this.home, 'projects', slug, 'memory', 'MEMORY.md'), '- note\n');
  }
}

// ---------------------------------------------------------------------- Codex

export interface CodexThreadSpec {
  id: string;
  /** Conversation this thread belongs to (defaults to itself). */
  root?: string;
  parent?: string;
  kind?: 'user' | 'guardian' | 'spawn';
  cwd?: string;
  name?: string;
  prompt?: string;
  ageMs?: number;
  archived?: boolean;
}

export class CodexFixture {
  readonly home: string;
  /** Thread ids `codex delete` refuses, as if they were loaded in a running Codex. */
  readonly refuse = new Set<string>();
  readonly calls: string[][] = [];
  private readonly files = new Map<string, string>();
  private readonly specs = new Map<string, CodexThreadSpec>();
  executable: string | undefined = 'codex-stub';
  supportsDelete = true;

  constructor() {
    this.home = mkdir(path.join(scratch('sweeper-codex-'), 'dot-codex'));
    mkdir(path.join(this.home, 'sessions'));
  }

  thread(spec: CodexThreadSpec): string {
    const kind = spec.kind ?? 'user';
    const source =
      kind === 'user'
        ? 'vscode'
        : kind === 'guardian'
          ? { subagent: { other: 'guardian' } }
          : { subagent: { thread_spawn: { parent_thread_id: spec.parent ?? spec.root, depth: 1 } } };
    const payload: Record<string, unknown> = {
      session_id: spec.root ?? spec.id,
      id: spec.id,
      timestamp: '2026-01-02T03:04:05.000Z',
      cwd: spec.cwd ?? 'D:\\work\\demo',
      source,
    };
    if (kind !== 'user') {
      payload.parent_thread_id = spec.parent ?? spec.root;
    }
    const lines: unknown[] = [
      { timestamp: '2026-01-02T03:04:05.000Z', type: 'session_meta', payload },
      {
        timestamp: '2026-01-02T03:04:05.500Z',
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>cwd</environment_context>' }] },
      },
      {
        timestamp: '2026-01-02T03:04:06.000Z',
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: spec.prompt ?? 'Fix the router' }] },
      },
      { timestamp: '2026-01-02T03:04:07.000Z', type: 'response_item', payload: { type: 'function_call', name: 'exec', arguments: '{}', call_id: 'c1' } },
      {
        timestamp: '2026-01-02T03:04:08.000Z',
        type: 'response_item',
        payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Router fixed' }] },
      },
      { timestamp: '2026-01-02T03:04:09.000Z', type: 'event_msg', payload: { type: 'token_count', info: {} } },
    ];
    const folder = spec.archived ? path.join(this.home, 'archived_sessions') : path.join(this.home, 'sessions', '2026', '01', '02');
    const file = write(path.join(folder, `rollout-2026-01-02T03-04-05-${spec.id}.jsonl`), `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
    age(file, spec.ageMs ?? 2 * DAY);
    this.files.set(spec.id, file);
    this.specs.set(spec.id, spec);
    if (spec.name) {
      fs.appendFileSync(path.join(this.home, 'session_index.jsonl'), `${JSON.stringify({ id: spec.id, thread_name: spec.name, updated_at: '2026-01-02T03:04:05Z' })}\n`);
    }
    return file;
  }

  lock(id: string): string {
    return write(path.join(this.home, 'thread-writer-locks', `${id}.lock`), '');
  }

  history(id: string, text: string): void {
    fs.appendFileSync(path.join(this.home, 'history.jsonl'), `${JSON.stringify({ session_id: id, ts: 1, text })}\n`);
  }

  /** Behaves like `codex delete`: removes the thread, its index line and the sub-agents it spawned, but not review threads. */
  readonly run: CodexRunner = async (_executable, args, env) => {
    this.calls.push(args);
    if (env.CODEX_HOME !== this.home) {
      return { code: 1, output: 'wrong CODEX_HOME' };
    }
    if (args[0] === 'delete' && args[1] === '--help') {
      return this.supportsDelete ? { code: 0, output: 'Usage: codex delete [OPTIONS] <SESSION>\n      --force' } : { code: 2, output: "error: unrecognized subcommand 'delete'" };
    }
    const id = args[2] as string;
    if (args[0] !== 'delete' || args[1] !== '--force' || !this.files.has(id)) {
      return { code: 1, output: 'Error: session not found' };
    }
    if (this.refuse.has(id)) {
      return { code: 1, output: 'Error: failed to delete session' };
    }
    const remove = (target: string): void => {
      fs.rmSync(this.files.get(target) as string, { force: true });
      const index = path.join(this.home, 'session_index.jsonl');
      if (fs.existsSync(index)) {
        fs.writeFileSync(
          index,
          fs
            .readFileSync(index, 'utf8')
            .split('\n')
            .filter((line) => !line.includes(target))
            .join('\n'),
        );
      }
    };
    remove(id);
    for (const [childId, child] of this.specs) {
      if (child.kind === 'spawn' && (child.parent ?? child.root) === id) {
        remove(childId);
      }
    }
    return { code: 0, output: `Deleted session ${id}` };
  };
}
