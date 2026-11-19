import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { ClaudeStore, firstPrompt, projectFolderName, scanTitles } from '../../src/core/claude';
import type { Remover, SessionInfo } from '../../src/core/types';
import { ClaudeFixture, DAY, age, mkdir, tree, uuid, write } from './helpers';

const remove: Remover = async (target) => {
  fs.rmSync(target, { recursive: true, force: true });
};

interface World {
  alive?: number[];
  /** pid → process name. Leave out to simulate a system where processes cannot be listed. */
  processes?: Record<number, string>;
}

function open(fixture: ClaudeFixture, world: World = {}): ClaudeStore {
  return new ClaudeStore({
    home: fixture.home,
    tempRoots: [fixture.temp],
    platform: 'win32',
    isAlive: (pid) => (world.alive ?? []).includes(pid),
    processes: async () => (world.processes ? new Map(Object.entries(world.processes).map(([pid, name]) => [Number(pid), name])) : undefined),
  });
}

const CWD = 'D:\\work\\alpha';
const SLUG = projectFolderName(CWD);
const A = uuid(1);
const B = uuid(2);

async function row(store: ClaudeStore, id: string, slug = SLUG): Promise<SessionInfo> {
  const found = (await store.list()).find((session) => session.id === id && session.groupKey === slug);
  if (!found) {
    throw new Error(`no row for ${id}`);
  }
  return found;
}

describe('title and prompt extraction', () => {
  it('prefers the last custom title, then the last generated one', () => {
    const text = [
      '{"type":"ai-title","aiTitle":"first guess"}',
      '{"type":"custom-title","customTitle":"mine"}',
      '{"type":"ai-title","aiTitle":"second guess"}',
      '{"type":"user","message":{"content":"\\"customTitle\\":\\"fake\\" and {\\"type\\":\\"custom-title\\"}"}}',
      '{"type":"custom-title","customTitle":"mine, renamed"}',
    ].join('\n');
    expect(scanTitles(text)).toEqual({ custom: 'mine, renamed', generated: 'second guess' });
  });

  it('ignores a cut-off first line and unrelated lines', () => {
    expect(scanTitles('tle","aiTitle":"broken"}\n{"type":"mode","mode":"normal"}\n')).toEqual({});
  });

  it('takes the first thing the user typed, without injected blocks', () => {
    const text = [
      '{"type":"user","isMeta":true,"message":{"role":"user","content":"meta"}}',
      '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"x"}]}}',
      '{"type":"user","message":{"role":"user","content":"<command-name>/model</command-name>"}}',
      '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"<system-reminder>ignore</system-reminder>  Fix\\n the  build "}]}}',
    ].join('\n');
    expect(firstPrompt(text)).toBe('Fix the build');
  });
});

