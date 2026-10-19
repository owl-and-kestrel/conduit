#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { Command } from 'commander';
import { FakeTransport } from '../transports/fake-transport.js';
import { ClipboardTransport } from '../transports/clipboard-transport.js';
import { ChatGPTPlaywrightTransport } from '../transports/chatgpt-playwright.js';
import { runLoop } from '../runtime/run-loop.js';
import { listenLoop } from '../runtime/listen-loop.js';
import { getStateRoot } from '../state/paths.js';
import { ACTIONS_END, ACTIONS_START, END_TURN, FINAL_END, FINAL_START } from '../protocol/delimiters.js';
import { runAuthDoctor } from './auth-doctor.js';
import { exec } from 'node:child_process';
import { createSession, listSessions, pauseSession, resumeSession, revokeSession } from '../sessions/session-store.js';
import { isPermissionProfileName } from '../sessions/profiles.js';
import { runClipboardDaemon } from '../daemon/daemon.js';
import { startControlPanel } from '../app/control-panel.js';
import { startParentWatchdogFromEnv } from './parent-watchdog.js';
import { getControlStatus, pauseAll, resumeAll, stopAll } from '../app/control-operations.js';
import {
  CLI_ACTOR,
  ControlApiError,
  ControlClient,
  formatApprovalDetail,
  formatApprovalLine,
  formatControlStatus,
  formatRunLine,
  formatServiceLine
} from './control-client.js';

const program = new Command();
startParentWatchdogFromEnv();

program
  .name('conduit')
  .description('Local harness for browser-mediated ChatGPT agent loops.')
  .version('0.0.1');

program.command('doctor')
  .description('Check the local Conduit runtime environment.')
  .action(() => {
    console.log('Conduit doctor');
    console.log(`node: ${process.version}`);
    console.log(`cwd: ${process.cwd()}`);
    console.log(`state: ${getStateRoot()}`);
    console.log(`package.json: ${existsSync(path.resolve('package.json')) ? 'found' : 'missing'}`);
    console.log('transport.fake: available');
    console.log('transport.clipboard: available');
    console.log('transport.chatgpt: available');
  });

program.command('auth:doctor')
  .description('Diagnose browser transport state.')
  .action(async () => {
    await runAuthDoctor();
  });

const sessionCommand = program.command('session')
  .description('Manage local Conduit sessions.');

sessionCommand.command('create')
  .description('Create a trusted local session.')
  .requiredOption('--label <text>', 'human-readable session label')
  .requiredOption('--root <path...>', 'allowed project root; repeat values after --root or pass multiple paths')
  .option('--profile <name>', 'read-only|edit-with-confirmation|shell-manual', 'read-only')
  .option('--transport <name>', 'clipboard|extension|browser-yolo|api', 'clipboard')
  .option('--expires-at <iso>', 'optional ISO expiration timestamp')
  .action(async (options: {
    label: string;
    root: string[];
    profile: string;
    transport: 'clipboard' | 'extension' | 'browser-yolo' | 'api';
    expiresAt?: string;
  }) => {
    if (!isPermissionProfileName(options.profile)) {
      throw new Error(`Unknown permission profile: ${options.profile}`);
    }

    const session = await createSession({
      label: options.label,
      permissionProfile: options.profile,
      allowedRoots: options.root,
      transport: options.transport,
      expiresAt: options.expiresAt
    });

    console.log(`Created session ${session.sessionId}`);
    console.log(`Label: ${session.label}`);
    console.log(`Profile: ${session.permissionProfile}`);
    console.log(`Roots: ${session.allowedRoots.join(', ')}`);
    console.log('');
    console.log('Starter request block:');
    console.log('```conduit');
    console.log(JSON.stringify({
      schema: 'conduit.request.v1',
      source: {
        kind: 'clipboard',
        trust: 'untrusted'
      },
      permissions: [
        {
          kind: 'filesystem',
          scope: 'project',
          access: 'read'
        }
      ],
      sessionId: session.sessionId,
      nonce: session.currentNonce,
      list: '.',
      reason: 'List the project root.',
      risk: 'low'
    }, null, 2));
    console.log('```');
  });

sessionCommand.command('list')
  .description('List local sessions.')
  .action(async () => {
    const sessions = await listSessions();
    if (sessions.length === 0) {
      console.log('No sessions.');
      return;
    }

    for (const session of sessions) {
      console.log([
        `${session.sessionId}  ${session.state}  ${session.permissionProfile}  ${session.label}`,
        `  transport: ${session.transport}`,
        `  roots: ${session.allowedRoots.join(', ')}`,
        `  currentNonce: ${session.currentNonce}`,
        `  createdAt: ${session.createdAt}${session.expiresAt ? `  expiresAt: ${session.expiresAt}` : ''}`
      ].join('\n'));
    }
  });

