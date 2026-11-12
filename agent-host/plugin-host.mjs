// 插件宿主：在一个子进程里运行插件的 JS 生成接口（submit / query，可选 models）。
// 按行收发 JSON，Go 端按 id 配对；stdin 关闭且手上没有调用时退出。
// stdout 只留给协议，插件里的 console 输出改写到 stderr，由后端记日志。
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';

for (const name of ['log', 'info', 'debug']) console[name] = (...args) => console.error(...args);

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const modules = new Map();
const inflight = new Map();
let pending = 0;
let closed = false;

function load(file) {
  if (!modules.has(file)) modules.set(file, import(pathToFileURL(file).href));
  return modules.get(file);
}

async function run({ module, fn, args = {} }, signal) {
  const exports = await load(module);
  const impl = exports[fn] ?? exports.default?.[fn];
  // models 可以不写；返回 null 让后端提示用户手动添加模型。
  if (typeof impl !== 'function' && fn === 'models') return null;
  if (typeof impl !== 'function') throw new Error(`插件没有实现 ${fn}`);
  const ctx = { config: args.config ?? {}, signal, log: (message) => send({ event: 'log', level: 'info', message: String(message) }) };
  if (fn === 'models') return impl(ctx);
  return fn === 'submit' ? impl(args.request, ctx) : impl(args.taskId, args.request, ctx);
}

function finish() {
  if (--pending === 0 && closed) process.exit(0);
}

const lines = readline.createInterface({ input: process.stdin, terminal: false });
lines.on('line', (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.method === 'abort') {
    inflight.get(message.params?.id)?.abort(new Error('调用已取消'));
    // 回一句，后端靠它判断事件循环有没有卡死。
    send({ id: message.id, result: null });
    return;
  }
  pending++;
  if (message.method !== 'call') {
    send({ id: message.id, error: { message: `no method ${message.method}` } });
    finish();
    return;
  }
  const controller = new AbortController();
  inflight.set(message.id, controller);
  Promise.resolve()
    .then(() => run(message.params ?? {}, controller.signal))
    .then(
      (result) => send({ id: message.id, result: result ?? null }),
      (error) => send({ id: message.id, error: { message: String(error?.message ?? error) } }),
    )
    .finally(() => {
      inflight.delete(message.id);
      finish();
    });
});
lines.on('close', () => {
  closed = true;
  if (pending === 0) process.exit(0);
});
