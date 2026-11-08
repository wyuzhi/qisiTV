import { test, expect } from 'bun:test';
import { canConfirmRound, roundStopReason } from './real-gen-policy.mjs';

test('正常回合可以确认并继续', () => {
  const round = { status: 'done', error: '', tasks: [{ status: 'succeeded' }] };
  expect(canConfirmRound(round)).toBe(true);
  expect(roundStopReason(round)).toBe('');
});

test('回合失败或超时不再确认', () => {
  for (const round of [{ status: 'failed', error: 'boom' }, { status: 'timeout', error: 'slow' }, { status: 'done', error: 'x' }]) {
    expect(canConfirmRound(round)).toBe(false);
    expect(roundStopReason(round)).toStartWith('turn_');
  }
});

test('任务失败或取消后停止后续轮次', () => {
  expect(roundStopReason({ status: 'done', error: '', tasks: [{ status: 'failed' }] })).toBe('task_failed');
  expect(roundStopReason({ status: 'done', error: '', tasks: [{ status: 'cancelled' }] })).toBe('task_cancelled');
});

test('三轮都正常回复但缺产物时列出缺口，判失败', async () => {
  const { completenessGaps } = await import('./real-gen-policy.mjs');
  expect(completenessGaps([], [])).toEqual([
    'image 成功任务 0/2', 'image 已下载产物 0/2', 'video 成功任务 0/2', 'video 已下载产物 0/2', 'render 成功任务 0/1', 'render 已下载产物 0/1',
  ]);
  const tasks = [
    { type: 'canvas_image', status: 'succeeded' }, { type: 'canvas_image', status: 'succeeded' },
    { type: 'canvas_video', status: 'succeeded' }, { type: 'canvas_video', status: 'failed' },
    { type: 'timeline_render', status: 'succeeded' },
  ];
  const artifacts = [
    { kind: 'image', bytes: 10 }, { kind: 'image', bytes: 10 }, { kind: 'video', bytes: 10 }, { kind: 'render', bytes: 0 },
  ];
  expect(completenessGaps(tasks, artifacts)).toEqual(['video 成功任务 1/2', 'video 已下载产物 1/2', 'render 已下载产物 0/1']);
  const ok = [...tasks.slice(0, 3), { type: 'canvas_video', status: 'succeeded' }, tasks[4]];
  const saved = [...artifacts.slice(0, 3), { kind: 'video', bytes: 5 }, { kind: 'render', bytes: 5 }];
  expect(completenessGaps(ok, saved)).toEqual([]);
});
