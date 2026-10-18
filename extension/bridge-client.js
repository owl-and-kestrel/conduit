// Shared client for the local Conduit bridge (127.0.0.1:3333). Loaded by the
// background service worker (importScripts) and the popup (<script>).
//
// The bridge only answers this extension: it pairs with the extension's own
// origin (chrome-extension://<id>, which web pages cannot claim) and hands back
// a per-process token that every extension endpoint requires. The token lives
// in memory only; when the service worker or the bridge restarts, the next
// request re-pairs automatically.

const CONDUIT_BRIDGE_BASE_URL = 'http://127.0.0.1:3333';
const CONDUIT_BRIDGE_TOKEN_HEADER = 'X-Conduit-Bridge-Token';

let conduitBridgeToken = null;
let conduitBridgePairing = null;

function conduitBridgePair() {
  conduitBridgePairing ??= (async () => {
    try {
      const response = await fetch(`${CONDUIT_BRIDGE_BASE_URL}/api/conduit-pair`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}'
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || typeof data.token !== 'string') {
        throw new Error(data.error || `Bridge pairing failed: HTTP ${response.status}`);
      }
      conduitBridgeToken = data.token;
      return data.token;
    } finally {
      conduitBridgePairing = null;
    }
  })();
  return conduitBridgePairing;
}

async function conduitBridgeFetch(path, init = {}) {
  const send = (token) => fetch(`${CONDUIT_BRIDGE_BASE_URL}${path}`, {
    ...init,
    headers: { ...(init.headers || {}), [CONDUIT_BRIDGE_TOKEN_HEADER]: token }
  });

  let response = await send(conduitBridgeToken ?? await conduitBridgePair());
  if (response.status === 401) {
    // The bridge restarted and minted a new token.
    response = await send(await conduitBridgePair());
  }
  return response;
}
