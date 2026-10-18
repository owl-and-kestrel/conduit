import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const cliPath = path.resolve('src/cli/index.ts');
const tsxPath = path.resolve('node_modules/.bin/tsx');
// Each case spawns several tsx processes; under a parallel full-suite run the
// 5 s vitest default is too tight (observed timeouts on Cedar).
const CLI_SUBPROCESS_TIMEOUT_MS = 60_000;

describe('Conduit CLI end-to-end flows', () => {
  it('runs doctor and the fake transport through the public CLI', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'conduit-cli-e2e-'));
    const stateRoot = path.join(tempRoot, 'state');
    try {
      const doctor = await runCli(['doctor'], stateRoot);
      expect(doctor.stdout).toContain('Conduit doctor');
      expect(doctor.stdout).toContain('transport.fake: available');

      const run = await runCli([
        'run',
        '--transport',
        'fake',
        '--project',
        path.resolve('fixtures/fake-project'),
        '--task',
        'Read README.md and summarize it.'
      ], stateRoot);
      expect(run.stdout).toContain('Fake transport completed the read-only tractability spike.');

      const runId = run.stdout.match(/Run ([^ ]+) complete\./)?.[1];
      expect(runId).toBeTruthy();
      const final = await readFile(path.join(stateRoot, 'runs', runId!, 'final.json'), 'utf8');
      expect(final).toContain('"status": "complete"');
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  }, CLI_SUBPROCESS_TIMEOUT_MS);

  it('creates, lists, and revokes a trusted clipboard session through the public CLI', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'conduit-session-e2e-'));
    const projectRoot = path.join(tempRoot, 'project');
    const stateRoot = path.join(tempRoot, 'state');
    try {
      await mkdir(projectRoot, { recursive: true });
      await writeFile(path.join(projectRoot, 'README.md'), 'hello cli session\n', 'utf8');

      const created = await runCli([
        'session',
        'create',
        '--label',
        'CLI e2e',
        '--root',
        projectRoot,
        '--profile',
        'read-only'
      ], stateRoot);
      expect(created.stdout).toContain('Starter request block:');
      expect(created.stdout).toContain('"schema": "conduit.request.v1"');
      expect(created.stdout).toContain('"list": "."');

      const sessionId = created.stdout.match(/Created session ([^\n]+)/)?.[1];
      expect(sessionId).toBeTruthy();

      const listed = await runCli(['session', 'list'], stateRoot);
      expect(listed.stdout).toContain(sessionId);
      expect(listed.stdout).toContain('active  read-only  CLI e2e');

      const revoked = await runCli(['session', 'revoke', sessionId!], stateRoot);
      expect(revoked.stdout).toContain(`Revoked session ${sessionId}`);

      const listedAgain = await runCli(['session', 'list'], stateRoot);
      expect(listedAgain.stdout).toContain(`${sessionId}  revoked`);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  }, CLI_SUBPROCESS_TIMEOUT_MS);
});

async function runCli(args: string[], stateRoot: string): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(tsxPath, [cliPath, ...args], {
    cwd: path.resolve('.'),
    env: {
      ...process.env,
      CONDUIT_STATE_DIR: stateRoot
    },
    timeout: 20_000,
    maxBuffer: 1024 * 1024
  });
}
