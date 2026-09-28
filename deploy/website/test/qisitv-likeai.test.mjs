import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHandler, isPublicIP, resolvePublicTarget, LIMITS } from '../api/qisitv/likeai.ts';

const ORIGIN = 'https://cheeser.link';
const PREFIX = ORIGIN + '/api/qisitv/likeai';
const KEY = 'test-only-user-key';
const encoder = new TextEncoder();
function response(data, status = 200, headers = {}) {
  const bytes = typeof data === 'string' ? encoder.encode(data) : encoder.encode(JSON.stringify(data));
  return { status, headers: new Headers(headers), body: new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }) };
}
function request(path, init = {}) {
  return new Request(PREFIX + path, { ...init, headers: { Origin: ORIGIN, 'X-API-Key': KEY, ...init.headers } });
}
const completed = (url) => ({ code: 200, data: { status: 'completed', result: { videos: [url] } } });

test('only the documented methods and fixed paths are forwarded; no caller headers leak', async () => {
  const calls = [];
  const handler = createHandler(async (url, options) => { calls.push({ url, options }); return response({ code: 200, data: [] }); });
  const result = await handler(request('/task/models', { headers: { Cookie: 'site-cookie', Authorization: 'Bearer unused', 'X-Canvas-Upstream-URL': 'https://evil.test' } }));
  assert.equal(result.status, 200);
  assert.equal(calls[0].url, 'https://task.likeai.pro/task-api/task/models');
  assert.deepEqual(calls[0].options.headers, { 'X-API-Key': KEY, Accept: 'application/json' });
  assert.equal(result.headers.get('cache-control'), 'no-store, max-age=0');
  assert.equal(result.headers.get('access-control-allow-origin'), null);
  for (const path of ['/task/models?url=https://evil.test', '/task/query_task/a%2fb', '/task/delete_task/123', '/anything', '/task/cancel_task/123']) {
    assert.ok((await handler(request(path))).status >= 400, path);
  }
  assert.equal((await handler(request('/task/models', { method: 'POST' }))).status, 404);
  assert.equal(calls.length, 1);
});

test('same origin browser GET and local test origin are allowed; foreign/missing origins and keys fail', async () => {
  let calls = 0;
  const handler = createHandler(async () => { calls++; return response({ code: 200 }); });
  for (const init of [{ headers: { Origin: 'https://evil.test' } }, { headers: { 'X-API-Key': '' } }]) assert.ok((await handler(request('/task/models', init))).status >= 400);
  assert.equal((await handler(new Request(PREFIX + '/task/models', { headers: { 'X-API-Key': KEY } }))).status, 403);
  assert.equal((await handler(new Request(PREFIX + '/task/models', { headers: { 'X-API-Key': KEY, 'Sec-Fetch-Site': 'same-origin' } }))).status, 200);
  assert.equal((await handler(new Request('http://localhost:4321/api/qisitv/likeai/task/models', { headers: { Origin: 'http://localhost:4321', 'X-API-Key': KEY } }))).status, 200);
  assert.equal(calls, 2);
});

test('static-site rewrite route is accepted without allowing URL or query overrides', async () => {
  const calls = [];
  const handler = createHandler(async (url) => { calls.push(url); return response({ code: 200 }); });
  assert.equal((await handler(request('?__route=task/models'))).status, 200);
  assert.equal((await handler(request('/task/query_task/one?__route=task/query_task/one'))).status, 200);
  assert.equal((await handler(request('/task/models?__route=task/create_task'))).status, 400);
  assert.equal((await handler(request('?__route=task/models&url=https://evil.test'))).status, 400);
  assert.equal((await handler(request('?__route=task/models&__route=task/models'))).status, 400);
  assert.equal((await handler(request('?__route=https://evil.test'))).status, 404);
  assert.equal(calls.length, 2);
});