sessionCommand.command('revoke')
  .description('Revoke a local session.')
  .argument('<sessionId>', 'session id')
  .action(async (sessionId: string) => {
    const session = await revokeSession(sessionId);
    console.log(`Revoked session ${session.sessionId}`);
  });

sessionCommand.command('handshake')
  .description('Create a session through Conduit Control and print the agent handshake to paste into a chat (same as Copy Agent Handshake).')
  .option('--label <text>', 'session label', 'Agent handshake')
  .option('--root <path>', 'allowed project root')
  .option('--profile <name>', 'read-only|edit-with-confirmation|shell-manual', 'read-only')
  .option('--transport <name>', 'clipboard|extension|browser-yolo|api', 'extension')
  .option('--copy', 'also copy it to the clipboard through Conduit Control', false)
  .option('--url <url>', 'Conduit Control URL')
  .option('--json', 'print the raw API response', false)
  .action(async (options: {
    label: string;
    root?: string;
    profile: string;
    transport: string;
    copy: boolean;
    url?: string;
    json: boolean;
  }) => {
    const result = await new ControlClient({ url: options.url }).agentHandshake({
      label: options.label,
      root: options.root ?? process.cwd(),
      profile: options.profile,
      transport: options.transport,
      copy: options.copy
    });
    console.log(options.json ? JSON.stringify(result, null, 2) : result.handshake);
  });

// ---- Pause / kill switch (S1) and approvals parity (S2) ---------------------
// Each verb is one call to the Conduit Control API (see control-client.ts).
// --local runs the same control operations in-process, for when Control is
// not running; it is never an automatic fallback.

program.command('status')
  .description('Show whether Conduit is paused, plus live sessions and pending approvals.')
  .option('--url <url>', 'Conduit Control URL (default http://127.0.0.1:47831 or CONDUIT_CONTROL_URL)')
  .option('--local', 'read the state root directly instead of calling Conduit Control', false)
  .option('--json', 'print the raw API response', false)
  .action(async (options: { url?: string; local: boolean; json: boolean }) => {
    const control = options.local
      ? await getControlStatus()
      : (await new ControlClient({ url: options.url }).status()).control;
    console.log(options.json ? JSON.stringify({ control }, null, 2) : formatControlStatus(control));
  });

program.command('pause')
  .description('Pause Conduit: nothing runs (including trusted auto-runs) until resumed. With --session, pause one session.')
  .option('--session <id>', 'pause only this session')
  .option('--reason <text>', 'why Conduit is paused (shown in status)')
  .option('--url <url>', 'Conduit Control URL')
  .option('--local', 'write the state root directly instead of calling Conduit Control', false)
  .option('--json', 'print the raw API response', false)
  .action(async (options: { session?: string; reason?: string; url?: string; local: boolean; json: boolean }) => {
    if (options.session) {
      const result = options.local
        ? { session: await pauseSession(options.session) }
        : await new ControlClient({ url: options.url }).pause({ sessionId: options.session });
      console.log(options.json ? JSON.stringify(result, null, 2) : `Paused session ${result.session.sessionId}.`);
      return;
    }
    const control = options.local
      ? await pauseAll({ by: CLI_ACTOR, reason: options.reason })
      : (await new ControlClient({ url: options.url }).pause({ reason: options.reason })).control;
    console.log(options.json ? JSON.stringify({ control }, null, 2) : formatControlStatus(control));
  });

program.command('resume')
  .description('Resume Conduit after a pause. With --session, resume one paused session.')
  .option('--session <id>', 'resume only this session')
  .option('--url <url>', 'Conduit Control URL')
  .option('--local', 'write the state root directly instead of calling Conduit Control', false)
  .option('--json', 'print the raw API response', false)
  .action(async (options: { session?: string; url?: string; local: boolean; json: boolean }) => {
    if (options.session) {
      const result = options.local
        ? { session: await resumeSession(options.session) }
        : await new ControlClient({ url: options.url }).resume({ sessionId: options.session });
      console.log(options.json ? JSON.stringify(result, null, 2) : `Resumed session ${result.session.sessionId}.`);
      return;
    }
    const control = options.local
      ? await resumeAll({ by: CLI_ACTOR })
      : (await new ControlClient({ url: options.url }).resume()).control;
    console.log(options.json ? JSON.stringify({ control }, null, 2) : formatControlStatus(control));
  });

