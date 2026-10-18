import os from 'node:os';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { listApprovalRequests, type ApprovalRecord } from '../approvals/approval-store.js';
import { listSessions, type ConduitSession } from '../sessions/session-store.js';
import { getRunsRoot, getStateRoot, isSafeRunId, resolveRunFile, RunPathError } from '../state/paths.js';

export interface DiagnosticBundle {
  schema: 'conduit.diagnostic-bundle.v1';
  generatedAt: string;
  app: {
    version: string;
    channel: string;
  };
  platform: {
    platform: NodeJS.Platform;
    arch: string;
    release: string;
  };
  state: {
    stateRoot: string;
    redaction: {
      excludesClipboardContents: true;
      excludesRequestPayloads: true;
      excludesFileContents: true;
      excludesSessionNonces: true;
      excludesApiKeys: true;
      excludesEnvironmentVariables: true;
    };
  };
  services: Record<string, unknown>;
  sessions: Array<Record<string, unknown>>;
  approvals: Array<Record<string, unknown>>;
  runs: Array<Record<string, unknown>>;
  logs: Array<{
    path: string;
    exists: boolean;
    sizeBytes?: number;
    tail?: string[];
    error?: string;
  }>;
}

export async function createDiagnosticBundle(input: {
  services?: Record<string, unknown>;
  logPaths?: string[];
  channel?: string;
} = {}): Promise<DiagnosticBundle> {
  const packageJson = await readPackageJson();
  const [sessions, approvals, runs, logs] = await Promise.all([
    listSessions().then((items) => items.map(redactSession)),
    listApprovalRequests().then((items) => items.map(redactApproval)),
    listRecentRuns(),
    readLogSummaries(input.logPaths ?? defaultLogPaths())
  ]);

  return {
    schema: 'conduit.diagnostic-bundle.v1',
    generatedAt: new Date().toISOString(),
    app: {
      version: typeof packageJson.version === 'string' ? packageJson.version : 'unknown',
      channel: input.channel ?? process.env.CONDUIT_RELEASE_CHANNEL ?? 'local-preview'
    },
    platform: {
      platform: process.platform,
      arch: process.arch,
      release: os.release()
    },
    state: {
      stateRoot: getStateRoot(),
      redaction: {
        excludesClipboardContents: true,
        excludesRequestPayloads: true,
        excludesFileContents: true,
        excludesSessionNonces: true,
        excludesApiKeys: true,
        excludesEnvironmentVariables: true
      }
    },
    services: input.services ?? {},
    sessions,
    approvals,
    runs,
    logs
  };
}

function redactSession(session: ConduitSession): Record<string, unknown> {
  return {
    sessionId: session.sessionId,
    label: session.label,
    permissionProfile: session.permissionProfile,
    transport: session.transport,
    state: session.state,
    allowedRoots: session.allowedRoots,
    expiresAt: session.expiresAt,
    usedNonceCount: Array.isArray(session.usedNonces) ? session.usedNonces.length : 0,
    hasCurrentNonce: typeof session.currentNonce === 'string'
  };
}

function redactApproval(approval: ApprovalRecord): Record<string, unknown> {
  const action = approval.action;
  return {
    approvalId: approval.approvalId,
    status: approval.status,
    tool: action.tool,
    actionId: action.id,
    risk: action.risk,
    policyReason: approval.policyReason,
    createdAt: approval.createdAt,
    decidedAt: approval.decidedAt,
    decidedBy: approval.decidedBy,
    executionStatus: approval.executionStatus,
    executionRunId: approval.executionRunId,
    executionError: approval.executionError
  };
}

async function listRecentRuns(): Promise<Array<Record<string, unknown>>> {
  let runIds: string[];
  try {
    runIds = await readdir(getRunsRoot());
  } catch {
    return [];
  }

  const runs = await Promise.all(runIds.filter(isSafeRunId).sort().reverse().slice(0, 20).map(async (runId): Promise<Record<string, unknown> | null> => {
    try {
      const metadata = await readRunJson(runId, 'metadata.json');
      const final = await readRunJson(runId, 'final.json');
      return {
        runId,
        mode: metadata?.mode,
        approvalId: metadata?.approvalId,
        projectRoot: metadata?.projectRoot,
        startedAt: metadata?.startedAt,
        status: final?.status ?? 'unknown',
        summary: final?.summary
      };
    } catch (error) {
      // A symlinked run path escaping the runs root is omitted from the list,
      // and the file it points at is never read.
      if (error instanceof RunPathError) return null;
      throw error;
    }
  }));
  return runs.filter((run): run is Record<string, unknown> => run !== null);
}

async function readRunJson(runId: string, fileName: string): Promise<Record<string, unknown> | null> {
  const resolved = await resolveRunFile(runId, fileName);
  if (!resolved) return null;
  try {
    const parsed = JSON.parse(await readFile(resolved, 'utf8')) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function readLogSummaries(logPaths: string[]): Promise<DiagnosticBundle['logs']> {
  return Promise.all(logPaths.map(async (logPath) => {
    try {
      const info = await stat(logPath);
      const text = await readFile(logPath, 'utf8');
      return {
        path: logPath,
        exists: true,
        sizeBytes: info.size,
        tail: sanitizeLogTail(text)
      };
    } catch (error) {
      return {
        path: logPath,
        exists: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }));
}

function sanitizeLogTail(text: string): string[] {
  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(-40)
    .map(redactSecrets);
}

function redactSecrets(value: string): string {
  return value
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, '[REDACTED_GOOGLE_API_KEY]')
    .replace(/(api[_-]?key|token|secret|password|nonce)(["':=\s]+)([^\s"',}]+)/gi, '$1$2[REDACTED]');
}

function defaultLogPaths(): string[] {
  const stateRoot = getStateRoot();
  return [
    path.join(stateRoot, 'control-app.log'),
    path.join(stateRoot, 'clipboard-daemon.log'),
    path.join(stateRoot, 'agent-listener.log')
  ];
}

async function readJsonFile(filePath: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed = JSON.parse(await readFile(filePath, 'utf8')) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function readPackageJson(): Promise<Record<string, unknown>> {
  const packagePath = path.resolve('package.json');
  return await readJsonFile(packagePath) ?? {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
