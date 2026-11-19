// Starts a throw-away VS Code with this extension and made-up conversations, driven by Playwright.
// Used for the README screenshots and for the click-through check of the user interface.
// Nothing here can see real conversations: data folders, settings and extensions all live in a temp folder.
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';
import { buildDemoData } from '../demo-data.mjs';

export const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const LANGUAGE_PACKS = { 'zh-cn': 'MS-CEINTL.vscode-language-pack-zh-hans' };

function findInstall() {
  const base = join(root, '.vscode-test');
  for (const folder of existsSync(base) ? readdirSync(base) : []) {
    for (const [exe, cli] of [
      ['Code.exe', join('bin', 'code.cmd')],
      ['code', join('bin', 'code')],
      [join('Visual Studio Code.app', 'Contents', 'MacOS', 'Electron'), join('Visual Studio Code.app', 'Contents', 'Resources', 'app', 'bin', 'code')],
    ]) {
      if (existsSync(join(base, folder, exe))) {
        return { executable: join(base, folder, exe), cli: join(base, folder, cli) };
      }
    }
  }
  throw new Error('No VS Code found in .vscode-test. Run `npm run test:integration` once; it downloads one.');
}

function installCodexStub(bin) {
  mkdirSync(bin, { recursive: true });
  copyFileSync(join(root, 'test', 'support', 'codex-stub.js'), join(bin, 'codex-stub.js'));
  if (process.platform === 'win32') {
    writeFileSync(join(bin, 'codex.cmd'), '@echo off\r\nnode "%~dp0codex-stub.js" %*\r\n');
    return join(bin, 'codex.cmd');
  }
  writeFileSync(join(bin, 'codex'), '#!/bin/sh\nexec node "$(dirname "$0")/codex-stub.js" "$@"\n');
  chmodSync(join(bin, 'codex'), 0o755);
  return join(bin, 'codex');
}

/**
 * @param {{ locale?: string, settings?: Record<string, unknown>, width?: number, height?: number, vsix?: string }} options
 *   `vsix`: install this packaged extension instead of running the one in the working tree.
 */
export async function launchDemo({ locale = 'en', settings = {}, width = 1240, height = 800, vsix } = {}) {
  const install = findInstall();
  const work = realpathSync.native(mkdtempSync(join(tmpdir(), 'sweeper-demo-')));
  const data = buildDemoData(join(work, 'data'));
  const userData = join(work, 'user');
  const extensions = join(work, 'extensions');
  mkdirSync(join(userData, 'User'), { recursive: true });
  writeFileSync(
    join(userData, 'User', 'settings.json'),
    JSON.stringify({
      'workbench.startupEditor': 'none',
      'workbench.secondarySideBar.defaultVisibility': 'hidden',
      'workbench.tips.enabled': false,
      'workbench.layoutControl.enabled': false,
      'workbench.hover.delay': 600_000, // no tooltips in the way
      'window.commandCenter': false,
      'window.dialogStyle': 'custom', // dialogs drawn by VS Code itself can be seen and clicked
      'chat.commandCenter.enabled': false,
      'chat.disableAIFeatures': true,
      'telemetry.telemetryLevel': 'off',
      'update.mode': 'none',
      'extensions.autoUpdate': false,
      'security.workspace.trust.enabled': false,
      'editor.minimap.enabled': false,
      'editor.wordWrap': 'on',
      'editor.lineNumbers': 'off',
      'editor.fontSize': 13,
      'window.zoomLevel': 0.4,
      'sessionSweeper.codex.executablePath': installCodexStub(join(work, 'bin')),
      ...settings,
    }),
  );

  const env = { ...process.env, CLAUDE_CONFIG_DIR: data.claude, CODEX_HOME: data.codex, SESSION_SWEEPER_CLAUDE_TEMP: data.temp };
  delete env.ELECTRON_RUN_AS_NODE;

  const cli = (what) => execFileSync(`"${install.cli}" --install-extension "${what}" --extensions-dir "${extensions}" --user-data-dir "${userData}"`, { env, shell: true, stdio: 'ignore' });
  if (vsix) {
    cli(vsix);
  }
  const args = [
    ...(vsix ? [] : [`--extensionDevelopmentPath=${root}`]),
    `--user-data-dir=${userData}`,
    `--extensions-dir=${extensions}`,
    '--skip-welcome',
    '--skip-release-notes',
    '--disable-workspace-trust',
    '--disable-updates',
    `--locale=${locale}`,
  ];

  const pack = LANGUAGE_PACKS[locale];
  if (pack) {
    // The display language only changes when VS Code's own language pack is installed...
    cli(pack);
    // ...and a running VS Code has registered it, which takes effect on the next start.
    const registration = join(userData, 'languagepacks.json');
    const warmUp = await electron.launch({ executablePath: install.executable, args, env });
    await warmUp.firstWindow();
    for (let waited = 0; !existsSync(registration) && waited < 60_000; waited += 500) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    await warmUp.close();
    if (!existsSync(registration)) {
      throw new Error(`VS Code did not register the ${locale} language pack`);
    }
  }

  data.touchInUse();
  const app = await electron.launch({ executablePath: install.executable, args, env });

  const page = await app.firstWindow();
  const browserWindow = await app.browserWindow(page);
  await browserWindow.evaluate((window, size) => {
    window.setSize(size.width, size.height);
    window.center();
  }, { width, height });
  await page.waitForSelector('.monaco-workbench');

  // Open the panel and wait until the list, the sizes and the leftovers are in.
  await page.locator('.activitybar a.action-label[aria-label^="Session Sweeper"]').first().click();
  const rows = page.locator('.sidebar .monaco-list-row');
  await rows.filter({ hasText: 'Fix checkout rounding bug' }).waitFor();
  await page.waitForFunction(() => document.querySelectorAll('.sidebar .monaco-list-row[aria-level="2"]').length >= 2 && [...document.querySelectorAll('.sidebar .monaco-list-row')].length >= 16);
  await page.waitForFunction(() => ![...document.querySelectorAll('.sidebar .monaco-list-row')].some((row) => /[KMG]B\+/.test(row.textContent ?? '')));

  return {
    app,
    page,
    rows,
    data,
    work,
    row: (title) => rows.filter({ hasText: title }),
    /** Drags the right edge of the side bar. */
    async widenSidebar(to) {
      const sidebar = await page.locator('.part.sidebar').boundingBox();
      if (sidebar) {
        const y = sidebar.y + sidebar.height / 2;
        await page.mouse.move(sidebar.x + sidebar.width, y);
        await page.mouse.down();
        await page.mouse.move(to, y, { steps: 10 });
        await page.mouse.up();
      }
    },
    /** The window without its title bar, which only says "Extension Development Host". */
    async clipBelowTitlebar() {
      const titlebar = await page.locator('.part.titlebar').boundingBox();
      const size = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
      const top = titlebar ? Math.ceil(titlebar.y + titlebar.height) : 0;
      return { x: 0, y: top, width: size.width, height: size.height - top };
    },
    async close({ keep = false } = {}) {
      await app.close().catch(() => undefined);
      if (keep) {
        console.log(`kept ${work}`);
      } else {
        rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
      }
    },
  };
}
