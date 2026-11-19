/// <reference types="mocha" />
// Runs inside a real VS Code. All data is fake and lives under SESSION_SWEEPER_TEST_ROOT.
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { SweeperApi } from '../../src/extension';

const root = process.env.SESSION_SWEEPER_TEST_ROOT as string;
const claudeHome = path.join(root, 'claude');
const codexHome = path.join(root, 'codex');
const tempRoot = path.join(root, 'temp', 'claude');
const DAY = 86_400_000;

const uuid = (n: number): string => `${String(n).padStart(8, '0')}-1111-4222-8333-444444444444`;
const CWD = 'D:\\demo\\alpha';
const SLUG = CWD.replace(/[^a-zA-Z0-9]/g, '-');
const [A, B, C, GONE] = [uuid(1), uuid(2), uuid(3), uuid(9)];
const [P, G1, G2] = [uuid(11), uuid(12), uuid(13)];

function write(file: string, content: string): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

function age(target: string, ms: number): void {
  const when = new Date(Date.now() - ms);
  if (fs.statSync(target).isDirectory()) {
    for (const name of fs.readdirSync(target)) {
      age(path.join(target, name), ms);
    }
  }
  fs.utimesSync(target, when, when);
}

function claudeSession(id: string, prompt: string, reply: string, title: Record<string, unknown>, ageMs: number): void {
  const base = { isSidechain: false, cwd: CWD, sessionId: id };
  const lines = [
    { ...base, type: 'user', message: { role: 'user', content: [{ type: 'text', text: prompt }] }, timestamp: '2026-01-02T03:04:05.000Z' },
    { type: 'api-request-blob', sessionId: id, message: { role: 'user', content: [{ type: 'text', text: 'bookkeeping' }] } },
    { ...base, type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: reply }] }, timestamp: '2026-01-02T03:04:06.000Z' },
    { ...title, sessionId: id },
  ];
  const file = write(path.join(claudeHome, 'projects', SLUG, `${id}.jsonl`), `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
  age(file, ageMs);
}

function codexThread(id: string, rootId: string, source: unknown, prompt: string): void {
  const lines = [
    { timestamp: '2026-01-02T03:04:05.000Z', type: 'session_meta', payload: { session_id: rootId, id, timestamp: '2026-01-02T03:04:05.000Z', cwd: CWD, source } },
    { timestamp: '2026-01-02T03:04:06.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt }] } },
    { timestamp: '2026-01-02T03:04:07.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done.' }] } },
  ];
  const file = write(path.join(codexHome, 'sessions', '2026', '01', '02', `rollout-2026-01-02T03-04-05-${id}.jsonl`), `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
  age(file, 2 * DAY);
}

/** Puts a stand-in for the Codex CLI where the extension is told to look for it. */
function installCodexStub(): string {
  const bin = path.join(root, 'bin');
  // This file runs from out/test/integration; the stub is kept as plain JavaScript in the sources.
  const source = path.join(__dirname, '..', '..', '..', 'test', 'support', 'codex-stub.js');
  write(path.join(bin, 'codex-stub.js'), fs.readFileSync(source, 'utf8'));
  if (process.platform === 'win32') {
    return write(path.join(bin, 'codex.cmd'), '@echo off\r\nnode "%~dp0codex-stub.js" %*\r\n');
  }
  const script = write(path.join(bin, 'codex'), '#!/bin/sh\nexec node "$(dirname "$0")/codex-stub.js" "$@"\n');
  fs.chmodSync(script, 0o755);
  return script;
}

