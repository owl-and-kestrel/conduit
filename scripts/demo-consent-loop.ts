/**
 * scripts/demo-consent-loop.ts
 *
 * Demonstrates the Conduit thesis in one isolated, end-to-end consent loop:
 *
 *   "Conduit does not make local execution safe. It makes local execution legible."
 *
 * The script creates one trusted session and drives its starter envelope through
 * three arms, using ONLY existing CLI commands as child processes (no Conduit
 * internals are imported):
 *
 *   A. trusted                  — the nonce-bearing starter envelope from a paired
 *                                 trusted session runs quietly: one run created,
 *                                 zero approval asks, results left on the clipboard.
 *   B. untrusted (nonce gone)   — a copy with the nonce deleted must NEVER run
 *                                 silently: it becomes exactly one review ask
 *                                 (tool == conduit.review), which the demo denies.
 *                                 No run is created; no execution happens.
 *   C. replay (stale nonce)     — the original envelope again; its nonce was
 *                                 consumed in arm A, so a known session with a
 *                                 stale nonce is refused with a repair envelope,
 *                                 not escalated: one rejection, zero asks, zero runs.
 *
 * Run:        npx tsx scripts/demo-consent-loop.ts [--json-out <file>] [--keep]
 *   --json-out <file>  also write the results JSON to <file>.
 *   --keep             keep the temporary isolation directory (for debugging).
 *
 * Isolation:
 *   - All state lives in an fs.mkdtemp('conduit-demo-') directory under os.tmpdir()
 *     with `state/` wired as CONDUIT_STATE_DIR, so the demo never reads a real ~/.conduit.
 *   - The clipboard is shimmed inside `<root>/bin/`: `pbpaste` is
 *     `cat "$CONDUIT_DEMO_CLIPBOARD"` and `pbcopy` is `cat > "$CONDUIT_DEMO_CLIPBOARD"`,
 *     prepended to PATH. The demo therefore never touches the real system clipboard
 *     and also works on Linux (Conduit shells out to the pbpaste/pbcopy executables).
 *   - Conduit Control is started on an ephemeral loopback port
 *     (`app start --port 0 --host 127.0.0.1`); if the resolved URL ports at
 *     47831 or 3333 the script refuses to continue, so it can never silently talk
 *     to a real running Conduit Control.
 *
 * Note: every CLI call is a fresh Node + tsx process, so the recorded wall times
 * include start-up cost and are NOT a throughput benchmark.
 */

import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI_ENTRY = path.join(REPO_ROOT, 'src', 'cli', 'index.ts');
const THESIS = 'Conduit does not make local execution safe. It makes local execution legible.';
const APP_URL_PATTERN = /Conduit app: (http:\/\/127\.0\.0\.1:\d+)/;
const FORBIDDEN_PORTS = new Set([47831, 3333]);
const CLI_TIMEOUT_MS = 60_000;
const APP_START_TIMEOUT_MS = 30_000;
const PBPASTE_SH = '#!/bin/sh\ncat "$CONDUIT_DEMO_CLIPBOARD"\n';
const PBCOPY_SH = '#!/bin/sh\ncat > "$CONDUIT_DEMO_CLIPBOARD"\n';

interface CliRun { stdout: string; stderr: string; code: number; ms: number; }
interface ArmEvents { accepted: number; executed: number; rejected: number; requiresReview: number; error: number; }
interface ApprovalLike { status?: string; action?: { tool?: string } | null; }
interface CheckResult { arm: string; check: string; expected: unknown; actual: unknown; pass: boolean; }
interface DenyOutcome { status: string; pendingAfterDeny: number; runsCreatedAfterDeny: number; denyMs: number; }
interface ArmRun {
  arm: string; daemonMs: number; armMs: number; events: ArmEvents;
  approvalId: string | null; runsCreated: number; newAsks: number;
  pendingAsks: number; pendingTools: string[]; clipboardAfter: string;
}
interface PublicArm {
  arm: string; daemonMs: number; armMs: number; events: ArmEvents;
  approvalIdPresent: boolean; runsCreated: number; newAsks: number;
  pendingAsks: number; pendingTools: string[]; clipboardAfterPreview: string;
  denyStatus?: string; denyMs?: number; runsCreatedAfterDeny?: number;
}
interface DemoResults {
  schema: string; thesis: string; startedAt: string; finishedAt: string;
  node: string; platform: string; cli: string; arms: PublicArm[];
  checks: CheckResult[]; pass: boolean;
  totals: { asksTrusted: number; asksUntrusted: number; executions: number; reviews: number; rejections: number; runsCreated: number; approvalsDenied: number; };
}

