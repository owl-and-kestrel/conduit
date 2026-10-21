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
    expect(script).toContain('script/packaged_package_json.mjs');
    expect(script).not.toContain('Copy-Item (Join-Path $Root "package.json")');

    const nodeScript = await readText('script/package_windows.mjs');
    expect(nodeScript).toContain('Conduit-win-x64.zip');
    expect(nodeScript).toContain("'runtime', 'dist', 'src'");
    expect(nodeScript).toContain('desktop-shell-contract.md');
    expect(nodeScript).toContain('Conduit-Report-Bug.ps1');
    expect(nodeScript).toContain('npm install --omit=dev');
    expect(nodeScript).toContain("writePackagedPackageJson(path.join(root, 'package.json')");
    expect(nodeScript).not.toContain("cp(path.join(root, 'package.json')");

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
    expect(script).toContain('node "$ROOT/script/packaged_package_json.mjs" "$ROOT/package.json" "$PACKAGE_ROOT/package.json"');
    expect(script).not.toContain('cp "$ROOT/package.json"');

    const reportBug = await readText('platforms/linux/bin/conduit-report-bug');
    expect(reportBug).toContain('xdg-open');
    expect(reportBug).toContain('http://127.0.0.1:47831#diagnostics');

    const desktop = await readText('platforms/linux/share/applications/conduit.desktop');
    expect(desktop).toContain('Name=Conduit');
    expect(desktop).toContain('Exec=conduit-open-control');
  });

  // A downloaded package is installed with `npm install --omit=dev` from the
  // public registry alone (no .npmrc, no lockfile), and npm resolves
  // devDependencies before omitting them, so the packaged package.json must not
  // carry any. Runtime dependencies must not come from a scope that .npmrc
  // routes to a private registry. tests/platforms/linux-package-public-install
  // proves the install end to end (opt-in, needs the network).
  it('writes the packaged package.json without devDependencies or privately scoped dependencies', async () => {
    const work = await mkdtemp(path.join(os.tmpdir(), 'conduit-packaged-json-'));
    try {
      const destination = path.join(work, 'package.json');
      await execFileAsync(process.execPath, [path.resolve('script/packaged_package_json.mjs'), path.resolve('package.json'), destination]);
      const source = JSON.parse(await readText('package.json'));
      const packaged = JSON.parse(await readFile(destination, 'utf8'));
      const { devDependencies, ...rest } = source;
      expect(devDependencies, 'the source package.json keeps its devDependencies').toBeTruthy();
      expect(packaged).toEqual(rest);
      expect(packaged).not.toHaveProperty('devDependencies');

      const privateScopes = (await readText('.npmrc')).split(/\r?\n/)
        .map((line) => /^\s*(@[^:\s]+):registry\s*=/.exec(line)?.[1])
        .filter((scope): scope is string => Boolean(scope));
      expect(privateScopes).toContain('@owl-kestrel');
      const runtimeDependencies = Object.keys({ ...packaged.dependencies, ...packaged.optionalDependencies, ...packaged.peerDependencies });
      expect(runtimeDependencies.length).toBeGreaterThan(0);
      for (const name of runtimeDependencies) {
        expect(privateScopes.some((scope) => name.startsWith(`${scope}/`)), `${name} resolves only on a private registry`).toBe(false);
      }
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });

  // script/package_linux.sh copies platforms/linux/bin/* to <package>/bin/, so
  // a packaged launcher's root is one level above its directory, also when it
  // is reached through a symlink (e.g. one placed on PATH). From a source
  // checkout (no runtime/) the root is the repo, three levels up, and the
  // launcher falls back to `npm run conduit`. The launchers resolve symlinks
  // with plain `readlink`; the stub readlink below refuses GNU `-f` to keep
  // them portable to systems without it.
  it.skipIf(process.platform === 'win32')('Linux launchers resolve the package root, and the repo root from a source checkout', async () => {
    const work = await realpath(await mkdtemp(path.join(os.tmpdir(), 'conduit-linux-launcher-')));
    try {
      const packageRoot = path.join(work, 'extracted', 'conduit-linux-x64');
      const repoRoot = path.join(work, 'checkout');
      const cliDir = path.join(packageRoot, 'runtime', 'dist', 'src', 'cli');
      const fakeBin = path.join(work, 'fake-bin');
      for (const dir of [path.join(packageRoot, 'bin'), cliDir, path.join(repoRoot, 'platforms', 'linux', 'bin'), fakeBin, path.join(work, 'elsewhere'), path.join(work, 'on-path'), path.join(work, 'empty-path')]) {
        await mkdir(dir, { recursive: true });
      }
      // Stub runtime and stub npm: report where the launcher ran them from.
      const report = 'console.log(JSON.stringify({ cwd: process.cwd(), argv: process.argv.slice(2) }));\n';
      await writeFile(path.join(cliDir, 'index.js'), report);
      await writeFile(path.join(fakeBin, 'npm'), `#!${process.execPath}\n${report}`);
      await chmod(path.join(fakeBin, 'npm'), 0o755);
      const realReadlink = execFileSync('bash', ['-c', 'command -v readlink'], { encoding: 'utf8' }).trim();
      await writeFile(path.join(fakeBin, 'readlink'), `#!/usr/bin/env bash\nfor arg in "$@"; do\n  if [[ "$arg" == -f ]]; then echo "readlink: illegal option -- f" >&2; exit 1; fi\ndone\nexec ${JSON.stringify(realReadlink)} "$@"\n`);
      await chmod(path.join(fakeBin, 'readlink'), 0o755);
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
        // A relative symlink chain: on-path/<name>-chain -> <name>-rel -> ../extracted/.../bin/<name>.
        const chained = path.join(work, 'on-path', `${name}-chain`);
        await symlink(path.join('..', 'extracted', 'conduit-linux-x64', 'bin', name), path.join(work, 'on-path', `${name}-rel`));
        await symlink(`${name}-rel`, chained);
        for (const launcher of [packaged, linked, chained]) {
          expect(await run(launcher), `${name} via ${launcher}`).toEqual({ cwd: packageRoot, argv: argv(packageRoot) });
        }
        expect(await run(source), `${name} from a source checkout`).toEqual({ cwd: repoRoot, argv: ['run', 'conduit', '--', ...argv(repoRoot)] });

        // Without readlink, a symlinked launcher stops with a clear message.
        const noReadlink = await execFileAsync('/bin/bash', [linked], { cwd: path.join(work, 'elsewhere'), env: { PATH: path.join(work, 'empty-path') } })
          .then(() => ({ code: 0, stderr: '' }), (error: { code?: number; stderr?: string }) => ({ code: error.code, stderr: error.stderr ?? '' }));
        expect(noReadlink.code, `${name} without readlink`).toBe(1);
        expect(noReadlink.stderr, `${name} without readlink`).toContain('readlink is not installed');
      }
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });

  // script/package_windows.{ps1,mjs} copy the launchers into the package root
  // itself, next to runtime/, so the packaged root is $PSScriptRoot. Without
  // runtime/ (source checkout, platforms/windows) the repo is two levels up.
  // Line endings are normalized first: a Windows checkout with
  // core.autocrlf=true has CRLF files.
  it('Windows launchers use their own directory as the package root', async () => {
    for (const name of ['Conduit-Control.ps1', 'Conduit-Agent-Listener.ps1', 'Conduit-Clipboard-Daemon.ps1']) {
      const lf = (await readText(path.join('platforms/windows', name))).replace(/\r\n/g, '\n');
      for (const [eol, text] of [['as checked out', lf], ['CRLF', lf.replace(/\n/g, '\r\n')]]) {
        expectWindowsPackageRoot(text, `${name} (${eol})`);
      }
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

// Matches LF and CRLF launcher text alike.
function expectWindowsPackageRoot(launcher: string, label: string): void {
  expect(launcher, label).toMatch(/^\$root = \$PSScriptRoot\r?\nif \(-not \(Test-Path \(Join-Path \$root "runtime\/dist\/src\/cli\/index\.js"\)\)\) \{\r?\n  \$root = Split-Path -Parent \(Split-Path -Parent \$PSScriptRoot\)\r?\n\}\r?\nSet-Location \$root\r?$/m);
  expect(launcher, label).toContain('$cli = Join-Path $root "runtime/dist/src/cli/index.js"');
}

async function expectExists(file: string): Promise<void> {
  await expect(access(path.resolve(file))).resolves.toBeUndefined();
}

async function readText(file: string): Promise<string> {
  return readFile(path.resolve(file), 'utf8');
}