function buildFixture(): void {
  claudeSession(A, 'How do I share the Thunderbolt link?', 'Bridge the two adapters.', { type: 'ai-title', aiTitle: 'Thunderbolt sharing' }, 2 * DAY);
  claudeSession(B, 'Plan a trip to Kyoto', 'Three days is enough.', { type: 'custom-title', customTitle: 'Trip planning' }, 3 * DAY);
  claudeSession(C, 'Still typing here', 'Yes?', { type: 'ai-title', aiTitle: 'Open right now' }, 0);
  write(path.join(claudeHome, 'projects', SLUG, A, 'subagents', 'agent-1.jsonl'), '{"x":1}\n');
  write(path.join(claudeHome, 'projects', SLUG, 'memory', 'MEMORY.md'), '- keep me\n');
  write(path.join(claudeHome, 'file-history', A, 'abc@v1'), 'old content');
  fs.mkdirSync(path.join(claudeHome, 'session-env', A), { recursive: true });
  write(path.join(tempRoot, 'project', A, 'scratchpad', 'script.ps1'), 'x');
  fs.mkdirSync(path.join(tempRoot, 'project', GONE, 'scratchpad'), { recursive: true });
  age(path.join(tempRoot, 'project', GONE), 5 * DAY);

  codexThread(P, P, 'vscode', 'Explore the fibre modem');
  codexThread(G1, P, { subagent: { other: 'guardian' } }, 'review 1');
  codexThread(G2, P, { subagent: { other: 'guardian' } }, 'review 2');
  write(path.join(codexHome, 'session_index.jsonl'), `${JSON.stringify({ id: P, thread_name: 'Router tricks', updated_at: '2026-01-02T03:04:05Z' })}\n`);
}

function everything(dir: string): string[] {
  const found: string[] = [];
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      found.push(path.join(current, entry.name));
      if (entry.isDirectory()) {
        walk(path.join(current, entry.name));
      }
    }
  };
  walk(dir);
  return found;
}

