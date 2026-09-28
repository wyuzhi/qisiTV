import { lookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';
import { Readable } from 'node:stream';

export const config = { maxDuration: 180, supportsResponseStreaming: true };
export const LIMITS = { upload: 4_200_000, json: 2_000_000, artifact: 128 * 1024 * 1024, timeoutMs: 120_000 };
const PREFIX = '/api/qisitv/likeai';
const UPSTREAM = 'https://task.likeai.pro/task-api';
const TASK_ID = '[A-Za-z0-9_-]{1,160}';
const HEADERS = {
  'Cache-Control': 'no-store, max-age=0',
  'CDN-Cache-Control': 'no-store',
  'Vercel-CDN-Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

class RelayError extends Error {
  status: number;
  reason: string;
  constructor(status: number, reason: string, message: string) { super(message); this.status = status; this.reason = reason; }
}

const blockedV4 = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blockedV4.addSubnet(address, prefix, 'ipv4');
const publicV6 = new BlockList();
publicV6.addSubnet('2000::', 3, 'ipv6');
const blockedV6 = new BlockList();
for (const [address, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]] as const) {
  blockedV6.addSubnet(address, prefix, 'ipv6');
}

export function isPublicIP(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blockedV4.check(address, 'ipv4');
  return family === 6 && publicV6.check(address, 'ipv6') && !blockedV6.check(address, 'ipv6');
}

export async function resolvePublicTarget(raw: string, resolver = lookup) {
  let url: URL;
  try { url = new URL(raw); } catch { throw new RelayError(502, 'unsafe_artifact', '生成结果地址无效'); }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || url.hash) {
    throw new RelayError(502, 'unsafe_artifact', '生成结果必须使用公共 HTTPS 地址');
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(hostname)
    ? [{ address: hostname, family: isIP(hostname) }]
    : await resolver(hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some((entry) => !isPublicIP(entry.address))) {
    throw new RelayError(502, 'unsafe_artifact', '生成结果地址不可访问');
  }
  return { url, address: addresses[0].address, family: addresses[0].family };
}

type UpstreamResponse = { status: number; headers: Headers; body: ReadableStream<Uint8Array> };
type OutboundOptions = { method?: string; headers?: Record<string, string>; body?: Uint8Array; signal: AbortSignal };
type Transport = (url: string, options: OutboundOptions) => Promise<UpstreamResponse>;

// DNS is checked once per hop and pinned to that address for the TLS connection.
// User headers, cookies and credentials are never reused for artifact requests.
export const requestPublicHTTPS: Transport = async (raw, options) => {
  const target = await resolvePublicTarget(raw);
  return new Promise((resolve, reject) => {
    const request = httpsRequest(target.url, {
      method: options.method || 'GET',
      headers: options.headers,
      signal: options.signal,
      agent: false,
      lookup: (_hostname, _options, callback) => {
        if ((_options as { all?: boolean }).all) callback(null, [{ address: target.address, family: target.family }] as never);
        else callback(null, target.address, target.family);
      },
    }, (response) => {
      const headers = new Headers();
      for (const [key, value] of Object.entries(response.headers)) {
        if (typeof value === 'string') headers.set(key, value);
      }
      resolve({ status: response.statusCode || 502, headers, body: Readable.toWeb(response) as ReadableStream<Uint8Array> });
    });
    request.on('error', reject);
    request.end(options.body);
  });
};

function isAllowedOrigin(value: string): boolean {
  if (value === 'https://cheeser.link' || value === 'https://www.cheeser.link') return true;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost') && value === url.origin;
  } catch { return false; }
}

