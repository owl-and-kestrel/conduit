import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeFileAtomic } from '../../src/state/atomic-write.js';

describe('writeFileAtomic', () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), 'conduit-atomic-write-'));
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  it('survives concurrent writers to one path and leaves no temp files', async () => {
    // The target directory does not exist yet; the helper must create it.
    const target = path.join(tempRoot, 'nested', 'state.json');
    const contents = Array.from({ length: 25 }, (_, i) => `{"writer":${i}}\n`);

    await expect(Promise.all(contents.map((text) => writeFileAtomic(target, text)))).resolves.toHaveLength(25);

    expect(contents).toContain(await readFile(target, 'utf8'));
    expect(await readdir(path.dirname(target))).toEqual(['state.json']);
  });
});
