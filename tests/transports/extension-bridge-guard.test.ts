import { readFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import vm from 'node:vm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EXTENSION_ORIGINS_ENV, ExtensionTransport } from '../../src/transports/extension-transport.js';

// The bridge on 127.0.0.1:3333 feeds agent turns into the local runtime and
// hands out outbound harness messages (which carry session nonces). Only the
// paired Conduit extension may use it; web pages the user visits may not.

const EXTENSION_ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
const OTHER_EXTENSION_ORIGIN = 'chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba';
const EVIL_ORIGIN = 'https://evil.example';
const PANEL_ORIGIN = 'http://127.0.0.1:47831';

interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

describe('extension bridge guard', () => {
  let transport: ExtensionTransport;
  let port: number;

  beforeEach(async () => {
    transport = new ExtensionTransport({ port: 0, allowedExtensionOrigins: [] });
    await transport.open();
    port = Number(new URL(transport.getBaseUrl()).port);
  });

  afterEach(async () => {
    await transport.close();
  });

  function send(
    method: string,
    requestPath: string,
    headers: Record<string, string> = {},
    body?: unknown
  ): Promise<RawResponse> {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const req = http.request({
        host: '127.0.0.1',
        port,
        method,
        path: requestPath,
        headers: {
          Host: `127.0.0.1:${port}`,
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
          ...headers
        }
      }, (res) => {
        let text = '';
        res.on('data', (chunk) => { text += chunk; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }));
      });
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  async function pair(origin = EXTENSION_ORIGIN): Promise<RawResponse> {
    return send('POST', '/api/conduit-pair', { Origin: origin }, {});
  }

  async function pairedToken(): Promise<string> {
    const response = await pair();
    expect(response.status).toBe(200);
    return (JSON.parse(response.body) as { token: string }).token;
  }

  async function inboundCount(): Promise<number> {
    const health = await send('GET', '/health');
    return (JSON.parse(health.body) as { receivedInboundCount: number }).receivedInboundCount;
  }

  it('listens on loopback only', () => {
    const address = (transport as unknown as { server: http.Server }).server.address();
    expect(address).toMatchObject({ address: '127.0.0.1' });
  });

  it('rejects a cross-origin web page with 403 and no CORS grant', async () => {
    await pairedToken();
    const call = await send('POST', '/api/conduit-call', { Origin: EVIL_ORIGIN, 'Sec-Fetch-Site': 'cross-site' }, {
      payload: '```conduit-final\n{"status":"complete","summary":"pwned"}\n```',
      key: 'evil-1'
    });
    expect(call.status).toBe(403);
    expect(call.headers['access-control-allow-origin']).toBeUndefined();
    expect(await inboundCount()).toBe(0);

    // text/plain needs no preflight, so the server itself must refuse it.
    const simplePost = await send('POST', '/api/conduit-call', { Origin: EVIL_ORIGIN, 'Content-Type': 'text/plain' }, {
      payload: 'x'
    });
    expect(simplePost.status).toBe(403);

    for (const target of ['/health', '/api/conduit-outbound', '/api/conduit-pair']) {
      const response = await send(target === '/api/conduit-pair' ? 'POST' : 'GET', target, { Origin: EVIL_ORIGIN });
      expect(response.status, target).toBe(403);
      expect(response.headers['access-control-allow-origin'], target).toBeUndefined();
    }
  });

  it('rejects a web page that fires an Origin-less no-cors request', async () => {
    const response = await send('GET', '/api/conduit-outbound', { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'no-cors' });
    expect(response.status).toBe(403);
  });

  it('rejects a forged or rebound Host header', async () => {
    const token = await pairedToken();
    const forged = [
      'evil.example',
      `evil.example:${port}`,
      `127.0.0.1.evil.example:${port}`,
      `127.0.0.1:${port}@evil.example`,
      `127.0.0.1:${port + 1}`,
      '127.0.0.1',
      // Loopback after URL parsing, but not in the exact form the bridge
      // answers to: shorthand/numeric IPv4, userinfo, a zero-padded port.
      `127.1:${port}`,
      `2130706433:${port}`,
      `0x7f.0.0.1:${port}`,
      `attacker@127.0.0.1:${port}`,
      `127.0.0.1:0${port}`
    ];
    for (const host of forged) {
      const health = await send('GET', '/health', { Host: host });
      expect(health.status, host).toBe(403);
      const call = await send('POST', '/api/conduit-call', {
        Host: host,
        Origin: EXTENSION_ORIGIN,
        'X-Conduit-Bridge-Token': token
      }, { payload: 'x', key: `rebind-${host}` });
      expect(call.status, host).toBe(403);
    }
    expect(await inboundCount()).toBe(0);

    expect((await send('GET', '/health', { Host: `localhost:${port}` })).status).toBe(200);
  });

  it('serves the paired extension and requires its token', async () => {
    const pairing = await pair();
    expect(pairing.status).toBe(200);
    expect(pairing.headers['access-control-allow-origin']).toBe(EXTENSION_ORIGIN);
    const { token } = JSON.parse(pairing.body) as { token: string };
    expect(token).toMatch(/^[A-Za-z0-9_-]{40,}$/);

    const unpaired = await send('POST', '/api/conduit-tab-status', { Origin: EXTENSION_ORIGIN }, { status: 'content_script_alive' });
    expect(unpaired.status).toBe(401);
    const wrongToken = await send('GET', '/api/conduit-outbound', { 'X-Conduit-Bridge-Token': 'x'.repeat(token.length) });
    expect(wrongToken.status).toBe(401);

    const status = await send('POST', '/api/conduit-tab-status', {
      Origin: EXTENSION_ORIGIN,
      'X-Conduit-Bridge-Token': token
    }, { tabId: 7, status: 'content_script_alive', observedAt: new Date().toISOString() });
    expect(status.status).toBe(200);
    expect(status.headers['access-control-allow-origin']).toBe(EXTENSION_ORIGIN);

    // An extension GET may arrive without an Origin header; the token suffices.
    const call = await send('POST', '/api/conduit-call', {
      Origin: EXTENSION_ORIGIN,
      'X-Conduit-Bridge-Token': token
    }, { payload: '```conduit-final\n{"status":"complete","summary":"ok"}\n```', key: 'legit-1' });
    expect(call.status).toBe(200);
    await expect(transport.waitForAssistantTurn({ timeoutMs: 1000 })).resolves.toMatchObject({
      text: expect.stringContaining('"summary":"ok"')
    });

    // Re-pairing from the same extension (service-worker restart) returns the same token.
    expect(JSON.parse((await pair()).body)).toEqual({ token });
  });

  it('pins the first extension that pairs', async () => {
    await pairedToken();
    const other = await pair(OTHER_EXTENSION_ORIGIN);
    expect(other.status).toBe(403);
    expect(other.body).toContain('paired with another extension');
    expect(other.body).not.toContain('token');
  });

  it('accepts only configured extension origins when an allowlist is set', async () => {
    await transport.close();
    transport = new ExtensionTransport({ port: 0, allowedExtensionOrigins: [OTHER_EXTENSION_ORIGIN] });
    await transport.open();
    port = Number(new URL(transport.getBaseUrl()).port);

    expect((await pair(EXTENSION_ORIGIN)).status).toBe(403);
    expect((await pair(OTHER_EXTENSION_ORIGIN)).status).toBe(200);
  });

  it('refuses to start when the configured allowlist names no valid extension origin', async () => {
    // A bare extension ID (no chrome-extension://) or a web origin is not a
    // usable pin. Falling back to first-come pairing would drop the pin.
    const bareId = EXTENSION_ORIGIN.replace('chrome-extension://', '');
    expect(() => new ExtensionTransport({ port: 0, allowedExtensionOrigins: [bareId] }))
      .toThrow(/Refusing to start the Conduit extension bridge: CONDUIT_EXTENSION_ORIGINS names no valid extension origin/);
    expect(() => new ExtensionTransport({ port: 0, allowedExtensionOrigins: [bareId, EVIL_ORIGIN, 'null'] }))
      .toThrow(/names no valid extension origin/);

    // The same through the environment variable, which is how users set it.
    const saved = process.env[EXTENSION_ORIGINS_ENV];
    try {
      process.env[EXTENSION_ORIGINS_ENV] = ` ${bareId} , ${EVIL_ORIGIN} `;
      expect(() => new ExtensionTransport({ port: 0 })).toThrow(/names no valid extension origin/);
      // Unset or empty still means first-come pairing.
      process.env[EXTENSION_ORIGINS_ENV] = ' , ';
      expect(() => new ExtensionTransport({ port: 0 })).not.toThrow();
    } finally {
      if (saved === undefined) delete process.env[EXTENSION_ORIGINS_ENV];
      else process.env[EXTENSION_ORIGINS_ENV] = saved;
    }

    // A list with at least one valid entry keeps that pin: other extensions,
    // including the first to ask, are refused.
    await transport.close();
    transport = new ExtensionTransport({ port: 0, allowedExtensionOrigins: [bareId, OTHER_EXTENSION_ORIGIN] });
    await transport.open();
    port = Number(new URL(transport.getBaseUrl()).port);
    expect((await pair(EXTENSION_ORIGIN)).status).toBe(403);
    expect((await pair(OTHER_EXTENSION_ORIGIN)).status).toBe(200);
  });

  it('rejects preflights from non-allowed origins', async () => {
    const preflight = (origin: string, target = '/api/conduit-call') => send('OPTIONS', target, {
      Origin: origin,
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'content-type,x-conduit-bridge-token'
    });

    const evil = await preflight(EVIL_ORIGIN);
    expect(evil.status).toBe(403);
    expect(evil.headers['access-control-allow-origin']).toBeUndefined();
    expect((await preflight('null')).status).toBe(403);
    expect((await preflight(PANEL_ORIGIN)).status).toBe(403);

    const legit = await preflight(EXTENSION_ORIGIN);
    expect(legit.status).toBe(204);
    expect(legit.headers['access-control-allow-origin']).toBe(EXTENSION_ORIGIN);
    expect(legit.headers['access-control-allow-headers']).toContain('x-conduit-bridge-token');
    expect(legit.headers.vary).toBe('Origin');

    const panelRetry = await preflight(PANEL_ORIGIN, '/api/conduit-retry');
    expect(panelRetry.status).toBe(204);
    expect(panelRetry.headers['access-control-allow-origin']).toBe(PANEL_ORIGIN);
  });

  it('lets the control panel and Origin-less local clients read health but nothing else', async () => {
    const panelHealth = await send('GET', '/health', { Origin: PANEL_ORIGIN, 'Sec-Fetch-Site': 'same-site' });
    expect(panelHealth.status).toBe(200);
    expect(panelHealth.headers['access-control-allow-origin']).toBe(PANEL_ORIGIN);

    const panelRetry = await send('POST', '/api/conduit-retry', { Origin: PANEL_ORIGIN }, {});
    expect(panelRetry.status).toBe(404);
    expect(JSON.parse(panelRetry.body)).toEqual({ ok: false, error: 'No outbound message is available to retry.' });

    expect((await send('POST', '/api/conduit-call', { Origin: PANEL_ORIGIN }, { payload: 'x' })).status).toBe(403);
    expect((await send('GET', '/api/conduit-outbound', { Origin: PANEL_ORIGIN })).status).toBe(403);

    // macOS menu-bar app / curl: no Origin, no Sec-Fetch headers.
    expect((await send('GET', '/health')).status).toBe(200);
    expect((await send('POST', '/api/conduit-call', {}, { payload: 'x' })).status).toBe(401);
    expect((await send('POST', '/api/conduit-pair', {}, {})).status).toBe(403);

    // The popup's "Health JSON" link is a top-level navigation.
    const navigation = await send('GET', '/health', { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate' });
    expect(navigation.status).toBe(200);
  });

  it('works with the shipped extension bridge client, including re-pairing after a bridge restart', async () => {
    const source = await readFile(path.resolve('extension/bridge-client.js'), 'utf8');
    const baseUrl = transport.getBaseUrl();
    // Chrome attaches the extension origin; the client code itself is unchanged.
    const extensionFetch = (url: string, init: RequestInit = {}) => fetch(
      url.replace('http://127.0.0.1:3333', baseUrl),
      { ...init, headers: { ...(init.headers as Record<string, string> | undefined), Origin: EXTENSION_ORIGIN } }
    );
    const context = vm.createContext({ fetch: extensionFetch });
    vm.runInContext(source, context);
    const bridgeFetch = vm.runInContext('conduitBridgeFetch', context) as (p: string, init?: RequestInit) => Promise<Response>;

    const status = await bridgeFetch('/api/conduit-tab-status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tabId: 1, status: 'content_script_alive', observedAt: new Date().toISOString() })
    });
    expect(status.status).toBe(200);

    vm.runInContext("conduitBridgeToken = 'stale-token-from-a-previous-bridge'", context);
    const sendMessage = transport.sendMessage('hello from the harness');
    const poll = await bridgeFetch('/api/conduit-outbound');
    expect(poll.status).toBe(200);
    await expect(poll.json()).resolves.toMatchObject({ type: 'harness_message', message: expect.stringContaining('hello from the harness') });
    await sendMessage;
  });
});
