import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { getStateRoot } from '../state/paths.js';
import { writeFileAtomic } from '../state/atomic-write.js';
import { withFileLock } from '../state/file-lock.js';

// "Always allow this exact package" (demo profile only; S2 of the demo slice).
//
// The allow list is keyed by the EXACT package sha256 (Jon D2), never the page
// origin: a `conduit://` link does not authenticate its origin, so an origin
// claim cannot decide anything. A different digest asks again.
// - Only a request whose every action starts a sha256-pinned package skips the
//   ask; any other action in the request makes it ask.
// - Network mode (Jon 2026-10-20): each allow also records the network mode of
//   the start it was approved for — 'local' (loopback) or 'lan' (`lan: true`,
//   which is what binds 0.0.0.0). A 'local' allow does not cover a later
//   `lan: true` start of the same digest (that asks again); a 'lan' allow also
//   covers 'local' starts, the narrower exposure. Revoking one digest revokes
//   every mode.
// - Migration: records written before the mode existed are hash-only, so they
//   are read as 'local' and marked `networkMigrated: true` (conservative: a LAN
//   start of such a digest asks once, then records its own 'lan' allow).
// - Revoking an allow restores the ask.
// - The store exists only under the demo profile (the panel refuses
//   `remember: 'package'` while the switch is off).
//
// Normative note (spec.md is not touched): this departs from spec.md:1010-1012
// ("approval records MUST NOT ... grant future approvals") by design for the
// demo. It is not an approval record: it is a separate, explicit record the
// person chooses at approve time ("Always allow this exact package"), keyed by
// the exact digest, and revocable from the panel API
// (POST /api/package-allows/:id/revoke) and the CLI (`conduit packages
// revoke`), so the person can always see and undo what it grants.

export const REMEMBER_THIS_PACKAGE = 'package' as const;

/**
 * The network exposure of a `service.start` (Jon 2026-10-20): 'lan' binds
 * 0.0.0.0, 'local' stays on loopback — the same condition the service registry
 * keys the bind on.
 */
export type PackageAllowNetwork = 'local' | 'lan';

export interface PackageAllow {
  /** `'allow_' + random hex`; stable across the store's lifetime. */
  allowId: string;
  sha256: string;
  state: 'active' | 'revoked';
  allowedAt: string;
  allowedBy: string;
  approvalId: string;
  /**
   * The network mode this allow was recorded for (Jon 2026-10-20): 'lan'
   * covers both modes, 'local' only local-only starts of the same digest.
   */
  network: PackageAllowNetwork;
  /** Set on version-1 (hash-only) records, read conservatively as 'local'. */
  networkMigrated?: true;
  /**
   * Provenance: what the request claimed (claimed url, shown title and the
   * request's own `source`), not verified. The sha256 of the unpacked bytes is
   * the verified part; the rest is an audit trail.
   */
  url?: string;
  title?: string | null;
  source?: unknown;
  revokedAt?: string;
  revokedBy?: string;
}

