// Regenerates docs/screenshots/*.png: the control panel in demo-data mode and
// the static website, at desktop (1440x900) and phone (390x844) sizes, in light
// and dark color schemes.
//
//   npx playwright install chromium   # once
//   npm run screenshots
//
// The control panel runs in-process on an ephemeral loopback port with a
// throwaway state directory, so nothing touches ~/.conduit or the clipboard.
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { startControlPanel } from '../src/app/control-panel.js';
import type { ClipboardIO } from '../src/daemon/clipboard-io.js';

const outDir = path.resolve('docs/screenshots');
const sizes = [
  { label: 'desktop', width: 1440, height: 900, scale: 1 },
  { label: 'mobile', width: 390, height: 844, scale: 2 }
] as const;
const schemes = ['light', 'dark'] as const;

const noClipboard: ClipboardIO = {
  read: async () => '',
  write: async () => {
    throw new Error('Screenshots never write the clipboard.');
  }
};

async function main(): Promise<void> {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'conduit-shots-'));
  process.env.CONDUIT_STATE_DIR = stateDir;
  const app = await startControlPanel({ host: '127.0.0.1', port: 0, clipboard: noClipboard });
  const site = pathToFileURL(path.resolve('website/index.html')).href;
  const targets = [
    { name: 'control-overview', url: `${app.url}/?demo=1#overview` },
    { name: 'control-approvals', url: `${app.url}/?demo=1#approvals` },
    { name: 'website-home', url: site }
  ];

  await mkdir(outDir, { recursive: true });
  const browser = await chromium.launch();
  const problems: string[] = [];
  try {
    for (const target of targets) {
      for (const colorScheme of schemes) {
        for (const size of sizes) {
          const context = await browser.newContext({
            viewport: { width: size.width, height: size.height },
            deviceScaleFactor: size.scale,
            colorScheme
          });
          const page = await context.newPage();
          page.on('pageerror', (error) => problems.push(`${target.name}: ${error.message}`));
          await page.goto(target.url, { waitUntil: 'networkidle' });
          await page.waitForTimeout(400);
          const overflow = Number(await page.evaluate('document.documentElement.scrollWidth - window.innerWidth'));
          if (overflow > 0) problems.push(`${target.name} ${size.label}: ${overflow}px horizontal overflow`);
          const file = path.join(outDir, `${target.name}-${size.label}-${colorScheme}.png`);
          await page.screenshot({ path: file });
          console.log(path.relative(process.cwd(), file));
          await context.close();
        }
      }
    }
  } finally {
    await browser.close();
    await app.close();
    await rm(stateDir, { recursive: true, force: true });
  }
  if (problems.length > 0) {
    console.error(problems.join('\n'));
    process.exitCode = 1;
  }
}

await main();
