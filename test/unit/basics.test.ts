import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { projectFolderName } from '../../src/core/claude';
import { findCodexExecutable } from '../../src/core/codexExe';
import { formatBytes, relativeTime } from '../../src/core/format';
import { dropLines, hasAnyFile, isUuid, mapLimit, readFirstLine, readHead, readTail, removeEmptyTree, treeStats, uuidsIn } from '../../src/core/fsx';
import { looksLikeClaude, parsePs, parseTasklist } from '../../src/core/processes';
import { contentText, oneLine, parseJsonObject, promptToTitle, stripWrappers } from '../../src/core/text';
import { age, mkdir, scratch, write } from './helpers';

describe('format', () => {
  it('formats sizes', () => {
    expect([0, 1023, 1024, 1536, 10 * 1024, 5 * 1024 ** 2, 3.25 * 1024 ** 3].map(formatBytes)).toEqual(['0 B', '1023 B', '1.0 KB', '1.5 KB', '10 KB', '5.0 MB', '3.3 GB']);
  });

  it('formats elapsed time', () => {
    const now = Date.UTC(2026, 10, 19);
    const minute = 60_000;
    const ago = (ms: number): string => relativeTime(now - ms, now, 'en');
    expect([10_000, 5 * minute, 3 * 60 * minute, 24 * 60 * minute, 12 * 24 * 60 * minute, 70 * 24 * 60 * minute, 800 * 24 * 60 * minute].map(ago)).toEqual([
      'now',
      '5 minutes ago',
      '3 hours ago',
      'yesterday',
      '12 days ago',
      '2 months ago',
      '2 years ago',
    ]);
    expect(relativeTime(now - 5 * minute, now, 'zh-cn')).toBe('5分钟前');
    expect(relativeTime(now - 5 * minute, now, 'not a locale')).toBe('5 minutes ago');
  });
});

describe('text', () => {
  it('strips injected blocks and flattens whitespace', () => {
    expect(stripWrappers('<system-reminder>a\nb</system-reminder> hi <ide_selection>x</ide_selection>there')).toBe('hi there');
    expect(stripWrappers('<b>kept</b>')).toBe('<b>kept</b>');
    expect(oneLine('  a \n\n b\tc ', 80)).toBe('a b c');
    expect(oneLine('abcdefghij', 6)).toBe('abcde…');
    expect(promptToTitle('<command-name>/clear</command-name>')).toBe('');
  });

  it('reads message content in both shapes', () => {
    expect(contentText('plain')).toBe('plain');
    expect(contentText([{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'input_text', text: 'b' }, { type: 'tool_result', content: 'no' }])).toBe('a\n\nb');
    expect(contentText(undefined)).toBe('');
  });

  it('parses only JSON objects', () => {
    expect(parseJsonObject(' {"a":1}\r')).toEqual({ a: 1 });
    expect(parseJsonObject('[1]')).toBeUndefined();
    expect(parseJsonObject('{broken')).toBeUndefined();
    expect(parseJsonObject('')).toBeUndefined();
  });
});

describe('ids and folder names', () => {
  it('recognises conversation ids', () => {
    const id = '3f2a9c1e-7b64-4d08-9a51-c0ffee123456';
    expect(isUuid(id)).toBe(true);
    expect(isUuid(`${id}.jsonl`)).toBe(false);
    expect(uuidsIn(`1p_failed_events.${id}.019A2B3C-4D5E-7F60-8A1B-2C3D4E5F6A7B.json`)).toEqual([id, '019a2b3c-4d5e-7f60-8a1b-2c3d4e5f6a7b']);
    expect(uuidsIn('bash-edit-diff')).toEqual([]);
  });

  it('names project folders the way Claude Code does', () => {
    expect(projectFolderName('c:\\code\\web_shop')).toBe('c--code-web-shop');
    expect(projectFolderName('C:\\Users\\me\\My Docs\\App 2')).toBe('C--Users-me-My-Docs-App-2');
    expect(projectFolderName('/home/me/my.app')).toBe('-home-me-my-app');
    expect(projectFolderName('d:\\文件\\x')).toBe('d-----x');
  });
});

describe('processes', () => {
  it('parses process listings', () => {
    expect(parseTasklist('"claude.exe","1092","Console","1","512,345 K"\r\n"System Idle Process","0","Services","0","8 K"\r\n\r\n')).toEqual(
      new Map([
        [1092, 'claude.exe'],
        [0, 'System Idle Process'],
      ]),
    );
    expect(parsePs('    1 /sbin/init\n 4242 node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js --resume\n')).toEqual(
      new Map([
        [1, '/sbin/init'],
        [4242, 'node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js --resume'],
      ]),
    );
  });

  it('tells Claude Code from unrelated programs', () => {
    expect(['claude.exe', 'Claude.EXE', 'node.exe', 'bun.exe'].map((name) => looksLikeClaude(name, 'win32'))).toEqual([true, true, true, true]);
    expect(['chrome.exe', 'claude-helper.exe', 'Code.exe'].map((name) => looksLikeClaude(name, 'win32'))).toEqual([false, false, false]);
    expect(looksLikeClaude('/home/me/.local/share/claude/versions/2.1.327 --resume', 'linux')).toBe(true);
    expect(looksLikeClaude('/usr/bin/vim notes.txt', 'linux')).toBe(false);
  });
});

