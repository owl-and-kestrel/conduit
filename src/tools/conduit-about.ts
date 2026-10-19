import { z } from 'zod';
import type { ToolDefinition } from './types.js';

const ConduitAboutArgsSchema = z.object({}).passthrough();

export const conduitAboutTool: ToolDefinition<z.infer<typeof ConduitAboutArgsSchema>> = {
  name: 'conduit.about',
  description: 'Explain what Conduit is and how to ask it for local actions.',
  risk: 'low',
  schema: ConduitAboutArgsSchema,
  async run() {
    return {
      content: {
        summary: 'Conduit is a local execution bridge. It lets an agent request local filesystem, git, patch, and shell actions through structured JSON blocks, while the local runtime enforces session, nonce, policy, project-root, and approval rules. Conduit is not a sandbox: an approved shell command runs with the user\'s permissions.',
        minimalRequest: {
          v: '1',
          session: 'sess_...',
          n: 'call_...',
          do: 'list',
          path: '.',
          why: 'Orient before making changes.'
        },
        rule: 'Talk to the user normally, then include exactly one clearly separated fenced conduit block when requesting execution.'
      }
    };
  }
};
