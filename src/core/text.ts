/** Blocks that the tools wrap around or inject into user messages; they are not what the user typed. */
const WRAPPER_TAGS = [
  'system-reminder',
  'ide_opened_file',
  'ide_selection',
  'ide_diagnostics',
  'local-command-caveat',
  'local-command-stdout',
  'local-command-stderr',
  'command-name',
  'command-message',
  'command-args',
  'environment_context',
  'user_instructions',
  'turn_aborted',
];

const WRAPPER_RE = new RegExp(`<(${WRAPPER_TAGS.join('|')})>[\\s\\S]*?</\\1>`, 'g');

/** The user's own words from a raw message, without injected blocks. */
export function stripWrappers(text: string): string {
  return text.replace(WRAPPER_RE, '').trim();
}

export function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/** A short single-line label made from a user message; empty when nothing meaningful is left. */
export function promptToTitle(text: string, max = 80): string {
  return oneLine(stripWrappers(text), max);
}

/** Parses one JSONL line, returning undefined for anything that is not a JSON object. */
export function parseJsonObject(line: string): Record<string, unknown> | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) {
    return undefined;
  }
  try {
    const value: unknown = JSON.parse(trimmed);
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/**
 * Concatenates the text parts of a message `content` value, which is either a
 * plain string or an array of typed blocks (`text`, `input_text`, `output_text`).
 */
export function contentText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  const parts: string[] = [];
  for (const block of content) {
    const object = asObject(block);
    const type = asString(object?.type);
    if (object && (type === 'text' || type === 'input_text' || type === 'output_text')) {
      const text = asString(object.text);
      if (text) {
        parts.push(text);
      }
    }
  }
  return parts.join('\n\n');
}
