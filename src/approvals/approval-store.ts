import { mkdir, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import type { ToolAction } from '../protocol/schemas.js';
import { getStateRoot } from '../state/paths.js';
import { writeFileAtomic } from '../state/atomic-write.js';
import { createRunId } from '../util/ids.js';

const APPROVAL_POLL_MS = 500;
export const DEFAULT_APPROVAL_TIMEOUT_MS = 10 * 60 * 1000;

export interface ConfirmationRequest {
  action: ToolAction;
  policyReason: string;
  prompt: string;
  runId?: string;
  runDir?: string;
  projectRoot?: string;
  sessionId?: string;
}

export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired';
export type ApprovalExecutionStatus = 'running' | 'ran' | 'failed';

export interface ApprovalRecord extends ConfirmationRequest {
  approvalId: string;
  status: ApprovalStatus;
  createdAt: string;
  updatedAt: string;
  /**
   * When a still-pending record stops being decidable. Past it, any read
   * expires the record to `expired` with `decidedBy: 'timeout'` (deny). Records
   * written before this field existed fall back to createdAt + the default
   * timeout. See `applyLazyExpiry`.
   */
  expiresAt?: string;
  decidedAt?: string;
  decidedBy?: string;
  decisionReason?: string;
  executionStatus?: ApprovalExecutionStatus;
  executionRunId?: string;
  executionError?: string;
  executionStartedAt?: string;
  executionFinishedAt?: string;
}

export interface StoredApprovalOptions {
  timeoutMs?: number;
}

/** Who can be recorded as deciding an approval through Conduit Control. */
export const APPROVAL_DECIDERS = ['control-app', 'menubar', 'notification', 'cli'] as const;
export type ApprovalDecider = typeof APPROVAL_DECIDERS[number];

export function isApprovalDecider(value: unknown): value is ApprovalDecider {
  return typeof value === 'string' && (APPROVAL_DECIDERS as readonly string[]).includes(value);
}

export async function requestStoredApproval(
  request: ConfirmationRequest,
  options: StoredApprovalOptions = {}
): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;
  const record = await createApprovalRequest(request, { timeoutMs });
  const decided = await waitForApprovalDecision(record.approvalId, timeoutMs);
  return decided.status === 'approved';
}

export async function createApprovalRequest(
  request: ConfirmationRequest,
  options: StoredApprovalOptions = {}
): Promise<ApprovalRecord> {
  await ensureApprovalsDir();
  const created = new Date();
  const now = created.toISOString();
  const record: ApprovalRecord = {
    ...request,
    approvalId: `approval_${createRunId()}`,
    status: 'pending',
    createdAt: now,
    updatedAt: now,
    expiresAt: new Date(created.getTime() + (options.timeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS)).toISOString()
  };
  await writeApprovalRecord(record);
  return record;
}