// Module-level, initialized in main() before any child process is spawned.
let childEnv: NodeJS.ProcessEnv = process.env;
let clipboardFile = '';
let controlUrl = '';
let controlAppChild: ChildProcess | null = null;
let redactionSecrets = new Set<string>();

function note(message: string): void {
  console.error(`consent-loop: ${message}`);
}

function secret(value: unknown): string | null {
  if (typeof value !== 'string' || value.length < 12) return null;
  redactionSecrets.add(value);
  return value;
}

function redact(text: string): string {
  let out = text;
  for (const secretValue of redactionSecrets) out = out.split(secretValue).join('<redacted>');
  // The result block also carries the session's next one-shot nonce.
  return out.replace(/("(?:nextNonce|nonce|sessionId|runId|approvalId)"\s*:\s*")[^"]*"/g, '$1<redacted>"');
}

function runCli(args: string[]): Promise<CliRun> {
  const startedAt = performance.now(); // wall time, includes Node + tsx start-up
  return new Promise((resolve, reject) => {
    execFile(process.execPath, ['--import', 'tsx', CLI_ENTRY, ...args], {
      cwd: REPO_ROOT,
      env: childEnv,
      timeout: CLI_TIMEOUT_MS
    }, (error, stdout, stderr) => {
      const ms = Math.round(performance.now() - startedAt);
      if (error) {
        reject(new Error(`CLI ${args.join(' ')} failed (code ${String(error.code ?? 'signal')}, ${ms} ms): ${stderr.trim().slice(-600) || error.message}`));
        return;
      }
      resolve({ stdout, stderr, code: 0, ms });
    });
  });
}

async function cliJson(args: string[]): Promise<Record<string, unknown>> {
  const run = await runCli(args);
  try {
    return JSON.parse(run.stdout) as Record<string, unknown>;
  } catch {
    throw new Error(`CLI ${args.slice(0, 2).join(' ')} did not print JSON.`);
  }
}

async function listApprovals(url: string, all: boolean): Promise<ApprovalLike[]> {
  const args = all
    ? ['approvals', 'list', '--all', '--json', '--url', url]
    : ['approvals', 'list', '--json', '--url', url];
  const parsed = await cliJson(args);
  return Array.isArray(parsed.approvals) ? parsed.approvals as ApprovalLike[] : [];
}

async function countRuns(url: string): Promise<number> {
  const parsed = await cliJson(['runs', 'list', '--json', '--url', url]);
  return Array.isArray(parsed.runs) ? parsed.runs.length : 0;
}

function envelopeBlock(envelope: Record<string, unknown>): string {
  return '```conduit\n' + JSON.stringify(envelope, null, 2) + '\n```\n';
}

function parseStarterEnvelope(stdout: string): Record<string, unknown> {
  const lines = stdout.split('\n');
  const start = lines.findIndex((line) => line.trim() === '```conduit');
  const end = start === -1 ? -1 : lines.findIndex((line, index) => index > start && line.trim() === '```');
  if (start === -1 || end === -1) {
    throw new Error('session create did not print a closed ```conduit starter block.');
  }
  const envelope = JSON.parse(lines.slice(start + 1, end).join('\n')) as Record<string, unknown>;
  if (typeof envelope.sessionId !== 'string' || typeof envelope.nonce !== 'string') {
    throw new Error('Starter envelope is missing sessionId/nonce strings.');
  }
  return envelope;
}

function startControlApp(): Promise<string> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let settled = false;
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };
    const timer = setTimeout(() => fail(new Error(`Timed out after ${APP_START_TIMEOUT_MS} ms waiting for the Conduit app URL.`)), APP_START_TIMEOUT_MS);
    const child = spawn(process.execPath, ['--import', 'tsx', CLI_ENTRY, 'app', 'start', '--port', '0', '--host', '127.0.0.1'], {
      cwd: REPO_ROOT,
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    controlAppChild = child;
    if (!child.stdout) {
      fail(new Error('app start was not spawned with a piped stdout.'));
      return;
    }
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8'); // keep draining even after a successful match
      if (settled) return;
      const match = stdout.match(APP_URL_PATTERN);
      if (!match) return;
      const port = Number(new URL(match[1] ?? 'http://127.0.0.1:0').port);
      if (FORBIDDEN_PORTS.has(port)) {
        fail(new Error(`Refusing to run the demo against port ${port}: the demo Control must be ephemeral (--port 0).`));
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(match[1] ?? '');
    });
    child.stderr.on('data', () => undefined); // drain
    child.on('error', (error) => fail(new Error(`Could not spawn app start: ${error.message}`)));
    child.on('exit', (code) => {
      if (!settled) fail(new Error(`app start exited before printing a URL (code ${String(code ?? 'signal')}).`));
    });
  });
}

