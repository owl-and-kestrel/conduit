import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  addPackageAllows,
  allowCovers,
  findActivePackageAllow,
  listPackageAllows,
  packageOnlyDigests,
  revokePackageAllow,
  type PackageAllow,
  type PackageAllowNetwork
} from '../../src/approvals/package-allows.js';
import { executeRequestFromUnknown } from '../../src/daemon/execute-request.js';
import { removeTree } from '../helpers/remove-tree.js';

// A closed loopback port: an allowed start fails fast when it fetches, without
// any real server (only "was there an ask" is under test here).
const PACKAGE_URL = 'http://127.0.0.1:9/pkg.tgz';

function packageAction(sha: string, network: PackageAllowNetwork | 'none', id = 'svc'): Record<string, unknown> {
  return {
    id,
    tool: 'service.start',
    args: {
      name: 'pkg',
      package: { url: PACKAGE_URL, sha256: sha },
      ...(network === 'none' ? {} : { lan: network === 'lan' })
    }
  };
}

function packageRequest(sha: string, network: PackageAllowNetwork | 'none'): unknown {
  return {
    schema: 'conduit.request.v1',
    source: { kind: 'web', trust: 'untrusted' },
    actions: [packageAction(sha, network)]
  };
}

/** The panel's own path: digests of a package-only request, recorded as allows. */
async function allowFromRequest(
  actions: unknown,
  approvalId: string
): Promise<PackageAllow[]> {
  const digests = packageOnlyDigests(actions);
  expect(digests).not.toBeNull();
  return addPackageAllows({ packages: digests!, approvalId, decidedBy: 'cli' });
}