export async function listApprovalRequests(): Promise<ApprovalRecord[]> {
  await ensureApprovalsDir();
  const names = await readdir(getApprovalsDir()).catch(() => []);
  const records = await Promise.all(names
    .filter((name) => name.endsWith('.json'))
    .map((name) => loadApprovalRecord(path.basename(name, '.json'))));
  return records
    .filter((record): record is ApprovalRecord => record !== null)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function getApprovalRequest(approvalId: string): Promise<ApprovalRecord | null> {
  return loadApprovalRecord(approvalId);
}

export async function resolveApprovalRequest(
  approvalId: string,
  status: 'approved' | 'denied',
  decisionReason?: string,
  decidedBy?: string
): Promise<ApprovalRecord> {
  // Lazy expiry runs first, so a stale ask can never be approved late.
  const record = await loadApprovalRecord(approvalId);
  if (!record) {
    throw new Error(`Unknown approval request: ${approvalId}`);
  }
  if (record.status !== 'pending') {
    return record;
  }

  const now = new Date().toISOString();
  const updated: ApprovalRecord = {
    ...record,
    status,
    updatedAt: now,
    decidedAt: now,
    ...(decidedBy ? { decidedBy } : {}),
    ...(decisionReason ? { decisionReason } : {})
  };
  await writeApprovalRecord(updated);
  return updated;
}

export async function markApprovalExecutionRunning(approvalId: string): Promise<ApprovalRecord> {
  const record = await readApprovalRecord(approvalId);
  if (!record) {
    throw new Error(`Unknown approval request: ${approvalId}`);
  }
  if (record.executionStatus) {
    return record;
  }
  const now = new Date().toISOString();
  const updated: ApprovalRecord = {
    ...record,
    executionStatus: 'running',
    executionStartedAt: now,
    updatedAt: now
  };
  await writeApprovalRecord(updated);
  return updated;
}

export async function markApprovalExecutionFinished(
  approvalId: string,
  result: { status: 'ran'; runId: string } | { status: 'failed'; error: string }
): Promise<ApprovalRecord> {
  const record = await readApprovalRecord(approvalId);
  if (!record) {
    throw new Error(`Unknown approval request: ${approvalId}`);
  }
  const now = new Date().toISOString();
  const updated: ApprovalRecord = {
    ...record,
    executionStatus: result.status,
    ...(result.status === 'ran' ? { executionRunId: result.runId } : { executionError: result.error }),
    executionFinishedAt: now,
    updatedAt: now
  };
  await writeApprovalRecord(updated);
  return updated;
}

export async function waitForApprovalDecision(
  approvalId: string,
  timeoutMs: number = DEFAULT_APPROVAL_TIMEOUT_MS
): Promise<ApprovalRecord> {
  const startedAt = Date.now();
  while (true) {
    const record = await loadApprovalRecord(approvalId);
    if (!record) {
      throw new Error(`Unknown approval request: ${approvalId}`);
    }
    if (record.status !== 'pending') {
      return record;
    }
    if (Date.now() - startedAt >= timeoutMs) {
      return expireApprovalRequest(record);
    }
    await delay(APPROVAL_POLL_MS);
  }
}

async function expireApprovalRequest(record: ApprovalRecord): Promise<ApprovalRecord> {
  if (record.status !== 'pending') return record;
  const now = new Date().toISOString();
  const expired: ApprovalRecord = {
    ...record,
    status: 'expired',
    updatedAt: now,
    decidedAt: now,
    decidedBy: 'timeout',
    decisionReason: 'Approval request timed out.'
  };
  await writeApprovalRecord(expired);
  return expired;
}

/**
 * Timeout means deny, applied lazily on read (spec S2 / safety invariant 5).
 * Confirmations have a waiter that expires them; untrusted-request reviews
 * (`conduit.review`) have none, so before this they stayed pending forever and
 * could be approved long after the agent gave up, against a changed workspace.
 * Every read path (list, get, resolve, wait) goes through here; no timer.
 */
export function getApprovalExpiry(record: ApprovalRecord): number {
  const explicit = record.expiresAt ? Date.parse(record.expiresAt) : Number.NaN;
  if (Number.isFinite(explicit)) return explicit;
  const created = Date.parse(record.createdAt);
  // An unparseable createdAt is treated as already stale (fail closed).
  return Number.isFinite(created) ? created + DEFAULT_APPROVAL_TIMEOUT_MS : 0;
}

async function loadApprovalRecord(approvalId: string, now: number = Date.now()): Promise<ApprovalRecord | null> {
  const record = await readApprovalRecord(approvalId);
  if (!record) return null;
  if (record.status === 'pending' && getApprovalExpiry(record) <= now) {
    return expireApprovalRequest(record);
  }
  return record;
}

const APPROVAL_ID_PATTERN = /^approval_[A-Za-z0-9_-]+$/;

async function readApprovalRecord(approvalId: string): Promise<ApprovalRecord | null> {
  // Ids arrive from URLs and the CLI; never let one name a file outside approvals/.
  if (!APPROVAL_ID_PATTERN.test(approvalId)) return null;
  try {
    const text = await readFile(getApprovalPath(approvalId), 'utf8');
    return JSON.parse(text) as ApprovalRecord;
  } catch {
    return null;
  }
}

async function writeApprovalRecord(record: ApprovalRecord): Promise<void> {
  await ensureApprovalsDir();
  // Write-then-rename so a concurrent reader (a waiter, the panel, lazy
  // expiry) never sees a truncated file and mistakes it for an unknown id.
  await writeFileAtomic(getApprovalPath(record.approvalId), `${JSON.stringify(record, null, 2)}\n`);
}

async function ensureApprovalsDir(): Promise<void> {
  await mkdir(getApprovalsDir(), { recursive: true });
}

function getApprovalsDir(): string {
  return path.join(getStateRoot(), 'approvals');
}

function getApprovalPath(approvalId: string): string {
  return path.join(getApprovalsDir(), `${approvalId}.json`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
