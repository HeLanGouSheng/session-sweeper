import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { ClaudeStore, projectFolderName } from '../../src/core/claude';
import { CodexStore } from '../../src/core/codex';
import { claudeMessage, codexMessage, readPreview } from '../../src/core/preview';
import { buildNeedles, conversationContains, textContains } from '../../src/core/search';
import { CancelledError, type SessionInfo } from '../../src/core/types';
import { ClaudeFixture, CodexFixture, scratch, uuid, write } from './helpers';

const CWD = 'D:\\work\\alpha';
const SLUG = projectFolderName(CWD);

async function claudeRow(fixture: ClaudeFixture): Promise<SessionInfo> {
  const [session] = await new ClaudeStore({ home: fixture.home, tempRoots: [fixture.temp], isAlive: () => false }).list();
  return session as SessionInfo;
}

async function codexRow(fixture: CodexFixture): Promise<SessionInfo> {
  const [session] = await new CodexStore({ home: fixture.home, findExecutable: async () => undefined, run: fixture.run, isLocked: async () => false }).list();
  return session as SessionInfo;
}

/** A one-file conversation made of the given user messages, for exercising the search on raw bytes. */
function transcriptOf(messages: string[], extraLines: string[] = []): SessionInfo {
  const lines = [...extraLines, ...messages.map((text) => JSON.stringify({ type: 'user', message: { role: 'user', content: text } }))];
  const file = write(path.join(scratch(), `${uuid(1)}.jsonl`), `${lines.join('\n')}\n`);
  return { provider: 'claude', key: `x/${uuid(1)}`, id: uuid(1), title: '', groupKey: 'x', modifiedAt: 0, sizeBytes: 0, transcripts: [file] };
}

describe('search patterns', () => {
  it('looks for the text as typed and as written inside JSON', () => {
    expect(buildNeedles('plain').exact.map(String)).toEqual(['plain']);
    expect(buildNeedles('say "hi"').exact.map(String)).toEqual(['say "hi"', 'say \\"hi\\"']);
    expect(buildNeedles('a\nb').exact.map(String)).toEqual(['a\\nb']);
    expect(buildNeedles('').exact).toEqual([]);
    expect(buildNeedles('Mixed 中文').fold).toBe(true);
    expect(buildNeedles('中文 123').fold).toBe(false);
  });

  it('matches short texts case-insensitively', () => {
    expect(textContains('Router Tricks', 'router')).toBe(true);
    expect(textContains('Router Tricks', 'switch')).toBe(false);
  });
});

describe('searching transcript files', () => {
  it('finds text regardless of letter case, and other scripts exactly', async () => {
    const session = transcriptOf(['Thunderbolt 共享网络 Ünïcode']);
    expect(await conversationContains(session, 'thunderBOLT')).toBe(true);
    expect(await conversationContains(session, '共享网络')).toBe(true);
    expect(await conversationContains(session, '共享网路')).toBe(false);
    expect(await conversationContains(session, 'Ünïcode')).toBe(true);
    expect(await conversationContains(session, 'ünïcode')).toBe(false); // only A–Z is folded; other letters must match exactly
    expect(await conversationContains(session, '')).toBe(false);
    expect(await conversationContains({ ...session, transcripts: [path.join(scratch(), 'missing.jsonl')] }, 'x')).toBe(false);
  });

  it('finds text that JSON writes with escapes', async () => {
    const session = transcriptOf(['say "hi" to C:\\temp\nnext line']);
    expect(await conversationContains(session, 'say "hi"')).toBe(true);
    expect(await conversationContains(session, 'C:\\temp')).toBe(true);
    expect(await conversationContains(session, 'temp\nnext')).toBe(true);
    expect(await conversationContains(session, 'temp next')).toBe(false);
  });

  it('finds every later match after rejected ones', async () => {
    const bookkeeping = Array.from({ length: 50 }, (_, n) => JSON.stringify({ type: 'api-request-blob', n, message: { role: 'user', content: 'findme hidden' } }));
    expect(await conversationContains(transcriptOf(['nothing here', 'please FindMe now'], bookkeeping), 'findme')).toBe(true);
    expect(await conversationContains(transcriptOf(['nothing here'], bookkeeping), 'findme')).toBe(false);
  });

  it('handles lines that cross read chunks and lines larger than a chunk', async () => {
    const chunk = 4 * 1024 * 1024;
    for (const query of ['needle-in-the-haystack', '跨块的中文关键词']) {
      // The matching line starts shortly before the 4 MB mark and ends after it.
      const padding = JSON.stringify({ type: 'mode', filler: 'a'.repeat(chunk - 60) });
      const crossing = transcriptOf([`before ${query} after`], [padding]);
      expect(fs.statSync(crossing.transcripts[0] as string).size).toBeGreaterThan(chunk);
      expect(await conversationContains(crossing, query)).toBe(true);
      expect(await conversationContains(crossing, `${query}!`)).toBe(false);
      // One message of 9 MB with the match at its very end, then a short one.
      const huge = transcriptOf([`${'b'.repeat(9 * 1024 * 1024)} ${query}`, 'tail']);
      expect(await conversationContains(huge, query)).toBe(true);
      expect(await conversationContains(huge, 'TAIL')).toBe(true);
    }
  });

  it('copes with a last line that has no line break', async () => {
    const session = transcriptOf(['first']);
    fs.appendFileSync(session.transcripts[0] as string, JSON.stringify({ type: 'user', message: { role: 'user', content: 'unterminated' } }));
    expect(await conversationContains(session, 'unterminated')).toBe(true);
  });

  it('stops when cancelled', async () => {
    const abort = new AbortController();
    abort.abort();
    await expect(conversationContains(transcriptOf(['x']), 'zzz', abort.signal)).rejects.toBeInstanceOf(CancelledError);
  });
});

