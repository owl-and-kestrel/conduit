import { mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveInsideProject } from '../../src/policy/sandbox.js';
import { fileWriteTool } from '../../src/tools/file-write.js';
import { executeToolAction } from '../../src/tools/types.js';

describe('resolveInsideProject', () => {
  let base: string;
  let projectRoot: string;
  let outside: string;

  beforeEach(async () => {
    base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'conduit-sandbox-')));
    projectRoot = path.join(base, 'project');
    outside = path.join(base, 'outside');
    await mkdir(path.join(projectRoot, 'src'), { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, 'secret.txt'), 'outside\n', 'utf8');
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it('refuses a new file under an in-project directory that is a symlink to outside', async () => {
    await symlink(outside, path.join(projectRoot, 'linked'));

    await expect(resolveInsideProject('linked/new.txt', projectRoot)).rejects.toThrow(/outside project root/);
    await expect(resolveInsideProject('linked/deeper/new.txt', projectRoot)).rejects.toThrow(/outside project root/);
    await expect(resolveInsideProject(path.join(projectRoot, 'linked', 'new.txt'), projectRoot))
      .rejects.toThrow(/outside project root/);
  });

  it('refuses an existing in-project file that is a symlink to outside', async () => {
    await symlink(path.join(outside, 'secret.txt'), path.join(projectRoot, 'link.txt'));

    await expect(resolveInsideProject('link.txt', projectRoot)).rejects.toThrow(/outside project root/);
  });

  it('refuses a dangling symlink, wherever it points', async () => {
    await symlink(path.join(outside, 'not-yet.txt'), path.join(projectRoot, 'dangling.txt'));

    await expect(resolveInsideProject('dangling.txt', projectRoot)).rejects.toThrow(/outside project root/);
    await expect(resolveInsideProject('dangling.txt/child', projectRoot)).rejects.toThrow(/outside project root/);
  });

  it('allows a normal nested new file and returns its real path', async () => {
    await expect(resolveInsideProject('src/new.ts', projectRoot))
      .resolves.toBe(path.join(projectRoot, 'src', 'new.ts'));
    await expect(resolveInsideProject('a/b/c/new.ts', projectRoot))
      .resolves.toBe(path.join(projectRoot, 'a', 'b', 'c', 'new.ts'));
  });

  it('allows an in-project symlinked directory that points inside the project', async () => {
    await symlink(path.join(projectRoot, 'src'), path.join(projectRoot, 'alias'));

    await expect(resolveInsideProject('alias/new.ts', projectRoot))
      .resolves.toBe(path.join(projectRoot, 'src', 'new.ts'));
  });

  it('refuses .git as any path component', async () => {
    await mkdir(path.join(projectRoot, '.git', 'hooks'), { recursive: true });
    await writeFile(path.join(projectRoot, '.git', 'config'), '[core]\n', 'utf8');

    await expect(resolveInsideProject('.git/config', projectRoot)).rejects.toThrow(/outside project root.*\.git/);
    await expect(resolveInsideProject('.git', projectRoot)).rejects.toThrow(/outside project root/);
    await expect(resolveInsideProject('sub/.git/hooks/x', projectRoot)).rejects.toThrow(/outside project root/);
    await expect(resolveInsideProject('.GIT/config', projectRoot)).rejects.toThrow(/outside project root/);
    await expect(resolveInsideProject(path.join(projectRoot, '.git', 'hooks', 'pre-commit'), projectRoot))
      .rejects.toThrow(/outside project root/);
    // .github, x.git and .gitignore are ordinary project paths.
    await expect(resolveInsideProject('.github/workflows/ci.yml', projectRoot)).resolves.toContain('.github');
    await expect(resolveInsideProject('.gitignore', projectRoot)).resolves.toContain('.gitignore');
    await expect(resolveInsideProject('repo.git/x', projectRoot)).resolves.toContain('repo.git');
  });

  it('refuses a symlink alias that resolves into .git', async () => {
    await mkdir(path.join(projectRoot, '.git', 'hooks'), { recursive: true });
    await symlink(path.join(projectRoot, '.git', 'hooks'), path.join(projectRoot, 'hooks'));

    await expect(resolveInsideProject('hooks/pre-commit', projectRoot)).rejects.toThrow(/outside project root/);
  });

  it('refuses a symlink loop cleanly without hanging', async () => {
    await symlink(path.join(projectRoot, 'loop-b'), path.join(projectRoot, 'loop-a'));
    await symlink(path.join(projectRoot, 'loop-a'), path.join(projectRoot, 'loop-b'));

    await expect(resolveInsideProject('loop-a', projectRoot)).rejects.toThrow(/outside project root/);
    await expect(resolveInsideProject('loop-a/new.txt', projectRoot)).rejects.toThrow(/outside project root/);
  }, 5_000);

  it('file.write refuses to create a file through an in-project symlink to outside', async () => {
    await symlink(outside, path.join(projectRoot, 'linked'));
    const runDir = path.join(base, 'run');
    await mkdir(runDir, { recursive: true });

    const result = await executeToolAction(
      { id: 'w1', tool: 'file.write', args: { path: 'linked/planted.txt', content: 'x\n', mode: 'create' } },
      fileWriteTool,
      { projectRoot, runId: 'test', runDir }
    );

    expect(result.status).toBe('denied');
    expect(await readdir(outside)).toEqual(['secret.txt']);
  });
});
