// Takes the README screenshots with made-up conversations.
//
//   npm run test:integration   (once; it downloads the VS Code used here)
//   npm run screenshot
import { join } from 'node:path';
import { launchDemo, root } from './lib/vscode.mjs';

const media = join(root, 'media');
const TARGET = 'Fix checkout rounding bug';

async function shoot(locale, files, labels) {
  const demo = await launchDemo({ locale });
  try {
    const { page } = demo;
    await demo.widenSidebar(520);
    const clip = await demo.clipBelowTitlebar();
    const target = demo.row(TARGET);

    // 1. The list, with a preview next to it and the pointer on a row so its buttons show.
    await target.hover();
    await target.locator(`a.action-label[aria-label^="${labels.preview}"]`).click();
    await page.locator('.editor-instance .view-lines').filter({ hasText: 'floating-point' }).waitFor();
    await target.hover();
    await page.waitForTimeout(500);
    await page.screenshot({ path: join(media, files.list), clip });
    console.log(`saved media/${files.list}`);

    // 2. The question asked before anything is deleted.
    if (files.confirm) {
      await target.locator(`a.action-label[aria-label^="${labels.delete}"]`).click();
      const dialog = page.locator('.monaco-dialog-box');
      await dialog.waitFor();
      await page.waitForTimeout(500);
      await page.screenshot({ path: join(media, files.confirm), clip });
      console.log(`saved media/${files.confirm}`);
      await page.keyboard.press('Escape');
      await dialog.waitFor({ state: 'detached' });
    }
  } finally {
    await demo.close();
  }
}

const only = process.argv[2];
if (!only || only === 'en') {
  await shoot('en', { list: 'screenshot.png', confirm: 'screenshot-confirm.png' }, { preview: 'Preview', delete: 'Delete' });
}
if (!only || only === 'zh-cn') {
  await shoot('zh-cn', { list: 'screenshot.zh-cn.png', confirm: 'screenshot-confirm.zh-cn.png' }, { preview: '预览', delete: '删除' });
}
