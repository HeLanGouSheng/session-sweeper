import { execFile } from 'child_process';
import * as path from 'path';

/** pid → image name (Windows) or full command line (elsewhere). */
export type ProcessTable = Map<number, string>;

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function parseTasklist(output: string): ProcessTable {
  const table: ProcessTable = new Map();
  for (const line of output.split(/\r?\n/)) {
    const match = /^"([^"]*)","(\d+)"/.exec(line);
    if (match) {
      table.set(Number(match[2]), match[1] as string);
    }
  }
  return table;
}

export function parsePs(output: string): ProcessTable {
  const table: ProcessTable = new Map();
  for (const line of output.split('\n')) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (match) {
      table.set(Number(match[1]), (match[2] as string).trim());
    }
  }
  return table;
}

/** Lists running processes, or undefined when that is not possible on this system. */
export function listProcesses(platform: NodeJS.Platform = process.platform): Promise<ProcessTable | undefined> {
  return new Promise((resolve) => {
    const options = { windowsHide: true, timeout: 10_000, maxBuffer: 32 * 1024 * 1024 };
    const done = (error: Error | null, stdout: string): void => {
      if (error) {
        resolve(undefined);
        return;
      }
      const table = platform === 'win32' ? parseTasklist(stdout) : parsePs(stdout);
      resolve(table.size ? table : undefined);
    };
    if (platform === 'win32') {
      const root = process.env.SystemRoot ?? process.env.windir;
      const tasklist = root ? path.join(root, 'System32', 'tasklist.exe') : 'tasklist';
      execFile(tasklist, ['/FO', 'CSV', '/NH'], options, done);
    } else {
      execFile('ps', ['-A', '-o', 'pid=,command='], options, done);
    }
  });
}

/**
 * Whether a process could be Claude Code. Process ids are reused, so a stale
 * registration may point at an unrelated program; this keeps such a program
 * from making a conversation look open forever.
 */
export function looksLikeClaude(description: string, platform: NodeJS.Platform = process.platform): boolean {
  if (platform === 'win32') {
    return /^(claude|node|bun)(\.exe)?$/i.test(description.trim());
  }
  return /claude/i.test(description);
}