function checkRequest(request: Request): { path: string; key: string } {
  const url = new URL(request.url);
  let origin = request.headers.get('origin');
  if (!origin && request.headers.get('sec-fetch-site') === 'same-origin') origin = url.origin;
  if (!origin || !isAllowedOrigin(origin) || !isAllowedOrigin(url.origin) || origin !== url.origin) {
    throw new RelayError(403, 'origin_rejected', '请从起司网站内使用该功能');
  }
  // The static Astro Vercel build needs an explicit rewrite into this function.
  // Accept only its route parameter; it never becomes a host or arbitrary URL.
  const rewritePath = url.searchParams.get('__route');
  if ([...url.searchParams.keys()].some((name) => name !== '__route') || url.searchParams.getAll('__route').length > 1) throw new RelayError(400, 'invalid_path', '接口地址无效');
  let path = url.pathname.startsWith(PREFIX + '/') ? url.pathname.slice(PREFIX.length) : '';
  if (rewritePath !== null) {
    if (path && path !== '/' + rewritePath) throw new RelayError(400, 'invalid_path', '接口地址无效');
    if (url.pathname !== PREFIX && !path) throw new RelayError(400, 'invalid_path', '接口地址无效');
    path = '/' + rewritePath;
  }
  if (!path) throw new RelayError(400, 'invalid_path', '接口地址无效');
  const key = request.headers.get('x-api-key') || '';
  if (!key || key.length > 512 || /[\s\x00-\x1f\x7f]/.test(key)) throw new RelayError(401, 'api_key_required', '请填写自己的 LikeAI API Key');
  return { path, key };
}

async function readLimited(body: ReadableStream<Uint8Array> | null, limit: number): Promise<Uint8Array> {
  if (!body) return new Uint8Array();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > limit) throw new RelayError(413, 'payload_too_large', '文件或响应过大，请使用原始下载链接或 HTTPS 素材链接');
      chunks.push(next.value);
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}

function checkLength(headers: Headers, limit: number) {
  const size = headers.get('content-length');
  if (size && (!/^\d+$/.test(size) || Number(size) > limit)) throw new RelayError(413, 'payload_too_large', '文件过大，请使用原始下载链接或 HTTPS 素材链接');
}

async function likeAIJSON(transport: Transport, path: string, key: string, signal: AbortSignal, method = 'GET', body?: Uint8Array, contentType?: string) {
  const response = await transport(UPSTREAM + path, {
    method, signal, body,
    headers: { 'X-API-Key': key, Accept: 'application/json', ...(contentType ? { 'Content-Type': contentType } : {}) },
  });
  if (response.status >= 300 && response.status < 400) {
    await response.body.cancel();
    throw new RelayError(502, 'upstream_redirect', 'LikeAI 接口返回了不支持的跳转');
  }
  const raw = new TextDecoder().decode(await readLimited(response.body, LIMITS.json));
  let payload: unknown;
  try { payload = JSON.parse(raw.split(key).join('[REDACTED]')); }
  catch { throw new RelayError(502, 'invalid_upstream_response', 'LikeAI 返回了无效响应'); }
  return { status: response.status, payload };
}

