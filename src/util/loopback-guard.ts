import type http from 'node:http';

/**
 * Shared guards for Conduit's local HTTP surfaces: the control panel (:47831)
 * and the extension bridge (:3333). Both bind to loopback, but binding alone
 * does not stop a web page in the user's browser from sending requests to
 * 127.0.0.1, or a DNS-rebinding page from reading the responses. Each server
 * composes these helpers into its own policy.
 */

/** Default ports of Conduit's local HTTP surfaces. */
export const CONTROL_PANEL_DEFAULT_PORT = 47831;
export const EXTENSION_BRIDGE_DEFAULT_PORT = 3333;

const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export function isLoopbackHostname(hostname: string): boolean {
  return LOOPBACK_HOSTNAMES.has(hostname.toLowerCase());
}

/**
 * Refuses a Host header that does not name a loopback host (DNS rebinding).
 * With `port`, the Host must also name exactly that port. With `requireHost`,
 * a missing Host header is refused too. Returns a refusal reason, or null.
 */
export function refuseNonLoopbackHost(
  req: http.IncomingMessage,
  options: { port?: number; requireHost?: boolean } = {}
): string | null {
  const hostHeader = req.headers.host;
  if (!hostHeader) {
    return options.requireHost ? 'Missing Host header.' : null;
  }
  let parsed: URL;
  try {
    parsed = new URL(`http://${hostHeader}`);
  } catch {
    return 'Invalid Host header.';
  }
  // Refuse anything the URL parser had to reinterpret (userinfo, paths, ...).
  const canonical = parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname;
  if (canonical !== hostHeader.toLowerCase() || !isLoopbackHostname(parsed.hostname)) {
    return 'Only requests addressed to a loopback host are answered.';
  }
  if (options.port !== undefined && Number(parsed.port || '80') !== options.port) {
    return 'The Host header names a different port.';
  }
  return null;
}

/**
 * True for a browser-extension origin. Web pages cannot claim one: the browser,
 * not page script, sets the Origin header.
 */
export function isBrowserExtensionOrigin(origin: string): boolean {
  return /^(chrome-extension|moz-extension|safari-web-extension):\/\/[A-Za-z0-9._-]+$/.test(origin);
}

/** True when Sec-Fetch-Site says a page on another origin initiated the request. */
export function isCrossSiteFetch(req: http.IncomingMessage): boolean {
  const fetchSite = req.headers['sec-fetch-site'];
  return typeof fetchSite === 'string' && fetchSite !== 'same-origin' && fetchSite !== 'none';
}

/**
 * Control-panel policy. Refuse:
 * - Host headers that are not loopback (DNS-rebinding pages), and
 * - state-changing requests carrying a foreign Origin or a cross-site
 *   Sec-Fetch-Site (cross-site form/fetch posts that could approve or run work).
 * Non-browser clients (the macOS menu-bar app, curl, tests) send no Origin and
 * are unaffected.
 */
export function refuseNonLocalRequest(req: http.IncomingMessage): string | null {
  const hostRefusal = refuseNonLoopbackHost(req);
  if (hostRefusal) {
    return hostRefusal === 'Invalid Host header.'
      ? hostRefusal
      : 'Conduit Control only answers requests addressed to a loopback host.';
  }

  const method = (req.method ?? 'GET').toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
    return null;
  }

  if (isCrossSiteFetch(req)) {
    return 'Cross-site requests cannot change Conduit state.';
  }

  const hostHeader = req.headers.host;
  const origin = req.headers.origin;
  if (typeof origin === 'string' && origin.length > 0) {
    if (!hostHeader || origin !== `http://${hostHeader}`) {
      return 'Cross-origin requests cannot change Conduit state.';
    }
  }
  return null;
}