program.command('stop-all')
  .description('Kill switch: pause Conduit and revoke every live session.')
  .option('--reason <text>', 'why everything was stopped')
  .option('--url <url>', 'Conduit Control URL')
  .option('--local', 'write the state root directly instead of calling Conduit Control', false)
  .option('--json', 'print the raw API response', false)
  .action(async (options: { reason?: string; url?: string; local: boolean; json: boolean }) => {
    const result = options.local
      ? await stopAll({ by: CLI_ACTOR, reason: options.reason })
      : await new ControlClient({ url: options.url }).stopAll({ reason: options.reason });
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(formatControlStatus(result.control));
    console.log(`Revoked sessions: ${result.revokedSessions.length > 0 ? result.revokedSessions.join(', ') : 'none'}`);
  });

program.command('diagnostics')
  .description('Print the redacted diagnostic bundle (the same preview as Report Bug).')
  .option('--url <url>', 'Conduit Control URL')
  .action(async (options: { url?: string }) => {
    console.log(JSON.stringify((await new ControlClient({ url: options.url }).diagnostics()).bundle, null, 2));
  });

const urlCommand = program.command('url').description('Submit conduit:// links to Conduit Control.');

urlCommand.command('open')
  .description('Submit a conduit:// link to Conduit Control. It is handled exactly like the menu bar does: untrusted requests become a review, nothing runs unapproved.')
  .argument('<conduitUrl>', 'conduit:// link')
  .option('--url <url>', 'Conduit Control URL')
  .option('--json', 'print the raw API response', false)
  .action(async (conduitUrl: string, options: { url?: string; json: boolean }) => {
    const result = await new ControlClient({ url: options.url }).openConduitUrl(conduitUrl);
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(`Execution: ${result.execution?.status ?? 'unknown'}${result.execution?.runId ? ` (run ${result.execution.runId})` : ''}`);
    if (result.execution?.reason) console.log(`Reason: ${result.execution.reason}`);
  });

const approvalsCommand = program.command('approvals')
  .description('List and decide pending Conduit approvals (same API as the panel and menu bar).');

approvalsCommand.command('list')
  .description('List approvals, newest first. Pending only unless --all.')
  .option('--all', 'include decided and expired approvals', false)
  .option('--url <url>', 'Conduit Control URL')
  .option('--json', 'print the raw API response', false)
  .action(async (options: { all: boolean; url?: string; json: boolean }) => {
    const result = await new ControlClient({ url: options.url }).listApprovals();
    const approvals = (result.approvals as any[]).filter((approval) => options.all || approval.status === 'pending');
    if (options.json) {
      console.log(JSON.stringify({ approvals }, null, 2));
      return;
    }
    console.log(approvals.length === 0
      ? (options.all ? 'No approvals.' : 'No pending approvals.')
      : approvals.map(formatApprovalLine).join('\n'));
  });

approvalsCommand.command('show')
  .description('Show one approval with its full arguments.')
  .argument('<approvalId>', 'approval id')
  .option('--url <url>', 'Conduit Control URL')
  .option('--json', 'print the raw API response', false)
  .action(async (approvalId: string, options: { url?: string; json: boolean }) => {
    const result = await new ControlClient({ url: options.url }).showApproval(approvalId);
    console.log(options.json ? JSON.stringify(result, null, 2) : formatApprovalDetail(result.approval));
  });

for (const decision of ['approve', 'deny'] as const) {
  const command = approvalsCommand.command(decision)
    .description(decision === 'approve'
      ? 'Approve a pending approval. An untrusted review runs once, read-only, like Approve once in the panel.'
      : 'Deny a pending approval.')
    .argument('<approvalId>', 'approval id')
    .option('--reason <text>', 'decision reason recorded on the approval');
  if (decision === 'approve') {
    command.option('--for-this-chat', 'Allow for this chat: the same exact shell command or file write in this chat runs without asking again. Ends when the chat is revoked or Conduit restarts.', false);
  }
  command
    .option('--url <url>', 'Conduit Control URL')
    .option('--json', 'print the raw API response', false)
    .action(async (approvalId: string, options: { reason?: string; forThisChat?: boolean; url?: string; json: boolean }) => {
      const result = await new ControlClient({ url: options.url })
        .decideApproval(approvalId, decision, options.reason, { forThisChat: options.forThisChat === true });
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      console.log(formatApprovalLine(result.approval));
      if (result.execution) {
        console.log(`Execution: ${result.execution.status}${result.execution.runId ? ` (run ${result.execution.runId})` : ''}`);
        if (result.copiedToClipboard) console.log('Result copied to the clipboard.');
        else if (result.execution.rendered) console.log(result.execution.rendered);
      }
    });
}

