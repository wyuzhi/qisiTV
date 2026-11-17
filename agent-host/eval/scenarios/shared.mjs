// 评测场景共用的小工具：只放无业务状态的纯函数，避免场景文件之间互相 import 成环。

export function clone(val) {
  return val === undefined ? undefined : JSON.parse(JSON.stringify(val));
}

// 模拟后端里尚未进入真实后端的能力，由运行参数 --sim-capabilities 显式打开。
// 默认全关，基线测的就是今天真实后端能给外部 Agent 的工具。
export const SIM_CAPABILITIES = [
  'task.wait',
  'canvas.timeline.deliver',
  'canvas.generation.regenerate',
  'canvas.nodes.configure',
  'canvas.nodes.get',
];

export function parseSimCapabilities(raw) {
  const list = String(raw || '').split(',').map((item) => item.trim()).filter(Boolean);
  for (const item of list) {
    if (!SIM_CAPABILITIES.includes(item)) {
      throw new Error(`未知的模拟能力: ${item}（可选: ${SIM_CAPABILITIES.join(', ')}）`);
    }
  }
  return [...new Set(list)];
}

export function applySimCapabilities(simGo, capabilities = []) {
  simGo.enableCapabilities(capabilities);
}

// 回复至少要说明结果已经产生。认「已生成 / 已经生成 / 生成好 / 完成 / 已绑定」等说法，
// 但排除「还没生成」「无法完成」这类否定句，避免把过程说明当成完成汇报。
const BLOCKED_BEFORE = /(尚未|还没|没有|没能|没|未能|无法|不能|未|会|将|要|准备|计划|打算|等|如果|一旦|要是|若|待|再|正在|还在|仍在|仍)$/;
const RESULT_PHRASE = /已经?(?:成功|顺利|全部|都|均|完成)*生成|生成好|生成完|完成|做完|绑定|写入|写到/;

function clauseReportsResult(clause) {
  let start = 0;
  while (start < clause.length) {
    const match = RESULT_PHRASE.exec(clause.slice(start));
    if (!match) return false;
    const index = start + match.index;
    const prefix = clause.slice(Math.max(0, index - 2), index);
    const rest = clause.slice(index + match[0].length);
    // 未来条件只认紧贴结果谓词的部分：结果用逗号断开后再说「之后可以查看」仍算已汇报结果；
    // 「生成完成后」「生成完毕后」则是过程说明，不算结果。
    const localRest = rest.split(/[，,。；;、]/)[0];
    const future = rest.startsWith('后') ||
      /^(?:完成|完毕|成|毕)后/.test(rest) ||
      localRest.includes('之后') ||
      localRest.includes('以后');
    const failed = /^(?:失败|出错|报错)/.test(rest);
    const progressing = /^中(?=[，。；、\s]|$)/.test(rest);
    const partial = /^(?:一半|部分|一部分)/.test(rest);
    if (!BLOCKED_BEFORE.test(prefix) && !future && !failed && !progressing && !partial) return true;
    if (future) {
      // 未来条件后的同一段是计划描述，不能把其中的「绑定」等动作再当成已完成结果。
      const nextBreak = rest.search(/[，,。；;、\n]/);
      if (nextBreak === -1) return false;
      start = index + match[0].length + nextBreak + 1;
      continue;
    }
    start = index + match[0].length;
  }
  return false;
}

export function replyReportsResult(text) {
  return String(text || '')
    .split(/[。；\n]/)
    .some((clause) => clauseReportsResult(clause));
}

// 收尾等待由场景声明；只有明确需要更久的场景才放宽，其他场景保持原有上限。
export function resolveSettleTimeoutMs(scenario = {}, modelMode = 'fake') {
  const explicit = Number(scenario.settleTimeoutMs);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  return modelMode === 'fake' ? 10_000 : 120_000;
}

// 回合字段 waitForTasksBeforeTurnMs：开始这一轮前，等本画布上运行中的任务结束，最多等这么久。
// 模拟「用户隔了一会儿才回来问」，不替 Agent 绑定任何结果。
export async function waitForCanvasTasks(simGo, canvasId, maxMs, pollMs = 250) {
  const deadline = Date.now() + Math.max(0, Number(maxMs) || 0);
  for (;;) {
    const running = simGo.snapshot().tasks.filter((task) => task.canvasId === canvasId && task.status === 'running');
    if (running.length === 0) return { settled: true, running: 0 };
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { settled: false, running: running.length };
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, remaining)));
  }
}

// 竖屏 9:16 的精确判定：比例写法必须正好是 9:16（忽略空白）；
// 像素写法按宽高计算比例，与 9/16 的相对偏差不超过 1%。
export function isPortrait916(sizeVal) {
  const compact = String(sizeVal || '').trim().replace(/\s+/g, '').toLowerCase();
  if (!compact) return false;
  if (compact === '9:16') return true;
  const match = /^(\d+)x(\d+)$/.exec(compact);
  if (!match) return false;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!(width > 0) || !(height > 0)) return false;
  return Math.abs(width / height - 9 / 16) / (9 / 16) <= 0.01;
}