async function stopControlApp(): Promise<void> {
  const child = controlAppChild;
  controlAppChild = null;
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
    try {
      child.kill('SIGINT');
    } catch {
      resolve();
    }
    setTimeout(() => {
      try {
        child.kill('SIGKILL'); // only reaches the child if it is still alive
      } catch {
        /* already gone */
      }
    }, 5_000);
  });
}

async function armRun(arm: string, envelope: Record<string, unknown>, url: string): Promise<ArmRun> {
  const armStartedAt = performance.now();
  await writeFile(clipboardFile, envelopeBlock(envelope), 'utf8');
  const runsBefore = await countRuns(url);
  const asksBefore = (await listApprovals(url, true)).length;

  const daemon = await runCli(['daemon', 'once']);
  const events: ArmEvents = { accepted: 0, executed: 0, rejected: 0, requiresReview: 0, error: 0 };
  let approvalId: string | null = null;
  for (const line of daemon.stdout.split('\n')) {
    if (!line.includes('[Conduit daemon] ')) continue;
    if (line.includes('Accepted request')) events.accepted += 1;
    else if (line.includes('Executed request')) events.executed += 1;
    else if (line.includes('Rejected request')) events.rejected += 1;
    else if (line.includes('Review required')) events.requiresReview += 1;
    else continue;
    runEventIds(line);
    const approvalMatch = line.match(/approval=(\S+)/);
    approvalId = approvalMatch?.[1] ?? approvalId;
  }
  for (const line of daemon.stderr.split('\n')) {
    if (line.includes('[Conduit daemon] Error')) events.error += 1;
  }
  secret(approvalId);

  const clipboardAfter = await readFile(clipboardFile, 'utf8');
  const runsAfter = await countRuns(url);
  const pending = await listApprovals(url, false);
  const allAsksAfter = (await listApprovals(url, true)).length;

  return {
    arm,
    daemonMs: daemon.ms,
    armMs: Math.round(performance.now() - armStartedAt),
    events,
    approvalId,
    runsCreated: runsAfter - runsBefore,
    newAsks: allAsksAfter - asksBefore,
    pendingAsks: pending.length,
    pendingTools: pending.map((approval) => approval.action?.tool).filter((tool): tool is string => Boolean(tool)),
    clipboardAfter
  };
}

function runEventIds(line: string): void {
  const runMatch = line.match(/run=(\S+)/);
  if (runMatch) secret(runMatch[1]);
}

async function denyOutcomeOf(approvalId: string, url: string): Promise<DenyOutcome> {
  const runsBeforeDeny = await countRuns(url);
  const deny = await runCli(['approvals', 'deny', approvalId, '--reason', 'consent demo: denied', '--json', '--url', url]);
  const parsed = JSON.parse(deny.stdout) as { approval?: ApprovalLike };
  return {
    status: parsed.approval?.status ?? 'unknown',
    pendingAfterDeny: (await listApprovals(url, false)).length,
    runsCreatedAfterDeny: (await countRuns(url)) - runsBeforeDeny,
    denyMs: deny.ms
  };
}

