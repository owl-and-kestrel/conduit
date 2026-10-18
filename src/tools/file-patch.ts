import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { resolveInsideProject } from '../policy/sandbox.js';
import { isSensitivePath } from '../policy/sensitive-paths.js';
import type { ToolDefinition } from './types.js';

const execFileAsync = promisify(execFile);

const FilePatchArgsSchema = z.object({
  patch: z.string().min(1)
});

type FilePatchArgs = z.infer<typeof FilePatchArgsSchema>;

export const filePatchTool: ToolDefinition<FilePatchArgs> = {
  name: 'file.patch',
  description: 'Apply a diff patch to the project using git apply.',
  risk: 'high',
  schema: FilePatchArgsSchema,
  async run(args, context) {
    const patchFileName = `patch_${Date.now()}.diff`;
    const patchPath = path.join(context.runDir, patchFileName);
    await writeFile(patchPath, args.patch, 'utf8');

    // Same sandbox and sensitive-file rules as file.write, for every path the
    // patch touches, before anything is applied.
    for (const touched of await listPatchPaths(patchPath, context.projectRoot)) {
      const absolutePath = await resolveInsideProject(touched, context.projectRoot);
      if (isSensitivePath(absolutePath)) {
        throw new Error(`Denied sensitive file patch: ${touched}`);
      }
    }

    try {
      await execFileAsync('git', ['apply', patchPath], {
        cwd: context.projectRoot
      });

      const { stdout: diffOutput } = await execFileAsync('git', ['diff'], {
        cwd: context.projectRoot
      });

      return {
        content: { success: true, message: 'Patch applied successfully.', diff: diffOutput },
        metadata: { patchFile: patchFileName }
      };
    } catch (error: any) {
      throw new Error(`Failed to apply patch: ${error.stderr || error.message || String(error)}`);
    }
  }
};

/**
 * Every path `git apply <patchPath>` would touch, read by git itself with the
 * same cwd and options as the apply, so this check cannot disagree with git
 * about how the patch parses or how -p1 strips names.
 *
 * `git apply --numstat -z` prints one name per file: the new name (the old
 * one for a delete). `-R` swaps old and new, so the reverse run prints each
 * file's old name. Together they cover creates, deletes, edits, mode changes,
 * symlinks and both sides of renames and copies. `--summary` is read only to
 * prove that every line of git's output has a shape this parser knows.
 *
 * Anything else refuses the patch: git failing to read it, a name that is not
 * valid UTF-8 or contains a newline (the summary would be ambiguous), an
 * unknown summary line, or the two runs disagreeing on how many files there are.
 */
export async function listPatchPaths(patchPath: string, cwd: string): Promise<string[]> {
  const forward = parseNumstatZ(await gitApplyListing(['--numstat', '--summary', '-z', patchPath], cwd));
  const reverse = parseNumstatZ(await gitApplyListing(['--numstat', '-z', '-R', patchPath], cwd));
  if (forward.paths.length === 0 || forward.paths.length !== reverse.paths.length || reverse.rest !== '') {
    throw unparsable('git listed a different set of files forward and reversed');
  }
  assertKnownSummary(forward.rest);
  return [...new Set([...forward.paths, ...reverse.paths])];
}

async function gitApplyListing(args: string[], cwd: string): Promise<string> {
  let stdout: Buffer;
  try {
    ({ stdout } = await execFileAsync('git', ['apply', ...args], { cwd, encoding: 'buffer' }));
  } catch (error: any) {
    const stderr = Buffer.isBuffer(error?.stderr) ? error.stderr.toString('utf8') : '';
    throw unparsable(stderr.trim() || error?.message || String(error));
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(stdout);
  } catch {
    throw unparsable('a path is not valid UTF-8');
  }
}

// "<added>\t<deleted>\t<name>\0" per file ("-" counts for binary), then any summary lines.
function parseNumstatZ(output: string): { paths: string[]; rest: string } {
  const record = /^(?:\d+|-)\t(?:\d+|-)\t([^\0\n]+)\0/;
  const paths: string[] = [];
  let rest = output;
  for (let match = record.exec(rest); match; match = record.exec(rest)) {
    paths.push(match[1]);
    rest = rest.slice(match[0].length);
  }
  return { paths, rest };
}

const SUMMARY_LINES = [
  /^ (?:create|delete)(?: mode [0-7]{6})? \S.*$/,
  /^ mode change [0-7]{6} => [0-7]{6}(?: \S.*)?$/,
  /^ (?:rename|copy) \S.* \(\d+%\)$/,
  /^ rewrite \S.* \(\d+%\)$/
];

function assertKnownSummary(summary: string): void {
  if (summary === '') return;
  if (!summary.endsWith('\n')) throw unparsable('unexpected git apply output');
  for (const line of summary.slice(0, -1).split('\n')) {
    if (!SUMMARY_LINES.some((shape) => shape.test(line))) {
      throw unparsable(`unexpected git apply summary line: ${JSON.stringify(line)}`);
    }
  }
}

function unparsable(detail: string): Error {
  return new Error(`Refused patch: could not list every path it touches (${detail})`);
}
