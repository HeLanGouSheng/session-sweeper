// Clicks through the user interface in a real VS Code, on made-up conversations:
// the buttons, dialogs, menus and notifications that the API-level tests cannot reach.
//
//   npm run test:integration   (once; it downloads the VS Code used here)
//   npm run test:ui
//   node scripts/ui-check.mjs --vsix session-sweeper-0.1.0.vsix   (checks the packaged extension instead)
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { launchDemo } from './lib/vscode.mjs';

const vsixFlag = process.argv.indexOf('--vsix');
const demo = await launchDemo(vsixFlag > 0 ? { vsix: resolve(process.argv[vsixFlag + 1]) } : {});
const { page, rows, data } = demo;
let failed = false;

const step = async (name, run) => {
  process.stdout.write(`- ${name} ... `);
  await run();
  console.log('ok');
};

const titleAction = (label) => page.locator(`.part.sidebar .title a.action-label[aria-label*="${label}"], .part.sidebar .pane-header a.action-label[aria-label*="${label}"]`).first();
const rowAction = (title, label) => demo.row(title).locator(`a.action-label[aria-label^="${label}"]`);
const toast = (text) => page.locator('.notification-list-item').filter({ hasText: text });
const dialog = page.locator('.monaco-dialog-box');
const dialogButton = (name) => dialog.getByRole('button', { name, exact: true });
const menuItem = (name) => page.locator('.monaco-menu .action-item').filter({ hasText: name }).last();
const sessionTitles = async () =>
  (await rows.evaluateAll((elements) => elements.map((element) => element.querySelector('.label-name')?.textContent ?? ''))).filter(Boolean);
const transcripts = (folder) => readdirSync(join(data.claude, 'projects', folder)).filter((name) => name.endsWith('.jsonl')).length;
const rollouts = () => readdirSync(join(data.codex, 'sessions', '2026', '11', '02')).length;

async function clickRowAction(title, label) {
  await demo.row(title).hover();
  await rowAction(title, label).click();
}

// Notifications come and go; remember every one that was shown, to report them when a step fails.
await page.evaluate(() => {
  window.__seenToasts = [];
  new MutationObserver(() => {
    for (const element of document.querySelectorAll('.notification-list-item')) {
      const text = element.textContent ?? '';
      if (text && !window.__seenToasts.includes(text)) {
        window.__seenToasts.push(text);
      }
    }
  }).observe(document.body, { childList: true, subtree: true, characterData: true });
});

