import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, cpSync, existsSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createServer as createTCPServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { bundleNpmRuntime, packageAgentHost, verifyRuntime, NODE_VERSION } from './package-agent-host.mjs';
import { resolveNpmCommand, DEFAULT_CN_NPM_REGISTRY, DEFAULT_GLOBAL_NPM_REGISTRY } from '../agent-host/plugin-packages.mjs';

const { test, expect } = process.versions.bun
  ? await import('bun:test')
  : {
      test: (name, fn, timeout) => nodeTest(name, typeof timeout === 'number' ? { timeout } : {}, fn),
      expect: (actual) => ({
        toBe: (expected) => assert.strictEqual(actual, expected),
        toEqual: (expected) => assert.deepStrictEqual(actual, expected),
        toBeTruthy: () => assert.ok(actual),
        toBeUndefined: () => assert.strictEqual(actual, undefined),
        toThrow: (pattern) => {
          if (pattern === undefined) assert.throws(actual);
          else assert.throws(actual, typeof pattern === 'string' ? new RegExp(pattern) : pattern);
        },
      }),
    };

function resolveTestRuntime() {
  if (process.env.BEEFTV_NODE_RUNTIME) return process.env.BEEFTV_NODE_RUNTIME;
  const appRuntime = '/Applications/BeefTV.app/Contents/Resources/agent-host/runtime';
  if (process.platform === 'darwin' && existsSync(path.join(appRuntime, 'bin', 'node'))) return appRuntime;
  return '';
}

test('release rejects missing runtime and unsupported target', () => {
  expect(() => verifyRuntime('', 'darwin/arm64')).toThrow('required');
  expect(() => verifyRuntime('/missing', 'linux/arm64')).toThrow('Unsupported');
  expect(() => verifyRuntime('/missing', 'linux/amd64')).toThrow('Missing bundled Node');
  expect(() => verifyRuntime('/missing', 'windows/amd64')).toThrow('Missing bundled Node');
});

