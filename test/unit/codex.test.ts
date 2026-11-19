import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { CODEX_DELETE_UNSUPPORTED, CODEX_NOT_FOUND, CodexStore, isLockHeld } from '../../src/core/codex';
import type { SessionInfo } from '../../src/core/types';
import { CodexFixture, DAY, scratch, tree, uuid, write } from './helpers';

const P = uuid(1); // a conversation
const G1 = uuid(2); // its review threads
const G2 = uuid(3);
const S1 = uuid(4); // a sub-agent it spawned
const S1G = uuid(5); // review thread of that sub-agent
const Q = uuid(6); // another conversation

function open(fixture: CodexFixture, locked: string[] = []): CodexStore {
  return new CodexStore({
    home: fixture.home,
    findExecutable: async () => fixture.executable,
    run: fixture.run,
    isLocked: async (file) => locked.some((id) => file.endsWith(`${id}.lock`)),
  });
}

function populated(): CodexFixture {
  const fixture = new CodexFixture();
  fixture.thread({ id: P, name: 'Router tricks', cwd: 'D:\\Work\\Demo' });
  fixture.thread({ id: G1, root: P, kind: 'guardian' });
  fixture.thread({ id: G2, root: P, kind: 'guardian' });
  fixture.thread({ id: S1, root: P, parent: P, kind: 'spawn' });
  fixture.thread({ id: S1G, root: P, parent: S1, kind: 'guardian' });
  fixture.thread({ id: Q, prompt: 'Summarise   the\nweek', archived: true });
  fixture.thread({ id: uuid(7), root: Q, kind: 'guardian' });
  fixture.history(P, 'about p');
  fixture.history(Q, 'about q');
  return fixture;
}

async function row(store: CodexStore, id: string): Promise<SessionInfo> {
  const found = (await store.list()).find((session) => session.id === id);
  if (!found) {
    throw new Error(`no row for ${id}`);
  }
  return found;
}

describe('listing', () => {
  it('shows conversations only, with their helper threads counted', async () => {
    const fixture = populated();
    const list = await open(fixture).list();
    expect(list.map((session) => session.id).sort()).toEqual([P, Q]);
    const first = await row(open(fixture), P);
    expect(first).toMatchObject({ provider: 'codex', key: P, title: 'Router tricks', cwd: 'D:\\Work\\Demo', groupKey: 'd:\\work\\demo', helperCount: 4 });
    expect(first.createdAt).toBe(Date.parse('2026-01-02T03:04:05.000Z'));
    expect(first.busy).toBeUndefined();
    const second = await row(open(fixture), Q);
    expect(second).toMatchObject({ title: 'Summarise the week', helperCount: 1, archived: true });
  });

  it('marks a conversation as in use when Codex holds a lock on it or on one of its helpers', async () => {
    const fixture = populated();
    fixture.lock(G2);
    fixture.lock(Q);
    expect((await row(open(fixture, [G2]), P)).busy).toBe('lock');
    expect((await row(open(fixture, [G2]), Q)).busy).toBeUndefined(); // lock file exists but nobody holds it
  });

  it('marks a conversation that was just written to', async () => {
    const fixture = new CodexFixture();
    fixture.thread({ id: P, ageMs: 2_000 });
    expect((await row(open(fixture), P)).busy).toBe('recent');
  });

  it('skips files it does not recognise and reads the early format', async () => {
    const fixture = new CodexFixture();
    const folder = path.join(fixture.home, 'sessions', '2025', '05', '01');
    write(path.join(folder, 'rollout-unknown.jsonl'), '{"something":"else"}\n');
    write(path.join(folder, 'rollout-garbage.jsonl'), 'not json\n');
    write(path.join(folder, `rollout-2025-05-01T00-00-00-${P}.jsonl`), `{"id":"${P}","timestamp":"2025-05-01T00:00:00Z","instructions":null}\n{"type":"message","role":"user","content":[{"type":"input_text","text":"old style"}]}\n`);
    const list = await open(fixture).list();
    expect(list.map((session) => [session.id, session.title])).toEqual([[P, 'old style']]);
  });
});

