// Builds a made-up Claude Code and Codex data set, for screenshots and for trying the
// extension without touching real conversations.
//
//   node scripts/demo-data.mjs <target folder>
//
// Then start VS Code with CLAUDE_CONFIG_DIR=<target>/claude, CODEX_HOME=<target>/codex
// and SESSION_SWEEPER_CLAUDE_TEMP=<target>/temp/claude.
import { appendFileSync, mkdirSync, truncateSync, utimesSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const MB = 1024 * 1024;

let counter = 0;
const nextId = () => `${(++counter).toString(16).padStart(8, '0')}-5eed-4a11-9c0d-0123456789ab`;

function write(file, content) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
  return file;
}

/** A file of the given size without writing its content. */
function blob(file, bytes) {
  write(file, '');
  truncateSync(file, Math.round(bytes));
}

function age(target, ms) {
  const when = new Date(Date.now() - ms);
  if (statSync(target).isDirectory()) {
    for (const name of readdirSync(target)) {
      age(join(target, name), ms);
    }
  }
  utimesSync(target, when, when);
}

const slugOf = (cwd) => cwd.replace(/[^a-zA-Z0-9]/g, '-');

export function buildDemoData(target) {
  const claude = join(target, 'claude');
  const codex = join(target, 'codex');
  const temp = join(target, 'temp', 'claude');

  function claudeConversation({ cwd, title, turns, ago, dataMb = 0, snapshots = false, scratch = false }) {
    const id = nextId();
    const slug = slugOf(cwd);
    const started = Date.now() - ago - HOUR;
    const lines = [];
    turns.forEach(([prompt, reply, tools = []], index) => {
      const at = new Date(started + index * 4 * 60_000).toISOString();
      lines.push({ type: 'user', isSidechain: false, cwd, sessionId: id, message: { role: 'user', content: [{ type: 'text', text: prompt }] }, timestamp: at });
      lines.push({
        type: 'assistant',
        isSidechain: false,
        cwd,
        sessionId: id,
        message: { role: 'assistant', content: [{ type: 'text', text: reply }, ...tools.map((name) => ({ type: 'tool_use', name, input: {} }))] },
        timestamp: at,
      });
    });
    lines.push({ type: 'ai-title', aiTitle: title, sessionId: id });
    const file = write(join(claude, 'projects', slug, `${id}.jsonl`), `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
    if (dataMb) {
      blob(join(claude, 'projects', slug, id, 'subagents', 'agent-a1b2c3.jsonl'), Math.round(dataMb * 0.7 * MB));
      blob(join(claude, 'projects', slug, id, 'tool-results', 'toolu_01.txt'), Math.round(dataMb * 0.3 * MB));
      age(join(claude, 'projects', slug, id), ago);
    }
    if (snapshots) {
      write(join(claude, 'file-history', id, '4f1d2c@v1'), 'export const total = (items) => items.reduce((sum, item) => sum + item.price, 0);\n');
      mkdirSync(join(claude, 'session-env', id), { recursive: true });
    }
    if (scratch) {
      write(join(temp, slug, id, 'scratchpad', 'repro.mjs'), 'console.log(0.1 + 0.2);\n');
      write(join(temp, slug, id, 'tasks', 'b1.output'), 'ok\n');
    }
    age(file, ago);
    return file;
  }

  function codexThread({ id = nextId(), root, cwd, name, prompt, reply = 'Done.', ago, guardian = false, mb = 0 }) {
    const lines = [
      {
        timestamp: new Date(Date.now() - ago).toISOString(),
        type: 'session_meta',
        payload: {
          session_id: root ?? id,
          id,
          ...(guardian ? { parent_thread_id: root } : {}),
          timestamp: new Date(Date.now() - ago).toISOString(),
          cwd,
          source: guardian ? { subagent: { other: 'guardian' } } : 'vscode',
        },
      },
      { timestamp: new Date(Date.now() - ago).toISOString(), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt }] } },
      { timestamp: new Date(Date.now() - ago).toISOString(), type: 'response_item', payload: { type: 'function_call', name: 'exec', arguments: '{}', call_id: 'c1' } },
      { timestamp: new Date(Date.now() - ago).toISOString(), type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: reply }] } },
    ];
    const file = write(join(codex, 'sessions', '2026', '11', '02', `rollout-2026-11-02T10-00-00-${id}.jsonl`), `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
    if (mb) {
      truncateSync(file, Math.round(mb * MB)); // pads with zero bytes after the last line
    }
    age(file, ago);
    if (name) {
      mkdirSync(codex, { recursive: true });
      appendFileSync(join(codex, 'session_index.jsonl'), `${JSON.stringify({ id, thread_name: name, updated_at: new Date(Date.now() - ago).toISOString() })}\n`);
    }
    return id;
  }

  function codexConversation({ cwd, name, prompt, reply, ago, mb, reviews }) {
    const id = codexThread({ cwd, name, prompt, reply, ago, mb });
    for (let n = 0; n < reviews; n++) {
      codexThread({ root: id, cwd, prompt: `Review step ${n + 1}`, ago, guardian: true, mb: 0.2 });
    }
    return id;
  }

  const shop = 'D:\\projects\\web-shop';
  const notes = 'D:\\projects\\notes-app';

  const inUse = claudeConversation({
    cwd: shop,
    title: 'Refactor the payment service',
    ago: 0,
    dataMb: 12,
    turns: [['Split PaymentService into a gateway and a ledger.', 'Starting with the gateway interface.', ['Read', 'Edit']]],
  });
  claudeConversation({
    cwd: shop,
    title: 'Fix checkout rounding bug',
    ago: 2 * HOUR,
    dataMb: 180,
    snapshots: true,
    scratch: true,
    turns: [
      ['The cart total is off by one cent for some orders. Can you find out why?', 'I will reproduce it first, then look at how the totals are summed.', ['Bash', 'Read']],
      ['It happens with three items at 0.10, 0.20 and 0.30.', 'That is floating-point addition: 0.1 + 0.2 is not exactly 0.3. The totals should be summed in cents as integers.', ['Edit', 'Bash']],
      ['Do that, and add a test for this order.', 'Done. Prices are converted to integer cents before summing, and the new test covers the 0.10 + 0.20 + 0.30 order.', ['Edit', 'Bash']],
    ],
  });
  claudeConversation({
    cwd: shop,
    title: 'Migrate the test suite to Vitest',
    ago: 26 * HOUR,
    dataMb: 64,
    snapshots: true,
    turns: [['Move the Jest tests to Vitest.', 'Converting the config first.', ['Read', 'Edit']]],
  });
  claudeConversation({ cwd: shop, title: 'Why is the Docker build slow?', ago: 3 * DAY, dataMb: 3, turns: [['The image takes 9 minutes to build.', 'The dependency layer is rebuilt on every change. Copy the lockfile before the sources.', ['Read']]] });
  claudeConversation({ cwd: notes, title: 'Offline sync design', ago: 6 * DAY, dataMb: 420, snapshots: true, turns: [['How should notes sync when the device was offline?', 'A per-note version vector keeps conflicts local to one note.', ['Agent']]] });
  claudeConversation({ cwd: notes, title: 'Add a dark mode', ago: 15 * DAY, dataMb: 1, turns: [['Add a dark theme toggle.', 'Using CSS custom properties, so components need no changes.', ['Edit']]] });

  codexConversation({ cwd: shop, name: 'Set up the CI pipeline', prompt: 'Add a GitHub Actions workflow that runs the tests.', reply: 'The workflow runs lint and tests on every push.', ago: 5 * HOUR, mb: 9, reviews: 6 });
  codexConversation({ cwd: shop, name: 'Benchmark image resizing', prompt: 'Compare sharp and jimp for thumbnails.', reply: 'sharp is about eight times faster here.', ago: 4 * DAY, mb: 41, reviews: 17 });
  codexConversation({ cwd: notes, name: 'Export notes to Markdown', prompt: 'Write an exporter.', reply: 'Added `notes export`.', ago: 9 * DAY, mb: 2, reviews: 2 });

  // What conversations deleted long ago left behind.
  for (let n = 0; n < 12; n++) {
    const dir = join(temp, slugOf(shop), nextId());
    mkdirSync(join(dir, 'scratchpad'), { recursive: true });
    age(dir, 20 * DAY);
  }
  for (let n = 0; n < 3; n++) {
    const id = nextId();
    blob(join(claude, 'file-history', id, 'a0b1c2@v1'), 0.4 * MB);
    age(join(claude, 'file-history', id), 20 * DAY);
  }
  write(join(claude, 'projects', slugOf(shop), 'memory', 'MEMORY.md'), '- Prices are stored in integer cents.\n');
  return {
    claude,
    codex,
    temp,
    /** Makes one conversation look as if it is being written to right now, so it shows as in use. */
    touchInUse: () => utimesSync(inUse, new Date(), new Date()),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const target = process.argv[2];
  if (!target) {
    console.error('Usage: node scripts/demo-data.mjs <target folder>');
    process.exit(1);
  }
  const made = buildDemoData(target);
  console.log(`CLAUDE_CONFIG_DIR=${made.claude}\nCODEX_HOME=${made.codex}\nSESSION_SWEEPER_CLAUDE_TEMP=${made.temp}`);
}
