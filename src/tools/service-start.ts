import { z } from 'zod';
import type { ToolDefinition } from './types.js';
import { isDemoProfileEnabled } from '../runtime/demo-profile.js';
import { serviceRegistry } from '../runtime/service-registry.js';

const ServiceStartArgsSchema = z.object({
  name: z.string().min(1).max(80),
  path: z.string().min(1), // entry script inside the project root (also checked by the policy path rule)
  args: z.array(z.string()).optional(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  port: z.number().int().min(1024).max(65535).optional(),
  lan: z.boolean().optional(),
  readySeconds: z.number().int().min(1).max(300).optional()
}).strict();

type ServiceStartArgs = z.infer<typeof ServiceStartArgsSchema>;

export const serviceStartTool: ToolDefinition<ServiceStartArgs> = {
  name: 'service.start',
  description: 'Demo profile only: start a long-lived Node program from the project with an assigned PORT; returns when it prints CONDUIT_READY.',
  risk: 'high',
  schema: ServiceStartArgsSchema,
  async run(args, context) {
    // Defence in depth: policy already keeps the tool out of every profile
    // but 'demo-review', and that profile itself denies when the switch is
    // off. Check again here so the tool can never be called around policy.
    if (!isDemoProfileEnabled()) {
      throw new Error('service.start is available only with the demo profile (CONDUIT_DEMO_PROFILE=1).');
    }
    const service = await serviceRegistry.start({
      name: args.name,
      path: args.path,
      ...(args.args ? { args: args.args } : {}),
      ...(args.sha256 ? { sha256: args.sha256 } : {}),
      ...(args.port !== undefined ? { port: args.port } : {}),
      ...(args.lan !== undefined ? { lan: args.lan } : {}),
      ...(args.readySeconds !== undefined ? { readySeconds: args.readySeconds } : {}),
      projectRoot: context.projectRoot,
      runId: context.runId,
      runDir: context.runDir
    });
    return {
      content: {
        serviceId: service.serviceId,
        name: service.name,
        url: service.url,
        host: service.host,
        port: service.port,
        pid: service.pid,
        state: service.state,
        readyAt: service.readyAt,
        sha256: service.sha256
      },
      metadata: {
        serviceId: service.serviceId,
        logPath: service.logPath
      }
    };
  }
};
