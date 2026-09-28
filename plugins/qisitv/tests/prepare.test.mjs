import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { prepareMCP } from '../scripts/prepare.mjs';

const sample = Buffer.from('verified runtime fixture; do not execute');
const hash = createHash('sha256').update(sample).digest('hex');

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'qisitv prepare test '));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceRoot = path.join(root, 'temporary clone');
  const cache = path.join(root, 'stable runtime cache');
  await mkdir(path.join(sourceRoot, 'scripts'), { recursive: true });
  await mkdir(path.join(sourceRoot, 'licenses', 'nested'), { recursive: true });
  for (const file of ['prepare.mjs', 'runtime.mjs']) await copyFile(new URL(`../scripts/${file}`, import.meta.url), path.join(sourceRoot, 'scripts', file));
  for (const file of ['LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md', 'licenses/Go-LICENSE', 'licenses/nested/Dependency-LICENSE']) await writeFile(path.join(sourceRoot, file), `Notice for ${file}\n`);
  const platform = process.platform === 'win32' ? 'windows' : process.platform;
  const arch = process.arch === 'x64' ? 'amd64' : process.arch;
  const key = `${platform}-${arch}`;
  const file = `qisitv-connect-${key}${process.platform === 'win32' ? '.exe' : ''}`;
  await writeFile(path.join(sourceRoot, 'runtime.json'), JSON.stringify({ version: '0.2.0', release: 'mcp-v0.2.0', assets: { [key]: { file, sha256: hash } } }));
  return { root, sourceRoot, cache, file, runtimeOptions: { env: { QISITV_MCP_CACHE_DIR: cache }, fetchImpl: async () => new Response(sample) } };
}

function launch(setup, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(setup.sourceRoot, 'scripts', 'prepare.mjs'), ...args], {
      cwd: setup.root, env: { ...process.env, QISITV_MCP_CACHE_DIR: setup.cache }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', value => { stdout += value; });
    child.stderr.setEncoding('utf8').on('data', value => { stderr += value; });
    child.once('error', reject);
    child.once('close', code => resolve({ code, stdout, stderr }));
  });
}

test('prepares only command/args and retains all notices after the clone is deleted', async t => {
  const setup = await fixture(t);
  const config = await prepareMCP(setup);
  assert.deepEqual(config, { command: path.join(setup.cache, '0.2.0', setup.file), args: ['mcp'] });
  assert.ok(config.command.includes(' '));
  await rm(setup.sourceRoot, { recursive: true });
  assert.deepEqual(await readFile(config.command), sample);
  for (const file of ['LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md', 'licenses/Go-LICENSE', 'licenses/nested/Dependency-LICENSE']) {
    assert.equal(await readFile(path.join(path.dirname(config.command), file), 'utf8'), `Notice for ${file}\n`);
  }
});

test('cached runtime needs no network and stdout is a single client-neutral JSON definition', async t => {
  const setup = await fixture(t);
  const config = await prepareMCP(setup);
  for (const args of [[], ['--json']]) {
    const result = await launch(setup, args);
    assert.equal(result.code, 0);
    assert.equal(result.stderr, '');
    assert.deepEqual(JSON.parse(result.stdout), config);
    assert.equal(result.stdout.trim().split('\n').length, 1);
  }
});