describe('searching conversations', () => {
  it('matches what the user typed and what the assistant answered, in Claude Code', async () => {
    const fixture = new ClaudeFixture();
    fixture.session({ slug: SLUG, id: uuid(1), cwd: CWD, prompt: 'How do I share the Thunderbolt link?', reply: 'Use a "bridge" 网桥.' });
    const session = await claudeRow(fixture);
    expect(await conversationContains(session, 'thunderbolt LINK')).toBe(true);
    expect(await conversationContains(session, '"bridge"')).toBe(true);
    expect(await conversationContains(session, '网桥')).toBe(true);
  });

  it('ignores injected reminders, tool output, bookkeeping and metadata', async () => {
    const fixture = new ClaudeFixture();
    fixture.session({ slug: SLUG, id: uuid(1), cwd: CWD });
    const session = await claudeRow(fixture);
    for (const hidden of ['secret-note', 'tool-output-only', 'request-bookkeeping-only', 'alpha', 'sessionId', uuid(1)]) {
      expect(await conversationContains(session, hidden), hidden).toBe(false);
    }
  });

  it('matches Codex conversations the same way', async () => {
    const fixture = new CodexFixture();
    fixture.thread({ id: uuid(1), prompt: 'Explore the fibre modem', cwd: 'D:\\work\\demo' });
    const session = await codexRow(fixture);
    expect(await conversationContains(session, 'FIBRE modem')).toBe(true);
    expect(await conversationContains(session, 'router fixed')).toBe(true);
    expect(await conversationContains(session, 'environment_context')).toBe(false);
    expect(await conversationContains(session, 'token_count')).toBe(false);
    expect(await conversationContains(session, 'demo')).toBe(false);
  });
});

describe('preview', () => {
  it('reads Claude Code lines', () => {
    expect(claudeMessage('{"type":"api-request-blob","message":{"role":"user","content":"x"}}')).toBeUndefined();
    expect(claudeMessage('{"type":"user","isSidechain":true,"message":{"role":"user","content":"x"}}')).toBeUndefined();
    expect(claudeMessage('{"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"x"}]}}')).toBeUndefined();
    expect(claudeMessage('{"type":"assistant","message":{"role":"assistant","content":[{"type":"thinking","thinking":"hm"}]}}')).toBeUndefined();
    expect(claudeMessage('not json')).toBeUndefined();
    expect(claudeMessage('{"type":"user","timestamp":"2026-01-02T03:04:05Z","message":{"role":"user","content":"<ide_selection>x</ide_selection>hi"}}')).toEqual({
      role: 'user',
      text: 'hi',
      tools: [],
      time: Date.parse('2026-01-02T03:04:05Z'),
    });
    expect(claudeMessage('{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","name":"Read"}]}}')).toEqual({
      role: 'assistant',
      text: '',
      tools: ['Read'],
    });
  });

  it('reads Codex lines', () => {
    expect(codexMessage('{"timestamp":"t","type":"event_msg","payload":{"type":"token_count"}}')).toBeUndefined();
    expect(codexMessage('{"type":"response_item","payload":{"type":"message","role":"developer","content":[{"type":"input_text","text":"rules"}]}}')).toBeUndefined();
    expect(codexMessage('{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<permissions>x"}]}}')).toBeUndefined();
    expect(codexMessage('{"type":"response_item","payload":{"type":"custom_tool_call","name":"exec"}}')).toEqual({ role: 'assistant', text: '', tools: ['exec'] });
    expect(codexMessage('{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":" done "}]}}')).toEqual({
      role: 'assistant',
      text: 'done',
      tools: [],
    });
  });

  it('joins the pieces of an assistant turn and keeps both ends of a long conversation', async () => {
    const fixture = new ClaudeFixture();
    const file = fixture.session({ slug: SLUG, id: uuid(1), cwd: CWD, prompt: 'first question', reply: 'first answer' });
    const more: string[] = [];
    for (let n = 2; n <= 30; n++) {
      more.push(JSON.stringify({ type: 'user', message: { role: 'user', content: `question ${n}` } }));
      more.push(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: `answer ${n} ${'x'.repeat(50)}` }] } }));
    }
    fs.appendFileSync(file, `${more.join('\n')}\n`);
    const session = await claudeRow(fixture);
    const preview = await readPreview(session, { keep: 3, maxCharsPerMessage: 20 });
    expect(preview.total).toBe(60);
    expect(preview.head.map((message) => message.text)).toEqual(['first question', 'first answer', 'question 2']);
    expect(preview.head[1]?.tools).toEqual(['Bash']);
    expect(preview.tail.map((message) => message.role)).toEqual(['assistant', 'user', 'assistant']);
    expect(preview.tail[2]?.text).toBe('answer 30 xxxxxxxxxx\n\n[…]');
  });

  it('reads a Codex conversation', async () => {
    const fixture = new CodexFixture();
    fixture.thread({ id: uuid(1), prompt: 'Fix the router' });
    const preview = await readPreview(await codexRow(fixture));
    expect(preview.total).toBe(2);
    expect(preview.head).toMatchObject([
      { role: 'user', text: 'Fix the router', tools: [] },
      { role: 'assistant', text: 'Router fixed', tools: ['exec'] },
    ]);
    expect(preview.tail).toEqual([]);
  });
});