function publicArm(run: ArmRun, deny?: DenyOutcome): PublicArm {
  const result: PublicArm = {
    arm: run.arm,
    daemonMs: run.daemonMs,
    armMs: run.armMs,
    events: run.events,
    approvalIdPresent: run.approvalId !== null,
    runsCreated: run.runsCreated,
    newAsks: run.newAsks,
    pendingAsks: run.pendingAsks,
    pendingTools: run.pendingTools,
    clipboardAfterPreview: redact(run.clipboardAfter.slice(0, 400))
  };
  if (deny) {
    result.denyStatus = deny.status;
    result.denyMs = deny.denyMs;
    result.runsCreatedAfterDeny = deny.runsCreatedAfterDeny;
  }
  return result;
}

function addCheck(checks: CheckResult[], arm: string, check: string, expected: unknown, actual: unknown, pass?: boolean): void {
  checks.push({ arm, check, expected, actual, pass: pass ?? expected === actual });
}

async function runDemo(args: DemoArgs, startedAt: string): Promise<DemoResults> {
  const url = await startControlApp();
  controlUrl = url;
  note('Conduit Control listening on an ephemeral loopback port; state is fully isolated.');

  const sessionRun = await runCli([
    'session', 'create',
    '--label', 'Consent demo',
    '--profile', 'read-only',
    '--root', path.join(REPO_ROOT, 'fixtures', 'fake-project')
  ]);
  const trustedEnvelope = parseStarterEnvelope(sessionRun.stdout);
  secret(trustedEnvelope.sessionId);
  secret(trustedEnvelope.nonce);

  const checks: CheckResult[] = [];
  const trusted = await armRun('trusted', trustedEnvelope, url);
  addCheck(checks, trusted.arm, 'events.executed', 1, trusted.events.executed);
  addCheck(checks, trusted.arm, 'events.requiresReview', 0, trusted.events.requiresReview);
  addCheck(checks, trusted.arm, 'events.rejected', 0, trusted.events.rejected);
  addCheck(checks, trusted.arm, 'newAsks', 0, trusted.newAsks);
  addCheck(checks, trusted.arm, 'pendingAsks', 0, trusted.pendingAsks);
  addCheck(checks, trusted.arm, 'runsCreated', 1, trusted.runsCreated);
  const trustedClipboardHasReadme = trusted.clipboardAfter.includes('README.md');
  addCheck(checks, trusted.arm, 'clipboardListsReadme', 'contains README.md', trustedClipboardHasReadme, trustedClipboardHasReadme);

  const untrustedEnvelope: Record<string, unknown> = { ...trustedEnvelope };
  delete untrustedEnvelope.nonce;
  const untrusted = await armRun('untrusted (nonce missing)', untrustedEnvelope, url);
  const deny: DenyOutcome = untrusted.approvalId
    ? await denyOutcomeOf(untrusted.approvalId, url)
    : { status: 'no-ask-created', pendingAfterDeny: untrusted.pendingAsks, runsCreatedAfterDeny: 0, denyMs: 0 };
  addCheck(checks, untrusted.arm, 'events.executed', 0, untrusted.events.executed);
  addCheck(checks, untrusted.arm, 'events.requiresReview', 1, untrusted.events.requiresReview);
  addCheck(checks, untrusted.arm, 'events.rejected', 0, untrusted.events.rejected);
  addCheck(checks, untrusted.arm, 'newAsks', 1, untrusted.newAsks);
  addCheck(checks, untrusted.arm, 'pendingAsks', 1, untrusted.pendingAsks);
  addCheck(checks, untrusted.arm, 'pendingTools', 'conduit.review', untrusted.pendingTools.join(','));
  addCheck(checks, untrusted.arm, 'runsCreated', 0, untrusted.runsCreated);
  addCheck(checks, untrusted.arm, 'denyStatus', 'denied', deny.status);
  addCheck(checks, untrusted.arm, 'pendingAfterDeny', 0, deny.pendingAfterDeny);
  addCheck(checks, untrusted.arm, 'runsCreatedAfterDeny', 0, deny.runsCreatedAfterDeny);

  const replay = await armRun('replay (consumed nonce)', trustedEnvelope, url);
  addCheck(checks, replay.arm, 'events.executed', 0, replay.events.executed);
  addCheck(checks, replay.arm, 'events.requiresReview', 0, replay.events.requiresReview);
  addCheck(checks, replay.arm, 'events.rejected', 1, replay.events.rejected);
  addCheck(checks, replay.arm, 'newAsks', 0, replay.newAsks);
  addCheck(checks, replay.arm, 'pendingAsks', 0, replay.pendingAsks);
  addCheck(checks, replay.arm, 'runsCreated', 0, replay.runsCreated);

  const pass = checks.every((check) => check.pass);
  // `daemon once` ms is envelope-to-outcome; arm ms adds the five verification CLI calls.
  const summary = [
    `consent-loop: ${pass ? 'PASS' : 'FAIL'}`,
    `trusted: executed ${trusted.events.executed}, asks ${trusted.newAsks}, daemon ${trusted.daemonMs} ms, arm ${trusted.armMs} ms`,
    `untrusted: executed ${untrusted.events.executed}, asks ${untrusted.newAsks} -> ${deny.status}, daemon ${untrusted.daemonMs} ms, arm ${untrusted.armMs} ms`,
    `replay: executed ${replay.events.executed}, asks ${replay.newAsks}, rejected ${replay.events.rejected}, daemon ${replay.daemonMs} ms, arm ${replay.armMs} ms`
  ].join(' | ');
  console.log(summary);

  return {
    schema: 'conduit.demo.consent-loop.v1',
    thesis: THESIS,
    startedAt,
    finishedAt: new Date().toISOString(),
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    cli: 'tsx src/cli/index.ts',
    arms: [
      publicArm(trusted),
      publicArm(untrusted, deny),
      publicArm(replay)
    ],
    checks,
    pass,
    totals: {
      asksTrusted: trusted.newAsks,
      asksUntrusted: untrusted.newAsks,
      executions: trusted.events.executed + untrusted.events.executed + replay.events.executed,
      reviews: trusted.events.requiresReview + untrusted.events.requiresReview + replay.events.requiresReview,
      rejections: trusted.events.rejected + untrusted.events.rejected + replay.events.rejected,
      runsCreated: trusted.runsCreated + untrusted.runsCreated + replay.runsCreated,
      approvalsDenied: deny.status === 'denied' ? 1 : 0
    }
  };
}