test('task creation forwards exactly once and never retries errors', async () => {
  let calls = 0;
  const handler = createHandler(async (url, options) => {
    calls++;
    assert.equal(url, 'https://task.likeai.pro/task-api/task/create_task');
    assert.equal(options.method, 'POST');
    assert.equal(new TextDecoder().decode(options.body), '{"api_name":"test_model","prompt":"test"}');
    throw new Error('private network failure ' + KEY);
  });
  const result = await handler(request('/task/create_task', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"api_name":"test_model","prompt":"test"}' }));
  assert.equal(result.status, 502);
  assert.equal(calls, 1);
  assert.ok(!(await result.text()).includes(KEY));
});

test('invalid JSON or missing model never reaches upstream', async () => {
  const handler = createHandler(async () => { assert.fail('must not call upstream'); });
  for (const body of ['{', '{}', 'null', '[]']) {
    assert.equal((await handler(request('/task/create_task', { method: 'POST', body, headers: { 'Content-Type': 'application/json' } }))).status, 400);
  }
});

test('upload is bounded before sending anything upstream', async () => {
  const calls = [];
  const handler = createHandler(async (url, options) => { calls.push({ url, options }); return response({ code: 200, data: { url: 'https://cdn.example/ref.png' } }); });
  const form = new FormData(); form.set('file', new Blob(['sample'], { type: 'image/png' }), 'ref.png');
  assert.equal((await handler(request('/files', { method: 'POST', body: form }))).status, 200);
  assert.equal(calls[0].url, 'https://task.likeai.pro/task-api/files');
  assert.match(calls[0].options.headers['Content-Type'], /^multipart\/form-data; boundary=/);
  const huge = await handler(request('/files', { method: 'POST', headers: { 'Content-Type': 'multipart/form-data; boundary=x' }, body: new Uint8Array(LIMITS.upload + 1) }));
  assert.equal(huge.status, 413);
  assert.equal(calls.length, 1);
});

test('redirects from the credentialed API are not followed and echoed keys are redacted', async () => {
  let calls = 0;
  const handler = createHandler(async () => { calls++; return response('', 302, { Location: 'https://evil.test' }); });
  assert.equal((await handler(request('/task/models'))).status, 502);
  assert.equal(calls, 1);
  const redacted = await createHandler(async () => response({ code: 400, msg: KEY }, 400))(request('/task/models'));
  assert.ok(!(await redacted.text()).includes(KEY));
});

test('artifact authorization is queried before download; no key or cookie reaches CDN or redirects', async () => {
  const calls = [];
  const handler = createHandler(async (url, options) => {
    calls.push({ url, options });
    if (calls.length === 1) return response(completed('https://cdn.example/result.mp4'));
    if (calls.length === 2) return response('', 302, { Location: '/final.mp4' });
    return response('video-bytes', 200, { 'Content-Type': 'video/mp4', 'Content-Length': '11' });
  });
  const result = await handler(request('/task/artifact/task-1/video/0'));
  assert.equal(result.status, 200);
  assert.equal(await result.text(), 'video-bytes');
  assert.equal(calls[0].url, 'https://task.likeai.pro/task-api/task/query_task/task-1');
  assert.equal(calls[0].options.headers['X-API-Key'], KEY);
  for (const call of calls.slice(1)) {
    assert.equal(call.options.headers['X-API-Key'], undefined);
    assert.equal(call.options.headers.Cookie, undefined);
    assert.equal(call.options.headers.Authorization, undefined);
  }
  assert.equal(calls[2].url, 'https://cdn.example/final.mp4');
});

test('artifact API rejects unowned, unfinished, absent and unsafe results', async () => {
  for (const payload of [{ code: 401 }, { code: 200, data: { status: 'running' } }, completed(undefined), completed('http://cdn.example/insecure.mp4'), completed('https://user:pass@cdn.example/result.mp4')]) {
    let calls = 0;
    const result = await createHandler(async () => { calls++; return response(payload); })(request('/task/artifact/task-1/video/0'));
    assert.ok(result.status >= 400);
    assert.equal(calls, 1);
  }
});

test('artifact stream works above 4.5MB without buffering response; local size cap enforced', async () => {
  let calls = 0;
  const chunk = new Uint8Array(1_000_000);
  const handler = createHandler(async () => {
    if (++calls === 1) return response(completed('https://cdn.example/result.mp4'));
    let sent = 0;
    return { status: 200, headers: new Headers({ 'Content-Type': 'video/mp4' }), body: new ReadableStream({ pull(controller) { if (sent++ === 6) controller.close(); else controller.enqueue(chunk); } }) };
  });
  const result = await handler(request('/task/artifact/task-1/video/0'));
  assert.equal(result.status, 200);
  assert.equal((await result.arrayBuffer()).byteLength, 6_000_000);
  calls = 0;
  const tooLarge = await createHandler(async () => ++calls === 1 ? response(completed('https://cdn.example/result.mp4')) : response('', 200, { 'Content-Type': 'video/mp4', 'Content-Length': String(LIMITS.artifact + 1) }))(request('/task/artifact/task-1/video/0'));
  assert.equal(tooLarge.status, 413);
});

test('media type and redirect cap stop invalid artifact responses', async () => {
  let calls = 0;
  const wrongType = await createHandler(async () => ++calls === 1 ? response(completed('https://cdn.example/result.mp4')) : response('<html>bad</html>', 200, { 'Content-Type': 'text/html' }))(request('/task/artifact/task-1/video/0'));
  assert.equal(wrongType.status, 502);
  calls = 0;
  const looping = await createHandler(async () => ++calls === 1 ? response(completed('https://cdn.example/result.mp4')) : response('', 302, { Location: '/loop' }))(request('/task/artifact/task-1/video/0'));
  assert.equal(looping.status, 502);
  assert.equal(calls, 6);
});

test('public-IP validation rejects private, local, mapped, documentation and transition networks', async () => {
  for (const ip of ['127.0.0.1', '0.0.0.0', '10.1.1.1', '172.16.1.2', '192.168.1.1', '100.64.0.1', '169.254.169.254', '192.0.2.1', '224.1.1.1', '::', '::1', '::ffff:127.0.0.1', 'fc00::1', 'fe80::1', '2001:db8::1', '2002:7f00:1::']) assert.equal(isPublicIP(ip), false, ip);
  assert.equal(isPublicIP('1.1.1.1'), true);
  assert.equal(isPublicIP('2606:4700:4700::1111'), true);
  await assert.rejects(resolvePublicTarget('https://127.0.0.1/a'));
  await assert.rejects(resolvePublicTarget('https://cdn.example/a', async () => [{ address: '1.1.1.1', family: 4 }, { address: '10.0.0.1', family: 4 }]));
  const target = await resolvePublicTarget('https://cdn.example/a', async () => [{ address: '1.1.1.1', family: 4 }]);
  assert.equal(target.address, '1.1.1.1');
});
