import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { parseActions } from '../protocol/parse-actions.js';
import { parseFinal } from '../protocol/parse-final.js';
import { parseHandshakeRequest } from '../protocol/parse-handshake-request.js';
import { renderConduitRepair, renderConduitResults, renderProtocolError, renderToolResults } from '../protocol/render-results.js';
import { createRepairEnvelope } from '../protocol/repair.js';
import type { FinalBlock, ToolResult } from '../protocol/schemas.js';
import { consumeSessionNonce, getSession, validateSessionNonce } from '../sessions/session-store.js';
import { getRunDir } from '../state/paths.js';
import { checkExecutionGate } from '../state/pause-state.js';
import { appendJsonl, ensureRunDir, writeTextFile } from '../state/logs.js';
import type { AssistantTurn, ModelTransport } from '../transports/types.js';
import { createRunId } from '../util/ids.js';
import { executeActions } from './execute-actions.js';

export interface ListenInput {
  projectRoot: string;
  transport: ModelTransport;
  yes?: boolean;
  requireTrustedSession?: boolean;
}

export interface ListenSession {
  runId: string;
  runDir: string;
  projectRoot: string;
  turnCount: number;
  actionCount: number;
}

export type ListenTurnStatus = 'actions' | 'final' | 'protocol_error';

export interface ListenTurnResult {
  status: ListenTurnStatus;
  session: ListenSession | null;
}