describe('listing', () => {
  it('lists conversations with title, folder, creation time and size', async () => {
    const fixture = new ClaudeFixture();
    fixture.session({ slug: SLUG, id: A, cwd: CWD, aiTitle: 'Generated', customTitle: 'Renamed by me' });
    fixture.session({ slug: SLUG, id: B, cwd: CWD, aiTitle: 'Only generated' });
    fixture.session({ slug: SLUG, id: uuid(3), cwd: CWD, prompt: 'What is   the\nplan?' });
    fixture.memory(SLUG);
    write(path.join(fixture.home, 'projects', SLUG, 'notes.jsonl'), '{}\n');
    const list = await open(fixture).list();
    expect(Object.fromEntries(list.map((session) => [session.id, session.title]))).toEqual({
      [A]: 'Renamed by me',
      [B]: 'Only generated',
      [uuid(3)]: 'What is the plan?',
    });
    const first = list.find((session) => session.id === A) as SessionInfo;
    expect(first.cwd).toBe(CWD);
    expect(first.groupKey).toBe(SLUG);
    expect(first.key).toBe(`${SLUG}/${A}`);
    expect(first.createdAt).toBe(Date.parse('2026-01-02T03:04:05.000Z'));
    expect(first.sizeBytes).toBe(fs.statSync(fixture.transcriptPath(SLUG, A)).size);
    expect(first.busy).toBeUndefined();
    expect(first.otherCopies).toBeUndefined();
  });

  it('counts the data folder towards the size once it has been measured', async () => {
    const fixture = new ClaudeFixture();
    fixture.session({ slug: SLUG, id: A, cwd: CWD });
    fixture.extras(SLUG, A); // 8 bytes of sub-agent log and 6 bytes of tool output
    const store = open(fixture);
    const transcript = fs.statSync(fixture.transcriptPath(SLUG, A)).size;
    const unmeasured = await row(store, A);
    expect(unmeasured).toMatchObject({ sizeBytes: transcript, sizePending: true });
    expect(await store.measure(unmeasured)).toBe(transcript + 14);
    const measured = await row(store, A);
    expect(measured.sizeBytes).toBe(transcript + 14);
    expect(measured.sizePending).toBeUndefined();
    // Something new in the folder makes the measurement stale.
    write(path.join(fixture.home, 'projects', SLUG, A, 'tool-results', 'more.txt'), '1234');
    expect((await row(store, A)).sizePending).toBe(true);
  });

  it('reports no folder when the transcript only mentions other folders', async () => {
    const fixture = new ClaudeFixture();
    fixture.session({ slug: 'somewhere-else', id: A, cwd: CWD });
    expect((await row(open(fixture), A, 'somewhere-else')).cwd).toBeUndefined();
  });

  it('is unavailable without a projects folder', async () => {
    const fixture = new ClaudeFixture();
    fs.rmSync(path.join(fixture.home, 'projects'), { recursive: true });
    expect(await open(fixture).available()).toBe(false);
    expect(await open(fixture).list()).toEqual([]);
  });
});

describe('in-use detection', () => {
  it('marks conversations of running Claude Code processes, and only those', async () => {
    const fixture = new ClaudeFixture();
    for (const n of [1, 2, 3, 4]) {
      fixture.session({ slug: SLUG, id: uuid(n), cwd: CWD });
    }
    fixture.session({ slug: SLUG, id: uuid(5), cwd: CWD, ageMs: 5_000 });
    fixture.register(100, uuid(1)); // running Claude Code
    fixture.register(200, uuid(2)); // the pid now belongs to another program
    fixture.register(300, uuid(3)); // process is gone
    const store = open(fixture, { alive: [100, 200], processes: { 100: 'claude.exe', 200: 'chrome.exe' } });
    const busy = Object.fromEntries((await store.list()).map((session) => [session.id, session.busy]));
    expect(busy).toEqual({ [uuid(1)]: 'process', [uuid(2)]: undefined, [uuid(3)]: undefined, [uuid(4)]: undefined, [uuid(5)]: 'recent' });
  });

  it('errs on the side of "in use" when processes cannot be listed', async () => {
    const fixture = new ClaudeFixture();
    fixture.session({ slug: SLUG, id: A, cwd: CWD });
    fixture.register(100, A);
    expect((await row(open(fixture, { alive: [100] }), A)).busy).toBe('process');
  });

  it('refuses to delete a conversation that is in use', async () => {
    const fixture = new ClaudeFixture();
    fixture.session({ slug: SLUG, id: A, cwd: CWD });
    fixture.extras(SLUG, A);
    const idle = open(fixture);
    const plan = await idle.plan(await row(idle, A));
    fixture.register(100, A); // opened after the confirmation dialog
    const before = tree(fixture.home);
    const outcome = await open(fixture, { alive: [100], processes: { 100: 'claude.exe' } }).execute(plan, remove);
    expect(outcome).toMatchObject({ status: 'busy', busy: 'process', removed: 0 });
    expect(tree(fixture.home)).toEqual(before);
  });
});