const settingsCommand = program.command('settings')
  .description('Show or change Conduit settings (same API as the panel and the menu-bar Settings window).');

settingsCommand.command('show')
  .description('Show the current settings.')
  .option('--url <url>', 'Conduit Control URL')
  .option('--json', 'print the raw API response', false)
  .action(async (options: { url?: string; json: boolean }) => {
    const result = await new ControlClient({ url: options.url }).settings();
    console.log(options.json ? JSON.stringify(result, null, 2) : formatSettings(result.settings));
  });

settingsCommand.command('set')
  .description('Change settings. Only the options you pass change.')
  .option('--return-approves-shell-without-details <on|off>', 'Return approves shell commands without opening details (default off: Return opens the details first)')
  .option('--url <url>', 'Conduit Control URL')
  .option('--json', 'print the raw API response', false)
  .action(async (options: { returnApprovesShellWithoutDetails?: string; url?: string; json: boolean }) => {
    const update: Record<string, boolean> = {};
    if (options.returnApprovesShellWithoutDetails !== undefined) {
      update.returnApprovesShellWithoutDetails = parseOnOff(options.returnApprovesShellWithoutDetails, '--return-approves-shell-without-details');
    }
    if (Object.keys(update).length === 0) {
      throw new Error('Nothing to change. Pass --return-approves-shell-without-details on|off.');
    }
    const result = await new ControlClient({ url: options.url }).updateSettings(update);
    console.log(options.json ? JSON.stringify(result, null, 2) : formatSettings(result.settings));
  });

function parseOnOff(value: string, flag: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (['on', 'true', 'yes', '1'].includes(normalized)) return true;
  if (['off', 'false', 'no', '0'].includes(normalized)) return false;
  throw new Error(`${flag} takes on or off, got: ${value}`);
}

function formatSettings(settings: any): string {
  return `Return approves shell commands without opening details: ${settings?.returnApprovesShellWithoutDetails ? 'on' : 'off'}`;
}

const runsCommand = program.command('runs')
  .description('Inspect Conduit runs.');

runsCommand.command('list')
  .description('List recent runs (last 50), newest first.')
  .option('--url <url>', 'Conduit Control URL')
  .option('--json', 'print the raw API response', false)
  .action(async (options: { url?: string; json: boolean }) => {
    const result = await new ControlClient({ url: options.url }).listRuns();
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    const runs = result.runs as any[];
    console.log(runs.length === 0 ? 'No runs.' : runs.map(formatRunLine).join('\n'));
  });

runsCommand.command('result')
  .description('Print the stored result text of one run.')
  .argument('<runId>', 'run id')
  .option('--url <url>', 'Conduit Control URL')
  .option('--json', 'print the raw API response', false)
  .action(async (runId: string, options: { url?: string; json: boolean }) => {
    const result = await new ControlClient({ url: options.url }).runResult(runId);
    console.log(options.json ? JSON.stringify(result, null, 2) : (result.result || '(no result text)'));
  });

const servicesCommand = program.command('services')
  .description('Demo profile only: list or stop programs started by service.start (same API as the panel and menu bar).');

// A 404 "Not found" from either services verb means Control is running without
// the demo switch: say so plainly instead of a bare error.
function reportDemoServicesError(error: unknown): boolean {
  return error instanceof ControlApiError
    && error.status === 404
    && error.message === 'Not found';
}

servicesCommand.command('list')
  .description('List services started by service.start in this Control process.')
  .option('--url <url>', 'Conduit Control URL')
  .option('--json', 'print the raw API response', false)
  .action(async (options: { url?: string; json: boolean }) => {
    try {
      const result = await new ControlClient({ url: options.url }).listServices();
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      const services = result.services as any[];
      console.log(services.length === 0 ? 'No services.' : services.map(formatServiceLine).join('\n'));
    } catch (error) {
      if (reportDemoServicesError(error)) {
        console.error('Conduit Control is not running with the demo profile (CONDUIT_DEMO_PROFILE=1), so it has no services.');
        process.exitCode = 1;
        return;
      }
      throw error;
    }
  });

