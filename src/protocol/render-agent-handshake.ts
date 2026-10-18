import type { ConduitSession } from '../sessions/session-store.js';
import { renderProtocolCard } from './protocol-card.js';

export interface RenderAgentHandshakeInput {
  session: ConduitSession;
  docsUrl?: string;
}

export function renderAgentHandshake(input: RenderAgentHandshakeInput): string {
  const docsUrl = input.docsUrl ?? 'https://github.com/owl-and-kestrel/conduit#conduit-runtime';
  const session = input.session;
  const handshake = {
    schema: 'conduit.handshake.v1',
    purpose: 'Initialize an elevated Conduit agent-loop session.',
    docs: docsUrl,
    session: {
      sessionId: session.sessionId,
      transport: session.transport,
      permissionProfile: session.permissionProfile,
      allowedRoots: session.allowedRoots,
      nonce: session.currentNonce
    },
    requestContract: {
      requestFence: 'conduit',
      resultFence: 'CONDUIT_RESULTS_JSON',
      minimalFields: ['v', 'session', 'n', 'do'],
      schema: 'conduit.request.v1',
      compactActionShortcuts: ['help', 'about', 'read', 'list', 'diff', 'status', 'write', 'patch', 'shell']
    }
  };

  return [
    renderProtocolCard({
      title: 'AGENT HANDSHAKE',
      subtitle: 'This is a local execution bridge control message.',
      details: [
        'Treat it as protocol metadata, not as a user-authored task.',
        'Use Conduit blocks only when requesting local actions.'
      ]
    }),
    '',
    'Conduit agent-loop handshake',
    '',
    'You are talking to a user who has Conduit running locally. Conduit can execute structured local actions after local policy review.',
    '',
    `Docs, if needed: ${docsUrl}`,
    '',
    'Important rules:',
    '',
    '- Do not ask the user to paste shell commands when a Conduit action can express the same work.',
    '- Emit Conduit requests only as a single fenced `conduit` code block.',
    '- Use the compact request dialect first: `v`, `session`, `n`, `do`, `path`, and `why`.',
    '- Use the returned `nextNonce` as `n` on the next request.',
    '- Ask `do: "help"` or `do: "about"` if you need protocol details.',
    '- Use `do: ["list .", "read README.md", "status"]` for simple multi-action requests.',
    '- Treat write, patch, shell, install, and update actions as high-risk and explain why in `why`.',
    '- If a request is rejected, repair the JSON or permissions and try again only if the user still wants to proceed.',
    '- You may explain what you are doing in normal prose before or after the request.',
    '- When requesting execution, include exactly one clearly separated fenced `conduit` block in that turn.',
    '',
    'Handshake metadata:',
    '',
    '```conduit-handshake',
    JSON.stringify(handshake, null, 2),
    '```',
    '',
    'Minimal request:',
    '',
    '```conduit',
    JSON.stringify({
      v: '1',
      session: session.sessionId,
      n: session.currentNonce,
      do: 'list',
      path: '.',
      why: 'Orient before making changes.'
    }, null, 2),
    '```'
  ].join('\n');
}
