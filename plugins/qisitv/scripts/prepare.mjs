import { randomBytes } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm } from 'node:fs/promises';
import { constants } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureRuntime } from './runtime.mjs';

const pluginRoot = fileURLToPath(new URL('../', import.meta.url));
const notices = ['LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md'];

async function readLicenseFiles(root, signal) {
  const files = [];
  async function collect(relative) {
    signal?.throwIfAborted();
    const source = path.join(root, relative);
    const info = await lstat(source);
    if (info.isDirectory()) {
      for (const entry of await readdir(source)) await collect(path.join(relative, entry));
    } else if (info.isFile()) {
      files.push({ relative, bytes: await readFile(source, { signal }) });
    } else {
      throw new Error('The qisiTV license bundle must contain regular files and directories, not symbolic links.');
    }
  }
  for (const notice of notices) {
    const info = await lstat(path.join(root, notice));
    if (!info.isFile()) throw new Error(`The qisiTV ${notice} notice must be a regular file.`);
    await collect(notice);
  }
  const licenses = await lstat(path.join(root, 'licenses'));
  if (!licenses.isDirectory()) throw new Error('The qisiTV third-party license directory is missing.');
  await collect('licenses');
  if (files.length === notices.length) throw new Error('The qisiTV third-party license bundle is empty.');
  return files;
}

async function privateDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory()) throw new Error('The qisiTV runtime license destination must be a real directory.');
}

async function saveLicense(directory, file, signal) {
  signal?.throwIfAborted();
  const destination = path.join(directory, file.relative);
  let parent = directory;
  for (const part of file.relative.split(path.sep).slice(0, -1)) {
    parent = path.join(parent, part);
    await privateDirectory(parent);
  }
  const temporary = path.join(path.dirname(destination), `.license.${process.pid}.${randomBytes(8).toString('hex')}.part`);
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(file.bytes, { signal });
    await handle.sync();
    await handle.close();
    handle = undefined;
    signal?.throwIfAborted();
    await rename(temporary, destination);
  } finally {
    await handle?.close();
    await rm(temporary, { force: true });
  }
}

/** Prepare a client-neutral stdio MCP definition, without starting it or editing any client. */
export async function prepareMCP({ sourceRoot = pluginRoot, runtimeOptions = {} } = {}) {
  const { signal } = runtimeOptions;
  signal?.throwIfAborted();
  // Validate the complete notice bundle before downloading an executable.
  const licenses = await readLicenseFiles(sourceRoot, signal);
  const manifest = JSON.parse(await readFile(path.join(sourceRoot, 'runtime.json'), { encoding: 'utf8', signal }));
  const command = await ensureRuntime(manifest, runtimeOptions);
  signal?.throwIfAborted();
  if (!path.isAbsolute(command)) throw new Error('The prepared qisiTV MCP program must have an absolute path.');
  const directory = path.dirname(command);
  await privateDirectory(directory);
  for (const file of licenses) await saveLicense(directory, file, signal);
  signal?.throwIfAborted();
  return { command, args: ['mcp'] };
}

async function main(args) {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
    console.log('Usage: node scripts/prepare.mjs [--json]\n\nDownload and verify the qisiTV native MCP runtime, keep its licenses in the stable user cache, and print {"command":"/absolute/native/path","args":["mcp"]}.\nDoes not start MCP or modify any Agent/client configuration. Requires Node.js 18+.\n--json is the default output; --help does not download or change files.');
    return;
  }
  if (args.length !== 0 && (args.length !== 1 || args[0] !== '--json')) {
    throw new Error('Unsupported arguments. Use prepare.mjs [--json] or --help.');
  }
  if (Number(process.versions.node.split('.')[0]) < 18) throw new Error('qisiTV MCP requires Node.js 18 or newer.');
  const controller = new AbortController();
  let stoppingSignal;
  const handlers = new Map();
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    const stop = () => {
      if (stoppingSignal) return;
      stoppingSignal = signal;
      controller.abort(new Error('qisiTV MCP preparation cancelled.'));
    };
    handlers.set(signal, stop);
    process.on(signal, stop);
  }
  try {
    const config = await prepareMCP({ runtimeOptions: { signal: controller.signal } });
    console.log(JSON.stringify(config));
  } catch (error) {
    process.exitCode = stoppingSignal ? 128 + (constants.signals[stoppingSignal] ?? 1) : 1;
    throw error;
  } finally {
    for (const [signal, stop] of handlers) process.off(signal, stop);
  }
}

const invokedFile = process.argv[1] ? await realpath(process.argv[1]).catch(() => '') : '';
if (invokedFile === fileURLToPath(import.meta.url)) {
  try { await main(process.argv.slice(2)); }
  catch (error) {
    console.error(`qisiTV MCP: ${error.message}`);
    process.exitCode ||= 1;
  }
}
