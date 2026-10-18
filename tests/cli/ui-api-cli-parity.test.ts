import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { renderAppJs } from '../../src/app/control-panel-ui.js';
import { CONTROL_CLI_ROUTES } from '../../src/cli/control-client.js';

/**
 * UI is an API control plane (spec §3.5): every button in the web panel and
 * the menu-bar app is a Conduit Control HTTP call, and the CLI can make every
 * one of those calls too. Authorization lives on the server; a missing CLI
 * verb is never the protection.
 *
 * This test checks, with every list parsed from source (never hand-written):
 * - the panel and the menu bar call only routes the server actually has;
 * - every endpoint the panel or menu bar calls has a CLI verb;
 * - the CLI covers every route, and every CLI verb calls a real route;
 * - every CLI verb in the parity table exists in the real `conduit` CLI.
 *
 * Sources: the route if-chain in src/app/control-panel.ts, the `api(...)` calls
 * in the served panel script (renderAppJs), `ControlEndpoint` plus raw
 * `127.0.0.1:47831/api/...` URLs in the Swift app, `CONTROL_CLI_ROUTES`, and
 * `conduit --help`.
 *
 * EXEMPTIONS is the only hand-written table. Each entry says why the route has
 * no HTTP CLI verb; `inProcessVerb` names the CLI verb that performs the same
 * operation in-process, which counts as parity for a UI-called endpoint.
 * Endpoint keys are '<METHOD> <path>' with path parameters written ':id'.
 */
const EXEMPTIONS: Record<string, { reason: string; inProcessVerb?: string }> = {
  'GET /': { reason: 'Serves the panel page itself; not an operation.' },
  'GET /app.js': { reason: 'Serves the panel script; not an operation.' },
  'GET /api/sessions': {
    inProcessVerb: 'session list',
    reason: 'session list reads the same session store in-process (listSessions), so it works when Control is down. Routing it through Control is a later change.'
  },
  'POST /api/sessions': {
    inProcessVerb: 'session create',
    reason: 'session create calls the same createSession in-process. Routing it through Control is a later change.'
  },
  'POST /api/sessions/:id/revoke': {
    inProcessVerb: 'session revoke',
    reason: 'session revoke calls the same revokeSession in-process, so revoking never depends on Control being up.'
  },
  'POST /api/clipboard/check': {
    inProcessVerb: 'daemon once',
    reason: 'daemon once runs the same ClipboardWatcher.checkOnce in-process against the local clipboard.'
  }
};

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve('.');

function cliRoutes(): Set<string> {
  return new Set(Object.values(CONTROL_CLI_ROUTES).map((route) => `${route.method} ${route.path}`));
}

/** Expands `(a|b)` alternation groups into one path per alternative. */
function expandAlternatives(template: string): string[] {
  const group = template.match(/\(([\w|-]+)\)/);
  if (!group || group.index === undefined) return [template];
  const before = template.slice(0, group.index);
  const after = template.slice(group.index + group[0].length);
  return group[1].split('|').flatMap((choice) => expandAlternatives(`${before}${choice}${after}`));
}

async function serverRoutes(): Promise<Set<string>> {
  const source = await readFile(path.join(repoRoot, 'src/app/control-panel.ts'), 'utf8');
  const routes = new Set<string>();

  const literals = [...source.matchAll(/req\.method === '(GET|POST)' && url\.pathname === '([^']+)'/g)];
  for (const match of literals) routes.add(`${match[1]} ${match[2]}`);

  const patterns = [...source.matchAll(/const (\w+) = url\.pathname\.match\(\/\^(.+?)\$\/\);/g)];
  for (const match of patterns) {
    const name = match[1];
    const method = source.match(new RegExp(`req\\.method === '(GET|POST)' && ${name}\\?\\.\\[1\\]`))?.[1];
    if (!method) throw new Error(`No method check found for route regex ${name}; update the parity parser.`);
    const template = match[2].split('\\/').join('/').split('([^/]+)').join(':id');
    for (const routePath of expandAlternatives(template)) routes.add(`${method} ${routePath}`);
  }

  // No silent drift: every pathname check must have been understood above.
  const literalChecks = source.split('url.pathname ===').length - 1;
  const regexChecks = source.split('url.pathname.match(').length - 1;
  if (literals.length !== literalChecks || patterns.length !== regexChecks) {
    throw new Error(
      `The Control route table changed shape (parsed ${literals.length}/${literalChecks} literal and `
      + `${patterns.length}/${regexChecks} regex routes); update the parity parser.`
    );
  }
  return routes;
}