interface DemoArgs { jsonOut?: string; keep: boolean; }

function parseArgs(args: string[]): DemoArgs {
  const parsed: DemoArgs = { keep: false };
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--json-out') {
      const value = args[index + 1];
      if (!value) throw new Error('--json-out requires a file path.');
      parsed.jsonOut = path.resolve(value);
      index += 1;
      continue;
    }
    if (args[index] === '--keep') {
      parsed.keep = true;
      continue;
    }
    throw new Error(`Unknown argument: ${String(args[index])} (supported: --json-out <file>, --keep)`);
  }
  return parsed;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const startedAt = new Date().toISOString();
  const root = await mkdtemp(path.join(os.tmpdir(), 'conduit-demo-'));
  const stateDir = path.join(root, 'state');
  const binDir = path.join(root, 'bin');
  clipboardFile = path.join(root, 'clipboard.txt');
  await mkdir(stateDir, { recursive: true });
  await mkdir(binDir, { recursive: true });
  for (const [file, body] of [[path.join(binDir, 'pbpaste'), PBPASTE_SH], [path.join(binDir, 'pbcopy'), PBCOPY_SH]] as const) {
    await writeFile(file, body, 'utf8');
    await chmod(file, 0o755);
  }

  childEnv = { ...process.env };
  childEnv.PATH = `${binDir}${path.delimiter}${process.env.PATH ?? ''}`;
  childEnv.CONDUIT_STATE_DIR = stateDir;
  childEnv.CONDUIT_DEMO_CLIPBOARD = clipboardFile;
  childEnv.CONDUIT_PARENT_PID = String(process.pid); // children outlive the demo never
  delete childEnv.CONDUIT_CONTROL_URL; // never inherit a real Conduit Control

  let results: DemoResults;
  try {
    results = await runDemo(args, startedAt);
  } finally {
    await stopControlApp();
    if (!args.keep) await rm(root, { recursive: true, force: true });
  }

  console.log(JSON.stringify(results, null, 2));
  if (args.jsonOut) {
    await writeFile(args.jsonOut, `${JSON.stringify(results, null, 2)}\n`, 'utf8');
    note(`results written to --json-out file.`);
  }
  process.exitCode = results.pass ? 0 : 1;
}

main().catch((error: unknown) => {
  console.error(`consent-loop: failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
