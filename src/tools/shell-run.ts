import { spawn } from 'node:child_process';
import { z } from 'zod';
import type { ToolDefinition } from './types.js';
import { supervision } from '../runtime/process-tree.js';

const COMMAND_TIMEOUT_MS = 30000;
const TREE_KILL_GRACE_MS = 3000;
const MAX_BUFFER_BYTES = 10 * 1024 * 1024;

const ShellRunArgsSchema = z.object({
  command: z.string().min(1)
});

type ShellRunArgs = z.infer<typeof ShellRunArgsSchema>;

const DESTRUCTIVE_PATTERNS = [
  'rm -rf',
  'sudo',
  'chmod -R 777',
  'mkfs',
  'dd if='
];

export const shellRunTool: ToolDefinition<ShellRunArgs> = {
  name: 'shell.run',
  description: 'Execute a shell command inside the project root.',
  risk: 'high',
  schema: ShellRunArgsSchema,
  async run(args, context) {
    const cmd = args.command.trim();
    for (const pattern of DESTRUCTIVE_PATTERNS) {
      if (cmd.includes(pattern)) {
        throw new Error(`Command denied: contains destructive pattern '${pattern}'`);
      }
    }

    try {
      const { stdout, stderr } = await runShellCommand(args.command, context.projectRoot);

      const maxChars = 30000;
      let output = stdout || stderr;
      const truncated = output.length > maxChars;
      if (truncated) {
        output = output.slice(0, maxChars) + '... (truncated)';
      }

      return {
        content: output,
        metadata: {
          command: args.command,
          exitCode: 0,
          truncated
        }
      };
    } catch (error: any) {
      let output = error.stdout || error.stderr || error.message || String(error);
      const maxChars = 30000;
      const truncated = output.length > maxChars;
      if (truncated) {
        output = output.slice(0, maxChars) + '... (truncated)';
      }
      return {
        content: output,
        metadata: {
          command: args.command,
          exitCode: error.code || 1,
          truncated
        }
      };
    }
  }
};

type ShellCommandError = Error & { code?: number | string | null; signal?: NodeJS.Signals | null; stdout: string; stderr: string };

/**
 * Runs `command` through the shell like `exec` did (/bin/sh -c on POSIX,
 * cmd.exe on Windows; utf8 output; 10 MiB per stream), but with spawn so the
 * shell can be a process-group leader: `exec` does not pass `detached`
 * through to spawn. Under supervision the shell leads its own group and is
 * adopted, so the deadman watchdog can stop its whole tree. Rejects like
 * promisify(exec): an Error carrying `code`, `signal`, `stdout`, `stderr`.
 */
function runShellCommand(command: string, cwd: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...supervision.childSpawnOptions()
    });
    supervision.adopt(child);

    const chunks: Record<'stdout' | 'stderr', Buffer[]> = { stdout: [], stderr: [] };
    const sizes = { stdout: 0, stderr: 0 };
    let overflow: 'stdout' | 'stderr' | null = null;
    const stopTree = (): void => {
      void supervision.terminateTreeOf(child, TREE_KILL_GRACE_MS);
    };
    for (const name of ['stdout', 'stderr'] as const) {
      child[name]!.on('data', (chunk: Buffer) => {
        if (overflow) {
          return;
        }
        const room = MAX_BUFFER_BYTES - sizes[name];
        chunks[name].push(room < chunk.length ? chunk.subarray(0, room) : chunk);
        sizes[name] += Math.min(room, chunk.length);
        if (chunk.length > room) {
          overflow = name;
          stopTree();
        }
      });
    }

    // The timeout stops the whole command tree. exec's own `timeout`
    // SIGTERMed only the shell, so a grandchild holding the output pipe
    // could keep shell.run waiting forever.
    const timer = setTimeout(stopTree, COMMAND_TIMEOUT_MS);
    const output = () => ({
      stdout: Buffer.concat(chunks.stdout).toString('utf8'),
      stderr: Buffer.concat(chunks.stderr).toString('utf8')
    });

    child.once('error', (error) => {
      clearTimeout(timer);
      reject(Object.assign(error, output()));
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      const { stdout, stderr } = output();
      if (code === 0 && !overflow) {
        resolve({ stdout, stderr });
        return;
      }
      const reason = overflow ? `${overflow} maxBuffer length exceeded` : `Command failed: ${command}\n${stderr}`;
      const error = new Error(reason) as ShellCommandError;
      reject(Object.assign(error, { code, signal, stdout, stderr }));
    });
  });
}
