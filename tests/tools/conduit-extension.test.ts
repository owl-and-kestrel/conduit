import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { conduitExtensionPrepareAlphaInstallTool } from '../../src/tools/conduit-extension.js';

const execFileAsync = promisify(execFile);

// The fixture is built with /usr/bin/zip and the tool extracts with
// /usr/bin/unzip; hosts without them (e.g. a minimal Linux CI box) skip.
const hasZipTools = existsSync('/usr/bin/zip') && existsSync('/usr/bin/unzip');

describe.skipIf(!hasZipTools)('conduit.extension.prepareAlphaInstall', () => {
  let tempRoot: string;
  let projectRoot: string;

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), 'conduit-extension-tool-'));
    projectRoot = path.join(tempRoot, 'project');
    await mkdir(projectRoot, { recursive: true });
    process.env.CONDUIT_ALLOW_FILE_EXTENSION_PACKAGES = '1';
  });

  afterEach(async () => {
    delete process.env.CONDUIT_ALLOW_FILE_EXTENSION_PACKAGES;
    await rm(tempRoot, { recursive: true, force: true });
  });

  it('copies, verifies, and extracts a trusted alpha extension package', async () => {
    const zipPath = await createExtensionZip(tempRoot);
    const sha256 = createHash('sha256').update(await readFile(zipPath)).digest('hex');

    const result = await conduitExtensionPrepareAlphaInstallTool.run({
      url: new URL(`file://${zipPath}`).href,
      sha256,
      openExtensionsPage: false
    }, {
      projectRoot,
      runId: 'run_test',
      runDir: tempRoot
    });

    expect(result.content).toMatchObject({
      sha256,
      openedExtensionsPage: false,
      source: new URL(`file://${zipPath}`).href
    });
    const content = result.content as { extensionFolder: string; nextSteps: string[] };
    await expect(readFile(path.join(content.extensionFolder, 'manifest.json'), 'utf8')).resolves.toContain('Conduit Bridge');
    expect(content.nextSteps.join('\n')).toContain('Load unpacked');
  });

  it('rejects mismatched hashes and untrusted hosts', async () => {
    const zipPath = await createExtensionZip(tempRoot);
    await expect(conduitExtensionPrepareAlphaInstallTool.run({
      url: new URL(`file://${zipPath}`).href,
      sha256: '0'.repeat(64),
      openExtensionsPage: false
    }, {
      projectRoot,
      runId: 'run_test',
      runDir: tempRoot
    })).rejects.toThrow('hash mismatch');

    await expect(conduitExtensionPrepareAlphaInstallTool.run({
      url: 'https://example.test/conduit-bridge-extension.zip',
      openExtensionsPage: false
    }, {
      projectRoot,
      runId: 'run_test',
      runDir: tempRoot
    })).rejects.toThrow('not trusted');
  });
});

async function createExtensionZip(root: string): Promise<string> {
  const packageRoot = path.join(root, 'package');
  const extensionRoot = path.join(packageRoot, 'conduit-bridge-extension');
  await mkdir(extensionRoot, { recursive: true });
  await writeFile(path.join(extensionRoot, 'manifest.json'), JSON.stringify({
    manifest_version: 3,
    name: 'Conduit Bridge',
    version: '0.0.1'
  }), 'utf8');
  await writeFile(path.join(extensionRoot, 'content.js'), 'console.log("ok");\n', 'utf8');
  const zipPath = path.join(root, 'conduit-bridge-extension.zip');
  await execFileAsync('/usr/bin/zip', ['-qr', zipPath, 'conduit-bridge-extension'], { cwd: packageRoot });
  return zipPath;
}
