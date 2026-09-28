import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { cacheRoot, ensureRuntime, MAX_BINARY_BYTES, selectAsset } from '../scripts/runtime.mjs';

const sample = Buffer.from('a verified test runtime, never executed');
const digest = data => createHash('sha256').update(data).digest('hex');
const manifest = () => ({
  version: '0.2.0', release: 'mcp-v0.2.0',
  assets: Object.fromEntries(['darwin', 'linux', 'windows'].flatMap(os => ['amd64', 'arm64'].map(cpu => [
    `${os}-${cpu}`, { file: `qisitv-connect-${os}-${cpu}${os === 'windows' ? '.exe' : ''}`, sha256: digest(sample) },
  ]))),
});

async function isolated(t, fetchImpl) {
  const directory = await mkdtemp(path.join(tmpdir(), 'qisitv-plugin-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { platform: 'linux', arch: 'x64', env: { QISITV_MCP_CACHE_DIR: directory }, fetchImpl };
}

test('only the six supported platform assets and immutable release are accepted', () => {
  assert.equal(selectAsset(manifest(), 'win32', 'x64').file, 'qisitv-connect-windows-amd64.exe');
  assert.equal(selectAsset(manifest(), 'darwin', 'arm64').file, 'qisitv-connect-darwin-arm64');
  assert.throws(() => selectAsset(manifest(), 'linux', 'ppc64'), /Unsupported platform/);
  assert.throws(() => selectAsset(manifest(), 'freebsd', 'x64'), /Unsupported platform/);
  const changed = manifest();
  changed.release = 'latest';
  assert.throws(() => selectAsset(changed, 'linux', 'x64'), /manifest does not match/);
  changed.release = 'mcp-v0.2.0';
  changed.assets['linux-amd64'].file = '../../arbitrary-program';
  assert.throws(() => selectAsset(changed, 'linux', 'x64'), /invalid runtime checksum or filename/);
  changed.assets['linux-amd64'].file = 'qisitv-connect-linux-amd64';
  changed.assets['linux-amd64'].sha256 = 'invalid';
  assert.throws(() => selectAsset(changed, 'linux', 'x64'), /invalid runtime checksum or filename/);
});

test('cache location follows platform user data directories and isolated override', () => {
  assert.equal(cacheRoot({ platform: 'darwin', home: '/users/test', env: {} }), '/users/test/Library/Application Support/qisiTV/MCP/runtime');
  assert.equal(cacheRoot({ platform: 'linux', home: '/users/test', env: { XDG_DATA_HOME: '/data' } }), '/data/qisiTV/MCP/runtime');
  assert.equal(cacheRoot({ platform: 'win32', home: 'C:\\Users\\test', env: { LOCALAPPDATA: 'C:\\Local' } }), 'C:\\Local\\qisiTV\\MCP\\runtime');
  assert.throws(() => cacheRoot({ env: { QISITV_MCP_CACHE_DIR: './relative' } }), /absolute directory/);
});

test('downloads once, verifies cached bytes every time, and repairs a corrupted cache', async t => {
  let requests = 0;
  const options = await isolated(t, async (url, request) => {
    requests++;
    assert.equal(url, 'https://github.com/wyuzhi/qisiTV/releases/download/mcp-v0.2.0/qisitv-connect-linux-amd64');
    assert.equal(request.redirect, 'manual');
    assert.equal(request.headers.Authorization, undefined);
    return new Response(sample);
  });
  const binary = await ensureRuntime(manifest(), options);
  assert.deepEqual(await readFile(binary), sample);
  assert.equal(await ensureRuntime(manifest(), options), binary);
  assert.equal(requests, 1);
  await writeFile(binary, 'corrupted cache');
  assert.equal(await ensureRuntime(manifest(), options), binary);
  assert.equal(requests, 2);
  assert.deepEqual(await readFile(binary), sample);
  assert.equal((await stat(binary)).mode & 0o777, 0o755);
  assert.deepEqual(await readdir(path.dirname(binary)), [path.basename(binary)]);
});

test('a checksum failure discards the download before creating an executable', async t => {
  const options = await isolated(t, async () => new Response('tampered executable'));
  await assert.rejects(ensureRuntime(manifest(), options), /checksum verification failed/);
  assert.deepEqual(await readdir(path.join(options.env.QISITV_MCP_CACHE_DIR, '0.2.0')), []);
});

test('HTTP failure and excessive declared size never populate the cache', async t => {
  const options = await isolated(t, async () => new Response('missing', { status: 404 }));
  await assert.rejects(ensureRuntime(manifest(), options), /HTTP 404/);
  options.fetchImpl = async () => new Response('too large', { headers: { 'content-length': String(MAX_BINARY_BYTES + 1) } });
  await assert.rejects(ensureRuntime(manifest(), options), /size limit/);
  assert.deepEqual(await readdir(path.join(options.env.QISITV_MCP_CACHE_DIR, '0.2.0')), []);
});

test('an oversized stream without Content-Length is stopped and its partial file removed', async t => {
  const chunk = new Uint8Array(1024 * 1024);
  let chunks = 0;
  const options = await isolated(t, async () => new Response(new ReadableStream({
    pull(controller) {
      if (++chunks <= 65) controller.enqueue(chunk);
      else controller.close();
    },
  })));
  await assert.rejects(ensureRuntime(manifest(), options), /size limit/);
  assert.deepEqual(await readdir(path.join(options.env.QISITV_MCP_CACHE_DIR, '0.2.0')), []);
});

test('only HTTPS redirects to GitHub release hosts are followed', async t => {
  let calls = 0;
  const options = await isolated(t, async url => {
    calls++;
    if (calls === 1) return new Response(null, { status: 302, headers: { location: 'https://release-assets.githubusercontent.com/asset' } });
    assert.equal(url, 'https://release-assets.githubusercontent.com/asset');
    return new Response(sample);
  });
  await ensureRuntime(manifest(), options);
  assert.equal(calls, 2);
  for (const location of ['http://github.com/file', 'https://evil.example/file', 'https://github.com.evil.example/file', 'https://user:password@github.com/file']) {
    const bad = await isolated(t, async () => new Response(null, { status: 302, headers: { location } }));
    await assert.rejects(ensureRuntime(manifest(), bad), /outside the allowed GitHub release hosts/);
  }
});

test('download deadline aborts the request and leaves no partial file', async t => {
  const options = await isolated(t, async (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })));
  options.timeoutMs = 10;
  await assert.rejects(ensureRuntime(manifest(), options), /timed out/);
  assert.deepEqual(await readdir(path.join(options.env.QISITV_MCP_CACHE_DIR, '0.2.0')), []);
});

test('two chats can populate the same cache without exposing partial bytes', async t => {
  const options = await isolated(t, async () => new Response(sample));
  const [first, second] = await Promise.all([ensureRuntime(manifest(), options), ensureRuntime(manifest(), options)]);
  assert.equal(first, second);
  assert.deepEqual(await readFile(first), sample);
  assert.deepEqual(await readdir(path.dirname(first)), [path.basename(first)]);
});