describe('file helpers', () => {
  it('reads the ends and the first line of a file', async () => {
    const file = write(path.join(scratch(), 'a.txt'), `first line\n${'x'.repeat(200_000)}\nlast`);
    expect(await readFirstLine(file)).toBe('first line');
    expect((await readHead(file, 5)).toString()).toBe('first');
    expect((await readTail(file, 4)).toString()).toBe('last');
    expect((await readTail(file, 10 ** 9)).length).toBe(fs.statSync(file).size);
    expect(await readFirstLine(write(path.join(scratch(), 'b.txt'), 'x'.repeat(5000)), 1000)).toBeUndefined();
    expect(await readFirstLine(write(path.join(scratch(), 'c.txt'), 'no newline'))).toBe('no newline');
  });

  it('measures a folder', async () => {
    const dir = scratch();
    write(path.join(dir, 'a', 'one.txt'), '12345');
    write(path.join(dir, 'a', 'b', 'two.txt'), '123');
    mkdir(path.join(dir, 'empty', 'deeper'));
    expect(await treeStats(dir)).toMatchObject({ isDir: true, bytes: 8, files: 2 });
    expect(await treeStats(path.join(dir, 'a', 'one.txt'))).toMatchObject({ isDir: false, bytes: 5, files: 1 });
    expect(await treeStats(path.join(dir, 'nope'))).toBeNull();
    expect(await hasAnyFile(path.join(dir, 'empty'))).toBe(false);
    expect(await hasAnyFile(dir)).toBe(true);
    age(path.join(dir, 'a'), 10 * 86_400_000);
    const stats = await treeStats(path.join(dir, 'a'));
    expect(Date.now() - (stats?.newestMtimeMs ?? 0)).toBeGreaterThan(9 * 86_400_000);
  });

  it('removes folders only when they hold no files', async () => {
    const dir = scratch();
    mkdir(path.join(dir, 'empty', 'scratchpad'));
    mkdir(path.join(dir, 'empty', 'tasks', 'deep'));
    mkdir(path.join(dir, 'used', 'scratchpad'));
    write(path.join(dir, 'used', 'tasks', 'x.output'), 'x');
    expect(await removeEmptyTree(path.join(dir, 'empty'))).toBe(true);
    expect(await removeEmptyTree(path.join(dir, 'used'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'empty'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'used', 'scratchpad'))).toBe(true); // untouched, not half-removed
  });

  it('drops lines from a file and keeps the rest byte for byte', async () => {
    const file = write(path.join(scratch(), 'h.jsonl'), 'keep 1\r\ndrop me\r\nkeep 2\r\n');
    expect(await dropLines(file, (line) => line.includes('drop'))).toBe(1);
    expect(fs.readFileSync(file, 'utf8')).toBe('keep 1\r\nkeep 2\r\n');
    expect(await dropLines(file, () => false)).toBe(0);
    expect(await dropLines(path.join(scratch(), 'missing'), () => true)).toBe(0);
    expect(fs.readdirSync(path.dirname(file))).toEqual(['h.jsonl']);
  });

  it('limits concurrency and keeps order', async () => {
    let running = 0;
    let peak = 0;
    const out = await mapLimit([5, 1, 3, 2, 4], 2, async (n) => {
      peak = Math.max(peak, ++running);
      await new Promise((resolve) => setTimeout(resolve, n));
      running--;
      return n * 2;
    });
    expect(out).toEqual([10, 2, 6, 4, 8]);
    expect(peak).toBe(2);
  });
});

describe('finding the Codex program', () => {
  function layout(): { home: string; exe: (dir: string, mtime: number) => string } {
    const home = scratch();
    return {
      home,
      exe: (dir, mtime) => {
        const file = write(path.join(dir, 'codex.exe'), 'binary');
        fs.utimesSync(file, new Date(mtime), new Date(mtime));
        return file;
      },
    };
  }

  it('prefers the setting, then the running editor, then the newest bundled copy, then the app, then PATH', async () => {
    const { home, exe } = layout();
    const onPath = exe(path.join(home, 'pathdir'), 1_000_000);
    const env = { PATH: `${path.join(home, 'nothing-here')};${path.join(home, 'pathdir')}`, LOCALAPPDATA: path.join(home, 'AppData') };
    const find = (extra: object = {}): Promise<string | undefined> => findCodexExecutable({ home, env, platform: 'win32', ...extra });
    expect(await find()).toBe(onPath);

    const app = exe(path.join(home, 'AppData', 'OpenAI', 'Codex', 'bin', 'v1'), 2_000_000);
    expect(await find()).toBe(app);

    exe(path.join(home, '.vscode', 'extensions', 'openai.chatgpt-1.0.0', 'bin', 'windows-x86_64'), 3_000_000);
    const newer = exe(path.join(home, '.cursor', 'extensions', 'openai.chatgpt-2.0.0', 'bin', 'windows-x86_64'), 4_000_000);
    exe(path.join(home, '.vscode', 'extensions', 'someone.else-1.0.0', 'bin', 'windows-x86_64'), 9_000_000);
    expect(await find()).toBe(newer);

    const running = exe(path.join(home, 'running-editor', 'openai.chatgpt-0.9.0', 'bin', 'windows-x86_64'), 500_000);
    expect(await find({ extensionDirs: [path.join(home, 'running-editor', 'openai.chatgpt-0.9.0')] })).toBe(running);

    expect(await find({ override: onPath })).toBe(onPath);
    expect(await find({ override: path.join(home, 'does-not-exist.exe') })).toBeUndefined();
  });

  it('finds nothing on an empty machine', async () => {
    const { home } = layout();
    expect(await findCodexExecutable({ home, env: {}, platform: 'linux' })).toBeUndefined();
  });
});
