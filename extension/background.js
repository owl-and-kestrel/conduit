// Pairing and the bridge token live in bridge-client.js (conduitBridgeFetch).
importScripts('bridge-client.js');

chrome.runtime.onInstalled.addListener(() => {
  console.log('[Conduit Bridge] Extension installed.');
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'CONDUIT_PROTOCOL_BLOCK' || message.type === 'CONDUIT_CALL') {
    forwardProtocolBlock(message, sender)
      .then((data) => {
        console.log('[Conduit Bridge] Forwarded protocol block to Conduit CLI:', data);
        sendResponse({ ok: true });
      })
      .catch((error) => {
        console.error('[Conduit Bridge] Failed to forward protocol block. Is Conduit running with --transport extension?', error);
        sendResponse({ ok: false, error: String(error) });
      });
    return true;
  }

  if (message.type === 'SEND_RESULT') {
    postJson('/api/conduit-send-result', {
      tabId: sender.tab?.id,
      transportId: message.transportId,
      status: message.status,
      messageChars: message.messageChars,
      attempts: message.attempts,
      deduped: message.deduped,
      error: message.error
    }).catch((error) => {
      console.warn('[Conduit Bridge] Failed to report send result:', error);
    });
    return false;
  }

  if (message.type === 'TAB_STATUS') {
    postJson('/api/conduit-tab-status', {
      tabId: sender.tab?.id,
      url: message.url || sender.tab?.url,
      title: sender.tab?.title,
      status: message.status,
      observedAt: message.observedAt || new Date().toISOString(),
      transportId: message.transportId,
      attempt: message.attempt,
      elapsedMs: message.elapsedMs,
      messageChars: message.messageChars,
      error: message.error,
      composer: message.composer
    }).catch((error) => {
      console.warn('[Conduit Bridge] Failed to report tab status:', error);
    });
    return false;
  }

  if (message.type === 'POLL_OUTBOUND') {
    conduitBridgeFetch('/api/conduit-outbound')
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
      })
      .then((data) => sendResponse(data))
      .catch(() => sendResponse({ message: null }));
    return true;
  }

  return false;
});

async function forwardProtocolBlock(message, sender) {
  return postJson('/api/conduit-call', {
    payload: message.payload,
    kind: message.kind,
    key: message.key,
    url: message.url || sender.tab?.url,
    tabId: sender.tab?.id,
    observedAt: message.observedAt || new Date().toISOString()
  });
}

async function postJson(path, body) {
  const response = await conduitBridgeFetch(path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  return response.json();
}
