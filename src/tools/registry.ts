import { fileReadTool } from './file-read.js';
import { fileListTool } from './file-list.js';
import { gitStatusTool } from './git-status.js';
import { gitDiffTool } from './git-diff.js';
import { fileWriteTool } from './file-write.js';
import { filePatchTool } from './file-patch.js';
import { shellRunTool } from './shell-run.js';
import { conduitAboutTool } from './conduit-about.js';
import { conduitHelpTool } from './conduit-help.js';
import { conduitExtensionPrepareAlphaInstallTool } from './conduit-extension.js';
import { serviceStartTool } from './service-start.js';
import { isDemoProfileEnabled } from '../runtime/demo-profile.js';
import type { ToolDefinition } from './types.js';

const TOOLS = [
  fileReadTool,
  fileListTool,
  gitStatusTool,
  gitDiffTool,
  conduitAboutTool,
  conduitHelpTool,
  conduitExtensionPrepareAlphaInstallTool,
  fileWriteTool,
  filePatchTool,
  shellRunTool
] satisfies ToolDefinition[];

export function getTool(name: string): ToolDefinition | null {
  // service.start is registered only while the demo profile is on. With the
  // switch off both getTool and listTools return exactly what they returned
  // before (same order, same contents); with it on serviceStartTool is last.
  const tools = isDemoProfileEnabled() ? [...TOOLS, serviceStartTool] : TOOLS;
  return tools.find((tool) => tool.name === name) ?? null;
}

export function listTools(): ToolDefinition[] {
  return isDemoProfileEnabled() ? [...TOOLS, serviceStartTool] : [...TOOLS];
}
