import * as fsp from 'fs/promises';
import { claudeMessage, codexMessage } from './preview';
import { CancelledError, type SessionInfo } from './types';

const CHUNK = 4 * 1024 * 1024;
/** A line longer than this is not examined. Nothing a person typed or read is that long. */
const MAX_LINE = 64 * 1024 * 1024;
const NEWLINE = 10;

export interface Needles {
  /** True when letters must match regardless of case. */
  fold: boolean;
  /** Byte patterns for exact matching. */
  exact: Buffer[];
  /** The same patterns, case-folded, for matching against case-folded text. */
  folded: string[];
}

/** Case-folds bytes one-to-one, so offsets and multi-byte characters stay intact. */
function foldBytes(bytes: Buffer): string {
  return bytes.toString('latin1').toLowerCase();
}

/**
 * Prepares a query for searching transcript files, which are JSON Lines: besides
 * the text as typed, the form it takes inside a JSON string (escaped quotes,
 * backslashes and line breaks) is looked for too.
 */
export function buildNeedles(query: string): Needles {
  const variants = new Set([query, JSON.stringify(query).slice(1, -1)]);
  const exact = [...variants].filter((variant) => variant.length > 0 && !variant.includes('\n')).map((variant) => Buffer.from(variant, 'utf8'));
  return {
    // Matching bytes exactly is several times faster, and case only exists for letters.
    fold: /[a-z]/i.test(query),
    exact,
    folded: exact.map(foldBytes),
  };
}

type Accept = (line: Buffer) => boolean;

/**
 * Hands every line of `region` that contains a needle to `accept`, and returns
 * true as soon as one is accepted. `region` must consist of whole lines.
 */
function searchRegion(region: Buffer, needles: Needles, accept: Accept): boolean {
  const text = needles.fold ? foldBytes(region) : undefined;
  const find = (index: number, from: number): number =>
    text === undefined ? region.indexOf(needles.exact[index] as Buffer, from) : text.indexOf(needles.folded[index] as string, from);
  // Next known position of each needle; -2 means "not looked for yet".
  const next = needles.exact.map(() => -2);
  let from = 0;
  while (from < region.length) {
    let at = -1;
    for (let index = 0; index < next.length; index++) {
      let position = next[index] as number;
      if (position === -2 || (position >= 0 && position < from)) {
        position = find(index, from);
        next[index] = position;
      }
      if (position >= 0 && (at < 0 || position < at)) {
        at = position;
      }
    }
    if (at < 0) {
      return false;
    }
    const start = region.lastIndexOf(NEWLINE, at) + 1;
    const newline = region.indexOf(NEWLINE, at);
    const end = newline < 0 ? region.length : newline;
    if (accept(region.subarray(start, end))) {
      return true;
    }
    from = end + 1;
  }
  return false;
}

/**
 * Whether some line of the file contains a needle and is accepted. The file is read
 * once, in chunks; only matching lines are ever decoded.
 */
async function anyLine(file: string, needles: Needles, accept: Accept, signal?: AbortSignal): Promise<boolean> {
  let handle: fsp.FileHandle | undefined;
  try {
    handle = await fsp.open(file, 'r');
    const chunk = Buffer.allocUnsafe(CHUNK);
    // Pieces of a line whose end has not been read yet.
    let pending: Buffer[] = [];
    let pendingBytes = 0;
    let position = 0;
    for (;;) {
      if (signal?.aborted) {
        throw new CancelledError();
      }
      const { bytesRead } = await handle.read(chunk, 0, CHUNK, position);
      position += bytesRead;
      if (bytesRead === 0) {
        return pendingBytes > 0 && searchRegion(Buffer.concat(pending), needles, accept);
      }
      const view = chunk.subarray(0, bytesRead);
      const lastNewline = view.lastIndexOf(NEWLINE);
      if (lastNewline < 0) {
        if (pendingBytes + bytesRead > MAX_LINE) {
          pending = [];
          pendingBytes = 0;
        } else {
          pending.push(Buffer.from(view));
          pendingBytes += bytesRead;
        }
        continue;
      }
      const whole = view.subarray(0, lastNewline + 1);
      if (searchRegion(pendingBytes ? Buffer.concat([...pending, whole]) : whole, needles, accept)) {
        return true;
      }
      const rest = view.subarray(lastNewline + 1);
      pending = rest.length ? [Buffer.from(rest)] : [];
      pendingBytes = rest.length;
    }
  } catch (error) {
    if (error instanceof CancelledError) {
      throw error;
    }
    return false; // unreadable or vanished: not a match
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** Case-insensitive match for short texts such as titles and single messages. */
export function textContains(text: string, query: string): boolean {
  return text.toLowerCase().includes(query.toLowerCase());
}

/** Claude Code repeats every message in request bookkeeping lines, which make up most of a transcript. */
const BOOKKEEPING = [Buffer.from('{"type":"api-request'), Buffer.from('{"type":"file-history')];

function startsWith(line: Buffer, prefix: Buffer): boolean {
  return line.length >= prefix.length && line.compare(prefix, 0, prefix.length, 0, prefix.length) === 0;
}

/**
 * Whether the query appears in the visible conversation: something the user typed
 * or the assistant answered. Text the tools inject (reminders, memory, file
 * contents, request bookkeeping) does not count, otherwise a word from a memory
 * note or a folder name would match every conversation.
 *
 * Letters A–Z match regardless of case; everything else must match exactly.
 */
export async function conversationContains(session: SessionInfo, query: string, signal?: AbortSignal): Promise<boolean> {
  const needles = buildNeedles(query);
  if (needles.exact.length === 0) {
    return false;
  }
  const parse = session.provider === 'claude' ? claudeMessage : codexMessage;
  const accept: Accept = (line) => {
    if (BOOKKEEPING.some((prefix) => startsWith(line, prefix))) {
      return false;
    }
    const message = parse(line.toString('utf8'));
    return message !== undefined && textContains(message.text, query);
  };
  for (const file of session.transcripts) {
    if (await anyLine(file, needles, accept, signal)) {
      return true;
    }
  }
  return false;
}
