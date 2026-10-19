import { z } from 'zod';
import type { ToolDefinition } from './types.js';
import { isDemoProfileEnabled } from '../runtime/demo-profile.js';
import { serviceRegistry } from '../runtime/service-registry.js';
import { preparePackage } from '../runtime/package-cache.js';

const ServiceStartArgsSchema = z.object({
  name: z.string().min(1).max(80),
  path: z.string().min(1).optional(), // entry script inside the project root (also checked by the policy path rule)
  args: z.array(z.string()).optional(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  // Package form: an https (or loopback http) package fetched over the wire,
  // verified by sha256 before anything is unpacked or run.
  package: z.object({
    url: z.string().url(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    size: z.number().int().positive().optional()
  }).strict().optional(),
  port: z.number().int().min(1024).max(65535).optional(),
  lan: z.boolean().optional(),
  readySeconds: z.number().int().min(1).max(300).optional()
}).strict().superRefine((args, ctx) => {
  const hasPath = args.path !== undefined;
  const hasPackage = args.package !== undefined;
  if (hasPath === hasPackage) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'service.start takes exactly one of path (project entry) or package (url + sha256).',
      path: [hasPath ? 'path' : 'package']
    });
  }
  if (args.sha256 !== undefined && !hasPath) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'sha256 belongs to the path form; a package is verified by its own sha256.',
      path: ['sha256']
    });
  }
});

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
    // Package form: fetch (or reuse) the package into the content-addressed
    // cache, verify its sha256, and start the verified bytes from that
    // directory — never from a project file that could change.
    let fromPackage: {
      dir: string;
      entry: string;
      sha256: string;
      url: string;
      cached: boolean;
      bytesFetched: number;
    } | undefined;
    if (args.package) {
      const prepared = await preparePackage(args.package);
      fromPackage = {
        dir: prepared.dir,
        entry: prepared.entry,
        sha256: prepared.sha256,
        url: args.package.url,
        cached: prepared.cached,
        bytesFetched: prepared.bytesFetched
      };
    }
    const service = await serviceRegistry.start({
      name: args.name,
      ...(args.path !== undefined ? { path: args.path } : {}),
      ...(fromPackage ? { fromPackage } : {}),
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
        sha256: service.sha256,
        // Package form only: provenance of the digest that started.
        ...(service.package
          ? {
              package: {
                sha256: service.package.sha256,
                cached: service.package.cached,
                bytesFetched: service.package.bytesFetched
              }
            }
          : {})
      },
      metadata: {
        serviceId: service.serviceId,
        logPath: service.logPath
      }
    };
  }
};