describe('package allow network mode (in-process, no fetch)', () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = mkdtempSync(path.join(os.tmpdir(), 'conduit-package-network-'));
    process.env.CONDUIT_STATE_DIR = path.join(tempRoot, 'state');
    process.env.CONDUIT_DEMO_PROFILE = '1';
  });

  afterEach(() => {
    delete process.env.CONDUIT_DEMO_PROFILE;
    delete process.env.CONDUIT_STATE_DIR;
    removeTree(tempRoot);
  });

  it('packageOnlyDigests reports each start\'s network mode from lan', () => {
    const sha = 'a'.repeat(64);
    expect(packageOnlyDigests([packageAction(sha, 'none')])).toEqual([
      { sha256: sha, url: PACKAGE_URL, network: 'local' }
    ]);
    expect(packageOnlyDigests([packageAction(sha, 'local')])).toEqual([
      { sha256: sha, url: PACKAGE_URL, network: 'local' }
    ]);
    expect(packageOnlyDigests([packageAction(sha, 'lan')])).toEqual([
      { sha256: sha, url: PACKAGE_URL, network: 'lan' }
    ]);
  });

  it('a local allow does not cover a later lan: true start of the same digest', async () => {
    const sha = 'b'.repeat(64);
    const [allow] = await allowFromRequest([packageAction(sha, 'local')], 'approval_local');
    expect(allow.network).toBe('local');

    const lanStart = await executeRequestFromUnknown(packageRequest(sha, 'lan'));
    expect(lanStart.status).toBe('requires_review');
    expect(lanStart.allowIds).toBeUndefined();

    // The local record is untouched and active; a lan lookup finds nothing.
    expect(await findActivePackageAllow(sha, 'lan')).toBeNull();
    const local = await findActivePackageAllow(sha, 'local');
    expect(local?.allowId).toBe(allow.allowId);
    expect(local?.state).toBe('active');
  });

  it('a lan allow covers local-only starts: neither start asks', async () => {
    const sha = 'c'.repeat(64);
    const [allow] = await allowFromRequest([packageAction(sha, 'lan')], 'approval_lan');
    expect(allow.network).toBe('lan');

    const localStart = await executeRequestFromUnknown(packageRequest(sha, 'local'));
    // The start itself cannot fetch (closed port); only assert there was no ask.
    expect(localStart.status).toBe('executed');
    expect(localStart.allowIds).toContain(allow.allowId);
    expect(localStart.approvalId).toBeUndefined();

    const lanStart = await executeRequestFromUnknown(packageRequest(sha, 'lan'));
    expect(lanStart.status).toBe('executed');
    expect(lanStart.allowIds).toContain(allow.allowId);
    expect(lanStart.approvalId).toBeUndefined();
  });

  it('hash-only version-1 records are read as local and migrated (Jon 2026-10-20)', async () => {
    const sha = 'd'.repeat(64);
    const stateDir = path.join(tempRoot, 'state');
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(path.join(stateDir, 'package-allows.json'), `${JSON.stringify({
      version: 1,
      allows: [
        {
          allowId: 'allow_old',
          sha256: sha,
          state: 'active',
          allowedAt: '2026-10-19T00:00:00.000Z',
          allowedBy: 'cli',
          approvalId: 'approval_old',
          url: PACKAGE_URL
        },
        // A malformed mode is read as local too (fail closed), never as lan.
        {
          allowId: 'allow_bad_mode',
          sha256: '8'.repeat(64),
          state: 'active',
          allowedAt: '2026-10-18T00:00:00.000Z',
          allowedBy: 'cli',
          approvalId: 'approval_bad_mode',
          url: PACKAGE_URL,
          network: 'wide'
        }
      ]
    }, null, 2)}\n`);

    const listed = await listPackageAllows();
    expect(listed[0]?.network).toBe('local');
    expect(listed[0]?.networkMigrated).toBe(true);
    expect(listed[1]).toMatchObject({ allowId: 'allow_bad_mode', network: 'local', networkMigrated: true });
    expect(await findActivePackageAllow('8'.repeat(64), 'lan')).toBeNull();

    const localStart = await executeRequestFromUnknown(packageRequest(sha, 'local'));
    expect(localStart.status).toBe('executed');
    expect(localStart.allowIds).toContain('allow_old');

    const lanStart = await executeRequestFromUnknown(packageRequest(sha, 'lan'));
    expect(lanStart.status).toBe('requires_review');
    expect(lanStart.allowIds).toBeUndefined();
  });

  it('addPackageAllows is idempotent per mode, widens to lan, and dedupes one request to the widest mode', async () => {
    const sha = 'e'.repeat(64);
    const [localFirst] = await allowFromRequest([packageAction(sha, 'local')], 'approval_1');
    const [localAgain] = await allowFromRequest([packageAction(sha, 'local')], 'approval_2');
    expect(localAgain.allowId).toBe(localFirst.allowId);

    const [lanRecord] = await allowFromRequest([packageAction(sha, 'lan')], 'approval_3');
    expect(lanRecord.allowId).not.toBe(localFirst.allowId);
    expect(lanRecord.network).toBe('lan');

    // An active lan record covers a local-only ask, so the ask is idempotent:
    // whichever active record answers, it is active and covers local.
    const [covered] = await allowFromRequest([packageAction(sha, 'local')], 'approval_4');
    expect(covered.state).toBe('active');
    expect(['local', 'lan']).toContain(covered.network);
    expect(allowCovers(covered.network, 'local')).toBe(true);

    // One request with two starts of the same sha (one local, one lan)
    // records exactly one allow, with the widest network seen ('lan').
    const otherSha = 'f'.repeat(64);
    const mixed = [packageAction(otherSha, 'local'), packageAction(otherSha, 'lan', 'svc2')];
    const [recorded] = await allowFromRequest(mixed, 'approval_5');
    expect(recorded.sha256).toBe(otherSha);
    expect(recorded.network).toBe('lan');
    expect(await listPackageAllows()).toContainEqual(expect.objectContaining({ sha256: otherSha, network: 'lan' }));

    await expect(addPackageAllows({
      packages: [{ sha256: otherSha, url: PACKAGE_URL, network: 'wide' as any }],
      approvalId: 'approval_bad',
      decidedBy: 'cli'
    })).rejects.toThrow(/network/);
  });

  it('demo off: the allow store is ignored, so a start asks even with an active lan allow', async () => {
    const sha = '9'.repeat(64);
    await allowFromRequest([packageAction(sha, 'lan')], 'approval_lan');
    delete process.env.CONDUIT_DEMO_PROFILE;

    const asked = await executeRequestFromUnknown(packageRequest(sha, 'local'));
    expect(asked.status).toBe('requires_review');
    expect(asked.allowIds).toBeUndefined();
    expect(asked.approvalId).toBeTruthy();
  });

  it('revoking a digest removes every network mode, and all modes ask again', async () => {
    const sha = '7'.repeat(64);
    await allowFromRequest([packageAction(sha, 'local')], 'approval_local');
    await allowFromRequest([packageAction(sha, 'lan')], 'approval_lan');

    const revoked = await revokePackageAllow(sha, 'cli');
    expect(revoked.length).toBe(2);
    expect(revoked.map((allow) => allow.state)).toEqual(['revoked', 'revoked']);

    const asked = await executeRequestFromUnknown(packageRequest(sha, 'local'));
    expect(asked.status).toBe('requires_review');
    expect(asked.allowIds).toBeUndefined();
  });
});