servicesCommand.command('stop')
  .description('Stop one service the person started through service.start.')
  .argument('<serviceId>', 'service id')
  .option('--url <url>', 'Conduit Control URL')
  .option('--json', 'print the raw API response', false)
  .action(async (serviceId: string, options: { url?: string; json: boolean }) => {
    try {
      const result = await new ControlClient({ url: options.url }).stopService(serviceId);
      console.log(options.json ? JSON.stringify(result, null, 2) : formatServiceLine(result.service));
    } catch (error) {
      if (reportDemoServicesError(error)) {
        console.error('Conduit Control is not running with the demo profile (CONDUIT_DEMO_PROFILE=1), so it has no services.');
        process.exitCode = 1;
        return;
      }
      throw error;
    }
  });

program.command('login:system')
  .description('Open ChatGPT in the default system browser.')
  .action(() => {
    console.log('Opening ChatGPT in system browser...');
    const isMac = process.platform === 'darwin';
    if (isMac) {
      exec('open https://chatgpt.com/');
    } else {
      console.log('Only macOS system open is currently supported. Please open https://chatgpt.com/ manually.');
    }
  });

program.command('login')
  .description('Launch bundled Chromium to log in to ChatGPT.')
  .action(async () => {
    await runLoginLoop();
  });

program.command('login:chrome')
  .description('Launch installed Chrome channel to log in to ChatGPT.')
  .action(async () => {
    await runLoginLoop('chrome');
  });

program.command('login:chromium')
  .description('Alias for login (bundled Chromium).')
  .action(async () => {
    await runLoginLoop();
  });

async function runLoginLoop(channel?: string) {
  console.log(`Launching ${channel || 'bundled Chromium'}. Please log in...`);
  const profileDir = channel === 'chrome' ? 'chatgpt-chrome' : 'chatgpt';
  const os = await import('node:os');
  const profilePath = path.join(os.homedir(), '.conduit', 'browser-profiles', profileDir);
  
  const { chromium } = await import('playwright');
  const context = await chromium.launchPersistentContext(profilePath, {
    headless: false,
    channel,
    viewport: { width: 1280, height: 800 }
  });
  
  const page = context.pages()[0] || await context.newPage();
  await page.goto('https://chatgpt.com/');

  // Determine outcome
  const { SELECTORS } = await import('../transports/chatgpt-selectors.js');
  let outcome = 'timeout: unknown login state';
  try {
    await page.waitForSelector(SELECTORS.composer, { timeout: 30000 });
    outcome = 'ChatGPT composer detected. Login likely usable.';
  } catch {
    const url = page.url();
    const text = await page.content();
    if (url.includes('/api/auth/error')) {
      outcome = 'auth challenge or failure (/api/auth/error). Fallback to system browser: `conduit login:system`.';
    } else if (text.includes('Verify you are human')) {
      outcome = 'human verification required. Fallback to system browser: `conduit login:system`.';
    }
  }

  console.log(`\nOutcome: ${outcome}`);
  console.log('You may close the browser window when ready to save the session.');

  await new Promise<void>((resolve) => {
    context.on('close', () => resolve());
  });
  console.log('Browser closed. Login complete.');
}

program.command('run')
  .description('Start a bounded Conduit run.')
  .requiredOption('--project <path>', 'project root')
  .option('--task <text>', 'task text')
  .option('--task-file <file>', 'file containing task text')
  .option('--transport <name>', 'fake|chatgpt|clipboard|extension', 'fake')
  .option('--channel <name>', 'auto|chromium|chrome|msedge', 'auto')
  .option('--max-turns <n>', 'maximum model turns', parseInteger)
  .option('--yes', 'auto-approve all safe actions', false)
  .action(async (options: {
    project: string;
    task?: string;
    taskFile?: string;
    transport: string;
    channel: 'auto' | 'chromium' | 'chrome' | 'msedge';
    maxTurns?: number;
    yes: boolean;
  }) => {
    const task = await loadTask(options.task, options.taskFile);
    let transport;
    if (options.transport === 'fake') {
      transport = new FakeTransport([
        [
          ACTIONS_START,
          JSON.stringify({
            actions: [
              {
                id: 'read_readme',
                tool: 'file.read',
                args: { path: 'README.md' },
                reason: 'Read the fixture file for the tractability spike.',
                risk: 'low'
              }
            ]
          }, null, 2),
          ACTIONS_END,
          END_TURN
        ].join('\n'),
        [
          FINAL_START,
          JSON.stringify({
            status: 'complete',
            summary: 'Fake transport completed the read-only tractability spike.'
          }, null, 2),
          FINAL_END,
          END_TURN
        ].join('\n')
      ]);
    } else if (options.transport === 'clipboard') {
      transport = new ClipboardTransport();
    } else if (options.transport === 'chatgpt') {
      transport = new ChatGPTPlaywrightTransport({ channel: options.channel });
    } else if (options.transport === 'extension') {
      const { ExtensionTransport } = await import('../transports/extension-transport.js');
      transport = new ExtensionTransport();
    } else {
      throw new Error(`Only fake, clipboard, chatgpt, and extension transports are implemented. Requested: ${options.transport}`);
    }

    const output = await runLoop({
      task,
      projectRoot: options.project,
      transport,
      maxTurns: options.maxTurns,
      yes: options.yes
    });

    console.log(`Run ${output.runId} complete.`);
    console.log(`Logs: ${output.runDir}`);
    console.log(output.final.summary);
  });