suite('Session Sweeper in VS Code', () => {
  let api: SweeperApi;
  const extension = vscode.extensions.getExtension<SweeperApi>('YW.session-sweeper');

  suiteSetup(async () => {
    assert.ok(root && fs.existsSync(root), 'the test root must exist');
    buildFixture();
    await vscode.workspace.getConfiguration('sessionSweeper').update('codex.executablePath', installCodexStub(), vscode.ConfigurationTarget.Global);
    assert.ok(extension, 'the extension is installed');
    api = await extension.activate();
    await api.refresh();
  });

  suiteTeardown(() => {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  });

  test('registers every command it contributes', async () => {
    const registered = new Set(await vscode.commands.getCommands(true));
    const contributed = (extension?.packageJSON as { contributes: { commands: { command: string }[] } }).contributes.commands;
    assert.ok(contributed.length > 10);
    for (const { command } of contributed) {
      assert.ok(registered.has(command), `${command} is registered`);
    }
  });

  test('opens its view and refreshes from the command', async () => {
    await vscode.commands.executeCommand('sessionSweeper.sessions.focus');
    await vscode.commands.executeCommand('sessionSweeper.refresh');
    assert.strictEqual(api.sessions().length, 4);
  });

  test('lists the conversations of both tools', () => {
    const rows = api.sessions().map((session) => ({ provider: session.provider, title: session.title, busy: session.busy, helpers: session.helperCount, cwd: session.cwd }));
    rows.sort((a, b) => a.title.localeCompare(b.title));
    assert.deepStrictEqual(rows, [
      { provider: 'claude', title: 'Open right now', busy: 'recent', helpers: undefined, cwd: CWD },
      { provider: 'codex', title: 'Router tricks', busy: undefined, helpers: 2, cwd: CWD },
      { provider: 'claude', title: 'Thunderbolt sharing', busy: undefined, helpers: undefined, cwd: CWD },
      { provider: 'claude', title: 'Trip planning', busy: undefined, helpers: undefined, cwd: CWD },
    ]);
    assert.deepStrictEqual(
      api.leftovers().map((group) => [group.kind, group.items.length]),
      [['claude.emptyTemp', 1]],
    );
  });

  test('searches what was said', async () => {
    assert.strictEqual(await api.search('thunderbolt'), 1);
    assert.deepStrictEqual(api.visibleTitles(), ['Thunderbolt sharing']);
    assert.strictEqual(await api.search('kyoto'), 1);
    assert.strictEqual(await api.search('fibre MODEM'), 1);
    assert.deepStrictEqual(api.visibleTitles(), ['Router tricks']);
    assert.strictEqual(await api.search('bookkeeping'), 0);
    api.clearSearch();
    assert.strictEqual(api.visibleTitles().length, 4);
  });

  test('previews a conversation as plain text', async () => {
    const text = await api.preview(`claude:${SLUG}/${A}`);
    assert.ok(text.startsWith('# Thunderbolt sharing\n'), text);
    assert.ok(text.includes('How do I share the Thunderbolt link?'));
    assert.ok(text.includes('Bridge the two adapters.'));
    assert.ok(!text.includes('bookkeeping'));
    const codex = await api.preview(`codex:${P}`);
    assert.ok(codex.includes('Explore the fibre modem') && codex.includes('Done.'), codex);
  });

  test('moves a Claude Code conversation and all its traces to the bin', async () => {
    // Headless Linux machines have no bin to move things to; everywhere else the real one is used.
    const [outcome] = await api.deleteSessions([`claude:${SLUG}/${A}`], process.platform === 'linux' ? 'permanent' : 'trash');
    assert.strictEqual(outcome?.status, 'deleted', JSON.stringify(outcome));
    assert.deepStrictEqual(outcome?.leftovers, []);
    assert.deepStrictEqual(
      [...everything(claudeHome), ...everything(tempRoot)].filter((entry) => entry.includes(A)),
      [],
    );
    assert.ok(fs.existsSync(path.join(claudeHome, 'projects', SLUG, 'memory', 'MEMORY.md')), 'memory notes stay');
    assert.ok(fs.existsSync(path.join(claudeHome, 'projects', SLUG, `${B}.jsonl`)), 'other conversations stay');
    assert.deepStrictEqual(api.sessions().map((session) => session.title).sort(), ['Open right now', 'Router tricks', 'Trip planning']);
  });

  test('deletes permanently when asked to', async () => {
    const [outcome] = await api.deleteSessions([`claude:${SLUG}/${B}`], 'permanent');
    assert.strictEqual(outcome?.status, 'deleted', JSON.stringify(outcome));
    assert.ok(!fs.existsSync(path.join(claudeHome, 'projects', SLUG, `${B}.jsonl`)));
  });

  test('leaves a conversation that is in use alone', async () => {
    const transcript = path.join(claudeHome, 'projects', SLUG, `${C}.jsonl`);
    fs.utimesSync(transcript, new Date(), new Date()); // written to just now
    const [outcome] = await api.deleteSessions([`claude:${SLUG}/${C}`], 'permanent');
    assert.strictEqual(outcome?.status, 'busy');
    assert.ok(fs.existsSync(path.join(claudeHome, 'projects', SLUG, `${C}.jsonl`)));
  });

  test('deletes a Codex conversation and its helper threads through the Codex CLI', async () => {
    const [outcome] = await api.deleteSessions([`codex:${P}`], 'trash');
    assert.strictEqual(outcome?.status, 'deleted', JSON.stringify(outcome));
    assert.strictEqual(outcome?.removed, 3);
    assert.deepStrictEqual(everything(codexHome).filter((entry) => [P, G1, G2].some((id) => entry.includes(id))), []);
    assert.strictEqual(fs.readFileSync(path.join(codexHome, 'session_index.jsonl'), 'utf8').includes(P), false);
  });

  test('cleans up leftovers', async () => {
    const result = await api.cleanLeftovers('trash');
    assert.deepStrictEqual(result, { removed: 1, failures: [] });
    assert.ok(!fs.existsSync(path.join(tempRoot, 'project', GONE)));
    assert.deepStrictEqual(api.leftovers(), []);
  });
});
