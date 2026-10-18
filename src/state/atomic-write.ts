import { randomBytes } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Write a file atomically: write a uniquely named temp file beside it, then
 * rename it over the target. The temp name carries the pid and random bytes,
 * so concurrent writers (another process such as a `--local` CLI, or two
 * writes in this process) never share a temp file, and a reader sees either
 * the old or the new contents, never a partial file. The last rename wins.
 * This is the one atomic-write helper for Conduit state files.
 */
export async function writeFileAtomic(filePath: string, contents: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await writeFile(tempPath, contents, 'utf8');
    await rename(tempPath, filePath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}
