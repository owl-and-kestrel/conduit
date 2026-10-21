import { execFile, execFileSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const PUBLIC_REGISTRY = 'https://registry.npmjs.org/';

// Opt-in end-to-end proof that a downloaded Linux package installs from the
// public npm registry alone, as its README.txt says: build the package with
// script/package_linux.sh, extract it outside the repo, and run
// `npm install --omit=dev` with an empty HOME, no user or global npmrc, and an
// environment scrubbed of inherited npm_config_* (npm exports the repo's
// .npmrc, including its private scoped registry, to `npm test`). Needs the
// network and a built toolchain (`npm ci`), so it runs only with
// CONDUIT_PUBLIC_INSTALL_TEST=1:
//   CONDUIT_PUBLIC_INSTALL_TEST=1 npx vitest run tests/platforms/linux-package-public-install.test.ts
describe.runIf(process.env.CONDUIT_PUBLIC_INSTALL_TEST === '1' && process.platform !== 'win32')('Linux package public install', () => {
  it('installs with npm install --omit=dev from the public registry alone, outside the repo', async () => {
    await execFileAsync('bash', [path.resolve('script/package_linux.sh')], { timeout: 300_000, maxBuffer: 16 * 1024 * 1024 });
    const archive = path.resolve('dist/linux/conduit-linux-x64.tar.gz');
    const npm = execFileSync('bash', ['-c', 'command -v npm'], { encoding: 'utf8' }).trim();
    const work = await realpath(await mkdtemp(path.join(os.tmpdir(), 'conduit-public-install-')));
    try {
      const home = path.join(work, 'home');
      const extract = path.join(work, 'extract');
      await mkdir(home);
      await mkdir(extract);
      await execFileAsync('tar', ['-C', extract, '-xzf', archive], { timeout: 60_000 });
      const packageRoot = path.join(extract, 'conduit-linux-x64');
      expect(path.relative(path.resolve('.'), packageRoot).startsWith('..'), 'package is extracted outside the repo').toBe(true);

      const shipped = await readdir(packageRoot);
      expect(shipped).not.toContain('.npmrc');
      expect(shipped).not.toContain('package-lock.json');
      expect(shipped).not.toContain('node_modules');
      const packaged = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));
      expect(packaged).not.toHaveProperty('devDependencies');

      const env = {
        PATH: [path.dirname(npm), path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter),
        HOME: home,
        LANG: 'C',
        npm_config_userconfig: path.join(home, '.npmrc'),
        npm_config_globalconfig: path.join(home, 'global-npmrc'),
        npm_config_cache: path.join(home, '.npm'),
        npm_config_registry: PUBLIC_REGISTRY
      };
      await expect(access(env.npm_config_userconfig)).rejects.toThrow();
      const install = await execFileAsync(npm, ['install', '--omit=dev', '--no-audit', '--no-fund'], {
        cwd: packageRoot,
        env,
        timeout: 240_000,
        maxBuffer: 16 * 1024 * 1024
      });
      expect(install.stderr).not.toMatch(/E404/);

      for (const dependency of Object.keys(packaged.dependencies)) {
        await expect(access(path.join(packageRoot, 'node_modules', dependency, 'package.json')), dependency).resolves.toBeUndefined();
      }
      await expect(access(path.join(packageRoot, 'node_modules', '@owl-kestrel'))).rejects.toThrow();

      // The packaged runtime loads with only the installed runtime dependencies.
      const help = await execFileAsync(process.execPath, [path.join(packageRoot, 'runtime', 'dist', 'src', 'cli', 'index.js'), '--help'], {
        cwd: packageRoot,
        env,
        timeout: 60_000
      });
      expect(help.stdout).toMatch(/Usage:/);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }, 660_000);
});
