// Isolated child used by Go supervisor tests. No model SDK, no paid calls.
import http from 'node:http';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';

const LISTEN_FD = Number(process.env.BEEFTV_AGENT_LISTEN_FD || 0);
const LISTEN_PIPE = String(process.env.BEEFTV_AGENT_PIPE || '').trim();
const PORT_RAW = String(process.env.BEEFTV_AGENT_PORT || '').trim();
const INSTANCE_NONCE = process.env.BEEFTV_AGENT_INSTANCE_NONCE || '';
const LIFETIME_STDIN = process.env.BEEFTV_AGENT_LIFETIME_STDIN === '1';
const DATA_DIR = process.env.BEEFTV_AGENT_DATA_DIR || '';
const MODEL = process.env.BEEFTV_AGENT_MODEL || '';
if (!LISTEN_FD && !LISTEN_PIPE && !PORT_RAW) {
  console.error('owned-listener: missing BEEFTV_AGENT_PORT, BEEFTV_AGENT_PIPE, or BEEFTV_AGENT_LISTEN_FD');
  process.exit(2);
}

function instanceProof() {
  if (!INSTANCE_NONCE) return '';
  return crypto.createHash('sha256').update(INSTANCE_NONCE).digest('hex').slice(0, 16);
}

function timingSafeMatch(got, expected) {
  const a = Buffer.from(String(got ?? ''));
  const b = Buffer.from(String(expected ?? ''));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function instanceOK(req) {
  if (!INSTANCE_NONCE) return true;
  return timingSafeMatch(req.headers['x-beeftv-instance-nonce'] || '', INSTANCE_NONCE);
}

if (DATA_DIR) {
  try {
    fs.writeFileSync(path.join(DATA_DIR, 'spawned.marker'), String(process.pid));
    fs.writeFileSync(path.join(DATA_DIR, 'ops-pipe.txt'), String(process.env.BEEFTV_OPS_PIPE || ''));
  } catch { /* marker is best-effort */ }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (req.method === 'GET' && url.pathname === '/health') {
    if (!instanceOK(req)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, reason: 'instance_mismatch' }));
      return;
    }
    if (DATA_DIR && fs.existsSync(path.join(DATA_DIR, 'hang-health'))) {
      return;
    }
    const busy = DATA_DIR && fs.existsSync(path.join(DATA_DIR, 'busy'));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true, busy, model: MODEL, instance: instanceProof() || undefined,
    }));
    return;
  }
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: false, reason: 'not_found' }));
});

function onListen() {
  const bound = server.address();
  if (typeof bound === 'string') {
    console.log('owned-listener local-pipe');
    return;
  }
  const port = bound && typeof bound === 'object' ? bound.port : PORT_RAW;
  console.log(`owned-listener http://127.0.0.1:${port}`);
}

if (LISTEN_FD > 0) server.listen({ fd: LISTEN_FD }, onListen);
else if (LISTEN_PIPE) {
  if (process.platform !== 'win32' && LISTEN_PIPE.endsWith('.sock')) {
    try { fs.unlinkSync(LISTEN_PIPE); } catch { /* ignore ENOENT */ }
  }
  server.listen(LISTEN_PIPE, onListen);
} else server.listen(Number(PORT_RAW), '127.0.0.1', onListen);

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
}
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
if (LIFETIME_STDIN) {
  process.stdin.resume();
  process.stdin.on('end', shutdown);
  process.stdin.on('error', shutdown);
}
