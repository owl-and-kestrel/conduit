import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const websiteRoot = path.resolve('website');
const pages = ['index.html', 'download.html', 'about.html', 'api.html'];

describe('web presence', () => {
  it('ships the required public pages', async () => {
    for (const page of pages) {
      const html = await readWebsiteFile(page);
      expect(html).toContain('<!doctype html>');
      expect(html).toContain('Conduit');
      expect(html).toContain('assets/site.css');
      expect(html).not.toMatch(/lorem|placeholder|TODO/i);
    }
  });

  it('keeps navigation links valid across the static site', async () => {
    const knownFiles = new Set([
      ...pages,
      'assets/site.css'
    ]);

    for (const page of pages) {
      const html = await readWebsiteFile(page);
      const links = [...html.matchAll(/\b(?:href|src)="([^"]+)"/g)].map((match) => match[1]);
      for (const link of links) {
        if (link.startsWith('http') || link.startsWith('#') || link.startsWith('conduit:')) continue;
        expect(knownFiles.has(link), `${page} references missing asset or page ${link}`).toBe(true);
      }
    }
  });

  it('documents the exact-envelope security contract on the public API page', async () => {
    const api = await readWebsiteFile('api.html');
    expect(api).toContain('schema');
    expect(api).toContain('source');
    expect(api).toContain('permissions');
    expect(api).toContain('sessionId');
    expect(api).toContain('nonce');
    expect(api).toContain('clipboard buffer itself cannot include that prose');
    expect(api).toContain('Duplicate JSON keys');
  });

  it('keeps the download page focused on the polished app install path', async () => {
    const download = await readWebsiteFile('download.html');
    expect(download).toContain('Download for macOS');
    expect(download).toContain('Conduit.dmg');
    expect(download).toContain('drag <code>Conduit.app</code> to Applications');
    expect(download).toContain('Load the browser extension only if you want paired ChatGPT transport');
    // "Open Control Panel" lives in the Settings window, not the menu-bar popover.
    const settingsView = await readFile(path.resolve('macos/ConduitMenuBar/Sources/ConduitMenuBar/SettingsView.swift'), 'utf8');
    const popoverView = await readFile(path.resolve('macos/ConduitMenuBar/Sources/ConduitMenuBar/PopoverView.swift'), 'utf8');
    expect(settingsView).toContain('Button("Open Control Panel")');
    expect(popoverView).not.toContain('Open Control Panel');
    expect(download).toContain('open <strong>Settings</strong> (the gear button), then choose <strong>Open Control Panel</strong>');
    expect(download).not.toContain('<strong>Open Control Panel</strong> from the menu-bar icon');
    expect(download).toContain('Browser Extension Alpha');
    expect(download).toContain('Prepare extension with Conduit');
    expect(download).toContain('conduit://run?payload=');
    expect(download).toContain('conduit.extension.prepareAlphaInstall');
    expect(download).toContain('https://owlandkestrel.com/releases/conduit/conduit-bridge-extension.zip');
    expect(download).toContain('npm run extension:package');
    expect(download).toContain('Build From Source');
    expect(download).toContain('Windows and Linux');
    expect(download).toContain('Preview packages now carry launchers');
    expect(download).toContain('bug-report contract');
  });
});

async function readWebsiteFile(file: string): Promise<string> {
  return readFile(path.join(websiteRoot, file), 'utf8');
}
