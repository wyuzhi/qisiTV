import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { constants } from 'node:os';
import { ensureRuntime } from './runtime.mjs';

const controller = new AbortController();
let child;
let stoppingSignal;
let killTimer;

function stop(signal) {
  if (stoppingSignal) return;
  stoppingSignal = signal;
  controller.abort(new Error('qisiTV MCP startup cancelled.'));
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill(signal);
    killTimer = setTimeout(() => child.kill('SIGKILL'), 5_000);
    killTimer.unref();
  }
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => stop(signal));
}
process.on('exit', () => {
  if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
});

try {
  if (Number(process.versions.node.split('.')[0]) < 18) {
    throw new Error('qisiTV MCP requires Node.js 18 or newer. Install Node.js and reload the plugin.');
  }
  const manifest = JSON.parse(await readFile(new URL('../runtime.json', import.meta.url), 'utf8'));
  const executable = await ensureRuntime(manifest, { signal: controller.signal });
  controller.signal.throwIfAborted();
  child = spawn(executable, ['mcp', ...process.argv.slice(2)], { stdio: 'inherit', windowsHide: true });
  const result = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(killTimer);
  process.exitCode = stoppingSignal
    ? 128 + (constants.signals[stoppingSignal] ?? 1)
    : result.code ?? 128 + (constants.signals[result.signal] ?? 1);
} catch (error) {
  clearTimeout(killTimer);
  console.error(`qisiTV MCP: ${error.message}`);
  process.exitCode = stoppingSignal ? 128 + (constants.signals[stoppingSignal] ?? 1) : 1;
}