describe('deleting', () => {
  function populated(): ClaudeFixture {
    const fixture = new ClaudeFixture();
    for (const id of [A, B]) {
      fixture.session({ slug: SLUG, id, cwd: CWD });
      fixture.extras(SLUG, id);
      fixture.tempDir('project-one', id);
    }
    fixture.tempDir('project-two', A);
    fixture.memory(SLUG);
    write(
      path.join(fixture.home, 'history.jsonl'),
      [`{"display":"about a","sessionId":"${A}"}`, `{"display":"about b","sessionId":"${B}"}`, '{"display":"no session"}', ''].join('\n'),
    );
    write(
      path.join(fixture.home, 'projects', SLUG, 'sessions-index.json'),
      JSON.stringify({ version: 1, entries: [{ sessionId: A, firstPrompt: 'secret a' }, { sessionId: B, firstPrompt: 'b' }] }, null, 2),
    );
    // Not conversation data, even though the names contain ids.
    mkdir(path.join(fixture.home, 'plugins', 'synced', `${A}_${uuid(77)}`));
    write(path.join(fixture.home, 'cache', 'model-catalog', `${A}-abc.json`), '{}');
    write(path.join(fixture.temp, 'project-one', 'bash-edit-diff', 'x.diff'), 'd');
    return fixture;
  }

  it('lists every trace of the conversation and nothing else', async () => {
    const fixture = populated();
    const store = open(fixture);
    const plan = await store.plan(await row(store, A));
    const root = path.dirname(fixture.home);
    expect(plan.items.map((item) => path.relative(root, item.path).split(path.sep).join('/')).sort()).toEqual(
      [
        `dot-claude/file-history/${A}`,
        `dot-claude/projects/${SLUG}/${A}`,
        `dot-claude/projects/${SLUG}/${A}.jsonl`,
        `dot-claude/session-env/${A}`,
        `dot-claude/telemetry/1p_failed_events.${A}.${uuid(999)}.json`,
        `temp/claude/project-one/${A}`,
        `temp/claude/project-two/${A}`,
      ].sort(),
    );
    expect(plan.totalFiles).toBe(1 + 2 + 1 + 0 + 1 + 2 + 2);
    expect(plan.totalBytes).toBeGreaterThan(0);
  });

  it('removes all of it, cleans the indexes, and leaves everything else alone', async () => {
    const fixture = populated();
    const root = path.dirname(fixture.home);
    const expected = tree(root).filter((entry) => !entry.includes(A) || entry.startsWith('dot-claude/plugins/') || entry.startsWith('dot-claude/cache/'));
    const store = open(fixture);
    const outcome = await store.execute(await store.plan(await row(store, A)), remove);
    expect(outcome).toMatchObject({ status: 'deleted', removed: 7, failures: [], leftovers: [] });
    expect(tree(root)).toEqual(expected);
    expect(fs.readFileSync(path.join(fixture.home, 'history.jsonl'), 'utf8')).toBe(
      [`{"display":"about b","sessionId":"${B}"}`, '{"display":"no session"}', ''].join('\n'),
    );
    const index = JSON.parse(fs.readFileSync(path.join(fixture.home, 'projects', SLUG, 'sessions-index.json'), 'utf8')) as { entries: { sessionId: string }[] };
    expect(index.entries.map((entry) => entry.sessionId)).toEqual([B]);
    expect((await store.list()).map((session) => session.id)).toEqual([B]);
  });

  it('removes the transcript last', async () => {
    const fixture = populated();
    const store = open(fixture);
    const order: string[] = [];
    await store.execute(await store.plan(await row(store, A)), async (target) => {
      order.push(path.basename(target));
      fs.rmSync(target, { recursive: true, force: true });
    });
    expect(order[order.length - 1]).toBe(`${A}.jsonl`);
  });

  it('reports what could not be removed', async () => {
    const fixture = populated();
    const store = open(fixture);
    const stubborn = path.join(fixture.home, 'file-history', A);
    const outcome = await store.execute(await store.plan(await row(store, A)), async (target) => {
      if (target === stubborn) {
        throw new Error('file is locked');
      }
      fs.rmSync(target, { recursive: true, force: true });
    });
    expect(outcome.status).toBe('partial');
    expect(outcome.removed).toBe(6);
    expect(outcome.failures).toEqual([{ target: stubborn, message: 'file is locked' }]);
    expect(outcome.leftovers).toEqual([stubborn]);
  });

  it('includes sub-agent transcripts stored the old way', async () => {
    const fixture = new ClaudeFixture();
    fixture.session({ slug: SLUG, id: A, cwd: CWD });
    fixture.session({ slug: SLUG, id: B, cwd: CWD });
    const mine = write(path.join(fixture.home, 'projects', SLUG, 'agent-1a2b.jsonl'), `{"sessionId":"${A}","isSidechain":true}\n{"more":1}\n`);
    const theirs = write(path.join(fixture.home, 'projects', SLUG, 'agent-3c4d.jsonl'), `{"sessionId":"${B}","isSidechain":true}\n`);
    const store = open(fixture);
    const paths = (await store.plan(await row(store, A))).items.map((item) => item.path);
    expect(paths).toContain(mine);
    expect(paths).not.toContain(theirs);
  });
});

