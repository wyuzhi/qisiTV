import { describe, expect, test } from 'bun:test';
import { parseSimCapabilities, applySimCapabilities, waitForCanvasTasks } from './shared.mjs';

describe('模拟能力开关', () => {
  test('默认全关，只认已知能力', () => {
    expect(parseSimCapabilities('')).toEqual([]);
    expect(parseSimCapabilities(' task.wait ,task.wait')).toEqual(['task.wait']);
    expect(() => parseSimCapabilities('task.wait,canvas.summary')).toThrow('未知的模拟能力');
  });

  test('打开 task.wait 才调用模拟后端的开关', () => {
    let enabled = 0;
    const simGo = { enableTaskWait: () => { enabled += 1; } };
    applySimCapabilities(simGo, []);
    expect(enabled).toBe(0);
    applySimCapabilities(simGo, ['task.wait']);
    expect(enabled).toBe(1);
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
