// A stand-in for the Codex command-line program, for tests and demos. It does to the files
// under CODEX_HOME what `codex delete --force <id>` does: removes the thread's rollout file
// and its line in the index. Review threads are left alone, as the real command leaves them.
const fs = require('fs');
const path = require('path');

const home = process.env.CODEX_HOME;
const [command, flag, id] = process.argv.slice(2);

if (command === 'delete' && flag === '--help') {
  console.log('Usage: codex delete [OPTIONS] <SESSION>\n      --force');
  process.exit(0);
}
if (!home || command !== 'delete' || flag !== '--force' || !/^[0-9a-f-]{36}$/.test(id || '')) {
  console.error('bad arguments');
  process.exit(2);
}

let removed = 0;
const walk = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full);
    } else if (entry.name.includes(id)) {
      fs.rmSync(full);
      removed += 1;
    }
  }
};
walk(path.join(home, 'sessions'));

const index = path.join(home, 'session_index.jsonl');
if (fs.existsSync(index)) {
  const kept = fs.readFileSync(index, 'utf8').split('\n').filter((line) => !line.includes(id));
  fs.writeFileSync(index, kept.join('\n'));
}
if (removed === 0) {
  console.error('Error: failed to delete session');
  process.exit(1);
}
console.log(`Deleted session ${id}`);