/** Returns the text between the parentheses opening at `open`, honouring quotes. */
function argumentText(source: string, open: number): string {
  let depth = 0;
  let quote: string | null = null;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (char === '\\') index += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') quote = char;
    else if (char === '(' || char === '{' || char === '[') depth += 1;
    else if (char === ')' || char === '}' || char === ']') {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, index);
    }
  }
  throw new Error(`Unbalanced call at offset ${open}`);
}

/** Splits on `separator` at nesting depth 0, outside quotes. */
function splitTopLevel(text: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (char === '\\') index += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') quote = char;
    else if (char === '(' || char === '{' || char === '[') depth += 1;
    else if (char === ')' || char === '}' || char === ']') depth -= 1;
    else if (char === separator && depth === 0) {
      parts.push(text.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((part) => part.trim());
}

function panelCalls(): Set<string> {
  const script = renderAppJs();
  const calls = new Set<string>();
  for (const match of script.matchAll(/(^|[^\w.])api\(/g)) {
    const open = (match.index ?? 0) + match[0].length - 1;
    if (script.slice(Math.max(0, open - 12), open).endsWith('function api')) continue;
    const args = argumentText(script, open);
    const [first, ...rest] = splitTopLevel(args, ',');
    const pieces = splitTopLevel(first, '+');
    if (!/^'\/api[^']*'$/.test(pieces[0])) {
      throw new Error(`Panel call with a non-literal path cannot be checked for parity: api(${args})`);
    }
    const callPath = pieces.map((piece) => (/^'[^']*'$/.test(piece) ? piece.slice(1, -1) : ':id')).join('');
    const method = /method:\s*'POST'/.test(rest.join(',')) ? 'POST' : 'GET';
    calls.add(`${method} ${callPath}`);
  }
  return calls;
}

async function menuBarCalls(): Promise<Set<string>> {
  const sources = path.join(repoRoot, 'macos/ConduitMenuBar/Sources');
  const controlApi = await readFile(path.join(sources, 'ConduitMenuBarCore/ControlAPI.swift'), 'utf8');
  const start = controlApi.indexOf('public enum ControlEndpoint');
  const end = controlApi.indexOf('\n}\n', start);
  if (start < 0 || end < 0) throw new Error('ControlEndpoint not found in ControlAPI.swift; update the parity parser.');
  const endpointEnum = controlApi.slice(start, end);

  const methods = new Map<string, string>();
  const methodBlock = endpointEnum.slice(endpointEnum.indexOf('public var method'), endpointEnum.indexOf('public var path'));
  for (const match of methodBlock.matchAll(/case ([^:]+):\s*return "(GET|POST)"/g)) {
    for (const name of match[1].split(',')) {
      methods.set(name.trim().replace(/^\./, '').replace(/\(.*$/, ''), match[2]);
    }
  }

  const calls = new Set<string>();
  const pathBlock = endpointEnum.slice(endpointEnum.indexOf('public var path'));
  for (const match of pathBlock.matchAll(/case \.(\w+)(\([^)]*\))?\s*:\s*return "([^"]+)"/g)) {
    const method = methods.get(match[1]);
    if (!method) throw new Error(`ControlEndpoint.${match[1]} has no method case; update the parity parser.`);
    calls.add(`${method} ${match[3].replace(/\\\([^)]*\)/g, ':id')}`);
  }
  if (calls.size === 0) throw new Error('Parsed no ControlEndpoint paths; update the parity parser.');

  // Raw Control URLs outside ControlEndpoint (for example /api/url/open).
  for (const dir of ['ConduitMenuBar', 'ConduitMenuBarCore']) {
    for (const file of (await readdir(path.join(sources, dir))).filter((name) => name.endsWith('.swift'))) {
      const swift = await readFile(path.join(sources, dir, file), 'utf8');
      for (const match of swift.matchAll(/"http:\/\/127\.0\.0\.1:47831(\/api\/[^"]*)"/g)) {
        // The method is set later in the same function; stop at the next func.
        const following = swift.slice((match.index ?? 0) + match[0].length).split(/\bfunc\s/)[0];
        const method = following.match(/httpMethod = "(GET|POST)"/)?.[1] ?? 'GET';
        calls.add(`${method} ${match[1]}`);
      }
    }
  }
  return calls;
}

async function cliHelp(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(
    path.join(repoRoot, 'node_modules/.bin/tsx'),
    [path.join(repoRoot, 'src/cli/index.ts'), ...args, '--help'],
    { timeout: 60_000 }
  );
  return stdout;
}

function helpSection(help: string, title: 'Commands:' | 'Options:'): string[] {
  const lines = help.split('\n');
  const start = lines.indexOf(title);
  if (start < 0) return [];
  const section: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === '' || !line.startsWith(' ')) break;
    section.push(line);
  }
  return section;
}

