// conduitBridgeFetch (pairing + bridge token) comes from bridge-client.js.

const elements = {
  stateBadge: document.getElementById('stateBadge'),
  tabState: document.getElementById('tabState'),
  outboundState: document.getElementById('outboundState'),
  lastTab: document.getElementById('lastTab'),
  lastSend: document.getElementById('lastSend'),
  lastError: document.getElementById('lastError'),
  desktopPanel: document.getElementById('desktopPanel'),
  attentionPanel: document.getElementById('attentionPanel'),
  attentionTitle: document.getElementById('attentionTitle'),
  attentionText: document.getElementById('attentionText'),
  retryButton: document.getElementById('retryButton'),
  refreshButton: document.getElementById('refreshButton')
};

let latestHealth = null;

elements.refreshButton.addEventListener('click', () => refresh());
elements.retryButton.addEventListener('click', async () => {
  const transportId = selectRetryTransportId(latestHealth);
  await postJson('/api/conduit-retry', transportId ? { transportId } : {});
  await refresh();
});

refresh();

async function refresh() {
  setBadge('Checking', '');
  try {
    latestHealth = await getJson('/health');
    render(latestHealth);
  } catch (error) {
    latestHealth = null;
    setBadge('Offline', 'error');
    elements.tabState.textContent = 'offline';
    elements.outboundState.textContent = '-';
    elements.lastTab.textContent = 'Bridge server not reachable';
    elements.lastSend.textContent = '-';
    elements.lastError.textContent = error instanceof Error ? error.message : String(error);
    elements.desktopPanel.classList.remove('hidden');
    elements.attentionPanel.classList.add('hidden');
    elements.attentionPanel.classList.remove('attention');
  }
}

function render(health) {
  elements.desktopPanel.classList.add('hidden');
  const needsAttention = health.lastTransportError?.needsAttention === true || health.attentionOutbound > 0;
  const canRetry = bridgeCanRetry(health);
  const tabAvailable = health.tabAvailability?.status === 'ready';
  setBadge(needsAttention ? 'Attention' : canRetry ? 'Sending' : tabAvailable ? 'Connected' : 'No tab', needsAttention || !tabAvailable ? 'error' : 'ok');

  elements.tabState.textContent = tabAvailabilityLabel(health);
  elements.outboundState.textContent = outboundSummary(health);
  elements.lastTab.textContent = health.lastTabStatus
    ? `${health.lastTabStatus.status || 'unknown'} · ${health.lastTabStatus.title || health.lastTabStatus.url || 'unknown tab'} · ${health.tabAvailability?.reason || 'availability unknown'}`
    : 'No content-script heartbeat';
  elements.lastSend.textContent = health.lastSendResult
    ? `${health.lastSendResult.status || 'unknown'} ${health.lastSendResult.transportId || ''}`.trim()
    : 'No send result yet';
  elements.lastError.textContent = health.lastTransportError
    ? health.lastTransportError.error || health.lastTransportError.status || 'Unknown transport error'
    : 'None';

  if (canRetry) {
    elements.attentionTitle.textContent = needsAttention ? 'Needs attention' : 'Retry available';
    elements.attentionText.textContent = retryPanelText(health);
    elements.attentionPanel.classList.toggle('attention', needsAttention);
    elements.attentionPanel.classList.remove('hidden');
  } else {
    elements.attentionPanel.classList.add('hidden');
    elements.attentionPanel.classList.remove('attention');
  }
}

function outboundSummary(health) {
  if (health.attentionOutbound > 0) return `${health.attentionOutbound} attention`;
  if (health.retryingOutbound > 0) return `${health.retryingOutbound} retrying`;
  if (health.pendingSendResults > 0) return `${health.pendingSendResults} sending`;
  if (health.outboundQueued > 0) return `${health.outboundQueued} queued`;
  return 'idle';
}

function selectRetryTransportId(health) {
  return health?.attentionOutboundIds?.[0]
    || health?.retryingOutboundIds?.[0]
    || health?.pendingSendResultIds?.[0];
}

function bridgeCanRetry(health) {
  return Boolean(health?.attentionOutboundIds?.length || health?.retryingOutboundIds?.length || health?.pendingSendResultIds?.length);
}

function retryPanelText(health) {
  const id = selectRetryTransportId(health) || health?.lastTransportError?.transportId || 'unknown';
  const error = health?.lastTransportError?.error || health?.lastTransportError?.status || 'transport state';
  if (health?.lastTransportError?.needsAttention === true || health?.attentionOutbound > 0) {
    return `${id}: ${error}`;
  }
  if (health?.retryingOutbound > 0) {
    return `${id}: retry is scheduled; retry now if the ChatGPT tab is ready.`;
  }
  if (health?.pendingSendResults > 0) {
    return `${id}: send is in progress; retry if the tab appears stalled.`;
  }
  return `${id}: retry available.`;
}

function tabAvailabilityLabel(health) {
  const status = health?.tabAvailability?.status;
  if (status === 'ready') return 'alive';
  if (status === 'stale') return 'stale';
  if (status === 'unavailable') return 'unavailable';
  return 'missing';
}

function setBadge(text, className) {
  elements.stateBadge.textContent = text;
  elements.stateBadge.className = className;
}

async function getJson(path) {
  const response = await conduitBridgeFetch(path);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function postJson(path, body) {
  const response = await conduitBridgeFetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || `HTTP ${response.status}`);
  }
  return response.json();
}
