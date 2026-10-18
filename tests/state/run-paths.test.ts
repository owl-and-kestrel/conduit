import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startControlPanel, type ControlPanelHandle } from '../../src/app/control-panel.js';
import type { ClipboardIO } from '../../src/daemon/clipboard-io.js';
import { getRunDir, isSafeRunId, RunPathError } from '../../src/state/paths.js';

describe('run id to run path safety', () => {
  let tempRoot: string;
  let app: ControlPanelHandle;

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), 'conduit-run-paths-'));
    process.env.CONDUIT_STATE_DIR = tempRoot;
    const legitRunDir = path.join(tempRoot, 'runs', '20261018-120000-abcdef');
    await mkdir(legitRunDir, { recursive: true });
    await writeFile(path.join(legitRunDir, 'result.txt'), 'legit result', 'utf8');
    // Outside runs/: nothing served under /api/runs may ever reach this.
    const secretDir = path.join(tempRoot, 'secret');
    await mkdir(secretDir, { recursive: true });
    await writeFile(path.join(secretDir, 'result.txt'), 'TOP SECRET', 'utf8');
    await writeFile(path.join(secretDir, 'final.md'), 'TOP SECRET', 'utf8');
    app = await startControlPanel({ host: '127.0.0.1', port: 0, clipboard: new MemoryClipboard() });
  });

  afterEach(async () => {
    await app.close();
    delete process.env.CONDUIT_STATE_DIR;
    await rm(tempRoot, { recursive: true, force: true });
  });

  it('accepts run ids shaped like the ones createRunId produces', () => {
    expect(isSafeRunId('20261018-120000-abcdef')).toBe(true);
    expect(isSafeRunId('run_demo_0412')).toBe(true);
  });

  it('rejects ids that are not a single plain path segment', () => {
    for (const bad of ['', '.', '..', '../x', 'a/b', 'a\\b', '/etc/passwd', 'a\u0000b', '..%2Fx', '.hidden', 'a..b']) {
      expect(isSafeRunId(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it('refuses to build a run directory from an unsafe id', () => {
    expect(() => getRunDir('../x')).toThrow(RunPathError);
  });

  it('serves the result of a real run', async () => {
    const response = await fetch(`${app.url}/api/runs/20261018-120000-abcdef/result`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ runId: '20261018-120000-abcdef', result: 'legit result' });
  });

  it('returns 400 or 404 without leaking the secret for raw traversal paths', async () => {
    const traversalPaths = [
      '/api/runs/..%2Fsecret/result',
      '/api/runs/%2e%2e%2fsecret/result',
      '/api/runs/%2E%2E%2Fsecret/result',
      '/api/runs/..%252Fsecret/result',
      '/api/runs/..%5Csecret/result',
      '/api/runs/%2Fetc%2Fpasswd/result',
      '/api/runs/%E0%A4%A/result',
      '/api/runs/%00/result',
      '/api/runs/../secret/result'
    ];
    for (const rawPath of traversalPaths) {
      const { status, body } = await rawGet(app.url, rawPath);
      expect([400, 404], rawPath).toContain(status);
      expect(body, rawPath).not.toContain('TOP SECRET');
    }
  });

  it('refuses a run directory symlinked outside the runs root', async () => {
    await symlink(path.join(tempRoot, 'secret'), path.join(tempRoot, 'runs', 'escape'));
    const { status, body } = await rawGet(app.url, '/api/runs/escape/result');
    expect(status).toBe(404);
    expect(body).not.toContain('TOP SECRET');
  });

  it('refuses a result file symlinked outside its run directory', async () => {
    const runDir = path.join(tempRoot, 'runs', '20261018-120001-bbbbbb');
    await mkdir(runDir, { recursive: true });
    await symlink(path.join(tempRoot, 'secret', 'result.txt'), path.join(runDir, 'result.txt'));
    const { status, body } = await rawGet(app.url, '/api/runs/20261018-120001-bbbbbb/result');
    expect(status).toBe(404);
    expect(body).not.toContain('TOP SECRET');
  });

  it('lists the legit run but not an escaping symlink, in the run list and the diagnostics bundle', async () => {
    await writeFile(path.join(tempRoot, 'secret', 'final.json'), JSON.stringify({ status: 'complete', summary: 'TOP SECRET' }), 'utf8');
    await symlink(path.join(tempRoot, 'secret'), path.join(tempRoot, 'runs', 'escape'));
    const response = await fetch(`${app.url}/api/runs`);
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain('TOP SECRET');
    const body = JSON.parse(text) as { runs: Array<{ runId: string }> };
    expect(body.runs.map((run) => run.runId)).toEqual(['20261018-120000-abcdef']);

    const diagnostics = await fetch(`${app.url}/api/diagnostics`);
    expect(diagnostics.status).toBe(200);
    const diagnosticsText = await diagnostics.text();
    expect(diagnosticsText).not.toContain('TOP SECRET');
    const bundle = JSON.parse(diagnosticsText) as { bundle: { runs: Array<{ runId: string }> } };
    expect(bundle.bundle.runs.map((run) => run.runId)).toEqual(['20261018-120000-abcdef']);
  });
});

class MemoryClipboard implements ClipboardIO {
  text = '';
  async read(): Promise<string> {
    return this.text;
  }
  async write(text: string): Promise<void> {
    this.text = text;
  }
}

// fetch/URL would normalise dot segments, so send the raw path with http.get.
function rawGet(baseUrl: string, rawPath: string): Promise<{ status: number; body: string }> {
  const target = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: target.hostname, port: target.port, path: rawPath }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
  });
}
