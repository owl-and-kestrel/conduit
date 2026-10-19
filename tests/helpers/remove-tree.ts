import { chmodSync, lstatSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';

/**
 * rm -rf for a test temp dir that may hold Conduit's read-only package cache
 * (files 0o444, directories 0o555): give the owner write access back first
 * (chmod -R u+w, never following symlinks), then remove the tree.
 */
export function removeTree(root: string): void {
  makeWritable(root);
  rmSync(root, { recursive: true, force: true });
}

function makeWritable(target: string): void {
  let stats;
  try {
    stats = lstatSync(target);
  } catch {
    return;
  }
  if (stats.isSymbolicLink()) {
    return;
  }
  try {
    chmodSync(target, stats.isDirectory() ? 0o700 : 0o600);
  } catch {
    // Not ours to change: the rm below reports what it cannot remove.
  }
  if (stats.isDirectory()) {
    for (const name of readdirSync(target)) {
      makeWritable(path.join(target, name));
    }
  }
}
