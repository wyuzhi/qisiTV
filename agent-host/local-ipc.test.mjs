import { describe, expect, test } from 'bun:test';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { AsyncLocalStorage } from 'node:async_hooks';
import { fileURLToPath } from 'node:url';
import { createOperationBridge } from './operation-bridge.mjs';

const AGENT_HOST_DIR = path.dirname(fileURLToPath(import.meta.url));
const SERVER_MJS = path.join(AGENT_HOST_DIR, 'server.mjs');

function makeEndpoint(tag) {
  const suffix = `${tag}-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\beeftv-${suffix}`;
  }
  const base = fs.realpathSync('/tmp');
  return path.join(base, `btv-${suffix.slice(-24)}.sock`);
}

function requestPipe(socketPath, reqPath, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      socketPath,
      path: reqPath,
      method,
      headers: { Host: '127.0.0.1:1', ...headers },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode || 0, text, json: () => JSON.parse(text) });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

describe('local IPC pipe transport (agent-host & operation-bridge)', () => {
  test('operation-bridge talks over opsPipe when TCP opsUrl port is unreachable', async () => {
    const opsPipe = makeEndpoint('ops-bridge');
    const seen = [];
    const opsServer = http.createServer((req, res) => {
      seen.push({
        url: req.url,
        host: req.headers.host,
        agentToken: req.headers['x-beeftv-agent-token'],
        desktopToken: req.headers['x-desktop-token'],
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        code: 0,
        data: {
          ops: [{ id: 'canvas.get', summary: '读取画布', readOnly: true, assistantModes: ['canvas'], params: { type: 'object', properties: { canvasId: { type: 'string' } } } }],
        },
      }));
    });
    await new Promise((resolve) => opsServer.listen(opsPipe, resolve));
    try {
      const bridge = createOperationBridge({
        opsUrl: 'http://127.0.0.1:1/api',
        opsPipe,
        hostToken: 'host-tok-1',
        desktopToken: 'desk-tok-1',
        turnBudgetContext: new AsyncLocalStorage(),
      });
      const count = await bridge.loadDescriptors();
      expect(count).toBe(1);
      expect(seen).toEqual([{
        url: '/api/ops',
        host: '127.0.0.1:1',
        agentToken: 'host-tok-1',
        desktopToken: 'desk-tok-1',
      }]);
    } finally {
      await new Promise((resolve) => opsServer.close(resolve));
    }
  });

  test('server.mjs boots on BEEFTV_AGENT_PIPE and loads ops via BEEFTV_OPS_PIPE with zero TCP ports', async () => {
    const opsPipe = makeEndpoint('ops-srv');
    const agentPipe = makeEndpoint('agent-srv');
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'btv-pipe-host-'));
    const nonce = 'pipe-nonce-12345';
    const hostToken = 'pipe-host-secret';
    let opsHits = 0;

    const opsServer = http.createServer((req, res) => {
      opsHits += 1;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (req.url === '/api/ops') {
        res.end(JSON.stringify({ code: 0, data: { ops: [] } }));
        return;
      }
      if (req.url === '/api/plugins/packages/enabled') {
        res.end(JSON.stringify({ code: 0, data: { packages: [] } }));
        return;
      }
      res.end(JSON.stringify({ code: 0, data: {} }));
    });
    await new Promise((resolve) => opsServer.listen(opsPipe, resolve));

    let childStderr = '';
    const child = spawn('node', [SERVER_MJS], {
      env: {
        ...process.env,
        BEEFTV_AGENT_DATA_DIR: dataDir,
        BEEFTV_AGENT_HOST_TOKEN: hostToken,
        BEEFTV_AGENT_INSTANCE_NONCE: nonce,
        BEEFTV_AGENT_PIPE: agentPipe,
        BEEFTV_AGENT_PORT: '',
        BEEFTV_AGENT_LISTEN_FD: '',
        BEEFTV_OPS_URL: 'http://127.0.0.1:1/api',
        BEEFTV_OPS_PIPE: opsPipe,
        BEEFTV_AGENT_MODEL: 'deepseek-chat',
        BEEFTV_AGENT_API: 'openai-completions',
        BEEFTV_AGENT_BASE_URL: 'http://127.0.0.1:1/v1',
        BEEFTV_AGENT_API_KEY: 'sk-test-pipe',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stderr.on('data', (chunk) => { childStderr += chunk.toString('utf8'); });
    const exitPromise = new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) resolve();
      else child.once('exit', resolve);
    });

    try {
      const deadline = Date.now() + 25000;
      let health = null;
      while (Date.now() < deadline) {
        if (child.exitCode !== null || child.signalCode !== null) {
          throw new Error(`agent-host exited early (code=${child.exitCode} signal=${child.signalCode}): ${childStderr}`);
        }
        try {
          const resp = await requestPipe(agentPipe, '/health', {
            headers: {
              'X-Beeftv-Agent-Token': hostToken,
              'X-Beeftv-Instance-Nonce': nonce,
            },
          });
          if (resp.status === 200) {
            health = resp.json();
            break;
          }
        } catch {
          // Wait for listen.
        }
        await new Promise((r) => setTimeout(r, 40));
      }
      expect(health).not.toBeNull();
      expect(health.ok).toBe(true);
      const expectedInstance = crypto.createHash('sha256').update(nonce).digest('hex').slice(0, 16);
      expect(health.instance).toBe(expectedInstance);
      expect(opsHits).toBeGreaterThanOrEqual(1);
    } finally {
      child.stdin.end();
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
      }
      await Promise.race([exitPromise, new Promise((r) => setTimeout(r, 3000))]);
      await new Promise((resolve) => opsServer.close(resolve));
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