export async function listenLoop(input: ListenInput): Promise<void> {
  const projectRoot = await realpath(path.resolve(input.projectRoot));
  let session: ListenSession | null = null;

  await input.transport.open();
  await input.transport.ensureReady();
  console.log('[ListenLoop] Persistent listener ready. Press Ctrl+C to stop.');

  const close = async () => {
    await input.transport.close();
  };
  process.once('SIGINT', () => {
    console.log('\n[ListenLoop] Stopping listener...');
    close().finally(() => process.exit(0));
  });

  try {
    while (true) {
      const assistantTurn = await input.transport.waitForAssistantTurn({ timeoutMs: 0 });
      try {
        const result = await processListenTurn({
          assistantTurn,
          projectRoot,
          transport: input.transport,
          session,
          yes: input.yes,
          requireTrustedSession: input.requireTrustedSession
        });
        session = result.session;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[ListenLoop] Transport turn failed: ${message}`);
      }
    }
  } finally {
    await input.transport.close();
  }
}

export async function processListenTurn(input: {
  assistantTurn: AssistantTurn;
  projectRoot: string;
  transport: Pick<ModelTransport, 'sendMessage'>;
  session: ListenSession | null;
  yes?: boolean;
  requireTrustedSession?: boolean;
}): Promise<ListenTurnResult> {
  const finalResult = parseFinal(input.assistantTurn.text);
  const actionsResult = parseActions(input.assistantTurn.text);
  const handshakeRequestResult = parseHandshakeRequest(input.assistantTurn.text);

  if (handshakeRequestResult.ok) {
    const session = await ensureSession(input.session, input.projectRoot);
    await logAssistantTurn(session, input.assistantTurn);
    const repair = renderConduitRepair(createRepairEnvelope({
      reason: [
        'Agent-loop handshake requested. Local user approval is required before Conduit creates or exposes a paired session.',
        'Ask the user to choose Copy Agent Handshake from the Conduit menu-bar app or control panel.'
      ].join(' '),
      code: 'request_rejected'
    }));
    await input.transport.sendMessage(repair);
    await logUserMessage(session, repair);
    return { status: 'protocol_error', session };
  }

  if (finalResult.ok && actionsResult.ok) {
    const session = await ensureSession(input.session, input.projectRoot);
    await logAssistantTurn(session, input.assistantTurn);
    const errorMessage = renderProtocolError('You emitted both final and action protocol blocks. Choose exactly one.');
    await input.transport.sendMessage(errorMessage);
    await logUserMessage(session, errorMessage);
    return { status: 'protocol_error', session };
  }

  if (finalResult.ok) {
    const session = await ensureSession(input.session, input.projectRoot);
    await logAssistantTurn(session, input.assistantTurn);
    await writeFinal(session, finalResult.block);
    console.log(`[ListenLoop] Session ${session.runId} complete. Listener remains active.`);
    return { status: 'final', session: null };
  }

  if (actionsResult.ok) {
    // Pause gate before the nonce is consumed, so the agent can resend the
    // same request after resume. executeActions gates again per action.
    const gate = await checkExecutionGate();
    if (!gate.ok) {
      const session = await ensureSession(input.session, input.projectRoot);
      await logAssistantTurn(session, input.assistantTurn);
      const repair = renderConduitRepair(createRepairEnvelope({
        reason: gate.reason,
        code: 'paused',
        request: actionsResult.block,
        ...(actionsResult.block.sessionId ? { sessionId: actionsResult.block.sessionId } : {})
      }));
      await input.transport.sendMessage(repair);
      await logUserMessage(session, repair);
      return { status: 'protocol_error', session };
    }

    const trusted = input.requireTrustedSession
      ? await validateAndConsumeAgentRequest(actionsResult.block)
      : null;
    if (input.requireTrustedSession && !trusted?.ok) {
      const session = await ensureSession(input.session, input.projectRoot);
      await logAssistantTurn(session, input.assistantTurn);
      const repair = renderConduitRepair(trusted!.repair);
      await input.transport.sendMessage(repair);
      await logUserMessage(session, repair);
      return { status: 'protocol_error', session };
    }

    const sessionProjectRoot = trusted?.ok
      ? await realpath(path.resolve(trusted.session.allowedRoots[0]))
      : input.projectRoot;
    const session = await ensureSession(input.session, sessionProjectRoot);
    await logAssistantTurn(session, input.assistantTurn);
    const results = await executeActions({
      actions: actionsResult.block.actions,
      projectRoot: session.projectRoot,
      runId: session.runId,
      runDir: session.runDir,
      turn: session.turnCount + 1,
      yes: input.yes,
      ...(trusted?.ok ? { policySession: trusted.session } : {})
    });
    session.turnCount += 1;
    session.actionCount += actionsResult.block.actions.length;
    const renderedResults = trusted?.ok
      ? renderConduitResults({
        type: 'conduit.results.v1',
        runId: session.runId,
        sessionId: trusted.session.sessionId,
        nextNonce: trusted.session.currentNonce,
        results,
        status: summarizeResults(results)
      })
      : renderToolResults(results);
    await input.transport.sendMessage(renderedResults);
    await logUserMessage(session, renderedResults);
    return { status: 'actions', session };
  }

  const session = await ensureSession(input.session, input.projectRoot);
  await logAssistantTurn(session, input.assistantTurn);
  const errorMessage = renderProtocolError('No valid conduit request block or conduit-final block was found.');
  await input.transport.sendMessage(errorMessage);
  await logUserMessage(session, errorMessage);
  return { status: 'protocol_error', session };
}

async function validateAndConsumeAgentRequest(request: {
  sessionId?: string;
  nonce?: string;
}): Promise<
  | { ok: true; session: Awaited<ReturnType<typeof consumeSessionNonce>> }
  | { ok: false; repair: ReturnType<typeof createRepairEnvelope> }
> {
  if (!request.sessionId || !request.nonce) {
    return {
      ok: false,
      repair: createRepairEnvelope({
        reason: 'Agent-loop execution requires sessionId and nonce.',
        code: 'missing_session',
        request
      })
    };
  }

  const validation = await validateSessionNonce(request.sessionId, request.nonce);
  if (!validation.ok) {
    const session = await getSession(request.sessionId);
    return {
      ok: false,
      repair: createRepairEnvelope({
        reason: validation.sessionState === 'paused'
          ? `Session ${request.sessionId} is paused. Nothing runs for it until it is resumed.`
          : validation.reason,
        code: validation.sessionState === 'paused' ? 'paused' : 'invalid_session',
        request,
        sessionId: request.sessionId,
        ...(session?.state === 'active' ? { currentNonce: session.currentNonce } : {})
      })
    };
  }

  if (validation.session.transport !== 'extension' && validation.session.transport !== 'browser-yolo') {
    return {
      ok: false,
      repair: createRepairEnvelope({
        reason: `Session transport ${validation.session.transport} is not allowed for extension agent-loop execution.`,
        code: 'invalid_session',
        request,
        sessionId: request.sessionId
      })
    };
  }

  return {
    ok: true,
    session: await consumeSessionNonce(request.sessionId, request.nonce)
  };
}

async function ensureSession(session: ListenSession | null, projectRoot: string): Promise<ListenSession> {
  if (session) return session;

  const runId = createRunId();
  const runDir = getRunDir(runId);
  const nextSession: ListenSession = {
    runId,
    runDir,
    projectRoot,
    turnCount: 0,
    actionCount: 0
  };

  await ensureRunDir(runDir);
  await writeTextFile(runDir, 'task.md', [
    '# Persistent Listener Session',
    '',
    'This session was created from an extension `conduit-call` while Conduit was listening.'
  ].join('\n'));
  await writeTextFile(runDir, 'metadata.json', JSON.stringify({
    runId,
    projectRoot,
    mode: 'listen',
    startedAt: new Date().toISOString()
  }, null, 2));
  console.log(`[ListenLoop] Started session ${runId}`);
  return nextSession;
}

async function logAssistantTurn(session: ListenSession, assistantTurn: AssistantTurn): Promise<void> {
  await appendJsonl(session.runDir, 'transcript.jsonl', {
    role: 'assistant',
    text: assistantTurn.text,
    timestamp: assistantTurn.timestamp
  });
}

async function logUserMessage(session: ListenSession, text: string): Promise<void> {
  await appendJsonl(session.runDir, 'transcript.jsonl', {
    role: 'user',
    text,
    timestamp: new Date().toISOString()
  });
}

async function writeFinal(session: ListenSession, final: FinalBlock): Promise<void> {
  await writeTextFile(session.runDir, 'final.json', JSON.stringify(final, null, 2));
  await writeTextFile(session.runDir, 'final.md', final.summary);
}

function summarizeResults(results: ToolResult[]): 'ok' | 'partial' | 'denied' | 'error' {
  if (results.every((result) => result.status === 'ok')) {
    return 'ok';
  }
  if (results.every((result) => result.status === 'denied' || result.status === 'requires_confirmation')) {
    return 'denied';
  }
  if (results.some((result) => result.status === 'error')) {
    return 'error';
  }
  return 'partial';
}