test('bundleNpmRuntime copies npm CLI for unix and windows layouts and resolves bundled npm command', () => {
  const scratch = mkdtempSync(path.join(tmpdir(), 'beeftv-npm-bundle-'));
  try {
    // Unix layout
    const unixRuntime = path.join(scratch, 'unix-runtime');
    const unixNode = path.join(unixRuntime, 'bin', 'node');
    const unixNpmCli = path.join(unixRuntime, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
    mkdirSync(path.dirname(unixNode), { recursive: true });
    mkdirSync(path.dirname(unixNpmCli), { recursive: true });
    writeFileSync(unixNode, '#!/bin/sh\n');
    writeFileSync(unixNpmCli, 'console.log("bundled-npm");\n');
    const unixStage = path.join(scratch, 'unix-stage');
    const copiedUnixCli = bundleNpmRuntime({ runtime: unixRuntime, node: unixNode, target: 'darwin/arm64', stage: unixStage });
    expect(existsSync(copiedUnixCli)).toBe(true);
    expect(existsSync(path.join(unixStage, 'runtime', 'bin', 'npm'))).toBe(true);
    const stagedUnixNode = path.join(unixStage, 'runtime', 'bin', 'node');
    expect(resolveNpmCommand({ execPath: stagedUnixNode, platform: 'darwin' })).toEqual([
      stagedUnixNode,
      copiedUnixCli,
      `--registry=${DEFAULT_CN_NPM_REGISTRY}`,
      '--no-audit',
      '--no-fund',
    ]);
    expect(resolveNpmCommand({ execPath: stagedUnixNode, platform: 'darwin', registryUrl: 'global' })).toEqual([
      stagedUnixNode,
      copiedUnixCli,
      `--registry=${DEFAULT_GLOBAL_NPM_REGISTRY}`,
      '--no-audit',
      '--no-fund',
    ]);

    // Windows layout
    const winRuntime = path.join(scratch, 'win-runtime');
    const winNode = path.join(winRuntime, 'node.exe');
    const winNpmCli = path.join(winRuntime, 'node_modules', 'npm', 'bin', 'npm-cli.js');
    mkdirSync(path.dirname(winNpmCli), { recursive: true });
    writeFileSync(winNode, '');
    writeFileSync(winNpmCli, 'console.log("bundled-win-npm");\n');
    const winStage = path.join(scratch, 'win-stage');
    const copiedWinCli = bundleNpmRuntime({ runtime: winRuntime, node: winNode, target: 'windows/amd64', stage: winStage });
    expect(existsSync(copiedWinCli)).toBe(true);
    expect(existsSync(path.join(winStage, 'runtime', 'npm.cmd'))).toBe(true);
    const stagedWinNode = path.join(winStage, 'runtime', 'node.exe');
    expect(resolveNpmCommand({ execPath: stagedWinNode, platform: 'win32' })).toEqual([
      stagedWinNode,
      copiedWinCli,
      `--registry=${DEFAULT_CN_NPM_REGISTRY}`,
      '--no-audit',
      '--no-fund',
    ]);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('bundled runtime, locked dependencies, and paths with spaces', () => {
  const runtime = resolveTestRuntime();
  expect(runtime).toBeTruthy();
  const target = `${process.platform === 'win32' ? 'windows' : process.platform}/${process.arch === 'x64' ? 'amd64' : 'arm64'}`;
  const scratch = mkdtempSync(path.join(tmpdir(), 'beeftv package test '));
  try {
    const runtimeCopy = path.join(scratch, 'runtime source with spaces');
    const relative = process.platform === 'win32' ? 'node.exe' : 'bin/node';
    mkdirSync(path.dirname(path.join(runtimeCopy, relative)), { recursive: true });
    cpSync(path.join(runtime, relative), path.join(runtimeCopy, relative), { dereference: true });
    const npmCliRelative = process.platform === 'win32'
      ? path.join('node_modules', 'npm', 'bin', 'npm-cli.js')
      : path.join('lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
    mkdirSync(path.dirname(path.join(runtimeCopy, npmCliRelative)), { recursive: true });
    writeFileSync(path.join(runtimeCopy, npmCliRelative), 'console.log("9.9.9-bundled");\n');
    expect(() => verifyRuntime(runtimeCopy, target === 'darwin/arm64' ? 'darwin/amd64' : 'darwin/arm64')).toThrow();
    const destination = path.join(scratch, 'release with spaces', 'agent-host');
    packageAgentHost({ runtime: runtimeCopy, target, destination });
    const bundled = path.join(destination, 'runtime', relative);
    const bundledNpmCli = path.join(destination, 'runtime', npmCliRelative);
    expect(existsSync(bundled)).toBe(true);
    expect(existsSync(bundledNpmCli)).toBe(true);
    expect(existsSync(path.join(destination, 'model-stream-idle.mjs'))).toBe(true);
    expect(existsSync(path.join(destination, 'model-transport-error.mjs'))).toBe(true);
    expect(existsSync(path.join(destination, 'durable-turn-projection.mjs'))).toBe(true);
    expect(existsSync(path.join(destination, 'durable-extensions.mjs'))).toBe(true);
    expect(existsSync(path.join(destination, 'plugin-packages.mjs'))).toBe(true);
    expect(existsSync(path.join(destination, 'business-progress.mjs'))).toBe(true);
    expect(existsSync(path.join(destination, 'canvas-write-view.mjs'))).toBe(true);
    expect(existsSync(path.join(destination, 'node_modules/@earendil-works/pi-coding-agent/package.json'))).toBe(true);
    expect(existsSync(path.join(destination, 'run-agent-host.sh'))).toBe(false);
    const result = spawnSync(bundled, ['-p', 'process.versions.node'], { encoding: 'utf8', env: { ...process.env, PATH: '' } });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(NODE_VERSION);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}, 240000);

test('packaged server starts with local imports and makes zero model requests', async () => {
  const runtime = resolveTestRuntime();
  expect(runtime).toBeTruthy();
  const target = `${process.platform === 'win32' ? 'windows' : process.platform}/${process.arch === 'x64' ? 'amd64' : 'arm64'}`;
  const scratch = mkdtempSync(path.join(tmpdir(), 'beeftv packaged server '));
  const requests = [];
  let modelRequests = 0;
  // The host's request budget classifies model calls by origin, so keep this separate from ops.
  const provider = createServer((_request, response) => {
    modelRequests += 1;
    response.writeHead(500).end('No model requests allowed in packaging tests');
  });
  const ops = createServer((request, response) => {
    requests.push({ method: request.method, path: request.url, host: request.headers['x-beeftv-agent-token'] });
    response.setHeader('Content-Type', 'application/json');
    if (request.method !== 'GET' || request.url !== '/api/ops' || request.headers['x-beeftv-agent-token'] !== 'test-host') {
      response.writeHead(403).end(JSON.stringify({ code: 403 }));
      return;
    }
    response.end(JSON.stringify({ code: 0, data: { ops: [{ id: 'canvas.get', readOnly: true,
      summary: 'Read test canvas', scope: 'canvas', params: { type: 'object', properties: {} } }] } }));
  });
  let child;
  let exited;
  try {
    const destination = path.join(scratch, 'release with spaces', 'agent-host');
    packageAgentHost({ runtime, target, destination });
    await new Promise((resolve, reject) => { ops.once('error', reject); ops.listen(0, '127.0.0.1', resolve); });
    const opsURL = `http://127.0.0.1:${ops.address().port}`;
    await new Promise((resolve, reject) => { provider.once('error', reject); provider.listen(0, '127.0.0.1', resolve); });
    const providerURL = `http://127.0.0.1:${provider.address().port}/v1`;
    const reservation = createTCPServer();
    await new Promise((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve); });
    const port = reservation.address().port;
    await new Promise((resolve, reject) => reservation.close((error) => error ? reject(error) : resolve()));
    const bundled = path.join(destination, 'runtime', process.platform === 'win32' ? 'node.exe' : 'bin/node');
    let output = '';
    let spawnError;
    child = spawn(bundled, ['server.mjs'], { cwd: destination, stdio: ['ignore', 'pipe', 'pipe'], env: {
      PATH: '', HOME: scratch, USERPROFILE: scratch, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      BEEFTV_OPS_URL: `${opsURL}/api`, BEEFTV_AGENT_HOST_TOKEN: 'test-host',
      BEEFTV_AGENT_DATA_DIR: path.join(scratch, 'data'), BEEFTV_AGENT_PORT: String(port),
      BEEFTV_AGENT_MODEL: 'packaging-test-model', BEEFTV_AGENT_API: 'openai-completions',
      BEEFTV_AGENT_BASE_URL: providerURL, BEEFTV_AGENT_API_KEY: 'test-placeholder', BEEFTV_AGENT_TOTAL_REQUEST_BUDGET: '0',
    } });
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.once('error', (error) => { spawnError = error; });
    exited = new Promise((resolve) => child.once('close', resolve));
    let health;
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      if (spawnError || child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`Packaged server exited before health: ${spawnError || child.exitCode}\n${output}`);
      }
      try {
        const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) });
        if (response.ok) { health = await response.json(); break; }
      } catch { /* Wait only while the packaged child is starting. */ }
      await delay(100);
    }
    if (!health) throw new Error(`Packaged server did not become healthy\n${output}`);
    if (health.operations !== 1) throw new Error(`Packaged server did not discover operations: ${JSON.stringify(requests)}\n${output}`);
    expect(health.ok).toBe(true);
    expect(health.reason).toBeUndefined();
    expect(health.model).toBe('packaging-test-model');
    expect(health.api).toBe('openai-completions');
    expect(health.baseUrl).toBe(providerURL);
    expect(health.operations).toBe(1);
    expect(health.requests).toEqual({ dispatched: 0, perTurnRequests: 40, perTurnToolSteps: 40, lifetimeBudget: 0, lifetimeUsed: 0 });
    expect(modelRequests).toBe(0);
    expect(requests).toEqual([{ method: 'GET', path: '/api/ops', host: 'test-host' }]);
  } finally {
    if (child) {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await exited;
    }
    for (const server of [ops, provider]) {
      if (server.listening) {
        const closed = new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        server.closeAllConnections();
        await closed;
      }
    }
    rmSync(scratch, { recursive: true, force: true });
  }
}, 240000);
