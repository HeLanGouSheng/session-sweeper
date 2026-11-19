import { createReadStream } from 'fs';
import * as readline from 'readline';
import { asObject, asString, contentText, parseJsonObject, stripWrappers } from './text';
import { CancelledError, type SessionInfo } from './types';

export interface PreviewMessage {
  role: 'user' | 'assistant';
  text: string;
  /** Names of the tools the assistant called in this turn, in order. */
  tools: string[];
  time?: number;
}

export interface Preview {
  /** The first messages of the conversation. */
  head: PreviewMessage[];
  /** The last messages, when the conversation is longer than what is kept. */
  tail: PreviewMessage[];
  total: number;
}

export interface PreviewOptions {
  /** How many messages to keep from each end. */
  keep?: number;
  maxCharsPerMessage?: number;
  signal?: AbortSignal;
}

interface RawMessage {
  role: 'user' | 'assistant';
  text: string;
  tools: string[];
  time?: number;
}

function timeOf(entry: Record<string, unknown>): number | undefined {
  const parsed = Date.parse(asString(entry.timestamp) ?? '');
  return Number.isNaN(parsed) ? undefined : parsed;
}

function toolNames(content: unknown): string[] {
  if (!Array.isArray(content)) {
    return [];
  }
  const names: string[] = [];
  for (const block of content) {
    const object = asObject(block);
    if (object?.type === 'tool_use') {
      names.push(asString(object.name) ?? 'tool');
    }
  }
  return names;
}

/** One transcript line of Claude Code → a message, or undefined when the line is not part of the visible conversation. */
export function claudeMessage(line: string): RawMessage | undefined {
  // Request bookkeeping repeats every message and makes up most of the file; skip it without parsing.
  if (line.startsWith('{"type":"api-request') || line.startsWith('{"type":"file-history')) {
    return undefined;
  }
  const entry = parseJsonObject(line);
  if (!entry || entry.isSidechain === true || entry.isMeta === true) {
    return undefined;
  }
  const message = asObject(entry.message);
  if (!message) {
    return undefined;
  }
  const time = timeOf(entry);
  if (entry.type === 'user' && message.role === 'user') {
    const text = stripWrappers(contentText(message.content));
    return text ? withTime({ role: 'user', text, tools: [] }, time) : undefined;
  }
  if (entry.type === 'assistant' && message.role === 'assistant') {
    const text = contentText(message.content).trim();
    const tools = toolNames(message.content);
    return text || tools.length ? withTime({ role: 'assistant', text, tools }, time) : undefined;
  }
  return undefined;
}

/** One rollout line of Codex → a message. */
export function codexMessage(line: string): RawMessage | undefined {
  const start = line.slice(0, 200);
  if (!start.includes('"response_item"') && !start.includes('"message"') && !start.includes('_call"')) {
    return undefined;
  }
  const entry = parseJsonObject(line);
  if (!entry) {
    return undefined;
  }
  const item = asObject(entry.payload) ?? entry;
  const time = timeOf(entry);
  if (item.type === 'message') {
    if (item.role === 'user') {
      const text = stripWrappers(contentText(item.content));
      // Codex injects context blocks as user messages; they start with a tag.
      return text && !text.startsWith('<') ? withTime({ role: 'user', text, tools: [] }, time) : undefined;
    }
    if (item.role === 'assistant') {
      const text = contentText(item.content).trim();
      return text ? withTime({ role: 'assistant', text, tools: [] }, time) : undefined;
    }
    return undefined;
  }
  if (item.type === 'function_call' || item.type === 'custom_tool_call' || item.type === 'local_shell_call') {
    return withTime({ role: 'assistant', text: '', tools: [asString(item.name) ?? 'shell'] }, time);
  }
  return undefined;
}

function withTime(message: RawMessage, time: number | undefined): RawMessage {
  if (time !== undefined) {
    message.time = time;
  }
  return message;
}

/**
 * Reads the visible conversation out of a transcript: what the user typed, what the
 * assistant answered, and which tools it used. Only the first and last `keep`
 * messages are kept, so previewing a very long conversation stays cheap.
 */
export async function readPreview(session: SessionInfo, options: PreviewOptions = {}): Promise<Preview> {
  const keep = options.keep ?? 40;
  const maxChars = options.maxCharsPerMessage ?? 4000;
  const parse = session.provider === 'claude' ? claudeMessage : codexMessage;
  const head: PreviewMessage[] = [];
  const tail: PreviewMessage[] = [];
  let total = 0;
  let current: RawMessage | undefined;

  const flush = (): void => {
    if (!current) {
      return;
    }
    const text = current.text.length > maxChars ? `${current.text.slice(0, maxChars).trimEnd()}\n\n[…]` : current.text;
    const message: PreviewMessage = { role: current.role, text, tools: current.tools };
    if (current.time !== undefined) {
      message.time = current.time;
    }
    total += 1;
    if (head.length < keep) {
      head.push(message);
    } else {
      tail.push(message);
      if (tail.length > keep) {
        tail.shift();
      }
    }
    current = undefined;
  };

  for (const file of session.transcripts) {
    const lines = readline.createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (options.signal?.aborted) {
          throw new CancelledError();
        }
        const message = parse(line);
        if (!message) {
          continue;
        }
        // The assistant's turn is stored in pieces (text, tool calls); join them into one message.
        if (current && current.role === 'assistant' && message.role === 'assistant') {
          current.text = [current.text, message.text].filter(Boolean).join('\n\n');
          current.tools.push(...message.tools);
          continue;
        }
        flush();
        current = message;
      }
    } finally {
      lines.close();
    }
  }
  flush();
  return { head, tail, total };
}
