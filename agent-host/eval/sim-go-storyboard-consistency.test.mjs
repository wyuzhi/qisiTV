import { describe, expect, test } from 'bun:test';
import { createSimGo } from './sim-go.mjs';

function emptyCanvas(sim, canvasId) {
  return sim.ensureCanvas(canvasId, {
    id: canvasId,
    title: '分镜一致性',
    revision: 1,
    nodes: [],
    connections: [],
    timeline: null,
  });
}

describe('分镜行时长与真实后端一致', () => {
  test('新建分镜和追加行都要求 1..60 秒', () => {
    const sim = createSimGo();
    const canvasId = 'canvas-duration-prepare';
    emptyCanvas(sim, canvasId);
    sim.beginTurn({ turnId: 'turn-duration-prepare', canvasId, permissionMode: 'canvas' });
    const row = (seconds) => ({
      durationSeconds: seconds,
      plotDescription: '雨夜站台',
      imageGenerationPrompt: '雨夜站台首帧',
      videoMotionPrompt: '镜头缓推',
    });
    expect(() => sim.executeOp('canvas.script.prepare', {
      canvasId,
      expectedRevision: 1,
      script: { title: '长镜头', rows: [row(90)] },
      image: { model: 'seedream-3.0' },
    }, 'duration-prepare-1', 'turn-duration-prepare')).toThrow(/1 至 60 秒/);

    const prepared = sim.executeOp('canvas.script.prepare', {
      canvasId,
      expectedRevision: 1,
      script: { title: '长镜头', rows: [row(5)] },
      image: { model: 'seedream-3.0' },
    }, 'duration-prepare-2', 'turn-duration-prepare').result;
    expect(prepared.created.filter((item) => item.type === 'script').length).toBe(1);

    expect(() => sim.executeOp('canvas.script.rows.append', {
      canvasId,
      nodeId: prepared.nodeId,
      expectedRevision: 2,
      rows: [{ durationSeconds: 0, plotDescription: '零秒占位' }],
    }, 'duration-append-1', 'turn-duration-prepare')).toThrow(/1 至 60 秒/);
  });
});
