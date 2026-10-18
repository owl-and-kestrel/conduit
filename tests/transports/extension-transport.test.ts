import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ExtensionTransport } from '../../src/transports/extension-transport.js';

describe('ExtensionTransport', () => {
  let transport: ExtensionTransport;

  beforeEach(async () => {
    transport = new ExtensionTransport({
      port: 0,
      sendResultTimeoutMs: 75,
      sendProgressTimeoutMs: 40,
      sendRetryDelaysMs: [10, 20]
    });
    await transport.open();
    bridgeToken = await pairAsExtension(transport);
  });

  afterEach(async () => {
    await transport.close();
  });

  it('serves health state', async () => {
    const response = await fetch(`${transport.getBaseUrl()}/health`);
    expect(response.ok).toBe(true);
    await expect(response.json()).resolves.toMatchObject({
      status: 'ok',
      tabAvailability: {
        status: 'missing',
        reason: 'No ChatGPT content-script heartbeat has reached the local bridge.',
        observedAt: null
      },
      deliveredOutboundCount: 0,
      receivedInboundCount: 0,
      pendingSendResults: 0,
      tabStatusCount: 0,
      lastTabStatus: null,
      lastOutboundAt: null,
      lastSendResult: null,
      lastTransportError: null
    });
  });

  it('records extension tab status heartbeats', async () => {
    const observedAt = new Date().toISOString();
    await postJson(`${transport.getBaseUrl()}/api/conduit-tab-status`, {
      tabId: 42,
      url: 'https://chatgpt.com/c/test',
      status: 'content_script_alive',
      observedAt
    });

    const response = await fetch(`${transport.getBaseUrl()}/health`);
    await expect(response.json()).resolves.toMatchObject({
      tabAvailability: {
        status: 'ready',
        reason: 'ChatGPT content script last reported content_script_alive.',
        observedAt
      },
      tabStatusCount: 1,
      lastTabStatus: {
        tabId: 42,
        url: 'https://chatgpt.com/c/test',
        status: 'content_script_alive'
      }
    });
  });

  it('reports stale and unavailable ChatGPT tab availability', async () => {
    await transport.close();
    transport = new ExtensionTransport({
      port: 0,
      sendResultTimeoutMs: 75,
      sendProgressTimeoutMs: 40,
      sendRetryDelaysMs: [10, 20],
      tabStatusStaleMs: 10
    });
    await transport.open();
    bridgeToken = await pairAsExtension(transport);

    await postJson(`${transport.getBaseUrl()}/api/conduit-tab-status`, {
      tabId: 42,
      status: 'content_script_alive',
      observedAt: '2026-05-05T00:00:00.000Z'
    });

    const stale = await fetch(`${transport.getBaseUrl()}/health`);
    await expect(stale.json()).resolves.toMatchObject({
      tabAvailability: {
        status: 'stale',
        observedAt: '2026-05-05T00:00:00.000Z'
      }
    });

    await postJson(`${transport.getBaseUrl()}/api/conduit-tab-status`, {
      tabId: 42,
      status: 'extension_context_invalidated',
      observedAt: new Date().toISOString()
    });

    const unavailable = await fetch(`${transport.getBaseUrl()}/health`);
    await expect(unavailable.json()).resolves.toMatchObject({
      tabAvailability: {
        status: 'unavailable',
        reason: 'ChatGPT tab reported extension_context_invalidated.'
      }
    });
  });

  it('queues inbound protocol blocks that arrive before waitForAssistantTurn', async () => {
    const payload = [
      '```conduit-final',
      '{ "status": "complete", "summary": "Done." }',
      '```'
    ].join('\n');

    const response = await postJson(`${transport.getBaseUrl()}/api/conduit-call`, {
      payload,
      kind: 'conduit-final',
      key: 'final-1',
      observedAt: '2026-05-04T00:00:00.000Z'
    });

    expect(response.status).toBe('ok');
    await expect(transport.waitForAssistantTurn({ timeoutMs: 100 })).resolves.toMatchObject({
      text: payload,
      timestamp: '2026-05-04T00:00:00.000Z'
    });
  });

  it('ignores duplicate inbound protocol blocks by key', async () => {
    const payload = [
      '```conduit-final',
      '{ "status": "complete", "summary": "Done." }',
      '```'
    ].join('\n');

    await postJson(`${transport.getBaseUrl()}/api/conduit-call`, {
      payload,
      kind: 'conduit-final',
      key: 'same-key'
    });
    const duplicate = await postJson(`${transport.getBaseUrl()}/api/conduit-call`, {
      payload,
      kind: 'conduit-final',
      key: 'same-key'
    });

    expect(duplicate.status).toBe('duplicate_ignored');
  });

  it('delivers queued outbound messages to extension pollers', async () => {
    const send = transport.sendMessage('hello ChatGPT');

    const response = await bridgeFetch(`${transport.getBaseUrl()}/api/conduit-outbound`);
    const outbound = await response.json() as OutboundPollResponse;
    expect(outbound).toMatchObject({
      type: 'harness_message',
      transportId: 'out-1'
    });
    expect(outbound.message).toContain('Conduit transport id: out-1');
    expect(outbound.message).toContain('hello ChatGPT');

    await postJson(`${transport.getBaseUrl()}/api/conduit-send-result`, {
      transportId: outbound.transportId,
      status: 'sent'
    });
    await expect(send).resolves.toBeUndefined();

    const health = await fetch(`${transport.getBaseUrl()}/health`);
    await expect(health.json()).resolves.toMatchObject({
      deliveredOutboundCount: 1
    });
  });

  it('keeps listening after outbound delivery even before send confirmation', async () => {
    const send = transport.sendMessage('hello ChatGPT');

    const response = await bridgeFetch(`${transport.getBaseUrl()}/api/conduit-outbound`);
    const outbound = await response.json() as OutboundPollResponse;
    expect(outbound.transportId).toBe('out-1');
    await expect(send).resolves.toBeUndefined();

    const payload = [
      '```conduit-final',
      '{ "status": "complete", "summary": "Done." }',
      '```'
    ].join('\n');
    await postJson(`${transport.getBaseUrl()}/api/conduit-call`, {
      payload,
      kind: 'conduit-final',
      key: 'final-after-outbound'
    });

    await expect(transport.waitForAssistantTurn({ timeoutMs: 100 })).resolves.toMatchObject({
      text: payload
    });

    const health = await fetch(`${transport.getBaseUrl()}/health`);
    await expect(health.json()).resolves.toMatchObject({
      pendingSendResults: 1,
      pendingSendResultIds: [outbound.transportId]
    });
  });

  it('requeues failed sends with daemon-side backoff', async () => {
    const send = transport.sendMessage('hello ChatGPT');

    const response = await bridgeFetch(`${transport.getBaseUrl()}/api/conduit-outbound`);
    const outbound = await response.json() as OutboundPollResponse;
    await expect(send).resolves.toBeUndefined();

    await postJson(`${transport.getBaseUrl()}/api/conduit-send-result`, {
      transportId: outbound.transportId,
      status: 'failed',
      error: 'Timed out waiting for send button'
    });

    const health = await fetch(`${transport.getBaseUrl()}/health`);
    await expect(health.json()).resolves.toMatchObject({
      pendingSendResults: 0,
      retryingOutbound: 1,
      retryingOutboundIds: [outbound.transportId],
      lastTransportError: {
        transportId: outbound.transportId,
        status: 'failed',
        error: 'Timed out waiting for send button',
        retrying: true
      }
    });

    await delay(20);
    const retryResponse = await bridgeFetch(`${transport.getBaseUrl()}/api/conduit-outbound`);
    const retry = await retryResponse.json() as OutboundPollResponse;
    expect(retry).toMatchObject({
      transportId: outbound.transportId,
      message: outbound.message
    });
  });

  it('requeues stalled sends when the extension reports no send progress', async () => {
    const send = transport.sendMessage('hello ChatGPT');

    const response = await bridgeFetch(`${transport.getBaseUrl()}/api/conduit-outbound`);
    const outbound = await response.json() as OutboundPollResponse;
    await expect(send).resolves.toBeUndefined();

    await delay(55);

    const health = await fetch(`${transport.getBaseUrl()}/health`);
    const state = await health.json() as any;
    expect(state).toMatchObject({
      pendingSendResults: 0,
      lastTransportError: {
        transportId: outbound.transportId,
        status: 'timeout',
        retrying: true
      }
    });
    expect(state.retryingOutboundIds.includes(outbound.transportId) || state.outboundQueued > 0).toBe(true);

    await delay(15);
    const retryResponse = await bridgeFetch(`${transport.getBaseUrl()}/api/conduit-outbound`);
    const retry = await retryResponse.json() as OutboundPollResponse;
    expect(retry.transportId).toBe(outbound.transportId);
  });

  it('keeps waiting while the extension reports send progress', async () => {
    const send = transport.sendMessage('hello ChatGPT');

    const response = await bridgeFetch(`${transport.getBaseUrl()}/api/conduit-outbound`);
    const outbound = await response.json() as OutboundPollResponse;
    await expect(send).resolves.toBeUndefined();

    await delay(25);
    await postJson(`${transport.getBaseUrl()}/api/conduit-tab-status`, {
      tabId: 42,
      status: 'outbound_waiting_for_send_button',
      transportId: outbound.transportId
    });
    await delay(10);

    const health = await fetch(`${transport.getBaseUrl()}/health`);
    await expect(health.json()).resolves.toMatchObject({
      pendingSendResults: 1,
      retryingOutbound: 0,
      pendingSendResultIds: [outbound.transportId]
    });

    await postJson(`${transport.getBaseUrl()}/api/conduit-send-result`, {
      transportId: outbound.transportId,
      status: 'sent'
    });
  });

  it('extends the progress timeout when the extension keeps reporting send progress', async () => {
    await transport.close();
    transport = new ExtensionTransport({
      port: 0,
      sendResultTimeoutMs: 200,
      sendProgressTimeoutMs: 40,
      sendRetryDelaysMs: [10, 20]
    });
    await transport.open();
    bridgeToken = await pairAsExtension(transport);

    const send = transport.sendMessage('hello ChatGPT');

    const response = await bridgeFetch(`${transport.getBaseUrl()}/api/conduit-outbound`);
    const outbound = await response.json() as OutboundPollResponse;
    await expect(send).resolves.toBeUndefined();

    await delay(20);
    await postJson(`${transport.getBaseUrl()}/api/conduit-tab-status`, {
      tabId: 42,
      status: 'outbound_waiting_for_send_button',
      transportId: outbound.transportId
    });
    await delay(20);
    await postJson(`${transport.getBaseUrl()}/api/conduit-tab-status`, {
      tabId: 42,
      status: 'outbound_inserted_text',
      transportId: outbound.transportId
    });

    const stillPending = await fetch(`${transport.getBaseUrl()}/health`);
    await expect(stillPending.json()).resolves.toMatchObject({
      pendingSendResults: 1,
      retryingOutbound: 0,
      pendingSendResultIds: [outbound.transportId]
    });

    await postJson(`${transport.getBaseUrl()}/api/conduit-send-result`, {
      transportId: outbound.transportId,
      status: 'sent'
    });
  });

  it('manually retries a retrying outbound before its scheduled backoff fires', async () => {
    const send = transport.sendMessage('hello ChatGPT');

    const firstResponse = await bridgeFetch(`${transport.getBaseUrl()}/api/conduit-outbound`);
    const first = await firstResponse.json() as OutboundPollResponse;
    await expect(send).resolves.toBeUndefined();

    await postJson(`${transport.getBaseUrl()}/api/conduit-send-result`, {
      transportId: first.transportId,
      status: 'failed',
      error: 'Composer not ready'
    });

    const retrying = await fetch(`${transport.getBaseUrl()}/health`);
    await expect(retrying.json()).resolves.toMatchObject({
      retryingOutbound: 1,
      retryingOutboundIds: [first.transportId]
    });

    const retryResult = await postJson(`${transport.getBaseUrl()}/api/conduit-retry`, {
      transportId: first.transportId
    });
    expect(retryResult).toMatchObject({
      ok: true,
      transportId: first.transportId,
      status: 'queued'
    });

    const retryState = await fetch(`${transport.getBaseUrl()}/health`);
    await expect(retryState.json()).resolves.toMatchObject({
      retryingOutbound: 0,
      lastTransportError: {
        transportId: first.transportId,
        status: 'manual_retry',
        retrying: true
      }
    });

    const retryResponse = await bridgeFetch(`${transport.getBaseUrl()}/api/conduit-outbound`);
    const retry = await retryResponse.json() as OutboundPollResponse;
    expect(retry.transportId).toBe(first.transportId);
  });

  it('marks outbound sends as needing attention after retries are exhausted', async () => {
    const send = transport.sendMessage('hello ChatGPT');

    const firstResponse = await bridgeFetch(`${transport.getBaseUrl()}/api/conduit-outbound`);
    const first = await firstResponse.json() as OutboundPollResponse;
    await expect(send).resolves.toBeUndefined();

    for (const error of ['Composer not ready', 'Send button unavailable', 'Still broken']) {
      await postJson(`${transport.getBaseUrl()}/api/conduit-send-result`, {
        transportId: first.transportId,
        status: 'failed',
        error
      });
      await delay(25);
      const health = await fetch(`${transport.getBaseUrl()}/health`);
      const state = await health.json() as any;
      if (!state.lastTransportError?.exhausted) {
        await bridgeFetch(`${transport.getBaseUrl()}/api/conduit-outbound`);
      }
    }

    const health = await fetch(`${transport.getBaseUrl()}/health`);
    await expect(health.json()).resolves.toMatchObject({
      retryingOutbound: 0,
      attentionOutbound: 1,
      attentionOutboundIds: [first.transportId],
      lastTransportError: {
        transportId: first.transportId,
        status: 'failed',
        exhausted: true,
        needsAttention: true,
        deliveryAttempts: 3
      }
    });
  });

  it('manually retries an exhausted outbound send', async () => {
    const send = transport.sendMessage('hello ChatGPT');

    const firstResponse = await bridgeFetch(`${transport.getBaseUrl()}/api/conduit-outbound`);
    const first = await firstResponse.json() as OutboundPollResponse;
    await expect(send).resolves.toBeUndefined();

    for (const error of ['Composer not ready', 'Send button unavailable', 'Still broken']) {
      await postJson(`${transport.getBaseUrl()}/api/conduit-send-result`, {
        transportId: first.transportId,
        status: 'failed',
        error
      });
      await delay(25);
      const health = await fetch(`${transport.getBaseUrl()}/health`);
      const state = await health.json() as any;
      if (!state.lastTransportError?.exhausted) {
        await bridgeFetch(`${transport.getBaseUrl()}/api/conduit-outbound`);
      }
    }

    const retryResult = await postJson(`${transport.getBaseUrl()}/api/conduit-retry`, {
      transportId: first.transportId
    });
    expect(retryResult).toMatchObject({
      ok: true,
      transportId: first.transportId,
      status: 'queued'
    });

    const retryResponse = await bridgeFetch(`${transport.getBaseUrl()}/api/conduit-outbound`);
    const retry = await retryResponse.json() as OutboundPollResponse;
    expect(retry.transportId).toBe(first.transportId);

    const state = await fetch(`${transport.getBaseUrl()}/health`);
    await expect(state.json()).resolves.toMatchObject({
      attentionOutbound: 0,
      lastTransportError: {
        transportId: first.transportId,
        status: 'manual_retry'
      }
    });
  });

  it('returns a useful error when there is no outbound message to retry', async () => {
    const response = await bridgeFetch(`${transport.getBaseUrl()}/api/conduit-retry`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: 'No outbound message is available to retry.'
    });
  });
});

const EXTENSION_ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
let bridgeToken = '';

/** Pairs the way the extension does: POST /api/conduit-pair from its own origin. */
async function pairAsExtension(target: ExtensionTransport, origin = EXTENSION_ORIGIN): Promise<string> {
  const response = await fetch(`${target.getBaseUrl()}/api/conduit-pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin },
    body: '{}'
  });
  expect(response.status).toBe(200);
  const { token } = await response.json() as { token: string };
  return token;
}

/** fetch as the paired extension: its origin plus the bridge token. */
function bridgeFetch(url: string, init: RequestInit = {}): Promise<Response> {
  return fetch(url, {
    ...init,
    headers: {
      ...(init.headers as Record<string, string> | undefined),
      Origin: EXTENSION_ORIGIN,
      'X-Conduit-Bridge-Token': bridgeToken
    }
  });
}

interface OutboundPollResponse {
  type: string;
  transportId: string;
  message: string;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function postJson(url: string, body: unknown): Promise<any> {
  const response = await bridgeFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  expect(response.ok).toBe(true);
  return response.json();
}
