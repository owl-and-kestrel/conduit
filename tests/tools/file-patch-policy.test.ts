import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { filePatchTool, listPatchPaths } from '../../src/tools/file-patch.js';

const execFileAsync = promisify(execFile);

// file.patch applies the same sandbox and sensitive-file rules as file.write
// to every path git apply would touch, before applying anything.
describe('file.patch path policy', () => {
  let parent: string;
  let projectRoot: string;
  let runDir: string;

  beforeEach(async () => {
    parent = await mkdtemp(path.join(os.tmpdir(), 'conduit-patch-policy-'));
    projectRoot = path.join(parent, 'project');
    runDir = path.join(parent, 'run');
    await mkdir(projectRoot);
    await mkdir(runDir);
    await writeFile(path.join(projectRoot, 'README.md'), 'hello\n', 'utf8');
    await writeFile(path.join(projectRoot, '.env'), 'TOKEN=secret\n', 'utf8');
    await execFileAsync('git', ['init', '-q'], { cwd: projectRoot });
  });

  afterEach(async () => {
    await rm(parent, { recursive: true, force: true });
  });

  const apply = (patch: string) => filePatchTool.run({ patch }, { projectRoot, runId: 'test', runDir });
  const exists = (file: string) => access(file).then(() => true, () => false);

  it('still applies a normal in-project edit', async () => {
    const patch = [
      'diff --git a/README.md b/README.md',
      'index ce01362..5ea2ed4 100644',
      '--- a/README.md',
      '+++ b/README.md',
      '@@ -1 +1 @@',
      '-hello',
      '+patched',
      ''
    ].join('\n');

    await expect(apply(patch)).resolves.toMatchObject({ content: { success: true } });
    await expect(readFile(path.join(projectRoot, 'README.md'), 'utf8')).resolves.toBe('patched\n');
  });

  it('refuses a path outside the project', async () => {
    const outside = ['--- /dev/null', '+++ b/../outside.txt', '@@ -0,0 +1 @@', '+nope', ''].join('\n');
    await expect(apply(outside)).rejects.toThrow(/outside project root: \.\.\/outside\.txt/);
    expect(await exists(path.join(parent, 'outside.txt'))).toBe(false);

    // "+++ b//abs.txt" names an absolute path once -p1 strips "b".
    const absolute = ['--- /dev/null', '+++ b//abs.txt', '@@ -0,0 +1 @@', '+nope', ''].join('\n');
    await expect(apply(absolute)).rejects.toThrow(/outside project root: \/abs\.txt/);
  });

  it('refuses a sensitive path, including as a rename target', async () => {
    const editEnv = [
      'diff --git a/.env b/.env',
      '--- a/.env',
      '+++ b/.env',
      '@@ -1 +1 @@',
      '-TOKEN=secret',
      '+TOKEN=stolen',
      ''
    ].join('\n');
    await expect(apply(editEnv)).rejects.toThrow(/Denied sensitive file patch: \.env/);
    await expect(readFile(path.join(projectRoot, '.env'), 'utf8')).resolves.toBe('TOKEN=secret\n');

    const renameToSecrets = [
      'diff --git a/README.md b/secrets.json',
      'similarity index 100%',
      'rename from README.md',
      'rename to secrets.json',
      ''
    ].join('\n');
    await expect(apply(renameToSecrets)).rejects.toThrow(/Denied sensitive file patch: secrets\.json/);
    expect(await exists(path.join(projectRoot, 'README.md'))).toBe(true);
  });

  it('refuses a rename that leaves the project, and checks both of its paths', async () => {
    const renameOut = [
      'diff --git a/README.md b/../moved.md',
      'similarity index 100%',
      'rename from README.md',
      'rename to ../moved.md',
      ''
    ].join('\n');
    await expect(apply(renameOut)).rejects.toThrow(/outside project root: \.\.\/moved\.md/);
    expect(await exists(path.join(projectRoot, 'README.md'))).toBe(true);
    expect(await exists(path.join(parent, 'moved.md'))).toBe(false);

    const renameIn = renameOut.split('../moved.md').join('docs/moved.md');
    const patchFile = path.join(runDir, 'rename.diff');
    await writeFile(patchFile, renameIn, 'utf8');
    await expect(listPatchPaths(patchFile, projectRoot)).resolves.toEqual(['docs/moved.md', 'README.md']);
  });

  it('lists created, deleted, mode-changed and symlink paths', async () => {
    const patch = [
      'diff --git a/README.md b/README.md',
      'old mode 100644',
      'new mode 100755',
      'diff --git a/link b/link',
      'new file mode 120000',
      'index 0000000..b6e9ec8',
      '--- /dev/null',
      '+++ b/link',
      '@@ -0,0 +1 @@',
      '+/etc/hosts',
      '\\ No newline at end of file',
      'diff --git a/gone.txt b/gone.txt',
      'deleted file mode 100644',
      'index ce01362..0000000',
      '--- a/gone.txt',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-hello',
      ''
    ].join('\n');
    const patchFile = path.join(runDir, 'kinds.diff');
    await writeFile(patchFile, patch, 'utf8');
    await expect(listPatchPaths(patchFile, projectRoot)).resolves.toEqual(['README.md', 'link', 'gone.txt']);
  });

  it('refuses a patch whose paths cannot be listed unambiguously', async () => {
    await expect(apply('this is not a patch\n')).rejects.toThrow(/Refused patch: could not list every path/);

    // git unquotes "b/a\nb.txt" to a name with a newline in it; the summary
    // line for it would be ambiguous, so the patch is refused.
    const newlineName = ['--- /dev/null', '+++ "b/a\\nb.txt"', '@@ -0,0 +1 @@', '+x', ''].join('\n');
    await expect(apply(newlineName)).rejects.toThrow(/Refused patch: could not list every path/);
    expect(await exists(path.join(projectRoot, 'a\nb.txt'))).toBe(false);
  });
});
