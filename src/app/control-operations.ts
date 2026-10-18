import { listApprovalRequests } from '../approvals/approval-store.js';
import { listSessions, revokeAllLiveSessions, type ConduitSession } from '../sessions/session-store.js';
import { clearGlobalPause, getPauseState, setGlobalPause, type PauseState } from '../state/pause-state.js';

/**
 * Pause / resume / stop-all operations (spec S1). These are the bodies of the
 * Conduit Control endpoints `GET /api/control` and
 * `POST /api/control/{pause,resume,stop-all}`. The CLI reaches them over HTTP
 * (`conduit status|pause|resume|stop-all`); `--local` runs these same functions
 * in-process for when Control is not running, so a kill switch never depends
 * on the panel being up. There is no second implementation.
 */
export interface ControlStatus {
  paused: boolean;
  pause: PauseState;
  liveSessions: number;
  pausedSessions: Array<Pick<ConduitSession, 'sessionId' | 'label'>>;
  pendingApprovals: number;
}

export async function getControlStatus(): Promise<ControlStatus> {
  const [pause, sessions, approvals] = await Promise.all([
    getPauseState(),
    listSessions(),
    listApprovalRequests()
  ]);
  return {
    paused: pause.paused,
    pause,
    liveSessions: sessions.filter((session) => session.state === 'active').length,
    pausedSessions: sessions
      .filter((session) => session.state === 'paused')
      .map((session) => ({ sessionId: session.sessionId, label: session.label })),
    pendingApprovals: approvals.filter((approval) => approval.status === 'pending').length
  };
}

export async function pauseAll(input: { by: string; reason?: string }): Promise<ControlStatus> {
  await setGlobalPause(input);
  return getControlStatus();
}

export async function resumeAll(input: { by: string }): Promise<ControlStatus> {
  await clearGlobalPause(input);
  return getControlStatus();
}

/**
 * Kill: pause, then revoke every live session. Stopping the supervised child
 * processes belongs to the menu-bar supervisor (existing confirmed-quit tree
 * kill); this endpoint is the API half it calls first.
 */
export async function stopAll(input: { by: string; reason?: string }): Promise<{
  control: ControlStatus;
  revokedSessions: string[];
}> {
  await setGlobalPause({ by: input.by, reason: input.reason ?? 'Stopped all sessions.' });
  const revoked = await revokeAllLiveSessions();
  return {
    control: await getControlStatus(),
    revokedSessions: revoked.map((session) => session.sessionId)
  };
}