test('help and invalid flags do not download, create cache, or read the runtime manifest', async t => {
  const setup = await fixture(t);
  await rm(path.join(setup.sourceRoot, 'runtime.json'));
  const help = await launch(setup, ['--help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /Does not start MCP or modify/);
  assert.equal(help.stderr, '');
  const invalid = await launch(setup, ['--client', 'claude']);
  assert.equal(invalid.code, 1);
  assert.equal(invalid.stdout, '');
  assert.match(invalid.stderr, /Unsupported arguments/);
  await assert.rejects(stat(setup.cache), error => error.code === 'ENOENT');
});

test('missing notices fail before downloading or returning a configuration', async t => {
  const setup = await fixture(t);
  await rm(path.join(setup.sourceRoot, 'NOTICE'));
  let called = false;
  setup.runtimeOptions.fetchImpl = async () => { called = true; return new Response(sample); };
  await assert.rejects(prepareMCP(setup), error => error.code === 'ENOENT');
  assert.equal(called, false);
  await assert.rejects(stat(setup.cache), error => error.code === 'ENOENT');
});

test('a directory cannot silently replace a required notice', async t => {
  const setup = await fixture(t);
  await rm(path.join(setup.sourceRoot, 'NOTICE'));
  await mkdir(path.join(setup.sourceRoot, 'NOTICE'));
  await assert.rejects(prepareMCP(setup), /NOTICE notice must be a regular file/);
  await assert.rejects(stat(setup.cache), error => error.code === 'ENOENT');
});

test('aborted download leaves no partial runtime, config output or license scratch files', async t => {
  const setup = await fixture(t);
  const controller = new AbortController();
  setup.runtimeOptions.signal = controller.signal;
  let ready;
  const started = new Promise(resolve => { ready = resolve; });
  setup.runtimeOptions.fetchImpl = async (_url, { signal }) => new Promise((_resolve, reject) => {
    ready(); signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  const result = prepareMCP(setup);
  await started;
  controller.abort(new Error('test cancellation'));
  await assert.rejects(result, /test cancellation/);
  assert.deepEqual(await readdir(path.join(setup.cache, '0.2.0')), []);
});

test('CLI termination aborts its pending download without emitting configuration', { skip: process.platform === 'win32', timeout: 10000 }, async t => {
  const setup = await fixture(t);
  const preload = path.join(setup.root, 'mock-download.cjs');
  await writeFile(preload, `globalThis.fetch = async (_url, { signal }) => new Promise((_resolve, reject) => {
    const alive = setInterval(() => {}, 1000);
    signal.addEventListener('abort', () => { clearInterval(alive); reject(signal.reason); }, { once: true });
    process.stderr.write('download-ready\\n');
  });`);
  const child = spawn(process.execPath, ['--require', preload, path.join(setup.sourceRoot, 'scripts', 'prepare.mjs')], {
    cwd: setup.root, env: { ...process.env, QISITV_MCP_CACHE_DIR: setup.cache }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8').on('data', value => { stdout += value; });
  child.stderr.setEncoding('utf8').on('data', value => { stderr += value; });
  const closed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  await new Promise((resolve, reject) => {
    child.stderr.on('data', () => { if (stderr.includes('download-ready')) resolve(); });
    child.once('error', reject);
    child.once('close', () => reject(new Error('Preparer stopped before its mocked download began.')));
  });
  assert.equal(child.kill('SIGTERM'), true);
  assert.deepEqual(await closed, { code: 143, signal: null });
  assert.equal(stdout, '');
  assert.match(stderr, /qisiTV MCP preparation cancelled/);
  assert.deepEqual(await readdir(path.join(setup.cache, '0.2.0')), []);
});

test('concurrent preparers keep complete licenses and no temporary files', async t => {
  const setup = await fixture(t);
  const [first, second] = await Promise.all([prepareMCP(setup), prepareMCP(setup)]);
  assert.deepEqual(first, second);
  assert.equal(await readFile(path.join(path.dirname(first.command), 'NOTICE'), 'utf8'), 'Notice for NOTICE\n');
  assert.deepEqual((await readdir(path.dirname(first.command))).sort(), ['LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md', 'licenses', setup.file].sort());
});

test('license destination symlinks cannot redirect writes outside the runtime directory', { skip: process.platform === 'win32' }, async t => {
  const setup = await fixture(t);
  const outside = path.join(setup.root, 'outside');
  await mkdir(outside);
  await mkdir(path.join(setup.cache, '0.2.0'), { recursive: true });
  await symlink(outside, path.join(setup.cache, '0.2.0', 'licenses'));
  await assert.rejects(prepareMCP(setup), /real directory/);
  assert.deepEqual(await readdir(outside), []);
});
