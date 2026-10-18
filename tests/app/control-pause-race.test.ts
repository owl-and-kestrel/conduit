import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startControlPanel, type ControlPanelHandle } from '../../src/app/control-panel.js';
import { createApprovalRequest, getApprovalRequest } from '../../src/approvals/approval-store.js';
import type { ClipboardIO } from '../../src/daemon/clipboard-io.js';
import { getPauseState } from '../../src/state/pause-state.js';

vi.mock('../../src/daemon/execute-request.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/daemon/execute-request.js')>();
  const { setGlobalPause } = await import('../../src/state/pause-state.js');
  return {
    ...actual,
    executeApprovedReview: async (...args: Parameters<typeof actual.executeApprovedReview>) => {
      await setGlobalPause({ by: 'cli', reason: 'race' });
      return actual.executeApprovedReview(...args);
    }
  };
});

describe('approve racing a pause (N-02)', () => {
  let tempRoot: string;
  let projectRoot: string;
  let app: ControlPanelHandle;
  let clipboard: MemoryClipboard;

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), 'conduit-control-race-'));
    projectRoot = path.join(tempRoot, 'project');
    process.env.CONDUIT_STATE_DIR = path.join(tempRoot, 'state');
    clipboard = new MemoryClipboard();
    await mkdir(projectRoot, { recursive: true });
    await writeFile(path.join(projectRoot, 'README.md'), 'hello control\n', 'utf8');
    app = await startControlPanel({ host: '127.0.0.1', port: 0, clipboard });
  });

  afterEach(async () => {
    await app.close();
    delete process.env.CONDUIT_STATE_DIR;
    await rm(tempRoot, { recursive: true, force: true });
  });

  it('refuses with a clear paused repair, runs nothing and never re-runs', async () => {
    const review = await createApprovalRequest(reviewApproval(projectRoot));

    const response = await fetch(`${app.url}/api/approvals/${review.approvalId}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decidedBy: 'menubar' })
    });
    const body: any = await response.json();

    expect(response.status).toBe(409);
    expect(body.error).toContain('resend the request');
    expect(body.execution).toMatchObject({ status: 'rejected', repair: { code: 'paused' } });
    expect(body.execution.runId).toBeUndefined();
    expect(body.approval).toMatchObject({ status: 'approved', executionStatus: 'failed' });
    expect(body.approval.executionError).toContain('nothing ran');
    expect(clipboard.text).toBe('');
    expect((await getPauseState()).paused).toBe(true);

    const stored = await getApprovalRequest(review.approvalId);
    expect(stored).toMatchObject({ status: 'approved', executionStatus: 'failed' });
    expect(stored?.executionRunId).toBeUndefined();
  });
});

function reviewApproval(projectRoot: string) {
  return {
    action: {
      id: 'review_untrusted_request',
      tool: 'conduit.review',
      args: { actions: [{ id: 'read', tool: 'file.read', args: { path: 'README.md' } }] },
      reason: 'Review.',
      risk: 'high' as const
    },
    policyReason: 'Request is not attached to a trusted session.',
    prompt: 'Review?',
    projectRoot
  };
}

class MemoryClipboard implements ClipboardIO {
  text = '';
  async read(): Promise<string> {
    return this.text;
  }
  async write(text: string): Promise<void> {
    this.text = text;
  }
}