describe('a conversation stored in two project folders', () => {
  const OTHER_CWD = 'D:\\work\\beta';
  const OTHER = projectFolderName(OTHER_CWD);

  function copied(): ClaudeFixture {
    const fixture = new ClaudeFixture();
    fixture.session({ slug: SLUG, id: A, cwd: CWD });
    fixture.extras(SLUG, A);
    fixture.session({ slug: OTHER, id: A, cwd: OTHER_CWD });
    write(path.join(fixture.home, 'projects', OTHER, A, 'subagents', 'agent-x.jsonl'), '{}\n');
    fixture.tempDir('project-one', A);
    return fixture;
  }

  it('shows both copies and deletes only the chosen one, keeping shared data', async () => {
    const fixture = copied();
    const store = open(fixture);
    const first = await row(store, A, SLUG);
    expect(first.otherCopies).toBe(1);
    const plan = await store.plan(first);
    expect(plan.items.map((item) => path.basename(path.dirname(item.path)))).toEqual([SLUG, SLUG]);
    const outcome = await store.execute(plan, remove);
    expect(outcome).toMatchObject({ status: 'deleted', leftovers: [] });
    expect(fs.existsSync(fixture.transcriptPath(OTHER, A))).toBe(true);
    expect(fs.existsSync(path.join(fixture.home, 'file-history', A))).toBe(true);
    expect(fs.existsSync(path.join(fixture.temp, 'project-one', A))).toBe(true);

    // The remaining copy is now the last one: shared data goes with it.
    const last = await row(store, A, OTHER);
    expect(last.otherCopies).toBeUndefined();
    const final = await store.execute(await store.plan(last), remove);
    expect(final).toMatchObject({ status: 'deleted', leftovers: [] });
    expect(tree(path.dirname(fixture.home)).filter((entry) => entry.includes(A))).toEqual([]);
  });

  it('attributes shared data to the last copy when both are deleted in one go', async () => {
    const fixture = copied();
    const store = open(fixture);
    const first = await row(store, A, SLUG);
    const second = await row(store, A, OTHER);
    const firstPlan = await store.plan(first);
    const secondPlan = await store.plan(second, [first]);
    expect(firstPlan.items).toHaveLength(2);
    expect(secondPlan.items.map((item) => path.basename(item.path)).sort()).toEqual(
      [A, `${A}.jsonl`, A, A, `1p_failed_events.${A}.${uuid(999)}.json`, A].sort(),
    );
    await store.execute(firstPlan, remove);
    await store.execute(secondPlan, remove);
    expect(tree(path.dirname(fixture.home)).filter((entry) => entry.includes(A))).toEqual([]);
  });
});