export async function artifactResponse(transport: Transport, task: string, kind: string, index: number, key: string, signal: AbortSignal) {
  const query = await likeAIJSON(transport, '/task/query_task/' + task, key, signal);
  const payload = query.payload as { code?: number; data?: { status?: string; result?: Record<string, unknown> } };
  if (query.status !== 200 || payload.code !== 200) throw new RelayError(query.status >= 400 ? query.status : 502, 'task_query_failed', '无法读取该 LikeAI 任务');
  if (payload.data?.status !== 'completed') throw new RelayError(409, 'task_not_completed', '生成任务尚未完成');
  const items = payload.data.result?.[kind + 's'];
  const item = Array.isArray(items) ? items[index] : undefined;
  const raw = typeof item === 'string' ? item : item && typeof item === 'object' ? (item as { url?: unknown }).url : undefined;
  if (typeof raw !== 'string' || !raw) throw new RelayError(404, 'artifact_missing', '生成任务没有这个结果文件');
  let target = raw;
  for (let hop = 0; hop <= 4; hop++) {
    // Validate every redirect even when tests inject a mock transport.
    let parsed: URL;
    try { parsed = new URL(target); } catch { throw new RelayError(502, 'unsafe_artifact', '生成结果地址无效'); }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || (parsed.port && parsed.port !== '443') || parsed.hash) throw new RelayError(502, 'unsafe_artifact', '生成结果地址不可访问');
    const response = await transport(target, { signal, headers: { Accept: `${kind}/*, application/octet-stream`, 'Accept-Encoding': 'identity' } });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body.cancel();
      const location = response.headers.get('location');
      if (!location || hop === 4) throw new RelayError(502, 'artifact_redirect', '生成结果跳转次数过多');
      target = new URL(location, target).href;
      continue;
    }
    if (response.status !== 200) { await response.body.cancel(); throw new RelayError(502, 'artifact_download_failed', '生成结果下载失败，可尝试原始下载链接'); }
    try { checkLength(response.headers, LIMITS.artifact); }
    catch (error) { await response.body.cancel(); throw error; }
    const contentType = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if ((!contentType.startsWith(kind + '/') && contentType !== 'application/octet-stream') || contentType === 'image/svg+xml') {
      await response.body.cancel();
      throw new RelayError(502, 'invalid_artifact_type', '生成结果不是预期的媒体文件');
    }
    let bytes = 0;
    const stream = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        bytes += chunk.byteLength;
        if (bytes > LIMITS.artifact) throw new RelayError(413, 'artifact_too_large', '生成结果超过 128 MiB，请使用原始下载链接');
        controller.enqueue(chunk);
      },
    }));
    return new Response(stream, { headers: { ...HEADERS, 'Content-Type': contentType, 'Content-Security-Policy': "default-src 'none'; sandbox" } });
  }
  throw new RelayError(502, 'artifact_redirect', '生成结果跳转次数过多');
}

export function createHandler(transport: Transport = requestPublicHTTPS) {
  return async (request: Request): Promise<Response> => {
    try {
      const { path, key } = checkRequest(request);
      const signal = AbortSignal.any([request.signal, AbortSignal.timeout(LIMITS.timeoutMs)]);
      const artifact = new RegExp(`^/task/artifact/(${TASK_ID})/(image|video|audio)/(0|[1-9][0-9]{0,2})$`).exec(path);
      if (request.method === 'GET' && artifact) return await artifactResponse(transport, artifact[1], artifact[2], Number(artifact[3]), key, signal);
      const catalog = request.method === 'GET' && path === '/task/models';
      const query = request.method === 'GET' && new RegExp(`^/task/query_task/${TASK_ID}$`).test(path);
      const create = request.method === 'POST' && path === '/task/create_task';
      const upload = request.method === 'POST' && path === '/files';
      if (!catalog && !query && !create && !upload) throw new RelayError(404, 'unsupported_route', '接口不存在；取消只停止本地等待');
      let body: Uint8Array | undefined;
      const contentType = request.headers.get('content-type') || '';
      if (create || upload) {
        if (create ? !/^application\/json(?:;|$)/i.test(contentType) : !/^multipart\/form-data;\s*boundary=[\x21-\x7e]{1,200}$/i.test(contentType)) throw new RelayError(415, 'invalid_content_type', '请求格式无效');
        const limit = upload ? LIMITS.upload : LIMITS.json;
        checkLength(request.headers, limit);
        body = await readLimited(request.body, limit);
        if (create) {
          let input: { api_name?: unknown };
          try { input = JSON.parse(new TextDecoder().decode(body)); } catch { throw new RelayError(400, 'invalid_json', '生成请求不是有效 JSON'); }
          if (!input || typeof input !== 'object' || typeof input.api_name !== 'string' || !input.api_name.trim()) throw new RelayError(400, 'model_required', '请选择 LikeAI 模型');
        }
      }
      const result = await likeAIJSON(transport, path, key, signal, request.method, body, body ? contentType : undefined);
      return Response.json(result.payload, { status: result.status, headers: HEADERS });
    } catch (error) {
      const known = error instanceof RelayError;
      return Response.json({ code: known ? error.status : 502, reason: known ? error.reason : 'relay_failed', msg: known ? error.message : '请求未能完成，请先查询任务状态，避免重复提交' }, { status: known ? error.status : 502, headers: HEADERS });
    }
  };
}

export default { fetch: createHandler() };
