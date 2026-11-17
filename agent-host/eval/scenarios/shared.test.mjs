import { describe, expect, test } from 'bun:test';
import {
  parseSimCapabilities,
  applySimCapabilities,
  waitForCanvasTasks,
  replyReportsResult,
  resolveSettleTimeoutMs,
} from './shared.mjs';

describe('模拟能力开关', () => {
  test('默认全关，只认已知能力', () => {
    expect(parseSimCapabilities('')).toEqual([]);
    expect(parseSimCapabilities(' task.wait ,task.wait')).toEqual(['task.wait']);
    expect(parseSimCapabilities('canvas.timeline.deliver,canvas.nodes.get')).toEqual([
      'canvas.timeline.deliver',
      'canvas.nodes.get',
    ]);
    expect(() => parseSimCapabilities('task.wait,canvas.summary')).toThrow('未知的模拟能力');
  });

  test('打开能力时交给模拟后端，一次调用带齐全部开关', () => {
    let enabled = null;
    const simGo = { enableCapabilities: (names) => { enabled = names; } };
    applySimCapabilities(simGo, []);
    expect(enabled).toEqual([]);
    applySimCapabilities(simGo, ['task.wait', 'canvas.generation.regenerate']);
    expect(enabled).toEqual(['task.wait', 'canvas.generation.regenerate']);
  });
});

describe('回合前等任务', () => {
  test('任务结束就返回，不替 Agent 改任何东西', async () => {
    const tasks = [{ canvasId: 'c1', status: 'running' }, { canvasId: 'c2', status: 'running' }];
    setTimeout(() => { tasks[0].status = 'succeeded'; }, 30);
    const simGo = { snapshot: () => ({ tasks: tasks.map((t) => ({ ...t })) }) };
    const result = await waitForCanvasTasks(simGo, 'c1', 2000, 5);
    expect(result).toEqual({ settled: true, running: 0 });
    expect(tasks[1].status).toBe('running');
  });

  test('超时后如实返回还在跑的数量', async () => {
    const simGo = { snapshot: () => ({ tasks: [{ canvasId: 'c1', status: 'running' }] }) };
    const result = await waitForCanvasTasks(simGo, 'c1', 20, 5);
    expect(result).toEqual({ settled: false, running: 1 });
  });
});

describe('回复是否说明了生成结果', () => {
  test('接受「已经生成」「生成好」「完成」等同义说法', () => {
    expect(replyReportsResult('「镜 1 首帧」已经生成，并且绑定到了该节点。')).toBe(true);
    expect(replyReportsResult('镜 1 首帧已生成并绑定到节点。')).toBe(true);
    expect(replyReportsResult('首帧和视频都生成好了，已写到节点。')).toBe(true);
    expect(replyReportsResult('这一批已经完成。')).toBe(true);
    expect(replyReportsResult('已经成功生成并保存到素材库。')).toBe(true);
    expect(replyReportsResult('已生成中文字幕。')).toBe(true);
    expect(replyReportsResult('首帧已生成，之后可在素材库查看。')).toBe(true);
  });

  test('过程说明和否定句不算结果', () => {
    expect(replyReportsResult('还在生成中，请稍候。')).toBe(false);
    expect(replyReportsResult('目前还没有生成任何图。')).toBe(false);
    expect(replyReportsResult('这个任务无法完成。')).toBe(false);
    expect(replyReportsResult('生成明细：模型 Seedream 3.0，1 张。')).toBe(false);
    expect(replyReportsResult('已开始生成，请稍候。')).toBe(false);
    expect(replyReportsResult('还在完成中，请稍候。')).toBe(false);
    expect(replyReportsResult('正在完成，马上好。')).toBe(false);
    expect(replyReportsResult('视频绑定失败。')).toBe(false);
    expect(replyReportsResult('已经生成失败。')).toBe(false);
    expect(replyReportsResult('绑定到节点之后就可以预览。')).toBe(false);
    expect(replyReportsResult('已生成中，稍候。')).toBe(false);
    expect(replyReportsResult('没生成好，稍等。')).toBe(false);
    expect(replyReportsResult('生成好了之后我再绑定到节点。')).toBe(false);
    expect(replyReportsResult('等生成好之后我会告诉您。')).toBe(false);
    expect(replyReportsResult('任务只完成一半。')).toBe(false);
    expect(replyReportsResult('生成完成后会自动绑定到节点。')).toBe(false);
    expect(replyReportsResult('生成完毕后会通知您。')).toBe(false);
    expect(replyReportsResult('')).toBe(false);
  });
});

describe('场景收尾等待', () => {
  test('只有声明了 settleTimeoutMs 的场景放宽，其他保持原上限', () => {
    expect(resolveSettleTimeoutMs({}, 'fake')).toBe(10_000);
    expect(resolveSettleTimeoutMs({}, 'real')).toBe(120_000);
    expect(resolveSettleTimeoutMs({ settleTimeoutMs: 600_000 }, 'real')).toBe(600_000);
    expect(resolveSettleTimeoutMs({ settleTimeoutMs: 600_000 }, 'fake')).toBe(600_000);
  });
});
