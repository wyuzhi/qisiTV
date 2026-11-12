// 评测场景共用的小工具：只放无业务状态的纯函数，避免场景文件之间互相 import 成环。

export function clone(val) {
  return val === undefined ? undefined : JSON.parse(JSON.stringify(val));
}

// 模拟后端里尚未进入真实后端的能力，由运行参数 --sim-capabilities 显式打开。
// 默认全关，基线测的就是今天真实后端能给外部 Agent 的工具。
export const SIM_CAPABILITIES = ['task.wait'];

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
  if (capabilities.includes('task.wait')) simGo.enableTaskWait();
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
