import { randomBytes, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import {
  CONTROL_PANEL_DEFAULT_PORT,
  EXTENSION_BRIDGE_DEFAULT_PORT,
  isBrowserExtensionOrigin,
  isCrossSiteFetch,
  refuseNonLoopbackHost
} from '../util/loopback-guard.js';
import type { AssistantTurn, ModelTransport, WaitOptions } from './types.js';

const DEFAULT_PORT = EXTENSION_BRIDGE_DEFAULT_PORT;
const SEND_RESULT_TIMEOUT_MS = 300_000;
const SEND_PROGRESS_TIMEOUT_MS = 90_000;
const SEND_RETRY_DELAYS_MS = [5_000, 15_000, 30_000];
const TAB_STATUS_STALE_MS = 30_000;
const BRIDGE_HOST = '127.0.0.1';
export const BRIDGE_TOKEN_HEADER = 'x-conduit-bridge-token';
/** Comma-separated extension origins to accept instead of pairing with the first one. */
export const EXTENSION_ORIGINS_ENV = 'CONDUIT_EXTENSION_ORIGINS';

export interface ExtensionTransportOptions {
  port?: number;
  sendResultTimeoutMs?: number;
  sendProgressTimeoutMs?: number;
  sendRetryDelaysMs?: number[];
  tabStatusStaleMs?: number;
  /**
   * Extension origins allowed to pair, e.g. `chrome-extension://<id>`. Defaults
   * to $CONDUIT_EXTENSION_ORIGINS. When empty, the first extension origin that
   * pairs is pinned for the life of the bridge (unpacked extension IDs depend
   * on the install path, so they cannot be hard-coded).
   */
  allowedExtensionOrigins?: string[];
  /**
   * Origins of the Conduit control panel, which may read /health and request a
   * retry without pairing. Defaults to the panel's loopback origins.
   */
  controlPanelOrigins?: string[];
}

/** What a request is allowed to do after the bridge guard has run. */
type BridgeAccess =
  | { ok: true; paired: boolean; panel: boolean; corsOrigin: string | null }
  | { ok: false; status: 401 | 403; error: string; corsOrigin: string | null };

interface IncomingExtensionPayload {
  payload?: unknown;
  kind?: unknown;
  key?: unknown;
  tabId?: unknown;
  url?: unknown;
  observedAt?: unknown;
}

interface OutboundDelivery {
  transportId: string;
  message: string;
  createdAt: string;
  deliveryAttempts: number;
  markDelivered: () => void;
}

interface ExtensionSendResultPayload {
  transportId?: unknown;
  status?: unknown;
  error?: unknown;
  attempts?: unknown;
  deduped?: unknown;
  messageChars?: unknown;
  tabId?: unknown;
}

interface ExtensionTabStatusPayload {
  tabId?: unknown;
  url?: unknown;
  title?: unknown;
  status?: unknown;
  transportId?: unknown;
  observedAt?: unknown;
}

export class ExtensionTransport implements ModelTransport {
  private server: http.Server | null = null;
  private outboundQueue: OutboundDelivery[] = [];
  private pendingOutboundResponses: http.ServerResponse[] = [];
  private inboundQueue: AssistantTurn[] = [];
  private pendingTurnResolve: ((turn: AssistantTurn) => void) | null = null;
  private pendingTurnReject: ((error: Error) => void) | null = null;
  private seenIncomingKeys = new Set<string>();
  private pendingSendResults = new Map<string, {
    delivery: OutboundDelivery;
    resultTimeout: NodeJS.Timeout;
    progressTimeout: NodeJS.Timeout;
    createdAt: string;
    lastProgressAt: string;
    lastProgressStatus?: string;
  }>();
  private retryingOutbound = new Map<string, {
    delivery: OutboundDelivery;
    timeout: NodeJS.Timeout;
    retryAt: string;
    error: string;
  }>();
  private attentionOutbound = new Map<string, {
    delivery: OutboundDelivery;
    error: string;
    observedAt: string;
  }>();
  private deliveredOutboundCount = 0;
  private receivedInboundCount = 0;
  private outboundCounter = 0;
  private lastOutboundAt: string | null = null;
  private lastSendResult: unknown = null;
  private lastTransportError: unknown = null;
  private tabStatusCount = 0;
  private lastTabStatus: unknown = null;
  /** Per-process pairing secret. The extension learns it from /api/conduit-pair. */
  private readonly bridgeToken = randomBytes(32).toString('base64url');
  private readonly allowedExtensionOrigins: Set<string>;
  private readonly controlPanelOrigins: Set<string>;
  private pairedExtensionOrigin: string | null = null;

  constructor(private readonly options: ExtensionTransportOptions = {}) {
    const configuredOrigins = options.allowedExtensionOrigins ?? parseOriginList(process.env[EXTENSION_ORIGINS_ENV]);
    const invalidOrigins = configuredOrigins.filter((origin) => !isBrowserExtensionOrigin(origin));
    if (invalidOrigins.length > 0) {
      // Say so rather than silently falling back to first-come pairing.
      console.warn(`[ExtensionTransport] Ignoring non-extension origins in ${EXTENSION_ORIGINS_ENV}: ${invalidOrigins.join(', ')}`);
    }
    this.allowedExtensionOrigins = new Set(configuredOrigins.filter(isBrowserExtensionOrigin));
    this.controlPanelOrigins = new Set(options.controlPanelOrigins ?? [
      `http://127.0.0.1:${CONTROL_PANEL_DEFAULT_PORT}`,
      `http://localhost:${CONTROL_PANEL_DEFAULT_PORT}`
    ]);
  }

  async open(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        void this.handleRequest(req, res);
      });

      this.server.once('error', (error) => {
        reject(error);
      });

      // Loopback only: the bridge can feed agent turns into the local runtime.
      this.server.listen(this.options.port ?? DEFAULT_PORT, BRIDGE_HOST, () => {
        console.log('\n--- Extension Transport Started ---');
        console.log(`Listening for browser extension on ${this.getBaseUrl()}`);
        resolve();
      });
    });
  }

  async close(): Promise<void> {
    for (const response of this.pendingOutboundResponses.splice(0)) {
      sendJson(response, 200, { message: null });
    }

    for (const [transportId, pending] of this.pendingSendResults) {
      clearTimeout(pending.resultTimeout);
      clearTimeout(pending.progressTimeout);
      console.warn(`[ExtensionTransport] Extension transport closed before outbound ${transportId} was confirmed.`);
    }
    this.pendingSendResults.clear();
    for (const [, retry] of this.retryingOutbound) {
      clearTimeout(retry.timeout);
    }
    this.retryingOutbound.clear();
    this.attentionOutbound.clear();

    if (this.pendingTurnReject) {
      this.pendingTurnReject(new Error('Extension transport closed.'));
      this.pendingTurnReject = null;
      this.pendingTurnResolve = null;
    }

    return new Promise((resolve) => {
      if (!this.server) {
        resolve();
        return;
      }

      this.server.close(() => {
        console.log('\n--- Extension Transport Stopped ---');
        resolve();
      });
      this.server = null;
    });
  }

  async ensureReady(): Promise<void> {
    console.log(`[ExtensionTransport] Waiting for the extension to poll ${this.getBaseUrl()}...`);
  }

  getBaseUrl(): string {
    return `http://${BRIDGE_HOST}:${this.getListeningPort()}`;
  }

  private getListeningPort(): number {
    const address = this.server?.address();
    return typeof address === 'object' && address ? address.port : (this.options.port ?? DEFAULT_PORT);
  }

  async sendMessage(message: string): Promise<void> {
    const delivery = this.createOutboundDelivery(message);
    console.log(`[ExtensionTransport] outbound ${delivery.transportId} queued chars=${delivery.message.length}`);

    const delivered = new Promise<void>((resolve) => {
      delivery.markDelivered = resolve;
    });
    this.enqueueOutbound(delivery);

    await delivered;
  }

  async waitForAssistantTurn(options?: WaitOptions): Promise<AssistantTurn> {
    console.log('[ExtensionTransport] Waiting for protocol block from extension...');
    const queuedTurn = this.inboundQueue.shift();
    if (queuedTurn) {
      return queuedTurn;
    }

    return new Promise((resolve, reject) => {
      this.pendingTurnResolve = resolve;
      this.pendingTurnReject = reject;

      const timeoutMs = options?.timeoutMs ?? 300_000;
      if (timeoutMs > 0) {
        setTimeout(() => {
          if (this.pendingTurnResolve === resolve) {
            this.pendingTurnResolve = null;
            this.pendingTurnReject = null;
            reject(new Error(`waitForAssistantTurn timed out after ${timeoutMs}ms.`));
          }
        }, timeoutMs);
      }
    });
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const access = this.authorize(req);
    if (access.corsOrigin) {
      setCorsHeaders(res, access.corsOrigin);
    }
    if (!access.ok) {
      sendJson(res, access.status, { error: access.error });
      return;
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === 'POST' && req.url === '/api/conduit-pair') {
      sendJson(res, 200, { token: this.bridgeToken });
      return;
    }

    if (req.method === 'GET' && req.url === '/health') {
      const tabAvailability = this.getTabAvailability();
      sendJson(res, 200, {
        status: 'ok',
        tabAvailability,
        outboundQueued: this.outboundQueue.length,
        inboundQueued: this.inboundQueue.length,
        pendingPolls: this.pendingOutboundResponses.length,
        deliveredOutboundCount: this.deliveredOutboundCount,
        receivedInboundCount: this.receivedInboundCount,
        pendingSendResults: this.pendingSendResults.size,
        pendingSendResultIds: [...this.pendingSendResults.keys()],
        retryingOutbound: this.retryingOutbound.size,
        retryingOutboundIds: [...this.retryingOutbound.keys()],
        retryingOutboundDetails: [...this.retryingOutbound.values()].map((retry) => ({
          transportId: retry.delivery.transportId,
          retryAt: retry.retryAt,
          deliveryAttempts: retry.delivery.deliveryAttempts,
          error: retry.error
        })),
        attentionOutbound: this.attentionOutbound.size,
        attentionOutboundIds: [...this.attentionOutbound.keys()],
        attentionOutboundDetails: [...this.attentionOutbound.values()].map((attention) => ({
          transportId: attention.delivery.transportId,
          deliveryAttempts: attention.delivery.deliveryAttempts,
          error: attention.error,
          observedAt: attention.observedAt
        })),
        tabStatusCount: this.tabStatusCount,
        lastTabStatus: this.lastTabStatus,
        lastOutboundAt: this.lastOutboundAt,
        lastSendResult: this.lastSendResult,
        lastTransportError: this.lastTransportError
      });
      return;
    }

    if (req.url === '/api/conduit-retry') {
      if (!access.paired && !access.panel) {
        sendJson(res, 401, { error: 'Pair with the Conduit bridge first.' });
        return;
      }
    } else if (!access.paired) {
      // Outbound messages, inbound agent turns and send/tab reports belong to
      // the paired extension only.
      sendJson(res, 401, { error: 'Pair with the Conduit bridge first.' });
      return;
    }

    if (req.method === 'GET' && req.url === '/api/conduit-outbound') {
      this.handleOutboundPoll(req, res);
      return;
    }

    if (req.method === 'POST' && req.url === '/api/conduit-call') {
      await this.handleIncomingProtocolBlock(req, res);
      return;
    }

    if (req.method === 'POST' && req.url === '/api/conduit-send-result') {
      const body = await readJsonBody(req).catch(() => null) as ExtensionSendResultPayload | null;
      this.lastSendResult = body;
      console.log('[ExtensionTransport] Send result from extension:', body);
      this.resolveSendResult(body);
      sendJson(res, 200, { status: 'ok' });
      return;
    }

    if (req.method === 'POST' && req.url === '/api/conduit-retry') {
      const body = await readJsonBody(req).catch(() => ({})) as { transportId?: unknown };
      const result = this.retryOutbound(typeof body.transportId === 'string' ? body.transportId : undefined);
      sendJson(res, result.ok ? 200 : 404, result);
      return;
    }

    if (req.method === 'POST' && req.url === '/api/conduit-tab-status') {
      const body = await readJsonBody(req).catch(() => null) as ExtensionTabStatusPayload | null;
      this.lastTabStatus = body;
      this.tabStatusCount += 1;
      console.log('[ExtensionTransport] Tab status from extension:', body);
      this.recordSendProgress(body);
      sendJson(res, 200, { status: 'ok' });
      return;
    }

    sendJson(res, 404, { error: 'Not found' });
  }

  /**
   * Bridge policy. Every request must be addressed to 127.0.0.1/localhost on
   * the bridge's own port (blocks DNS rebinding). Browser requests must come
   * from the paired extension's origin or, for /health and /api/conduit-retry,
   * the Conduit control panel; any other Origin, including every web page, is
   * refused, so their CORS preflights fail too. Extension endpoints also
   * require the pairing token, which only an extension origin can obtain from
   * /api/conduit-pair. Origin-less clients (menu-bar app, curl) may read
   * /health.
   */
  private authorize(req: http.IncomingMessage): BridgeAccess {
    const hostRefusal = refuseNonLoopbackHost(req, { port: this.getListeningPort(), requireHost: true });
    if (hostRefusal) {
      return { ok: false, status: 403, error: hostRefusal, corsOrigin: null };
    }

    const method = (req.method ?? 'GET').toUpperCase();
    const path = req.url ?? '/';
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : null;
    const paired = this.hasValidToken(req);

    if (origin !== null) {
      const isExtension = isBrowserExtensionOrigin(origin);
      const panel = this.controlPanelOrigins.has(origin);
      if (isExtension && this.canPairWith(origin)) {
        if (path === '/api/conduit-pair' && method === 'POST') {
          this.pairedExtensionOrigin ??= origin;
        }
        return { ok: true, paired, panel: false, corsOrigin: origin };
      }
      if (panel && (path === '/health' || path === '/api/conduit-retry')) {
        return { ok: true, paired: false, panel: true, corsOrigin: origin };
      }
      return {
        ok: false,
        status: 403,
        error: isExtension
          ? `The Conduit bridge is paired with another extension. Restart the bridge or add this origin to ${EXTENSION_ORIGINS_ENV}.`
          : 'The Conduit bridge only accepts requests from the paired Conduit extension.',
        corsOrigin: null
      };
    }

    // No Origin: a non-browser client, a top-level navigation, or a no-cors
    // subresource (<img>, <script>) that a web page fired at us.
    if (path === '/api/conduit-pair' || method === 'OPTIONS') {
      return { ok: false, status: 403, error: 'Pairing requires the Conduit extension.', corsOrigin: null };
    }
    if (isCrossSiteFetch(req) && !paired && !(method === 'GET' && path === '/health' && req.headers['sec-fetch-mode'] === 'navigate')) {
      return { ok: false, status: 403, error: 'Cross-site requests cannot reach the Conduit bridge.', corsOrigin: null };
    }
    return { ok: true, paired, panel: false, corsOrigin: null };
  }

  private canPairWith(origin: string): boolean {
    if (this.allowedExtensionOrigins.size > 0) {
      return this.allowedExtensionOrigins.has(origin);
    }
    return this.pairedExtensionOrigin === null || this.pairedExtensionOrigin === origin;
  }

  private hasValidToken(req: http.IncomingMessage): boolean {
    const presented = req.headers[BRIDGE_TOKEN_HEADER];
    if (typeof presented !== 'string') return false;
    const expected = Buffer.from(this.bridgeToken);
    const actual = Buffer.from(presented);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  private handleOutboundPoll(req: http.IncomingMessage, res: http.ServerResponse): void {
    const delivery = this.outboundQueue.shift();
    if (delivery !== undefined) {
      this.deliverOutbound(res, delivery);
      return;
    }

    this.pendingOutboundResponses.push(res);
    req.setTimeout(30_000, () => {
      const index = this.pendingOutboundResponses.indexOf(res);
      if (index !== -1) {
        this.pendingOutboundResponses.splice(index, 1);
        sendJson(res, 200, { message: null });
      }
    });
  }

  private async handleIncomingProtocolBlock(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    let data: IncomingExtensionPayload;
    try {
      data = await readJsonBody(req) as IncomingExtensionPayload;
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON' });
      return;
    }

    if (typeof data.payload !== 'string' || data.payload.trim() === '') {
      sendJson(res, 400, { error: 'Missing payload' });
      return;
    }

    const dedupeKey = typeof data.key === 'string'
      ? data.key
      : `${data.kind ?? 'unknown'}:${data.payload}`;
    if (this.seenIncomingKeys.has(dedupeKey)) {
      sendJson(res, 200, { status: 'duplicate_ignored' });
      return;
    }
    this.seenIncomingKeys.add(dedupeKey);

    const turn: AssistantTurn = {
      text: data.payload,
      timestamp: typeof data.observedAt === 'string' ? data.observedAt : new Date().toISOString()
    };

    console.log(`[ExtensionTransport] Received ${data.kind ?? 'protocol block'} from ChatGPT extension.`);
    this.receivedInboundCount += 1;
    if (this.pendingTurnResolve) {
      const resolve = this.pendingTurnResolve;
      this.pendingTurnResolve = null;
      this.pendingTurnReject = null;
      resolve(turn);
    } else {
      this.inboundQueue.push(turn);
    }

    sendJson(res, 200, { status: 'ok' });
  }

  private createOutboundDelivery(message: string): OutboundDelivery {
    const transportId = `out-${++this.outboundCounter}`;
    return {
      transportId,
      createdAt: new Date().toISOString(),
      deliveryAttempts: 0,
      message: [
        `Conduit transport id: ${transportId}`,
        '',
        message
      ].join('\n'),
      markDelivered: () => {}
    };
  }

  private enqueueOutbound(delivery: OutboundDelivery): void {
    const pendingResponse = this.pendingOutboundResponses.shift();
    if (pendingResponse) {
      this.deliverOutbound(pendingResponse, delivery);
    } else {
      this.outboundQueue.push(delivery);
    }
  }

  private trackSendResult(delivery: OutboundDelivery): void {
    const transportId = delivery.transportId;
    const existing = this.pendingSendResults.get(transportId);
    if (existing) {
      clearTimeout(existing.resultTimeout);
      clearTimeout(existing.progressTimeout);
    }
    this.pendingSendResults.delete(transportId);
    const resultTimeout = setTimeout(() => {
      this.pendingSendResults.delete(transportId);
      const error = `Timed out waiting for extension to confirm outbound ${transportId} was sent.`;
      this.lastTransportError = {
        transportId,
        status: 'timeout',
        error,
        observedAt: new Date().toISOString()
      };
      this.lastSendResult = this.lastTransportError;
      this.scheduleSendRetry(delivery, error, 'timeout');
    }, this.options.sendResultTimeoutMs ?? SEND_RESULT_TIMEOUT_MS);
    const progressTimeout = this.createProgressTimeout(delivery, 'outbound_delivered');
    const now = new Date().toISOString();
    this.pendingSendResults.set(transportId, {
      delivery,
      resultTimeout,
      progressTimeout,
      createdAt: now,
      lastProgressAt: now,
      lastProgressStatus: 'outbound_delivered'
    });
  }

  private resolveSendResult(body: ExtensionSendResultPayload | null): void {
    const transportId = typeof body?.transportId === 'string' ? body.transportId : null;
    if (!transportId) return;

    const pending = this.pendingSendResults.get(transportId);
    if (!pending) return;

    clearTimeout(pending.resultTimeout);
    clearTimeout(pending.progressTimeout);
    this.pendingSendResults.delete(transportId);

    if (body?.status === 'sent') {
      this.lastTransportError = null;
      return;
    }

    const error = typeof body?.error === 'string'
      ? body.error
      : `Extension failed to send outbound ${transportId}.`;
    this.lastTransportError = {
      transportId,
      status: typeof body?.status === 'string' ? body.status : 'failed',
      error,
      observedAt: new Date().toISOString()
    };
    this.scheduleSendRetry(pending.delivery, error, 'failed');
  }

  private deliverOutbound(res: http.ServerResponse, delivery: OutboundDelivery): void {
    delivery.deliveryAttempts += 1;
    this.deliveredOutboundCount += 1;
    this.lastOutboundAt = new Date().toISOString();
    this.retryingOutbound.delete(delivery.transportId);
    this.trackSendResult(delivery);
    console.log(`[ExtensionTransport] outbound ${delivery.transportId} delivered-to-extension attempt=${delivery.deliveryAttempts} chars=${delivery.message.length}`);
    delivery.markDelivered();
    sendJson(res, 200, {
      type: 'harness_message',
      transportId: delivery.transportId,
      createdAt: delivery.createdAt,
      message: delivery.message
    });
  }

  private scheduleSendRetry(delivery: OutboundDelivery, error: string, status: 'failed' | 'timeout'): void {
    this.attentionOutbound.delete(delivery.transportId);
    const retryDelays = this.options.sendRetryDelaysMs ?? SEND_RETRY_DELAYS_MS;
    const retryIndex = delivery.deliveryAttempts - 1;
    const retryDelay = retryDelays[retryIndex];
    if (retryDelay === undefined) {
      this.lastTransportError = {
        transportId: delivery.transportId,
        status,
        error,
        exhausted: true,
        deliveryAttempts: delivery.deliveryAttempts,
        needsAttention: true,
        observedAt: new Date().toISOString()
      };
      this.attentionOutbound.set(delivery.transportId, {
        delivery,
        error,
        observedAt: new Date().toISOString()
      });
      console.warn(`[ExtensionTransport] outbound ${delivery.transportId} exhausted daemon send retries after ${delivery.deliveryAttempts} deliveries: ${error}`);
      return;
    }

    const retryAtDate = new Date(Date.now() + retryDelay);
    const retryAt = retryAtDate.toISOString();
    this.lastTransportError = {
      transportId: delivery.transportId,
      status,
      error,
      retrying: true,
      retryAt,
      deliveryAttempts: delivery.deliveryAttempts,
      observedAt: new Date().toISOString()
    };
    console.warn(`[ExtensionTransport] outbound ${delivery.transportId} ${status}; retrying delivery ${delivery.deliveryAttempts + 1} at ${retryAt}: ${error}`);
    const timeout = setTimeout(() => {
      this.retryingOutbound.delete(delivery.transportId);
      this.enqueueOutbound(delivery);
    }, retryDelay);
    this.retryingOutbound.set(delivery.transportId, {
      delivery,
      timeout,
      retryAt,
      error
    });
  }

  private retryOutbound(transportId?: string): { ok: true; transportId: string; status: string } | { ok: false; error: string } {
    const selectedTransportId = transportId
      ?? [...this.attentionOutbound.keys()][0]
      ?? [...this.retryingOutbound.keys()][0]
      ?? [...this.pendingSendResults.keys()][0];
    if (!selectedTransportId) {
      return { ok: false, error: 'No outbound message is available to retry.' };
    }

    const attention = this.attentionOutbound.get(selectedTransportId);
    const retrying = this.retryingOutbound.get(selectedTransportId);
    const pending = this.pendingSendResults.get(selectedTransportId);
    const delivery = attention?.delivery ?? retrying?.delivery ?? pending?.delivery;
    if (!delivery) {
      return { ok: false, error: `Unknown outbound message: ${selectedTransportId}` };
    }

    if (retrying) {
      clearTimeout(retrying.timeout);
      this.retryingOutbound.delete(selectedTransportId);
    }
    if (pending) {
      clearTimeout(pending.resultTimeout);
      clearTimeout(pending.progressTimeout);
      this.pendingSendResults.delete(selectedTransportId);
    }
    this.attentionOutbound.delete(selectedTransportId);
    this.enqueueOutbound(delivery);
    this.lastTransportError = {
      transportId: selectedTransportId,
      status: 'manual_retry',
      retrying: true,
      observedAt: new Date().toISOString()
    };
    return { ok: true, transportId: selectedTransportId, status: 'queued' };
  }

  private recordSendProgress(body: ExtensionTabStatusPayload | null): void {
    const transportId = typeof body?.transportId === 'string' ? body.transportId : null;
    if (!transportId) return;
    const pending = this.pendingSendResults.get(transportId);
    if (!pending) return;

    clearTimeout(pending.progressTimeout);
    pending.lastProgressAt = new Date().toISOString();
    pending.lastProgressStatus = typeof body?.status === 'string' ? body.status : undefined;
    pending.progressTimeout = this.createProgressTimeout(pending.delivery, pending.lastProgressStatus ?? 'outbound_progress');
  }

  private createProgressTimeout(delivery: OutboundDelivery, lastProgressStatus: string): NodeJS.Timeout {
    return setTimeout(() => {
      const pending = this.pendingSendResults.get(delivery.transportId);
      if (!pending) return;
      clearTimeout(pending.resultTimeout);
      clearTimeout(pending.progressTimeout);
      this.pendingSendResults.delete(delivery.transportId);
      const error = `No extension send progress after ${lastProgressStatus} for outbound ${delivery.transportId}.`;
      this.lastTransportError = {
        transportId: delivery.transportId,
        status: 'stalled',
        error,
        lastProgressStatus,
        lastProgressAt: pending.lastProgressAt,
        observedAt: new Date().toISOString()
      };
      this.lastSendResult = this.lastTransportError;
      this.scheduleSendRetry(delivery, error, 'timeout');
    }, this.options.sendProgressTimeoutMs ?? SEND_PROGRESS_TIMEOUT_MS);
  }

  private getTabAvailability(): {
    status: 'missing' | 'ready' | 'stale' | 'unavailable';
    reason: string;
    observedAt: string | null;
  } {
    const status = this.lastTabStatus as ExtensionTabStatusPayload | null;
    if (!status || this.tabStatusCount === 0) {
      return {
        status: 'missing',
        reason: 'No ChatGPT content-script heartbeat has reached the local bridge.',
        observedAt: null
      };
    }

    const observedAt = typeof status.observedAt === 'string' ? status.observedAt : null;
    const statusText = typeof status.status === 'string' ? status.status : 'unknown';
    const normalizedStatus = statusText.toLowerCase();
    if (
      normalizedStatus.includes('invalidated')
      || normalizedStatus.includes('unavailable')
      || normalizedStatus.includes('discarded')
      || normalizedStatus.includes('no_eligible')
    ) {
      return {
        status: 'unavailable',
        reason: `ChatGPT tab reported ${statusText}.`,
        observedAt
      };
    }

    if (observedAt) {
      const observedTime = Date.parse(observedAt);
      const staleMs = this.options.tabStatusStaleMs ?? TAB_STATUS_STALE_MS;
      if (Number.isFinite(observedTime) && Date.now() - observedTime > staleMs) {
        return {
          status: 'stale',
          reason: `Last ChatGPT content-script heartbeat is older than ${staleMs}ms.`,
          observedAt
        };
      }
    }

    return {
      status: 'ready',
      reason: `ChatGPT content script last reported ${statusText}.`,
      observedAt
    };
  }
}

function setCorsHeaders(res: http.ServerResponse, origin: string): void {
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', `Content-Type, ${BRIDGE_TOKEN_HEADER}`);
}

function parseOriginList(value: string | undefined): string[] {
  return (value ?? '').split(',').map((entry) => entry.trim()).filter(Boolean);
}

function sendJson(res: http.ServerResponse, statusCode: number, value: unknown): void {
  if (res.writableEnded) return;
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(value));
}

function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk.toString();
      if (body.length > 2_000_000) {
        reject(new Error('Body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(body || '{}'));
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}