program.command('listen')
  .description('Keep the extension transport open and handle protocol calls persistently.')
  .requiredOption('--project <path>', 'project root')
  .option('--yes', 'auto-approve all safe actions', false)
  .action(async (options: {
    project: string;
    yes: boolean;
  }) => {
    const { ExtensionTransport } = await import('../transports/extension-transport.js');
    await listenLoop({
      projectRoot: options.project,
      transport: new ExtensionTransport(),
      yes: options.yes,
      requireTrustedSession: true
    });
  });

const daemonCommand = program.command('daemon')
  .description('Run local Conduit daemons.');

daemonCommand.command('once')
  .description('Read the clipboard once, execute an exact Conduit envelope if present, and exit.')
  .option('--yes', 'approve confirmation-required actions', false)
  .action(async (options: { yes: boolean }) => {
    await runClipboardDaemon({ once: true, yes: options.yes });
  });

daemonCommand.command('start')
  .description('Watch the clipboard for exact Conduit envelopes.')
  .option('--interval-ms <n>', 'clipboard polling interval in milliseconds', parseInteger, 1000)
  .option('--yes', 'approve confirmation-required actions', false)
  .action(async (options: { intervalMs: number; yes: boolean }) => {
    await runClipboardDaemon({ intervalMs: options.intervalMs, yes: options.yes });
  });

const appCommand = program.command('app')
  .description('Run the local Conduit control app.');

appCommand.command('status')
  .description('Show the running Conduit Control service status (GET /api/status).')
  .option('--url <url>', 'Conduit Control URL')
  .option('--json', 'print the raw API response', false)
  .action(async (options: { url?: string; json: boolean }) => {
    const status = await new ControlClient({ url: options.url }).appStatus();
    if (options.json) {
      console.log(JSON.stringify(status, null, 2));
      return;
    }
    console.log(`Conduit Control: ${status.status}`);
    console.log(`Mode: ${status.mode}`);
    console.log(`Paused: ${status.paused ? 'yes' : 'no'}`);
    console.log(`State: ${status.stateRoot}`);
    console.log(`Checkout: ${status.identity?.checkoutRoot ?? 'unknown'}`);
  });

appCommand.command('start')
  .description('Start the local control app.')
  .option('--host <host>', 'host to bind', '127.0.0.1')
  .option('--port <n>', 'port to bind', parseInteger, 47831)
  .option('--open', 'open the app in the default browser', false)
  .action(async (options: { host: string; port: number; open: boolean }) => {
    const app = await startControlPanel({
      host: options.host,
      port: options.port,
      open: options.open
    });
    console.log(`Conduit app: ${app.url}`);
    console.log('Press Ctrl+C to stop.');
    await new Promise<void>((resolve) => {
      process.once('SIGINT', () => {
        app.close().finally(() => {
          console.log('\nConduit app stopped.');
          resolve();
        });
      });
    });
  });

async function loadTask(task?: string, taskFile?: string): Promise<string> {
  if (task && taskFile) {
    throw new Error('Use either --task or --task-file, not both.');
  }

  if (task) {
    return task;
  }

  if (taskFile) {
    return readFile(taskFile, 'utf8');
  }

  throw new Error('Missing --task or --task-file.');
}

function openSystemBrowser(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = execFile('open', [url], (error) => {
      if (error) reject(error);
      else resolve();
    });
    child.on('error', reject);
  });
}

function parseInteger(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`Expected integer, got: ${value}`);
  }
  return parsed;
}

await program.parseAsync().catch((error: unknown) => {
  console.error(`conduit: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
