import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Which checkout this Control's code runs from, reported on `GET /api/status`
// as `identity.checkoutRoot`.
//
// Several Conduit checkouts (and an installed Conduit) can run on one Mac, and
// all of them use port 47831. The menu-bar app adopts a Control that is already
// listening there only when that Control reports the app's own checkout, so the
// app in /x/conduit never shows or decides /x/conduit-fork's approvals.
//
// The root is the nearest directory above this module that holds package.json,
// with symlinks resolved. That is the code that is running, wherever the
// process was started from: `src/app/` under tsx and `dist/src/app/` after a
// build both lead to the checkout root. Conduit has no per-install id, so the
// checkout root is the whole identity.

export interface ControlIdentity {
  /** Symlink-resolved checkout root, or null when no package.json was found. */
  checkoutRoot: string | null;
}

export function findCheckoutRoot(start: string = path.dirname(fileURLToPath(import.meta.url))): string | null {
  let directory = path.resolve(start);
  for (;;) {
    if (existsSync(path.join(directory, 'package.json'))) {
      try {
        return realpathSync(directory);
      } catch {
        return null;
      }
    }
    const parent = path.dirname(directory);
    if (parent === directory) {
      return null;
    }
    directory = parent;
  }
}

let cached: ControlIdentity | undefined;

/** This process's identity. The checkout cannot change while it runs, so it is read once. */
export function getControlIdentity(): ControlIdentity {
  cached ??= { checkoutRoot: findCheckoutRoot() };
  return cached;
}
