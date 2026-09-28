import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

async function fixture(t, executable) {
  const directory = await mkdtemp(path.join(tmpdir(), 'qisitv-launcher-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const scripts = path.join(directory, 'scripts');
  const cache = path.join(directory, 'cache');
  await mkdir(scripts);
  await mkdir(path.join(cache, '0.2.0'), { recursive: true });
  for (const name of ['run.mjs', 'runtime.mjs']) {
    await copyFile(new URL(`../scripts/${name}`, import.meta.url), path.join(scripts, name));
  }
  const platform = process.platform === 'win32' ? 'windows' : process.platform;
  const arch = process.arch === 'x64' ? 'amd64' : process.arch;
  const key = `${platform}-${arch}`;
  const file = `qisitv-connect-${key}${process.platform === 'win32' ? '.exe' : ''}`;
  await writeFile(path.join(directory, 'runtime.json'), JSON.stringify({
    version: '0.2.0', release: 'mcp-v0.2.0',
    assets: { [key]: { file, sha256: createHash('sha256').update(executable).digest('hex') } },
  }));
  await writeFile(path.join(cache, '0.2.0', file), executable, { mode: 0o755 });
  return { directory, cache, script: path.join(scripts, 'run.mjs') };
}

function observe(child) {
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', data => { stdout += data; });
  child.stderr.setEncoding('utf8').on('data', data => { stderr += data; });
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('launcher did not exit')); }, 8_000);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('close', (code, signal) => { clearTimeout(timeout); resolve({ code, signal, stdout, stderr }); });
  });
}

test('launcher forwards arguments and stdin without adding anything to MCP stdout', { skip: process.platform === 'win32' }, async t => {
  const setup = await fixture(t, '#!/bin/sh\n[ "$1" = "mcp" ] && [ "$2" = "--port" ] && [ "$3" = "17777" ] || exit 67\ncat\n');
  const child = spawn(process.execPath, [setup.script, '--port', '17777'], {
    cwd: setup.directory,
    env: { ...process.env, QISITV_MCP_CACHE_DIR: setup.cache },
    stdio: 'pipe',
  });
  const result = observe(child);
  const protocol = '{"jsonrpc":"2.0","id":1,"method":"initialize"}\n';
  child.stdin.end(protocol);
  assert.deepEqual(await result, { code: 0, signal: null, stdout: protocol, stderr: '' });
});

test('launcher forwards termination and waits for its child instead of orphaning it', { skip: process.platform === 'win32' }, async t => {
  const setup = await fixture(t, '#!/bin/sh\ntrap \'exit 0\' TERM INT HUP\nprintf "%s" "$$" > "$QISITV_TEST_PID_FILE"\nwhile :; do read -r line || exit 0; done\n');
  const pidFile = path.join(setup.directory, 'child.pid');
  const child = spawn(process.execPath, [setup.script], {
    cwd: setup.directory,
    env: { ...process.env, QISITV_MCP_CACHE_DIR: setup.cache, QISITV_TEST_PID_FILE: pidFile },
    stdio: 'pipe',
  });
  const result = observe(child);
  let nativePid;
  const deadline = Date.now() + 3_000;
  while (!nativePid && Date.now() < deadline) {
    try { nativePid = Number(await readFile(pidFile, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!nativePid) await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok(nativePid, 'native child did not start');
  child.kill('SIGTERM');
  const stopped = await result;
  assert.equal(stopped.code, 143);
  assert.equal(stopped.stdout, '');
  assert.equal(stopped.stderr, '');
  assert.throws(() => process.kill(nativePid, 0), error => error.code === 'ESRCH');
});
