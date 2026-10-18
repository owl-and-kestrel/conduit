import type { ActionRequestBlock } from './schemas.js';
import type { ConduitRepairEnvelope } from './render-results.js';

export function classifyRepairCode(error: string | undefined): ConduitRepairEnvelope['code'] {
  const text = error ?? '';
  if (text.includes('JSON') || text.includes('Unexpected') || text.includes('Duplicate JSON object key')) {
    return 'malformed_json';
  }
  if (text.includes('schema')) {
    return 'invalid_schema';
  }
  if (text.includes('permissions')) {
    return 'invalid_permissions';
  }
  return 'request_rejected';
}

export function createRepairEnvelope(input: {
  reason: string;
  code: ConduitRepairEnvelope['code'];
  request?: Partial<ActionRequestBlock>;
  sessionId?: string;
  currentNonce?: string;
}): ConduitRepairEnvelope {
  const sessionId = input.sessionId ?? input.request?.sessionId ?? 'sess_...';
  const nonce = input.currentNonce ?? input.request?.nonce ?? 'call_...';
  return {
    type: 'conduit.repair.v1',
    status: 'rejected',
    reason: input.reason,
    code: input.code,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.currentNonce ? { currentNonce: input.currentNonce } : {}),
    expected: {
      exactEnvelope: true,
      schema: 'conduit.request.v1',
      requiredFields: ['schema or v: "1"', 'source', 'permissions', 'sessionId/session', 'nonce/n', 'actions or one compact action shortcut'],
      allowedClipboardForms: [
        'A single fenced ```conduit code block containing strict JSON.',
        'A single fenced ```conduit-json code block containing strict JSON.',
        'A single raw JSON Conduit request object.'
      ]
    },
    repairInstructions: input.code === 'paused' ? [
      'The local user paused Conduit. Nothing ran and no approval was requested.',
      'Do not retry in a loop. Tell the user the request is waiting, and resend the same request after they resume Conduit.',
      'The session nonce was not consumed, so the same sessionId and nonce stay valid after resume.'
    ] : [
      'Emit exactly one fenced ```conduit code block containing the repaired request JSON, with no surrounding prose inside the block.',
      'Use strict JSON: no comments, trailing commas, duplicate object keys, or markdown inside the JSON.',
      'Include schema: conduit.request.v1.',
      'Include source metadata and declared permissions, even when permissions is an empty array.',
      'Include the current sessionId and currentNonce from this repair envelope when present.',
      'For simple requests, prefer the compact dialect: v, session, n, do, path, and why.',
      'Use do: "help" or do: ".help" for protocol examples if you need more detail.',
      'For multi-action requests, use do: ["list .", "read README.md", "status"] or a canonical actions array.'
    ],
    example: {
      v: '1',
      source: {
        kind: 'clipboard',
        trust: 'untrusted'
      },
      permissions: [
        {
          kind: 'filesystem',
          scope: 'project',
          access: 'read'
        }
      ],
      session: sessionId,
      n: nonce,
      do: 'list',
      path: '.',
      why: 'List the project root.',
      risk: 'low'
    }
  };
}