interface PackageAllowStore {
  version: 2;
  allows: PackageAllow[];
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

function storePath(): string {
  return path.join(getStateRoot(), 'package-allows.json');
}

/**
 * The network mode of one `service.start` args object: 'lan' exactly when it
 * asks for `lan: true` (which binds 0.0.0.0), 'local' otherwise (loopback).
 */
export function networkOfStart(args: Record<string, unknown>): PackageAllowNetwork {
  return args.lan === true ? 'lan' : 'local';
}

/**
 * Whether an allow's network covers a requested start's network (Jon
 * 2026-10-20): a 'lan' allow covers both modes; a 'local' allow covers only a
 * 'local' start — the narrower exposure never grows the recorded one.
 */
export function allowCovers(allowNetwork: PackageAllowNetwork, requested: PackageAllowNetwork): boolean {
  return allowNetwork === 'lan' || requested === 'local';
}

/**
 * Reads one stored record into the version-2 shape: a missing or invalid
 * network (a hash-only version-1 record, or corrupt data) reads as 'local' and
 * is marked `networkMigrated: true`; the next save writes the normalized
 * record.
 */
function normalizeAllow(raw: unknown): PackageAllow {
  const allow = (raw ?? {}) as PackageAllow;
  const migrated = allow.network !== 'lan' && allow.network !== 'local';
  const network: PackageAllowNetwork = migrated ? 'local' : allow.network;
  const normalized: PackageAllow = { ...allow, network };
  if (migrated) {
    normalized.networkMigrated = true;
  } else {
    delete normalized.networkMigrated;
  }
  return normalized;
}

async function loadStore(): Promise<PackageAllowStore> {
  try {
    const text = await readFile(storePath(), 'utf8');
    const parsed = JSON.parse(text) as { version?: unknown; allows?: unknown };
    // Any stored version is accepted; records are normalized here (network
    // migration) so every reader sees the version-2 shape.
    if (parsed && Array.isArray(parsed.allows)) {
      return { version: 2, allows: parsed.allows.map(normalizeAllow) };
    }
  } catch {
    // Missing or unreadable store reads as an empty list, never as a failure:
    // a missing allow only means the person is asked again (fail closed).
  }
  return { version: 2, allows: [] };
}

async function saveStore(store: PackageAllowStore): Promise<void> {
  // Atomic write, so a concurrent reader (a later request deciding whether to
  // ask, the panel list) never sees a truncated store.
  await writeFileAtomic(storePath(), `${JSON.stringify(store, null, 2)}\n`);
}

/**
 * The digests of a "package-only" request, or null: non-null only when
 * `actions` is non-empty and EVERY action is a `service.start` whose
 * `args.package` carries a 64-hex sha256 and a string url. Any other action in
 * the request makes this null, so the request can never skip the ask because
 * of the packages it also starts.
 */
export function packageOnlyDigests(actions: unknown): Array<{ sha256: string; url: string; network: PackageAllowNetwork }> | null {
  if (!Array.isArray(actions) || actions.length === 0) {
    return null;
  }
  const digests: Array<{ sha256: string; url: string; network: PackageAllowNetwork }> = [];
  for (const action of actions) {
    if (!action || typeof action !== 'object' || (action as { tool?: unknown }).tool !== 'service.start') {
      return null;
    }
    const args = (action as { args?: unknown }).args;
    if (typeof args !== 'object' || args === null) {
      return null;
    }
    const pkg = (args as Record<string, unknown>)['package'];
    if (typeof pkg !== 'object' || pkg === null) {
      return null;
    }
    const sha256 = (pkg as { sha256?: unknown }).sha256;
    const url = (pkg as { url?: unknown }).url;
    if (typeof sha256 !== 'string' || !SHA256_PATTERN.test(sha256)) {
      return null;
    }
    if (typeof url !== 'string' || url.length === 0) {
      return null;
    }
    digests.push({ sha256, url, network: networkOfStart(args as Record<string, unknown>) });
  }
  return digests;
}

/** Newest first, revoked records included: the whole history is visible. */
export async function listPackageAllows(): Promise<PackageAllow[]> {
  const store = await loadStore();
  return [...store.allows].sort((a, b) => b.allowedAt.localeCompare(a.allowedAt));
}

/**
 * The newest active record for this exact digest whose network covers the
 * requested start's network mode, or null (which means: ask). The mode is
 * required: a 'local' allow covers only local starts, a 'lan' allow covers
 * both (Jon 2026-10-20).
 */
export async function findActivePackageAllow(sha256: string, network: PackageAllowNetwork): Promise<PackageAllow | null> {
  if (!SHA256_PATTERN.test(sha256)) {
    return null;
  }
  const store = await loadStore();
  const matches = store.allows
    .filter((allow) => allow.sha256 === sha256 && allow.state === 'active' && allowCovers(allow.network, network))
    .sort((a, b) => b.allowedAt.localeCompare(a.allowedAt));
  return matches[0] ?? null;
}

/**
 * Records one allow per distinct sha256, keyed by the sha256 AND the network
 * mode of the ask (Jon 2026-10-20): a digest started several ways in one
 * request collapses to the WIDEST mode seen ('lan' when any start asks for
 * `lan: true`). An active record that already covers that mode is returned
 * as-is (idempotent); an older active record of the narrower mode stays active
 * and the list shows both (a new 'lan' ask sits next to an old 'local' allow).
 */
export async function addPackageAllows(input: {
  packages: Array<{ sha256: string; url: string; network: PackageAllowNetwork }>;
  approvalId: string;
  decidedBy: string;
  title?: string | null;
  source?: unknown;
}): Promise<PackageAllow[]> {
  if (!Array.isArray(input.packages) || input.packages.length === 0) {
    throw new Error('addPackageAllows needs at least one package digest.');
  }
  return withFileLock(storePath(), async () => {
    const store = await loadStore();
    const allowedAt = new Date().toISOString();
    const widest = new Map<string, { sha256: string; url: string; network: PackageAllowNetwork }>();
    const records: PackageAllow[] = [];
    for (const pkg of input.packages) {
      if (!SHA256_PATTERN.test(pkg.sha256)) {
        throw new Error(`Package sha256 must be 64 lowercase hex digits, got: ${JSON.stringify(pkg.sha256)}`);
      }
      if (pkg.network !== 'local' && pkg.network !== 'lan') {
        throw new Error(`Package allow network must be 'local' or 'lan', got: ${JSON.stringify(pkg.network)}`);
      }
      const seen = widest.get(pkg.sha256);
      widest.set(pkg.sha256, {
        sha256: pkg.sha256,
        url: seen ? (seen.url || pkg.url) : pkg.url,
        network: seen ? (seen.network === 'lan' || pkg.network === 'lan' ? 'lan' : 'local') : pkg.network
      });
    }
    for (const pkg of widest.values()) {
      const existing = store.allows.find(
        (allow) => allow.sha256 === pkg.sha256 && allow.state === 'active' && allowCovers(allow.network, pkg.network)
      );
      if (existing) {
        records.push(existing);
        continue;
      }
      const record: PackageAllow = {
        allowId: `allow_${randomBytes(6).toString('hex')}`,
        sha256: pkg.sha256,
        state: 'active',
        allowedAt,
        allowedBy: input.decidedBy,
        approvalId: input.approvalId,
        url: pkg.url,
        title: input.title ?? null,
        source: input.source,
        network: pkg.network
      };
      store.allows.push(record);
      records.push(record);
    }
    await saveStore(store);
    return records;
  });
}

/**
 * Marks every active record for this digest revoked — of every network mode,
 * since one digest is one package no matter how it asked to bind (Jon
 * 2026-10-20) — so the ask comes back the next time that package wants to
 * start, over any mode. Returns the records it revoked ([]/404 when none was
 * active).
 */
export async function revokePackageAllow(sha256: string, by: string): Promise<PackageAllow[]> {
  return withFileLock(storePath(), async () => {
    const store = await loadStore();
    const revokedAt = new Date().toISOString();
    const revoked: PackageAllow[] = [];
    for (const allow of store.allows) {
      if (allow.sha256 === sha256 && allow.state === 'active') {
        allow.state = 'revoked';
        allow.revokedAt = revokedAt;
        allow.revokedBy = by;
        revoked.push(allow);
      }
    }
    if (revoked.length > 0) {
      await saveStore(store);
    }
    return revoked;
  });
}
