import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

export const MAX_BINARY_BYTES = 64 * 1024 * 1024;
const RELEASE = 'mcp-v0.2.0';
const VERSION = '0.2.0';
const RELEASE_BASE = `https://github.com/wyuzhi/qisiTV/releases/download/${RELEASE}/`;
const REDIRECT_HOSTS = new Set(['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com']);

export function selectAsset(manifest, platform = process.platform, arch = process.arch) {
  const os = { darwin: 'darwin', linux: 'linux', win32: 'windows' }[platform];
  const cpu = { arm64: 'arm64', x64: 'amd64' }[arch];
  if (!os || !cpu) {
    throw new Error(`Unsupported platform ${platform}/${arch}. qisiTV MCP supports macOS, Windows and Linux on ARM64 or x64.`);
  }
  if (manifest?.version !== VERSION || manifest?.release !== RELEASE) {
    throw new Error('The qisiTV plugin runtime manifest does not match this launcher. Update the complete plugin.');
  }
  const key = `${os}-${cpu}`;
  const file = `qisitv-connect-${key}${platform === 'win32' ? '.exe' : ''}`;
  const asset = manifest.assets?.[key];
  if (asset?.file !== file || !/^[a-f0-9]{64}$/.test(asset?.sha256 ?? '')) {
    throw new Error(`The qisiTV plugin has an invalid runtime checksum or filename for ${key}.`);
  }
  return { file, sha256: asset.sha256, url: RELEASE_BASE + file, version: VERSION };
}

export function cacheRoot({ platform = process.platform, env = process.env, home = homedir() } = {}) {
  if (env.QISITV_MCP_CACHE_DIR) {
    if (!path.isAbsolute(env.QISITV_MCP_CACHE_DIR)) {
      throw new Error('QISITV_MCP_CACHE_DIR must be an absolute directory.');
    }
    return env.QISITV_MCP_CACHE_DIR;
  }
  const paths = platform === 'win32' ? path.win32 : path.posix;
  let data;
  if (platform === 'darwin') {
    data = paths.join(home, 'Library', 'Application Support');
  } else if (platform === 'win32') {
    data = env.LOCALAPPDATA && paths.isAbsolute(env.LOCALAPPDATA) ? env.LOCALAPPDATA : paths.join(home, 'AppData', 'Local');
  } else {
    data = env.XDG_DATA_HOME && paths.isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : paths.join(home, '.local', 'share');
  }
  return paths.join(data, 'qisiTV', 'MCP', 'runtime');
}

async function hasChecksum(file, expected) {
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.size === 0 || info.size > MAX_BINARY_BYTES) return false;
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    return hash.digest('hex') === expected;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function checkedRedirect(location, previous) {
  let next;
  try {
    next = new URL(location, previous);
  } catch {
    throw new Error('The runtime download returned an invalid redirect.');
  }
  if (next.protocol !== 'https:' || next.username || next.password || next.port && next.port !== '443' || !REDIRECT_HOSTS.has(next.hostname)) {
    throw new Error('The runtime download redirected outside the allowed GitHub release hosts.');
  }
  return next.href;
}

async function fetchRelease(url, fetchImpl, signal) {
  for (let redirects = 0; redirects <= 5; redirects++) {
    const response = await fetchImpl(url, { redirect: 'manual', signal, headers: { Accept: 'application/octet-stream' } });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location) throw new Error('The runtime download returned an empty redirect.');
      url = checkedRedirect(location, url);
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`GitHub could not provide the qisiTV runtime (HTTP ${response.status}). Retry loading the plugin after checking your network.`);
    }
    return response;
  }
  throw new Error('The runtime download exceeded the GitHub redirect limit.');
}

export async function ensureRuntime(manifest, options = {}) {
  const { platform = process.platform, arch = process.arch, fetchImpl = globalThis.fetch, timeoutMs = 60_000, signal } = options;
  const asset = selectAsset(manifest, platform, arch);
  const directory = path.join(cacheRoot({ ...options, platform }), asset.version);
  const binary = path.join(directory, asset.file);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (await hasChecksum(binary, asset.sha256)) {
    if (platform !== 'win32') await chmod(binary, 0o755);
    return binary;
  }
  if (typeof fetchImpl !== 'function') throw new Error('qisiTV MCP requires Node.js 18 or newer.');

  const temporary = path.join(directory, `.${asset.file}.${process.pid}.${randomBytes(8).toString('hex')}.part`);
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason ?? new Error('Runtime download cancelled.'));
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const timeout = setTimeout(() => controller.abort(new Error('The qisiTV runtime download timed out. Check your network and reload the plugin.')), timeoutMs);
  let handle;
  try {
    const response = await fetchRelease(asset.url, fetchImpl, controller.signal);
    const declaredLength = response.headers.get('content-length');
    if (declaredLength !== null && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > MAX_BINARY_BYTES)) {
      await response.body?.cancel();
      throw new Error('The qisiTV runtime download exceeds its size limit.');
    }
    if (!response.body) throw new Error('The qisiTV runtime download was empty.');
    handle = await open(temporary, 'wx', 0o600);
    const hash = createHash('sha256');
    let bytes = 0;
    for await (const chunk of response.body) {
      controller.signal.throwIfAborted();
      bytes += chunk.byteLength;
      if (bytes > MAX_BINARY_BYTES) {
        controller.abort();
        throw new Error('The qisiTV runtime download exceeds its size limit.');
      }
      hash.update(chunk);
      await handle.writeFile(chunk);
    }
    controller.signal.throwIfAborted();
    if (bytes === 0 || hash.digest('hex') !== asset.sha256) {
      throw new Error('qisiTV runtime checksum verification failed. The downloaded file was discarded; no program was run.');
    }
    await handle.sync();
    await handle.close();
    handle = undefined;
    if (platform !== 'win32') await chmod(temporary, 0o755);
    try {
      await rename(temporary, binary);
    } catch (error) {
      // Another Codex chat may finish the same verified download first, and
      // Windows can deny replacing its running executable. Reuse only a match.
      if (!await hasChecksum(binary, asset.sha256)) throw error;
    }
    return binary;
  } catch (error) {
    if (controller.signal.aborted && controller.signal.reason instanceof Error && controller.signal.reason.message !== 'This operation was aborted') {
      throw controller.signal.reason;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
    await handle?.close();
    await rm(temporary, { force: true });
  }
}
