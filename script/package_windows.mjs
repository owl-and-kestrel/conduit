#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { writePackagedPackageJson } from './packaged_package_json.mjs';

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDir = path.join(root, 'dist', 'windows');
const packageRoot = path.join(distDir, 'Conduit-win-x64');
const archivePath = path.join(distDir, 'Conduit-win-x64.zip');
const mode = process.argv[2] ?? '';

if (mode === '') {
  await execFileAsync('npm', ['run', 'build'], { cwd: root, stdio: 'inherit' });
} else if (mode !== '--skip-build') {
  console.error('Usage: package_windows.mjs [--skip-build]');
  process.exit(2);
}

await rm(packageRoot, { recursive: true, force: true });
await rm(archivePath, { force: true });
await mkdir(path.join(packageRoot, 'runtime', 'dist'), { recursive: true });

// No devDependencies: the package must install from the public registry alone.
await writePackagedPackageJson(path.join(root, 'package.json'), path.join(packageRoot, 'package.json'));
await cp(path.join(root, 'dist', 'src'), path.join(packageRoot, 'runtime', 'dist', 'src'), { recursive: true });
await cp(path.join(root, 'dist', 'scripts'), path.join(packageRoot, 'runtime', 'dist', 'scripts'), { recursive: true });
await cp(path.join(root, 'platforms', 'desktop-shell-contract.md'), path.join(packageRoot, 'desktop-shell-contract.md'));
await cp(path.join(root, 'platforms', 'windows', 'README.md'), path.join(packageRoot, 'platforms-windows.md'));
await copyWindowsLaunchers();

await writeFile(path.join(packageRoot, 'README.txt'), `Conduit for Windows preview

Install:
1. Extract this archive.
2. Run npm install --omit=dev from the extracted directory.
3. Run Conduit-Control.ps1 to start the local control panel.
4. Run Conduit-Agent-Listener.ps1 for browser agent-loop transport.
5. Run Conduit-Clipboard-Daemon.ps1 for exact-envelope clipboard monitoring.

Report bugs:
- Run Conduit-Report-Bug.ps1 to open the redacted diagnostics view.
- Diagnostics preview excludes clipboard contents, request payloads, file
  contents, session nonces, API keys, environment variables, and secrets.

This preview is not a native tray app yet. The native shell must follow
desktop-shell-contract.md.
`, 'utf8');

await createZip();
console.log(`Created ${archivePath}`);

async function copyWindowsLaunchers() {
  const sourceDir = path.join(root, 'platforms', 'windows');
  const files = [
    'Conduit-Control.ps1',
    'Conduit-Agent-Listener.ps1',
    'Conduit-Clipboard-Daemon.ps1',
    'Conduit-Open-Control.ps1',
    'Conduit-Report-Bug.ps1'
  ];
  for (const file of files) {
    await cp(path.join(sourceDir, file), path.join(packageRoot, file));
  }
}

async function createZip() {
  try {
    await execFileAsync('zip', ['-qr', archivePath, path.basename(packageRoot)], { cwd: distDir });
    return;
  } catch (error) {
    if (!isCommandMissing(error)) {
      throw error;
    }
  }

  await execFileAsync('pwsh', [
    '-NoProfile',
    '-Command',
    `Compress-Archive -Path '${packageRoot.replaceAll("'", "''")}' -DestinationPath '${archivePath.replaceAll("'", "''")}' -Force`
  ]);
}

function isCommandMissing(error) {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && error.code === 'ENOENT';
}
