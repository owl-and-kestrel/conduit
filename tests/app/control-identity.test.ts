import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findCheckoutRoot, getControlIdentity } from '../../src/app/control-identity.js';

// Control reports the checkout it runs from so the menu-bar app adopts only
// its own checkout's Control on port 47831 (never a sibling checkout's).
describe('control identity', () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = realpathSync(await mkdtemp(path.join(os.tmpdir(), 'conduit-control-identity-')));
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  it('reports this checkout, symlinks resolved', () => {
    const checkout = realpathSync(fileURLToPath(new URL('../..', import.meta.url)));
    expect(getControlIdentity()).toEqual({ checkoutRoot: checkout });
  });

  it('finds the checkout from the source tree and from a build', async () => {
    const checkout = path.join(tempRoot, 'conduit');
    await mkdir(path.join(checkout, 'src', 'app'), { recursive: true });
    await mkdir(path.join(checkout, 'dist', 'src', 'app'), { recursive: true });
    await writeFile(path.join(checkout, 'package.json'), '{"name":"conduit"}\n', 'utf8');
    expect(findCheckoutRoot(path.join(checkout, 'src', 'app'))).toBe(checkout);
    expect(findCheckoutRoot(path.join(checkout, 'dist', 'src', 'app'))).toBe(checkout);
  });

  it('tells sibling checkouts apart and resolves a symlinked checkout to its real path', async () => {
    const checkout = path.join(tempRoot, 'conduit');
    const sibling = path.join(tempRoot, 'conduit-fork');
    for (const root of [checkout, sibling]) {
      await mkdir(path.join(root, 'src', 'app'), { recursive: true });
      await writeFile(path.join(root, 'package.json'), '{"name":"conduit"}\n', 'utf8');
    }
    const link = path.join(tempRoot, 'linked');
    await symlink(checkout, link);
    expect(findCheckoutRoot(path.join(sibling, 'src', 'app'))).toBe(sibling);
    expect(findCheckoutRoot(path.join(link, 'src', 'app'))).toBe(checkout);
  });

  it('reports null when no package.json is above the start', () => {
    expect(findCheckoutRoot(path.parse(tempRoot).root)).toBeNull();
  });
});