try {
  await demo.widenSidebar(560);

  await step('search narrows the list, clearing it brings everything back', async () => {
    await titleAction('Search Conversations').click();
    const input = page.locator('.quick-input-widget input.input');
    await input.fill('FLOATING-point');
    await input.press('Enter');
    await page.getByText('Conversations containing "FLOATING-point"').waitFor();
    await demo.row('Migrate the test suite to Vitest').waitFor({ state: 'detached' });
    assert.equal(await demo.row('Fix checkout rounding bug').count(), 1);
    assert.equal(await demo.row('Leftovers').count(), 0, 'leftovers are hidden while searching');
    await titleAction('Clear Search').click();
    await demo.row('Migrate the test suite to Vitest').waitFor();
    await demo.row('Leftovers').waitFor();
  });

  await step('a search without matches says so', async () => {
    await titleAction('Search Conversations').click();
    const input = page.locator('.quick-input-widget input.input');
    await input.fill('no conversation says this');
    await input.press('Enter');
    await page.getByText('No conversation contains that text.').waitFor();
    // The empty view offers its own button, next to the one in the title bar.
    await page.locator('.part.sidebar a.monaco-button').filter({ hasText: 'Clear Search' }).click();
    await demo.row('Fix checkout rounding bug').waitFor();
  });

  await step('a conversation in use offers an explanation instead of a trash button', async () => {
    await demo.row('Refactor the payment service').hover();
    assert.equal(await rowAction('Refactor the payment service', 'Delete').count(), 0);
    await rowAction('Refactor the payment service', 'Why Can').click();
    await toast('written to a moment ago').waitFor();
    await page.keyboard.press('Escape');
  });

  await step('sorting and grouping follow the menu, which marks the active choice', async () => {
    /** Opens a submenu of the "…" menu and clicks an entry, after checking which one is marked as active. */
    const choose = async (menu, item, activeBefore) => {
      await titleAction('More Actions').click();
      await menuItem(menu).hover();
      await menuItem(`✓ ${activeBefore}`).waitFor();
      await page.waitForTimeout(400); // a click right after a submenu opens is ignored
      await menuItem(item).click();
    };
    const before = await sessionTitles();
    assert.ok(before.indexOf('Refactor the payment service') < before.indexOf('Fix checkout rounding bug'), 'most recent first by default');
    await choose('Sort By', 'Size', 'Last Used');
    await page.waitForFunction(() => {
      const names = [...document.querySelectorAll('.sidebar .monaco-list-row .label-name')].map((element) => element.textContent);
      return names.indexOf('Fix checkout rounding bug') < names.indexOf('Refactor the payment service');
    });
    await choose('Group By', 'None', 'Folder');
    await page.waitForFunction(() => ![...document.querySelectorAll('.sidebar .monaco-list-row .label-name')].some((element) => element.textContent === 'web-shop'));
    const flat = await sessionTitles();
    assert.deepEqual(flat.slice(0, 3), ['Claude Code', 'Offline sync design', 'Fix checkout rounding bug'], 'one flat list, largest first');
    await choose('Group By', 'Folder', 'None');
    await choose('Sort By', 'Last Used', 'Size');
    await page.waitForFunction(() => {
      const names = [...document.querySelectorAll('.sidebar .monaco-list-row .label-name')].map((element) => element.textContent);
      return names.includes('web-shop') && names.indexOf('Refactor the payment service') < names.indexOf('Fix checkout rounding bug');
    });
  });

  // "Copy Conversation ID" is deliberately not clicked: the clipboard belongs to whoever runs this.
  await step('the context menu offers every action and opens a preview', async () => {
    await demo.row('Offline sync design').click({ button: 'right' });
    for (const name of ['Preview Conversation', 'Reveal Transcript in File Manager', 'Copy Conversation ID', 'Delete Conversation…', 'Delete Permanently…']) {
      assert.equal(await menuItem(name).count(), 1, name);
    }
    await page.waitForTimeout(400); // a click right after a menu opens is ignored
    await menuItem('Preview Conversation').click();
    await page.locator('.editor-instance .view-lines').filter({ hasText: 'version vector' }).waitFor();
  });

  await step('the Delete key asks the same question, and backing out deletes nothing', async () => {
    const before = transcripts('D--projects-notes-app');
    await demo.row('Offline sync design').click();
    await page.keyboard.press('Delete');
    await dialog.waitFor();
    assert.match(await dialog.innerText(), /Delete "Offline sync design"\?/);
    assert.match(await dialog.innerText(), /moved to the Recycle Bin/);
    await dialogButton('Cancel').click();
    await dialog.waitFor({ state: 'detached' });
    assert.equal(transcripts('D--projects-notes-app'), before);
    assert.equal(await demo.row('Offline sync design').count(), 1);
  });

  await step('the trash button deletes one conversation for good', async () => {
    const before = transcripts('D--projects-web-shop');
    await clickRowAction('Why is the Docker build slow?', 'Delete');
    await dialogButton('Delete Permanently').click();
    await toast('Deleted "Why is the Docker build slow?". Nothing was left behind.').waitFor();
    await demo.row('Why is the Docker build slow?').waitFor({ state: 'detached' });
    assert.equal(transcripts('D--projects-web-shop'), before - 1);
  });

  await step('a selection across both tools is deleted in one go', async () => {
    // VS Code stops popping up notifications when more than three arrive within 800 ms.
    // Nobody confirms two deletions that fast, but this script would.
    await page.waitForTimeout(1500);
    const before = { claude: transcripts('D--projects-notes-app'), codex: rollouts() };
    await demo.row('Add a dark mode').click();
    await demo.row('Export notes to Markdown').click({ modifiers: ['Control'] });
    await clickRowAction('Export notes to Markdown', 'Delete');
    await dialog.waitFor();
    const text = await dialog.innerText();
    assert.match(text, /Delete 2 conversations\?/);
    assert.match(text, /Claude Code: 1 conversation, 2 items/);
    assert.match(text, /Codex: 1 conversation and 2 helper threads/);
    assert.equal(await dialogButton('Delete').count(), 1);
    await dialogButton('Delete Permanently').click();
    await toast('Deleted 2 conversations. Nothing was left behind.').waitFor();
    await demo.row('Add a dark mode').waitFor({ state: 'detached' });
    await demo.row('Export notes to Markdown').waitFor({ state: 'detached' });
    assert.equal(transcripts('D--projects-notes-app'), before.claude - 1);
    assert.equal(rollouts(), before.codex - 3, 'the conversation and its two review threads');
  });

  await step('leftovers are cleaned up after a question', async () => {
    await page.waitForTimeout(1500); // see above
    const temp = join(data.temp, 'D--projects-web-shop');
    assert.equal(readdirSync(temp).length, 13);
    await clickRowAction('Leftovers', 'Clean Up');
    await dialog.waitFor();
    assert.match(await dialog.innerText(), /Empty temp folders: 12/);
    await dialogButton('Clean Up').click();
    await toast('Removed 15 leftover item(s).').waitFor();
    await demo.row('Leftovers').waitFor({ state: 'detached' });
    assert.equal(readdirSync(temp).length, 1, 'only the temp folder of a living conversation is left');
    assert.ok(existsSync(join(data.claude, 'projects', 'D--projects-web-shop', 'memory', 'MEMORY.md')), 'memory notes stay');
  });

  console.log('All interface checks passed.');
} catch (error) {
  failed = true;
  console.log('FAILED');
  console.error(error);
  console.error('Notifications shown so far:', await page.evaluate(() => window.__seenToasts).catch(() => '(unavailable)'));
  await page.screenshot({ path: join(demo.work, 'failure.png') }).catch(() => undefined);
  console.error(`A screenshot of the failure is in ${join(demo.work, 'failure.png')}`);
} finally {
  await demo.close({ keep: failed });
}
process.exit(failed ? 1 : 0);
