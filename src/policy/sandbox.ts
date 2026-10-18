import path from 'node:path';
import { lstat, realpath } from 'node:fs/promises';

/**
 * Resolve `inputPath` (absolute, or relative to `projectRoot`) to the real
 * path the file tools will read or write, and refuse it unless that real path
 * is inside the project's real path and outside every `.git` directory.
 *
 * Every file tool (file.read, file.write, file.list, and file.patch for each
 * path git lists) passes through here, so this is the one sandbox gate.
 *
 * A path that does not exist yet (a file about to be created) is resolved
 * through its deepest EXISTING ancestor: realpath of that ancestor, plus the
 * remaining components, which do not exist and so cannot be symlinks. A plain
 * `path.resolve` of the whole path would not follow an in-project directory
 * that is a symlink to somewhere outside, and file.write would then create a
 * file outside the project.
 *
 * An entry that exists but cannot be resolved is refused, never passed through:
 * a dangling symlink (writing through it would create its target, wherever
 * that is), a symlink loop (ELOOP), or any other resolution error.
 */
export async function resolveInsideProject(inputPath: string, projectRoot: string): Promise<string> {
  const realProjectRoot = await realpath(projectRoot);
  // path.resolve keeps an absolute inputPath and normalizes `.` and `..`.
  const absolutePath = path.resolve(realProjectRoot, inputPath);
  const resolvedPath = await realpathThroughExistingAncestor(absolutePath, inputPath);

  const relative = path.relative(realProjectRoot, resolvedPath);
  if (!isInside(relative)) {
    throw new Error(`Path is outside project root: ${inputPath}`);
  }

  // The project sandbox is the working tree, not git's metadata. Writing under
  // .git (hooks/, config) runs code on the next git command, and .git/config
  // can hold credentials, so .git is refused as any component of the path the
  // caller asked for and of the path it resolves to (a symlink alias into .git).
  // This lives here, not in isSensitivePath, because only this helper knows the
  // project root (a .git directory above the project is not in question) and
  // sees the symlink-resolved path, and because file.list calls only this one.
  // The message keeps "outside project root" so executeToolAction reports it
  // as denied, like every other sandbox refusal.
  if (hasGitComponent(path.relative(realProjectRoot, absolutePath)) || hasGitComponent(relative)) {
    throw new Error(`Path is outside project root: ${inputPath} (.git is git's metadata, not part of the project sandbox)`);
  }

  return resolvedPath;
}

function isInside(relative: string): boolean {
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

// Matches `.git` in any letter case (case-insensitive filesystems such as the
// macOS default open .git for .GIT) and with trailing dots or spaces, which
// Windows strips when opening a name.
const GIT_DIR_COMPONENT = /^\.git[. ]*$/i;

function hasGitComponent(relativePath: string): boolean {
  const separators = path.sep === '\\' ? /[\\/]/ : /\//;
  return relativePath.split(separators).some((component) => GIT_DIR_COMPONENT.test(component));
}

async function realpathThroughExistingAncestor(absolutePath: string, inputPath: string): Promise<string> {
  const missing: string[] = [];
  let candidate = absolutePath;

  for (;;) {
    try {
      const realCandidate = await realpath(candidate);
      return missing.length === 0 ? realCandidate : path.join(realCandidate, ...missing);
    } catch (error) {
      const code = errorCode(error);
      // ENOENT: candidate (or something under it) does not exist yet.
      // ENOTDIR: a component is a regular file; the tool's own I/O will fail.
      // Anything else (ELOOP, EACCES, ...) cannot be resolved: refuse.
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        throw unresolvable(inputPath, code);
      }
    }

    // realpath failed with ENOENT. If candidate itself exists, it is a symlink
    // whose target does not resolve (dangling); refuse rather than treat it as
    // a not-yet-created name.
    try {
      await lstat(candidate);
      throw unresolvable(inputPath, 'dangling symlink');
    } catch (error) {
      if (error instanceof UnresolvablePathError) throw error;
      const code = errorCode(error);
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        throw unresolvable(inputPath, code);
      }
    }

    const parent = path.dirname(candidate);
    if (parent === candidate) {
      // Not even the filesystem root resolved.
      throw unresolvable(inputPath, 'no existing ancestor');
    }
    missing.unshift(path.basename(candidate));
    candidate = parent;
  }
}

class UnresolvablePathError extends Error {}

function unresolvable(inputPath: string, reason: string): UnresolvablePathError {
  // Treated as outside the project: a path that cannot be resolved cannot be
  // shown to stay inside it. The wording keeps executeToolAction's "denied".
  return new UnresolvablePathError(`Path is outside project root: ${inputPath} (cannot be resolved: ${reason})`);
}

function errorCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return typeof code === 'string' ? code : 'unknown error';
}