describe('leftovers', () => {
  function littered(): ClaudeFixture {
    const fixture = new ClaudeFixture();
    fixture.session({ slug: SLUG, id: A, cwd: CWD });
    fixture.extras(SLUG, A);
    age(fixture.tempDir('p1', A), 5 * DAY); // belongs to a living conversation
    age(fixture.tempDir('p1', uuid(10), false), 5 * DAY); // gone, empty
    age(fixture.tempDir('p1', uuid(11)), 5 * DAY); // gone, has files
    fixture.tempDir('p1', uuid(12), false); // gone, but touched just now
    age(fixture.tempDir('p1', uuid(13), false), 5 * DAY); // no transcript, but a live process is registered for it
    age(mkdir(path.join(fixture.temp, 'p1', 'bash-edit-diff')), 5 * DAY); // not a conversation folder
    age(mkdir(path.join(fixture.temp, 'p2')), 5 * DAY); // empty project folder
    fixture.register(100, uuid(13));
    age(write(path.join(fixture.home, 'file-history', uuid(20), 'f@v1'), 'x'), 5 * DAY);
    age(path.join(fixture.home, 'file-history', uuid(20)), 5 * DAY);
    age(mkdir(path.join(fixture.home, 'session-env', uuid(20))), 5 * DAY);
    age(write(path.join(fixture.home, 'telemetry', `1p_failed_events.${uuid(20)}.${uuid(998)}.json`), '[]'), 5 * DAY);
    age(write(path.join(fixture.home, 'projects', SLUG, uuid(21), 'subagents', 'a.jsonl'), '{}'), 5 * DAY);
    age(path.join(fixture.home, 'projects', SLUG, uuid(21)), 5 * DAY);
    age(mkdir(path.join(fixture.home, 'plugins', 'synced', `${uuid(30)}_${uuid(31)}`)), 5 * DAY);
    age(path.join(fixture.home, 'telemetry', `1p_failed_events.${A}.${uuid(999)}.json`), 5 * DAY);
    return fixture;
  }

  const names = (paths: { path: string }[]): string[] => paths.map((item) => path.basename(item.path)).sort();

  it('finds what deleted conversations left behind, and only that', async () => {
    const fixture = littered();
    const groups = Object.fromEntries((await open(fixture, { alive: [100], processes: { 100: 'claude.exe' } }).leftovers()).map((group) => [group.kind, group]));
    expect(names(groups['claude.emptyTemp']?.items ?? [])).toEqual([uuid(10), 'p2'].sort());
    expect(names(groups['claude.orphanTemp']?.items ?? [])).toEqual([uuid(11)]);
    expect(groups['claude.orphanTemp']?.totalFiles).toBe(2);
    expect(names(groups['claude.orphanData']?.items ?? [])).toEqual(
      [uuid(20), uuid(20), `1p_failed_events.${uuid(20)}.${uuid(998)}.json`, uuid(21)].sort(),
    );
  });

  it('cleans them up without touching anything else', async () => {
    const fixture = littered();
    const root = path.dirname(fixture.home);
    const store = open(fixture, { alive: [100], processes: { 100: 'claude.exe' } });
    const gone = [uuid(10), uuid(11), uuid(20), uuid(21)];
    const expected = tree(root).filter((entry) => !gone.some((id) => entry.includes(id)) && entry !== 'temp/claude/p2/');
    for (const kind of ['claude.emptyTemp', 'claude.orphanTemp', 'claude.orphanData'] as const) {
      const result = await store.cleanLeftovers(kind, remove);
      expect(result.failures).toEqual([]);
      expect(result.removed).toBeGreaterThan(0);
    }
    expect(tree(root)).toEqual(expected);
    expect(await store.leftovers()).toEqual([]);
  });

  it('removes a project temp folder once it is empty, never the temp root', async () => {
    const fixture = new ClaudeFixture();
    age(fixture.tempDir('lonely', uuid(10), false), 5 * DAY);
    await open(fixture).cleanLeftovers('claude.emptyTemp', remove);
    expect(tree(fixture.temp)).toEqual([]);
    expect(fs.existsSync(fixture.temp)).toBe(true);
  });

  it('does not treat a folder as empty once a file shows up in it', async () => {
    const fixture = new ClaudeFixture();
    const dir = fixture.tempDir('p1', uuid(10), false);
    age(dir, 5 * DAY);
    const store = open(fixture);
    expect((await store.leftovers()).map((group) => group.kind)).toEqual(['claude.emptyTemp']);
    age(write(path.join(dir, 'scratchpad', 'late.txt'), 'x'), 5 * DAY);
    age(dir, 5 * DAY);
    const result = await store.cleanLeftovers('claude.emptyTemp', remove);
    expect(result.removed).toBe(0);
    expect(fs.existsSync(path.join(dir, 'scratchpad', 'late.txt'))).toBe(true);
  });
});
