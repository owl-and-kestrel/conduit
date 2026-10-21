import { execFile, execFileSync } from 'node:child_process';
import { access, chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

describe('cross-platform desktop package scaffolds', () => {
  it('defines the shared desktop shell contract', async () => {
    const contract = await readText('platforms/desktop-shell-contract.md');
    expect(contract).toContain('Report Bug');
    expect(contract).toContain('http://127.0.0.1:47831#diagnostics');
    expect(contract).toContain('/api/agent-handshake');
    expect(contract).toContain('CONDUIT_PARENT_PID');
    expect(contract).toContain('Windows: signed installer eventually');
    expect(contract).toContain('Linux: AppImage/deb/rpm eventually');
  });

  it('ships Windows preview launchers and packaging script', async () => {
    await expectExists('script/package_windows.ps1');
    await expectExists('script/package_windows.mjs');
    await expectExists('platforms/windows/Conduit-Control.ps1');
    await expectExists('platforms/windows/Conduit-Agent-Listener.ps1');
    await expectExists('platforms/windows/Conduit-Clipboard-Daemon.ps1');
    await expectExists('platforms/windows/Conduit-Open-Control.ps1');
    await expectExists('platforms/windows/Conduit-Report-Bug.ps1');

    const script = await readText('script/package_windows.ps1');
    expect(script).toContain('Conduit-win-x64.zip');
    expect(script).toContain('Compress-Archive');
    expect(script).toContain('runtime/dist/src');
    expect(script).not.toContain('Copy-Item -Recurse (Join-Path $Root "dist")');
    expect(script).toContain('desktop-shell-contract.md');
    expect(script).toContain('Conduit-Report-Bug.ps1');
    expect(script).toContain('npm install --omit=dev');

    const nodeScript = await readText('script/package_windows.mjs');
    expect(nodeScript).toContain('Conduit-win-x64.zip');
    expect(nodeScript).toContain("'runtime', 'dist', 'src'");
    expect(nodeScript).toContain('desktop-shell-contract.md');
    expect(nodeScript).toContain('Conduit-Report-Bug.ps1');
    expect(nodeScript).toContain('npm install --omit=dev');

    const reportBug = await readText('platforms/windows/Conduit-Report-Bug.ps1');
    expect(reportBug).toContain('http://127.0.0.1:47831#diagnostics');

    const control = await readText('platforms/windows/Conduit-Control.ps1');
    expect(control).toContain('CONDUIT_PARENT_PID');
    expect(control).toContain('runtime/dist/src/cli/index.js');
    expect(control).toContain('app start --port 47831');
  });

  it('ships Linux preview launchers, desktop metadata, and packaging script', async () => {
    await expectExists('script/package_linux.sh');
    await expectExists('platforms/linux/bin/conduit-control');
    await expectExists('platforms/linux/bin/conduit-agent-listener');
    await expectExists('platforms/linux/bin/conduit-clipboard-daemon');
    await expectExists('platforms/linux/bin/conduit-open-control');
    await expectExists('platforms/linux/bin/conduit-report-bug');
    await expectExists('platforms/linux/share/applications/conduit.desktop');

    const script = await readText('script/package_linux.sh');
    expect(script).toContain('conduit-linux-x64.tar.gz');
    expect(script).toContain('runtime/dist/src');
    expect(script).not.toContain('cp -R "$ROOT/dist"');
    expect(script).toContain('desktop-shell-contract.md');
    expect(script).toContain('conduit-report-bug');
    expect(script).toContain('npm install --omit=dev');
    expect(script).toContain('tar -C "$DIST_DIR" -czf');

    const reportBug = await readText('platforms/linux/bin/conduit-report-bug');
    expect(reportBug).toContain('xdg-open');
    expect(reportBug).toContain('http://127.0.0.1:47831#diagnostics');

    const desktop = await readText('platforms/linux/share/applications/conduit.desktop');
    expect(desktop).toContain('Name=Conduit');
    expect(desktop).toContain('Exec=conduit-open-control');
  });

  // script/package_linux.sh copies platforms/linux/bin/* to <package>/bin/, so
  // a packaged launcher's root is one level above its directory, also when it
  // is reached through a symlink (e.g. one placed on PATH). From a source
  // checkout (no runtime/) the root is the repo, three levels up, and the
  // launcher falls back to `npm run conduit`. The launchers need
  // `readlink -f` (GNU coreutils; macOS 12.3+ readlink has it too).
  it.skipIf(process.platform === 'win32' || !hasReadlinkF())('Linux launchers resolve the package root, and the repo root from a source checkout', async () => {
    const work = await realpath(await mkdtemp(path.join(os.tmpdir(), 'conduit-linux-launcher-')));
    try {
      const packageRoot = path.join(work, 'extracted', 'conduit-linux-x64');
      const repoRoot = path.join(work, 'checkout');
      const cliDir = path.join(packageRoot, 'runtime', 'dist', 'src', 'cli');
      const fakeBin = path.join(work, 'fake-bin');
      for (const dir of [path.join(packageRoot, 'bin'), cliDir, path.join(repoRoot, 'platforms', 'linux', 'bin'), fakeBin, path.join(work, 'elsewhere'), path.join(work, 'on-path')]) {
        await mkdir(dir, { recursive: true });
      }
      // Stub runtime and stub npm: report where the launcher ran them from.
      const report = 'console.log(JSON.stringify({ cwd: process.cwd(), argv: process.argv.slice(2) }));\n';
      await writeFile(path.join(cliDir, 'index.js'), report);
      await writeFile(path.join(fakeBin, 'npm'), `#!${process.execPath}\n${report}`);
      await chmod(path.join(fakeBin, 'npm'), 0o755);
      const env = { ...process.env, PATH: [fakeBin, path.dirname(process.execPath), process.env.PATH ?? ''].join(path.delimiter) };
      const launchers = {
        'conduit-control': () => ['app', 'start', '--port', '47831'],
        'conduit-agent-listener': (root: string) => ['listen', '--project', root],
        'conduit-clipboard-daemon': () => ['daemon', 'start', '--interval-ms', '1000']
      };
      const run = async (launcher: string) => JSON.parse((await execFileAsync('bash', [launcher], { cwd: path.join(work, 'elsewhere'), env })).stdout);
      for (const [name, argv] of Object.entries(launchers)) {
        const packaged = path.join(packageRoot, 'bin', name);
        const source = path.join(repoRoot, 'platforms', 'linux', 'bin', name);
        const linked = path.join(work, 'on-path', name);
        for (const target of [packaged, source]) {
          await copyFile(path.resolve('platforms/linux/bin', name), target);
          await chmod(target, 0o755);
        }
        await symlink(packaged, linked);
        for (const launcher of [packaged, linked]) {
          expect(await run(launcher), `${name} via ${launcher}`).toEqual({ cwd: packageRoot, argv: argv(packageRoot) });
        }
        expect(await run(source), `${name} from a source checkout`).toEqual({ cwd: repoRoot, argv: ['run', 'conduit', '--', ...argv(repoRoot)] });
      }
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });

  // script/package_windows.{ps1,mjs} copy the launchers into the package root
  // itself, next to runtime/, so the packaged root is $PSScriptRoot. Without
  // runtime/ (source checkout, platforms/windows) the repo is two levels up.
  it('Windows launchers use their own directory as the package root', async () => {
    for (const name of ['Conduit-Control.ps1', 'Conduit-Agent-Listener.ps1', 'Conduit-Clipboard-Daemon.ps1']) {
      const launcher = await readText(path.join('platforms/windows', name));
      expect(launcher, name).toMatch(/^\$root = \$PSScriptRoot\nif \(-not \(Test-Path \(Join-Path \$root "runtime\/dist\/src\/cli\/index\.js"\)\)\) \{\n  \$root = Split-Path -Parent \(Split-Path -Parent \$PSScriptRoot\)\n\}\nSet-Location \$root$/m);
      expect(launcher, name).toContain('$cli = Join-Path $root "runtime/dist/src/cli/index.js"');
    }
  });

  it('exposes package scripts for every desktop target', async () => {
    const packageJson = JSON.parse(await readText('package.json'));
    expect(packageJson.scripts['macos:package']).toBe('./script/package_dmg.sh');
    expect(packageJson.scripts['windows:package']).toBe('node ./script/package_windows.mjs');
    expect(packageJson.scripts['linux:package']).toBe('./script/package_linux.sh');
  });
});

const execFileAsync = promisify(execFile);

function hasReadlinkF(): boolean {
  try {
    execFileSync('readlink', ['-f', '.'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

async function expectExists(file: string): Promise<void> {
  await expect(access(path.resolve(file))).resolves.toBeUndefined();
}

async function readText(file: string): Promise<string> {
  return readFile(path.resolve(file), 'utf8');
}
