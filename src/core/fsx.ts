import type { Dirent, Stats } from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';

const UUID_SOURCE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const UUID_EXACT = new RegExp(`^${UUID_SOURCE}$`, 'i');

export function isUuid(text: string): boolean {
  return UUID_EXACT.test(text);
}

/** All UUIDs that appear in a file or folder name, lower-cased. */
export function uuidsIn(name: string): string[] {
  return (name.match(new RegExp(UUID_SOURCE, 'gi')) ?? []).map((s) => s.toLowerCase());
}

export function norm(id: string): string {
  return id.toLowerCase();
}

export async function listDir(dir: string): Promise<Dirent[]> {
  try {
    return await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** `lstat` that returns null instead of throwing. Never follows symlinks. */
export async function statOrNull(target: string): Promise<Stats | null> {
  try {
    return await fsp.lstat(target);
  } catch {
    return null;
  }
}

export async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await fsp.stat(target)).isDirectory();
  } catch {
    return false;
  }
}

export async function exists(target: string): Promise<boolean> {
  return (await statOrNull(target)) !== null;
}

async function readRange(file: string, position: 'head' | 'tail', maxBytes: number): Promise<Buffer> {
  const handle = await fsp.open(file, 'r');
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, maxBytes);
    const start = position === 'head' ? 0 : size - length;
    const buffer = Buffer.allocUnsafe(length);
    let offset = 0;
    while (offset < length) {
      const { bytesRead } = await handle.read(buffer, offset, length - offset, start + offset);
      if (bytesRead === 0) {
        break;
      }
      offset += bytesRead;
    }
    return buffer.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

export function readHead(file: string, maxBytes: number): Promise<Buffer> {
  return readRange(file, 'head', maxBytes);
}

export function readTail(file: string, maxBytes: number): Promise<Buffer> {
  return readRange(file, 'tail', maxBytes);
}

/** The first line of a file, or undefined when it is longer than `maxBytes`. */
export async function readFirstLine(file: string, maxBytes = 8 * 1024 * 1024): Promise<string | undefined> {
  const handle = await fsp.open(file, 'r');
  try {
    const chunks: Buffer[] = [];
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    for (;;) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
      if (bytesRead === 0) {
        break;
      }
      const view = chunk.subarray(0, bytesRead);
      const newline = view.indexOf(10);
      if (newline >= 0) {
        chunks.push(Buffer.from(view.subarray(0, newline)));
        return Buffer.concat(chunks).toString('utf8');
      }
      chunks.push(Buffer.from(view));
      position += bytesRead;
      if (position > maxBytes) {
        return undefined;
      }
    }
    return chunks.length ? Buffer.concat(chunks).toString('utf8') : undefined;
  } finally {
    await handle.close();
  }
}

export interface TreeStats {
  isDir: boolean;
  bytes: number;
  files: number;
  /** Most recent modification time of the entry itself or anything inside it. */
  newestMtimeMs: number;
}

/** Size, file count and newest modification time of a file or folder. Symlinks are counted, not followed. */
export async function treeStats(target: string): Promise<TreeStats | null> {
  const top = await statOrNull(target);
  if (!top) {
    return null;
  }
  const result: TreeStats = { isDir: top.isDirectory(), bytes: 0, files: 0, newestMtimeMs: top.mtimeMs };
  if (!top.isDirectory()) {
    result.bytes = top.size;
    result.files = 1;
    return result;
  }
  const pending = [target];
  while (pending.length) {
    const dir = pending.pop() as string;
    for (const entry of await listDir(dir)) {
      const full = path.join(dir, entry.name);
      const st = await statOrNull(full);
      if (!st) {
        continue;
      }
      result.newestMtimeMs = Math.max(result.newestMtimeMs, st.mtimeMs);
      if (st.isDirectory()) {
        pending.push(full);
      } else {
        result.bytes += st.size;
        result.files += 1;
      }
    }
  }
  return result;
}

/** True when the folder holds at least one thing that is not a folder, at any depth. */
export async function hasAnyFile(dir: string): Promise<boolean> {
  const pending = [dir];
  while (pending.length) {
    const current = pending.pop() as string;
    for (const entry of await listDir(current)) {
      if (!entry.isDirectory()) {
        return true;
      }
      pending.push(path.join(current, entry.name));
    }
  }
  return false;
}

/**
 * Removes a folder that contains nothing but (possibly nested) empty folders.
 * Only ever calls `rmdir`, so a file that shows up in the meantime makes it fail instead of being deleted.
 */
export async function removeEmptyTree(dir: string): Promise<boolean> {
  if (await hasAnyFile(dir)) {
    return false;
  }
  const remove = async (current: string): Promise<boolean> => {
    for (const entry of await listDir(current)) {
      if (!entry.isDirectory() || !(await remove(path.join(current, entry.name)))) {
        return false;
      }
    }
    try {
      await fsp.rmdir(current);
      return true;
    } catch {
      return false;
    }
  };
  return remove(dir);
}

/**
 * Rewrites a text file without the lines for which `drop` returns true.
 * Returns the number of removed lines. The file is replaced atomically, and left
 * alone when it changes while we work on it.
 */
export async function dropLines(file: string, drop: (line: string) => boolean): Promise<number> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = await statOrNull(file);
    if (!before || !before.isFile()) {
      return 0;
    }
    const lines = (await fsp.readFile(file, 'utf8')).split('\n');
    const kept = lines.filter((line) => line.trim() === '' || !drop(line));
    const removed = lines.length - kept.length;
    if (removed === 0) {
      return 0;
    }
    const temp = `${file}.sweeper-${process.pid}.tmp`;
    await fsp.writeFile(temp, kept.join('\n'), { mode: before.mode });
    const after = await statOrNull(file);
    if (after && after.size === before.size && after.mtimeMs === before.mtimeMs) {
      await fsp.rename(temp, file);
      return removed;
    }
    await fsp.rm(temp, { force: true });
  }
  throw new Error(`${path.basename(file)} keeps changing; it was left untouched`);
}

/** Runs `fn` over `items` with at most `limit` running at once, preserving order. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      if (index >= items.length) {
        return;
      }
      results[index] = await fn(items[index] as T, index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