/**
 * Verbs of the real CLI, as 'verb', 'verb sub' and 'verb --option'. Only the
 * top-level verbs in `expand` get their own --help run (each is a process).
 */
async function cliVerbsFromHelp(expand: Set<string>): Promise<Set<string>> {
  const topLevel = helpSection(await cliHelp([]), 'Commands:')
    .filter((line) => /^ {2}\S/.test(line))
    .map((line) => line.trim().split(/\s+/)[0])
    .filter((verb) => verb !== 'help');
  const verbs = new Set<string>(topLevel);
  const helps = await Promise.all(topLevel
    .filter((verb) => expand.has(verb))
    .map(async (verb) => [verb, await cliHelp([verb])] as const));
  for (const [verb, help] of helps) {
    for (const line of helpSection(help, 'Commands:')) {
      if (!/^ {2}\S/.test(line)) continue;
      const sub = line.trim().split(/\s+/)[0];
      if (sub !== 'help') verbs.add(`${verb} ${sub}`);
    }
    for (const line of helpSection(help, 'Options:')) {
      const option = line.trim().match(/^(?:-\w, )?--([a-z][\w-]*)/)?.[1];
      if (option) verbs.add(`${verb} --${option}`);
    }
  }
  return verbs;
}

describe('UI / API / CLI parity (UI is an API control plane)', () => {
  it('derives a non-trivial route table from the server source', async () => {
    const routes = await serverRoutes();
    expect(routes.size).toBeGreaterThanOrEqual(15);
    for (const route of [
      'GET /api/control',
      'POST /api/control/pause',
      'POST /api/control/resume',
      'POST /api/sessions/:id/pause',
      'POST /api/approvals/:id/approve'
    ]) {
      expect(routes, route).toContain(route);
    }
  });

  it('the web panel and the menu bar call only real routes', async () => {
    const routes = await serverRoutes();
    const panel = panelCalls();
    const menuBar = await menuBarCalls();
    expect([...panel].filter((call) => !routes.has(call)).sort()).toEqual([]);
    expect([...menuBar].filter((call) => !routes.has(call)).sort()).toEqual([]);
    // S7: the panel's Pause all / Resume control.
    expect(panel).toContain('GET /api/control');
    expect(panel).toContain('POST /api/control/pause');
    expect(panel).toContain('POST /api/control/resume');
  });

  it('every endpoint the panel or menu bar calls has a CLI verb', async () => {
    const cli = cliRoutes();
    const uiCalls = new Set([...panelCalls(), ...(await menuBarCalls())]);
    const missing = [...uiCalls]
      .filter((call) => !cli.has(call) && !EXEMPTIONS[call]?.inProcessVerb)
      .sort();
    expect(missing).toEqual([]);
  });

  it('the CLI covers every route, and every CLI verb calls a real route', async () => {
    const routes = await serverRoutes();
    const cli = cliRoutes();
    expect([...routes].filter((route) => !cli.has(route) && !EXEMPTIONS[route]).sort()).toEqual([]);
    expect([...cli].filter((route) => !routes.has(route)).sort()).toEqual([]);
  });

  it('exemptions are justified and not stale', async () => {
    const routes = await serverRoutes();
    const cli = cliRoutes();
    for (const [route, exemption] of Object.entries(EXEMPTIONS)) {
      expect(routes, `${route} is no longer a route; drop its exemption`).toContain(route);
      expect(cli.has(route), `${route} now has a CLI verb; drop its exemption`).toBe(false);
      expect(exemption.reason.length, `${route} needs a reason`).toBeGreaterThan(20);
    }
  });

  it('every CLI verb in the parity table and every in-process verb exists in the real CLI', async () => {
    const named = [
      ...Object.keys(CONTROL_CLI_ROUTES),
      ...Object.values(EXEMPTIONS).flatMap((exemption) => (exemption.inProcessVerb ? [exemption.inProcessVerb] : []))
    ];
    const verbs = await cliVerbsFromHelp(new Set(named.map((verb) => verb.split(' ')[0])));
    expect(named.filter((verb) => !verbs.has(verb)).sort()).toEqual([]);
  }, 120_000);
});