describe('deleting', () => {
  it('deletes the conversation first, then every helper thread, and tidies up', async () => {
    const fixture = populated();
    fixture.lock(G1); // a stale lock file nobody holds
    const store = open(fixture);
    const plan = await store.plan(await row(store, P));
    expect(plan.threadIds?.[0]).toBe(P);
    expect([...(plan.threadIds ?? [])].sort()).toEqual([P, G1, G2, S1, S1G].sort());
    expect(plan.items).toHaveLength(5);

    const outcome = await store.execute(plan);
    expect(outcome).toMatchObject({ status: 'deleted', removed: 5, failures: [], leftovers: [] });
    const deletes = fixture.calls.filter((args) => args[1] === '--force').map((args) => args[2]);
    expect(deletes[0]).toBe(P);
    expect(deletes).not.toContain(S1); // went away with its parent, no second call needed
    expect([...deletes].sort()).toEqual([P, G1, G2, S1G].sort());
    expect(tree(fixture.home).filter((entry) => [P, G1, G2, S1, S1G].some((id) => entry.includes(id)))).toEqual([]);
    expect(fs.readFileSync(path.join(fixture.home, 'history.jsonl'), 'utf8')).toBe(`${JSON.stringify({ session_id: Q, ts: 1, text: 'about q' })}\n`);
    expect((await store.list()).map((session) => session.id)).toEqual([Q]);
  });

  it('touches nothing when Codex refuses the conversation itself', async () => {
    const fixture = populated();
    fixture.refuse.add(P);
    const before = tree(fixture.home);
    const store = open(fixture);
    const outcome = await store.execute(await store.plan(await row(store, P)));
    expect(outcome.status).toBe('failed');
    expect(outcome.failures).toEqual([{ target: P, message: 'Error: failed to delete session' }]);
    expect(fixture.calls.filter((args) => args[1] === '--force')).toEqual([['delete', '--force', P]]);
    expect(tree(fixture.home)).toEqual(before);
    expect(fs.readFileSync(path.join(fixture.home, 'history.jsonl'), 'utf8')).toContain('about p');
  });

  it('reports helpers Codex would not delete', async () => {
    const fixture = populated();
    fixture.refuse.add(G2);
    const store = open(fixture);
    const outcome = await store.execute(await store.plan(await row(store, P)));
    expect(outcome.status).toBe('partial');
    expect(outcome.removed).toBe(4);
    expect(outcome.leftovers.map((leftover) => path.basename(leftover))).toEqual([`rollout-2026-01-02T03-04-05-${G2}.jsonl`]);
  });

  it('does not even try while Codex has the conversation loaded', async () => {
    const fixture = populated();
    fixture.lock(S1G);
    const idle = open(fixture);
    const plan = await idle.plan(await row(idle, P));
    const outcome = await open(fixture, [S1G]).execute(plan);
    expect(outcome).toMatchObject({ status: 'busy', busy: 'lock', removed: 0 });
    expect(fixture.calls).toEqual([]);
  });

  it('picks up helper threads created after the plan was made', async () => {
    const fixture = populated();
    const store = open(fixture);
    const plan = await store.plan(await row(store, P));
    fixture.thread({ id: uuid(8), root: P, kind: 'guardian' });
    const outcome = await store.execute(plan);
    expect(outcome).toMatchObject({ status: 'deleted', removed: 6, leftovers: [] });
  });

  it('explains a missing or outdated Codex program', async () => {
    const fixture = populated();
    fixture.executable = undefined;
    let store = open(fixture);
    let outcome = await store.execute(await store.plan(await row(store, P)));
    expect(outcome).toMatchObject({ status: 'failed', failures: [{ target: 'codex', message: CODEX_NOT_FOUND }] });

    fixture.executable = 'codex-stub';
    fixture.supportsDelete = false;
    store = open(fixture);
    outcome = await store.execute(await store.plan(await row(store, P)));
    expect(outcome).toMatchObject({ status: 'failed', failures: [{ target: 'codex', message: CODEX_DELETE_UNSUPPORTED }] });
    expect(fixture.calls.some((args) => args[1] === '--force')).toBe(false);
  });
});

describe('leftovers', () => {
  it('finds helper threads whose conversation is gone and deletes them', async () => {
    const fixture = populated();
    const orphanReview = uuid(20);
    const orphanAgent = uuid(21);
    const orphanAgentReview = uuid(22);
    const fresh = uuid(23);
    const gone = uuid(90);
    fixture.thread({ id: orphanReview, root: gone, kind: 'guardian' });
    fixture.thread({ id: orphanAgent, root: gone, parent: gone, kind: 'spawn' });
    fixture.thread({ id: orphanAgentReview, root: gone, parent: orphanAgent, kind: 'guardian' });
    fixture.thread({ id: fresh, root: uuid(91), kind: 'guardian', ageMs: DAY / 2 });
    const store = open(fixture);
    const [group] = await store.leftovers();
    expect(group?.kind).toBe('codex.orphanThreads');
    expect([...(group?.threadIds ?? [])].sort()).toEqual([orphanReview, orphanAgent, orphanAgentReview].sort());

    const result = await store.cleanLeftovers();
    expect(result).toEqual({ removed: 3, failures: [] });
    expect(await store.leftovers()).toEqual([]);
    expect((await store.list()).map((session) => session.id).sort()).toEqual([P, Q]);
    expect(tree(fixture.home).some((entry) => entry.includes(fresh))).toBe(true);
  });

  it('leaves locked helper threads alone', async () => {
    const fixture = new CodexFixture();
    fixture.thread({ id: G1, root: uuid(90), kind: 'guardian' });
    fixture.lock(G1);
    expect(await open(fixture, [G1]).leftovers()).toEqual([]);
  });
});

describe('lock detection', () => {
  it('sees no lock on a missing or free file', async () => {
    const dir = scratch();
    expect(await isLockHeld(path.join(dir, 'missing.lock'))).toBe(false);
    expect(await isLockHeld(write(path.join(dir, 'free.lock'), ''))).toBe(false);
  });

  it.runIf(process.platform === 'win32')('sees a lock another process holds on Windows', async () => {
    const file = write(path.join(scratch(), 'held.lock'), '');
    const script = `$f=[IO.File]::Open('${file}','Open','ReadWrite','ReadWrite, Delete'); $f.Lock(0,1); [Console]::Out.WriteLine('locked'); [Console]::In.ReadLine() | Out-Null; $f.Close()`;
    const holder = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: ['pipe', 'pipe', 'ignore'] });
    try {
      await new Promise<void>((resolve, reject) => {
        holder.stdout.on('data', (data: Buffer) => data.toString().includes('locked') && resolve());
        holder.on('error', reject);
        holder.on('exit', () => reject(new Error('lock holder exited early')));
      });
      expect(await isLockHeld(file)).toBe(true);
    } finally {
      holder.removeAllListeners('exit');
      const exited = new Promise((resolve) => holder.on('exit', resolve));
      holder.stdin.write('\n');
      await exited;
    }
    expect(await isLockHeld(file)).toBe(false);
  });
});
