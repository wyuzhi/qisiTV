import { test, expect, describe } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createSimGo } from './sim-go.mjs';
import { SCENARIOS, resolveScenarioList, buildS3SeedCanvas } from './scenarios.mjs';
import {
  parseCliArgs,
  validateEvalConfig,
  redactSecrets,
  extractModelRequestTrace,
  createCostMeter,
  computeScenarioMetrics,
  buildEvalSummary,
  runEval,
  requestSessionKey,
  elideDataUrls,
  waitForCanvasIdle,
  createRequestTracker,
  runOwnRequestHooks,
} from './run-eval.mjs';
import http from 'node:http';

describe('sim-go 内存版 Go 业务权威模拟器测试', () => {
  test('支持 /api/ops、画布 CRUD、CAS revision 冲突检测与 opId 幂等重放', async () => {
    const sim = createSimGo({ hostToken: 'secret-token' });
    await sim.listen(0);
    try {
      // 未授权 token 应被拒绝
      const unauth = await fetch(`${sim.opsUrl}/ops`, {
        headers: { 'X-Beeftv-Agent-Token': 'wrong-token' },
      });
      expect(unauth.status).toBe(403);

      // 正常获取描述符
      const opsRes = await fetch(`${sim.opsUrl}/ops`, {
        headers: { 'X-Beeftv-Agent-Token': 'secret-token' },
      });
      expect(opsRes.status).toBe(200);
      const opsJson = await opsRes.json();
      expect(opsJson.code).toBe(0);
      expect(opsJson.data.ops.length).toBeGreaterThan(10);

      // 读取初始画布 revision=1
      const get1 = sim.executeOp('canvas.get', { canvasId: 'canvas-1' });
      expect(get1.result.canvas.revision).toBe(1);

      // 创建节点成功推进到 revision=2，且相同 opId 重放不重复创建
      const create1 = sim.executeOp(
        'canvas.nodes.create',
        {
          canvasId: 'canvas-1',
          expectedRevision: 1,
          nodes: [
            { type: 'script', title: '分镜脚本' },
            { type: 'image', title: '镜 1 首帧', prompt: '雨夜霓虹街头' },
            { type: 'video', title: '镜 1 视频', prompt: '镜头缓推' },
          ],
        },
        'op-create-1',
        'turn-1',
      );
      expect(create1.replayed).toBe(false);
      expect(create1.result.revision).toBe(2);
      expect(create1.result.created.length).toBe(3);

      const replay1 = sim.executeOp(
        'canvas.nodes.create',
        {
          canvasId: 'canvas-1',
          expectedRevision: 1,
          nodes: [
            { type: 'script', title: '分镜脚本' },
            { type: 'image', title: '镜 1 首帧', prompt: '雨夜霓虹街头' },
            { type: 'video', title: '镜 1 视频', prompt: '镜头缓推' },
          ],
        },
        'op-create-1',
        'turn-1',
      );
      expect(replay1.replayed).toBe(true);
      expect(replay1.result.revision).toBe(2);

      // 过期 expectedRevision=1 写操作触发 CAS revision_conflict
      expect(() =>
        sim.executeOp(
          'canvas.node.update',
          {
            canvasId: 'canvas-1',
            nodeId: create1.result.created[1].id,
            expectedRevision: 1,
            patch: { content: '新提示词' },
          },
          'op-stale-1',
        ),
      ).toThrow(/画布已变化/);
      expect(sim.counts.revisionConflicts).toBe(1);

      // 用户手动编辑模拟推进 revision，随后旧版本写入被拒
      const afterUserEdit = sim.userEditNode(create1.result.created[1].id, { content: '用户手改提示词' }, 'canvas-1');
      expect(afterUserEdit.revision).toBe(3);
      expect(sim.counts.userEdits).toBe(1);
    } finally {
      await sim.close();
    }
  });

  test('分镜行增删改与 imageNodeId/videoNodeId 产出连线绑定一致性', () => {
    const sim = createSimGo();
    const created = sim.executeOp(
      'canvas.nodes.create',
      {
        canvasId: 'canvas-1',
        expectedRevision: 1,
        nodes: [
          { type: 'script', title: '分镜脚本' },
          { type: 'image', title: '镜 1 首帧', prompt: '首帧A' },
          { type: 'image', title: '镜 1 备选首帧', prompt: '首帧B' },
          { type: 'video', title: '镜 1 视频', prompt: '视频A' },
        ],
      },
      'op-init',
    ).result.created;

    const [scriptNode, img1, img2, vid1] = created;

    const appended = sim.executeOp(
      'canvas.script.rows.append',
      {
        canvasId: 'canvas-1',
        nodeId: scriptNode.id,
        expectedRevision: 2,
        rows: [
          { durationSeconds: 5, plotDescription: '第一镜', dialogue: '台词1' },
          { durationSeconds: 5, plotDescription: '第二镜', dialogue: '台词2' },
        ],
      },
      'op-append',
    ).result;
    expect(appended.rowCount).toBe(2);
    const row1Id = appended.created[0].id;
    const row2Id = appended.created[1].id;

    // 绑定 row1 -> img1 与 vid1，应自动创建两条 storyboard-output 连线
    const update1 = sim.executeOp(
      'canvas.script.row.update',
      {
        canvasId: 'canvas-1',
        nodeId: scriptNode.id,
        expectedRevision: 3,
        patches: [{ rowId: row1Id, imageNodeId: img1.id, videoNodeId: vid1.id }],
      },
      'op-row-bind-1',
    ).result;
    expect(update1.createdEdgeIds.length).toBe(2);

    // 改绑 row1 -> img2，旧 img1 连线应被自动替换删除
    const update2 = sim.executeOp(
      'canvas.script.row.update',
      {
        canvasId: 'canvas-1',
        nodeId: scriptNode.id,
        expectedRevision: 4,
        patches: [{ rowId: row1Id, imageNodeId: img2.id }],
      },
      'op-row-bind-2',
    ).result;
    expect(update2.createdEdgeIds.length).toBe(1);
    expect(update2.deletedEdgeIds.length).toBe(1);

    // 删除 row1，其关联的产出连线也一并清除，剩余行重新编号为 1
    const removed = sim.executeOp(
      'canvas.script.row.remove',
      {
        canvasId: 'canvas-1',
        nodeId: scriptNode.id,
        expectedRevision: 5,
        rowIds: [row1Id],
      },
      'op-row-remove',
    ).result;
    expect(removed.rowCount).toBe(1);
    expect(removed.deletedEdgeIds.length).toBe(2);

    const doc = sim.executeOp('canvas.get', { canvasId: 'canvas-1' }).result.canvas;
    const remainingRows = doc.nodes.find((n) => n.id === scriptNode.id).metadata.storyboard.rows;
    expect(remainingRows.length).toBe(1);
    expect(remainingRows[0].id).toBe(row2Id);
    expect(remainingRows[0].shotNumber).toBe(1);
  });

  test('分镜提示词同步回执列出连带节点与字段，手改过的节点不列出', () => {
    const sim = createSimGo();
    const canvasId = 'canvas-sync-receipt';
    sim.ensureCanvas(canvasId, {
      id: canvasId,
      revision: 1,
      nodes: [
        {
          id: 'script', type: 'script', title: '分镜',
          metadata: { storyboard: { rows: [
            { id: 'r1', shotNumber: 1, imageGenerationPrompt: '旧首帧', imageNodeId: 'img-1' },
            { id: 'r2', shotNumber: 2, videoMotionPrompt: '旧视频', videoNodeId: 'vid-1' },
          ] } },
        },
        { id: 'img-1', type: 'image', title: '首帧', metadata: { composerContent: '旧首帧', prompt: '旧首帧', status: 'idle' } },
        { id: 'vid-1', type: 'video', title: '视频', metadata: { composerContent: '用户手改', prompt: '用户手改', status: 'idle' } },
      ],
      connections: [],
    });
    const result = sim.executeOp('canvas.script.row.update', {
      canvasId, nodeId: 'script', expectedRevision: 1,
      patches: [
        { rowId: 'r1', imageGenerationPrompt: '新首帧' },
        { rowId: 'r2', videoMotionPrompt: '新视频' },
      ],
    }, 'op-sync-receipt').result;
    expect(result.syncedNodeIds).toEqual(['img-1']);
    expect(result.skippedNodeIds).toEqual(['vid-1']);
    expect(result.alsoChanged).toEqual([
      { nodeId: 'img-1', title: '首帧', fields: ['composerContent', 'prompt'] },
    ]);
  });

  test('绑定产物回收其他节点 assetId 时回执列出连带节点', () => {
    const sim = createSimGo();
    sim.assets.set('asset-ref', {
      id: 'asset-ref', resourceId: 'res-ref',
      payloadJson: JSON.stringify({ data: { storageKey: 'resource:res-ref' } }),
    });
    sim.ensureCanvas('canvas-bind-receipt', {
      id: 'canvas-bind-receipt', revision: 1,
      nodes: [
        { id: 'slot', type: 'image', metadata: { storageKey: 'resource:res-ref', content: '/api/resources/res-ref/file' } },
        { id: 'root', type: 'image', metadata: { isBatchRoot: true, primaryImageId: 'slot', storageKey: 'resource:res-ref' } },
        { id: 'video', type: 'video', metadata: { taskId: 'task-1' } },
      ],
      connections: [],
    });
    sim.tasks.set('task-1', {
      id: 'task-1', type: 'video', status: 'succeeded', progress: 100, canvasId: 'canvas-bind-receipt',
      outputs: [{ index: 0, assetId: 'asset-video', resourceId: 'res-video', storageKey: 'resource:res-video', mimeType: 'video/mp4' }],
    });
    const result = sim.executeOp('canvas.task.bind', {
      canvasId: 'canvas-bind-receipt', taskId: 'task-1', nodeId: 'video', outputIndex: 0,
    }, 'op-bind-receipt').result;
    expect(result.alsoChanged).toEqual([
      { nodeId: 'slot', fields: ['assetId'] },
      { nodeId: 'root', fields: ['assetId'] },
    ]);
    expect(result.alsoChanged.some((item) => item.nodeId === 'video')).toBe(false);
  });

  test('素材正文没有主资源时不回填 assetId，也不报告变更', () => {
    const sim = createSimGo();
    sim.assets.set('asset-empty', { id: 'asset-empty', resourceId: 'res-ref', payloadJson: '{}' });
    sim.ensureCanvas('canvas-empty-asset', {
      id: 'canvas-empty-asset', revision: 1,
      nodes: [
        { id: 'slot', type: 'image', title: '缺绑定', metadata: {
          storageKey: 'resource:res-ref',
          content: '/api/resources/res-ref/file',
        } },
        { id: 'video', type: 'video', metadata: { taskId: 'task-1' } },
      ],
      connections: [],
    });
    sim.tasks.set('task-1', {
      id: 'task-1', type: 'video', status: 'succeeded', progress: 100, canvasId: 'canvas-empty-asset',
      outputs: [{ index: 0, assetId: 'asset-video', resourceId: 'res-video', storageKey: 'resource:res-video', mimeType: 'video/mp4' }],
    });
    const result = sim.executeOp('canvas.task.bind', {
      canvasId: 'canvas-empty-asset', taskId: 'task-1', nodeId: 'video', outputIndex: 0,
    }, 'op-empty-asset').result;
    expect(result.alsoChanged).toBeUndefined();
    const doc = sim.ensureCanvas('canvas-empty-asset');
    expect(doc.nodes.find((node) => node.id === 'slot').metadata.assetId).toBeUndefined();
  });

  test('资源回填逐项解析 storageKey 与 content，旧路径不遮蔽有效资源', () => {
    const sim = createSimGo();
    sim.assets.set('asset-legacy', {
      id: 'asset-legacy', resourceId: 'res-legacy',
      payloadJson: JSON.stringify({ data: { storageKey: 'resource:res-legacy' } }),
    });
    sim.ensureCanvas('canvas-legacy-resource', {
      id: 'canvas-legacy-resource', revision: 1,
      nodes: [
        { id: 'legacy', type: 'image', title: '旧路径节点', metadata: {
          storageKey: 'legacy/path/not-a-resource',
          content: '/api/resources/res-legacy/file?token=1',
        } },
        { id: 'video', type: 'video', metadata: { taskId: 'task-1' } },
      ],
      connections: [],
    });
    sim.tasks.set('task-1', {
      id: 'task-1', type: 'video', status: 'succeeded', progress: 100, canvasId: 'canvas-legacy-resource',
      outputs: [{ index: 0, assetId: 'asset-video', resourceId: 'res-video', storageKey: 'resource:res-video', mimeType: 'video/mp4' }],
    });
    const result = sim.executeOp('canvas.task.bind', {
      canvasId: 'canvas-legacy-resource', taskId: 'task-1', nodeId: 'video', outputIndex: 0,
    }, 'op-legacy-resource').result;
    expect(result.alsoChanged).toEqual([
      { nodeId: 'legacy', title: '旧路径节点', fields: ['assetId'] },
    ]);
    const doc = sim.ensureCanvas('canvas-legacy-resource');
    expect(doc.nodes.find((node) => node.id === 'legacy').metadata.assetId).toBe('asset-legacy');
  });

  test('时间线媒体也逐项解析资源来源并回填 assetId', () => {
    const sim = createSimGo();
    sim.assets.set('asset-timeline', {
      id: 'asset-timeline', resourceId: 'res-timeline',
      payloadJson: JSON.stringify({ data: { storageKey: 'resource:res-timeline' } }),
    });
    sim.ensureCanvas('canvas-legacy-timeline', {
      id: 'canvas-legacy-timeline', revision: 1,
      nodes: [{ id: 'video', type: 'video', metadata: { taskId: 'task-1' } }],
      connections: [],
      timeline: {
        version: 2, durationMs: 1000, tracks: [{ id: 'track-1', kind: 'video' }],
        clips: [{ id: 'clip-1', kind: 'video', trackId: 'track-1', startMs: 0, durationMs: 1000,
          directMedia: { kind: 'video', storageKey: 'legacy/path', url: '/api/resources/res-timeline/file?x=1' } }],
      },
    });
    sim.tasks.set('task-1', {
      id: 'task-1', type: 'video', status: 'succeeded', progress: 100, canvasId: 'canvas-legacy-timeline',
      outputs: [{ index: 0, assetId: 'asset-video', resourceId: 'res-video', storageKey: 'resource:res-video', mimeType: 'video/mp4' }],
    });
    sim.executeOp('canvas.task.bind', {
      canvasId: 'canvas-legacy-timeline', taskId: 'task-1', nodeId: 'video', outputIndex: 0,
    }, 'op-legacy-timeline');
    const doc = sim.ensureCanvas('canvas-legacy-timeline');
    expect(doc.timeline.clips[0].directMedia.assetId).toBe('asset-timeline');
  });

  test('已有素材正文合法引用次级资源时不被替换，也不进入 alsoChanged', () => {
    const sim = createSimGo();
    sim.assets.set('asset-declared', {
      id: 'asset-declared', resourceId: 'res-main',
      payloadJson: JSON.stringify({
        data: { storageKey: 'resource:res-main' },
        metadata: { referenceUrl: '/api/resources/res-secondary/file' },
      }),
    });
    sim.assets.set('asset-primary', {
      id: 'asset-primary', resourceId: 'res-secondary',
      payloadJson: JSON.stringify({ data: { storageKey: 'resource:res-secondary' } }),
    });
    sim.assets.set('asset-other', {
      id: 'asset-other', resourceId: 'res-other',
      payloadJson: JSON.stringify({ data: { storageKey: 'resource:res-other' } }),
    });
    sim.ensureCanvas('canvas-secondary-ref', {
      id: 'canvas-secondary-ref', revision: 1,
      nodes: [
        { id: 'slot', type: 'image', title: '合法次级引用', metadata: {
          assetId: 'asset-declared',
          storageKey: 'resource:res-secondary',
          content: '/api/resources/res-secondary/file',
        } },
        { id: 'missing', type: 'image', title: '待回填', metadata: {
          storageKey: 'resource:res-other',
          content: '/api/resources/res-other/file',
        } },
        { id: 'video', type: 'video', metadata: { taskId: 'task-1' } },
      ],
      connections: [],
    });
    sim.tasks.set('task-1', {
      id: 'task-1', type: 'video', status: 'succeeded', progress: 100, canvasId: 'canvas-secondary-ref',
      outputs: [{ index: 0, assetId: 'asset-video', resourceId: 'res-video', storageKey: 'resource:res-video', mimeType: 'video/mp4' }],
    });
    const result = sim.executeOp('canvas.task.bind', {
      canvasId: 'canvas-secondary-ref', taskId: 'task-1', nodeId: 'video', outputIndex: 0,
    }, 'op-secondary-ref').result;
    expect(result.alsoChanged).toEqual([
      { nodeId: 'missing', title: '待回填', fields: ['assetId'] },
    ]);
    const doc = sim.ensureCanvas('canvas-secondary-ref');
    expect(doc.nodes.find((node) => node.id === 'slot').metadata.assetId).toBe('asset-declared');
  });

  test('绑定和解绑首帧保留同一分镜行的动作演示板连线', () => {
    const sim = createSimGo();
    const canvasId = 'canvas-action-board';
    sim.ensureCanvas(canvasId, {
      id: canvasId, revision: 1,
      nodes: [
        { id: 'script', type: 'script', metadata: { storyboard: { rows: [{ id: 'row-1' }] } } },
        { id: 'board', type: 'image', metadata: { workflowKind: 'action_board' } },
        { id: 'frame', type: 'image', metadata: {} },
      ],
      connections: [{ id: 'board-edge', fromNodeId: 'script', toNodeId: 'board', fromHandleId: 'row:row-1' }],
    });
    for (const [index, imageNodeId] of ['frame', ''].entries()) {
      const result = sim.executeOp('canvas.script.row.update', {
        canvasId, nodeId: 'script', expectedRevision: index + 1,
        patches: [{ rowId: 'row-1', imageNodeId }],
      }, `bind-frame-${index}`).result;
      expect(result.deletedEdgeIds).not.toContain('board-edge');
      const doc = sim.ensureCanvas(canvasId);
      expect(doc.connections.some((edge) => edge.id === 'board-edge')).toBe(true);
      expect(doc.connections.filter((edge) => edge.toNodeId === 'frame').length).toBe(imageNodeId ? 1 : 0);
    }
  });

  test('生成提议确认、失败模拟、缺陷画面 media.inspect 及回合撤销 undo', async () => {
    const sim = createSimGo({ taskDelayMs: 5 });
    await sim.listen(0);
    try {
      sim.beginTurn({ turnId: 'turn-gen-1', canvasId: 'canvas-1' });
      const created = sim.executeOp(
        'canvas.nodes.create',
        {
          canvasId: 'canvas-1',
          expectedRevision: 1,
          nodes: [
            { type: 'image', title: '镜 1 首帧', prompt: '雨夜侦探特写' },
            { type: 'image', title: '镜 2 首帧', prompt: '暗巷追逐' },
          ],
        },
        'op-c1',
        'turn-gen-1',
      ).result.created;

      // 拒绝未经确认的直接生成任务请求
      const unconfirmedRes = await fetch(`${sim.baseUrl}/api/generation-tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ canvasId: 'canvas-1', nodeId: created[0].id, ConfirmedByUser: false }),
      });
      expect(unconfirmedRes.status).toBe(403);
      expect(sim.counts.unconfirmedTasks).toBe(1);

      // 发起生成提议
      const prop = sim.executeOp(
        'canvas.generation.propose',
        {
          canvasId: 'canvas-1',
          kind: 'image',
          nodeIds: [created[0].id, created[1].id],
          note: '测试提议',
        },
        'op-prop-1',
        'turn-gen-1',
      ).result;
      expect(prop.proposalId).toBeTruthy();

      // 预设第 1 个节点生成画面带六指缺陷，第 2 个节点生成失败
      sim.flagNextTaskDefect('右手六指畸形', created[0].id);
      sim.failNextTask('upstream_timeout', created[1].id);

      const tasks = await sim.confirmProposals(prop.proposalId, { delayMs: 5 });
      expect(tasks.length).toBe(2);
      expect(tasks[0].status).toBe('succeeded');
      expect(tasks[1].status).toBe('failed');

      // media.inspect 读取第 1 个节点，返回合法 PNG 与缺陷说明
      const inspectRes = sim.executeOp('media.inspect', {
        canvasId: 'canvas-1',
        nodeId: created[0].id,
      }).result;
      expect(inspectRes.note).toContain('右手六指畸形');
      expect(inspectRes.content.length).toBe(1);
      const pngBytes = Buffer.from(inspectRes.content[0].data, 'base64');
      const sha = crypto.createHash('sha256').update(pngBytes).digest('hex');
      expect(sha).toBe(inspectRes.content[0].sha256);

      // 撤销回合 turn-gen-1，画布节点回到初始空状态，且再次确认该回合提议会被拒绝
      const undone = sim.undoTurn('turn-gen-1', 'canvas-1');
      expect(undone.undone).toBe(true);
      expect(undone.canvas.nodes.length).toBe(0);
      await expect(sim.confirmProposals(prop.proposalId)).rejects.toThrow(/已撤销/);
    } finally {
      await sim.close();
    }
  });
});

describe('预算门禁、密钥脱敏与评测配置校验测试', () => {
  test('--model real 缺少单价或单价为 0 时拒绝启动', () => {
    const args = parseCliArgs(['--model', 'real', '--scenario', 'S1', '--budget-cny', '10']);
    expect(() => validateEvalConfig(args, {})).toThrow(/real_mode_price_missing/);
    expect(() =>
      validateEvalConfig(args, {
        BEEFTV_EVAL_PRICE_IN: '0',
        BEEFTV_EVAL_PRICE_OUT: '15',
      }),
    ).toThrow(/real_mode_price_missing/);
    expect(() =>
      validateEvalConfig(args, {
        BEEFTV_EVAL_PRICE_IN: '2',
        BEEFTV_EVAL_PRICE_OUT: '8',
      }),
    ).toThrow(/real_mode_credentials_missing/);

    const valid = validateEvalConfig(args, {
      BEEFTV_EVAL_PRICE_IN: '2.5',
      BEEFTV_EVAL_PRICE_OUT: '10',
      BEEFTV_AGENT_BASE_URL: 'https://example.invalid/v1',
      BEEFTV_AGENT_API_KEY: 'sk-test-secret-123456',
      BEEFTV_AGENT_MODEL: 'gpt-test',
    });
    expect(valid.modelMode).toBe('real');
    expect(valid.priceInPerMillion).toBe(2.5);
    expect(valid.priceOutPerMillion).toBe(10);
  });

  test('累计费用超预算上限时立即触发 aborted_budget 熔断并记录 ledger.jsonl', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'beeftv-meter-test-'));
    const ledgerPath = path.join(tmpDir, 'ledger.jsonl');
    try {
      const meter = createCostMeter({
        mode: 'fake',
        budgetCny: 0.05,
        priceInPerMillion: 100, // 每万 token 1 元
        priceOutPerMillion: 200,
        ledgerPath,
      });
      meter.setContext({ runIndex: 1, scenarioId: 'shortdrama-2shot', turnId: 't1' });

      // 第 1 笔请求花费 0.03 元，未超 0.05 元
      const e1 = meter.recordRequest({ inputTokens: 100, outputTokens: 100, durationMs: 10 });
      expect(e1.costCny).toBeCloseTo(0.03, 5);
      expect(e1.abortedBudget).toBe(false);

      // 第 2 笔请求再花 0.03 元，累计 0.06 元 > 0.05 元，立即抛 aborted_budget
      expect(() => meter.recordRequest({ inputTokens: 100, outputTokens: 100, durationMs: 10 })).toThrow(
        /aborted_budget/,
      );
      expect(meter.getState().abortedBudget).toBe(true);

      // 后续派发前检查也直接拒绝
      expect(() => meter.checkBudgetBeforeDispatch()).toThrow(/aborted_budget/);

      const lines = fs.readFileSync(ledgerPath, 'utf8').trim().split('\n');
      expect(lines.length).toBe(2);
      expect(JSON.parse(lines[1]).abortedBudget).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('redactSecrets 彻底脱敏环境变量密钥、sk-* 与 Bearer Token', () => {
    const raw = {
      apiKey: 'sk-live-9876543210abcdef',
      nested: {
        Authorization: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
        note: '调用失败: Bearer secret_token_xyz123 及 key=sk-abcdef1234567890 和 custom-sec-9999',
      },
    };
    const cleaned = redactSecrets(raw, ['custom-sec-9999']);
    const serialized = JSON.stringify(cleaned);
    expect(serialized).not.toContain('sk-live-9876543210abcdef');
    expect(serialized).not.toContain('sk-abcdef1234567890');
    expect(serialized).not.toContain('secret_token_xyz123');
    expect(serialized).not.toContain('custom-sec-9999');
    expect(cleaned.apiKey).toBe('[REDACTED]');
    expect(cleaned.nested.Authorization).toBe('[REDACTED]');
  });

  test('场景选择器与端到端单场景 fake 评测运行通过', async () => {
    expect(resolveScenarioList('all').length).toBe(7);
    expect(resolveScenarioList('S1,S3').map((s) => s.code)).toEqual(['S1', 'S3']);
    expect(buildS3SeedCanvas('c-s3').nodes.length).toBe(9);

    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'beeftv-eval-e2e-'));
    try {
      const res = await runEval({
        scenario: 'S2',
        model: 'fake',
        runs: 1,
        maxRequests: 15,
        budgetCny: 10,
        outDir,
      });
      expect(res.report.status).toBe('passed');
      expect(res.report.scenarios.length).toBe(1);
      expect(res.report.scenarios[0].metrics.passed).toBe(true);
      expect(res.report.scenarios[0].metrics.eliminableRequests).toBeGreaterThanOrEqual(1);
      const td = res.report.scenarios[0].turnDiagnostics[0];
      expect(td.requestCount).toBe(5);
      expect(td.eliminableRequestCount).toBe(3);
      expect(td.toolSequence).toEqual([
        'R1:canvas_get[可省]',
        'R2:canvas_nodes_create',
        'R3:canvas_script_rows_append[可省]',
        'R4:canvas_script_row_update[可省]',
        'R5:<reply>',
      ]);
      expect(Array.isArray(td.requests)).toBe(true);
      expect(td.requests.length).toBe(5);
      expect(fs.existsSync(res.jsonPath)).toBe(true);
      expect(fs.existsSync(res.mdPath)).toBe(true);
      expect(fs.existsSync(res.ledgerPath)).toBe(true);
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });

  test('extractModelRequestTrace 识别工具报错重试、空画布 canvas_get、单独 plan_update 与串行分步改画布', () => {
    const sseWithTool = (name, argsObj) =>
      `data: ${JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, function: { name, arguments: JSON.stringify(argsObj) } }],
            },
          },
        ],
      })}\n\ndata: [DONE]\n`;

    // 1) 空画布已有 <beeftv_studio> 仍调用 canvas_get -> 可省往返
    const tEmptyGet = extractModelRequestTrace(
      {
        messages: [
          { role: 'system', content: 'sys' },
          { role: 'user', content: '帮我做两镜短剧' },
          { role: 'user', content: '<beeftv_studio>\n[制作现场｜画布版本 1]\n概况：画布是空的。\n</beeftv_studio>' },
        ],
      },
      sseWithTool('canvas_get', { canvasId: 'c1' }),
      [],
    );
    expect(tEmptyGet.trigger).toBe('user_message');
    expect(tEmptyGet.responseTools).toEqual(['canvas_get']);
    expect(tEmptyGet.eliminable).toBe(true);
    expect(tEmptyGet.eliminableReason).toContain('空画布已有 <beeftv_studio>');

    // 2) 工具报错触发的下一跳重试 -> 可省往返
    const tErrRetry = extractModelRequestTrace(
      {
        messages: [
          { role: 'system', content: 'sys' },
          { role: 'user', content: '帮我建分镜' },
          {
            role: 'assistant',
            content: '',
            tool_calls: [{ id: 'tc-1', function: { name: 'canvas_script_prepare', arguments: '{}' } }],
          },
          { role: 'tool', tool_call_id: 'tc-1', content: '{"error":"模拟器未实现操作: canvas.script.prepare"}' },
          { role: 'user', content: '<beeftv_studio>\n概况：画布是空的。\n</beeftv_studio>' },
        ],
      },
      sseWithTool('canvas_nodes_create', { nodes: [{ type: 'script', title: '分镜' }] }),
      [],
    );
    expect(tErrRetry.trigger).toBe('tool_error_result');
    expect(tErrRetry.eliminable).toBe(true);
    expect(tErrRetry.eliminableReason).toContain('canvas_script_prepare:unsupported_operation');

    // 3) 单独调用 plan_update -> 可省往返
    const tPlanOnly = extractModelRequestTrace(
      {
        messages: [{ role: 'user', content: '开始' }],
      },
      sseWithTool('plan_update', { steps: [{ title: '步骤1', status: 'in_progress' }] }),
      [],
    );
    expect(tPlanOnly.eliminable).toBe(true);
    expect(tPlanOnly.eliminableReason).toContain('单独调用 plan_update');

    // 4) 同轮第二次串行写画布 -> 可省往返
    const tSerialWrite = extractModelRequestTrace(
      {
        messages: [
          { role: 'user', content: '建分镜' },
          {
            role: 'assistant',
            content: '',
            tool_calls: [{ id: 'tc-2', function: { name: 'canvas_nodes_create', arguments: '{}' } }],
          },
          { role: 'tool', tool_call_id: 'tc-2', content: '{"revision":2}' },
        ],
      },
      sseWithTool('canvas_script_rows_append', { nodeId: 'n1', rows: [{ plotDescription: '镜1' }] }),
      [{ responseTools: ['canvas_nodes_create'] }],
    );
    expect(tSerialWrite.eliminable).toBe(true);
    expect(tSerialWrite.eliminableReason).toContain('串行分步改画布');

    // 5) 真实宿主格式识别：planContinuation、supplementMarker (/steer) 与 <canvas_event>
    const tPlanCont = extractModelRequestTrace(
      {
        messages: [
          {
            role: 'user',
            content: '计划还没做完。继续做「创建首帧节点」；做完用 plan_update 更新状态。',
          },
        ],
      },
      sseWithTool('canvas_nodes_create', { nodes: [] }),
      [],
    );
    expect(tPlanCont.trigger).toBe('plan_continue');
    expect(tPlanCont.eliminable).toBe(true);
    expect(tPlanCont.eliminableReason).toContain('planContinuation');

    const tSteer = extractModelRequestTrace(
      {
        messages: [
          {
            role: 'assistant',
            content: '',
            tool_calls: [{ id: 'tc-s1', function: { name: 'canvas_nodes_create', arguments: '{}' } }],
          },
          { role: 'tool', tool_call_id: 'tc-s1', content: '{"revision":2}' },
          {
            role: 'user',
            content: [{ type: 'text', text: '[BEEFTV_INPUT:1]' }, { type: 'text', text: '改成赛博朋克 2 镜' }],
          },
        ],
      },
      sseWithTool('canvas_nodes_create', { nodes: [] }),
      [{ responseTools: ['canvas_nodes_create'] }],
    );
    expect(tSteer.trigger).toBe('user_steer');
    expect(tSteer.prevTools.map((t) => t.name)).toEqual(['canvas_nodes_create']);
    // user_steer 触发的重写不计为可省串行写
    expect(tSteer.eliminable).toBe(false);

    const tWake = extractModelRequestTrace(
      {
        messages: [{ role: 'user', content: '<canvas_event kind="generation_finished">\n好了\n</canvas_event>' }],
      },
      sseWithTool('media_overview', { nodeId: 'n1' }),
      [],
    );
    expect(tWake.trigger).toBe('auto_wake');

    // 6) plan_update 与 canvas_generation_propose 同批调用导致多一次总结请求
    const tPostProposeReply = extractModelRequestTrace(
      {
        messages: [
          {
            role: 'assistant',
            content: '',
            tool_calls: [
              { id: 'tc-p1', function: { name: 'plan_update', arguments: '{}' } },
              { id: 'tc-p2', function: { name: 'canvas_generation_propose', arguments: '{}' } },
            ],
          },
          { role: 'tool', tool_call_id: 'tc-p1', content: '{"ok":true}' },
          { role: 'tool', tool_call_id: 'tc-p2', content: '{"proposalId":"prop-1"}' },
        ],
      },
      `data: ${JSON.stringify({ choices: [{ delta: { content: '已发起生成提议' } }] })}\n\ndata: [DONE]\n`,
      [],
    );
    expect(tPostProposeReply.eliminable).toBe(true);
    expect(tPostProposeReply.eliminableReason).toContain('terminate 未生效');
  });

  test('已知自动唤醒缺口不能掩盖首轮失败或完成事件投递失败', () => {
    const scenario = SCENARIOS.find((item) => item.code === 'S5');
    const simGo = createSimGo();
    scenario.setup(simGo, 'canvas-s5');
    const result = scenario.evaluate({ simGo, canvasId: 'canvas-s5', wakeResult: { eventAccepted: true, autoWoken: false } });
    expect(result.status).toBe('failed');
    const rejectedEvent = scenario.evaluate({ simGo, canvasId: 'canvas-s5', wakeResult: { eventAccepted: false, autoWoken: false } });
    expect(rejectedEvent.status).toBe('failed');
    expect(rejectedEvent.capabilityGap).toBeNull();
    const summaryWithUnexpectedGap = buildEvalSummary(
      [
        {
          scenarioId: 'post-generation-review',
          expectedBaselinePass: true,
          metrics: {
            status: 'baseline_gap',
            passed: false,
            structuralCompletenessRate: 0.4,
            unconfirmedGenerationCount: 0,
            duplicateNodeCount: 0,
            duplicateProposalCount: 0,
            revisionConflicts: 0,
            unrecoveredConflicts: 0,
            turnCount: 1,
          },
        },
      ],
      { scenario: 'S5', modelMode: 'fake', runs: 1, maxRequests: 20, budgetCny: 10 },
      { totalRequests: 1, totalInputTokens: 100, totalOutputTokens: 20, totalTokens: 120, totalCostCny: 0.001, abortedBudget: false },
    );
    expect(summaryWithUnexpectedGap.status).toBe('failed');
  });

  test('事件自动唤醒与用户复查分别计分，技能仅首轮激活后仍进入后续请求', async () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'beeftv-eval-truth-'));
    try {
      const { report, markdown } = await runEval({
        scenario: 'S5,S6,S7', model: 'fake', runs: 1, maxRequests: 20, budgetCny: 10, outDir,
      });
      expect(report.status).toBe('passed');
      const [auto, skill, userReview] = report.scenarios;
      expect(auto.expectedBaselinePass).toBe(true);
      expect(auto.wakeResult).toEqual({ autoWoken: true, eventAccepted: true });
      expect(auto.metrics.status).toBe('passed');
      expect(auto.metrics.turnCount).toBe(1);
      expect(auto.metrics.mediaInspections).toBe(2);
      expect(skill.scenarioId).toBe('skill-across-turns');
      expect(skill.metrics.passed).toBe(true);
      expect(skill.requestEvidence.every((entry) => entry.activeSkillPresent)).toBe(true);
      expect(SCENARIOS.find((scenario) => scenario.code === 'S6').turns.filter((turn) => turn.useActiveSkillPins).length).toBe(1);
      expect(userReview.metrics.passed).toBe(true);
      expect(userReview.metrics.turnCount).toBe(2);
      expect(userReview.metrics.mediaInspections).toBe(2); // overview + versioned inspect
      expect(userReview.metrics.unconfirmedGenerationCount).toBe(0);
      expect(markdown).not.toContain('多轮压缩后技能规则保持率');
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe('请求归属、原文落盘与场景收尾', () => {
  test('按缓存亲和键识别请求所属会话', () => {
    expect(requestSessionKey({ prompt_cache_key: 'durable:a' })).toBe('durable:a');
    expect(requestSessionKey({ metadata: { user_id: 'durable:b' } })).toBe('durable:b');
    expect(requestSessionKey({ messages: [] })).toBe('');
  });

  test('落盘原文只去掉长的内联图片', () => {
    const long = `data:image/png;base64,${'A'.repeat(400)}`;
    const out = elideDataUrls({ messages: [{ content: [{ image_url: { url: long } }, { text: 'data:short' }] }] });
    expect(out.messages[0].content[0].image_url.url).toBe(`data:image/png;base64,<${long.length} chars elided>`);
    expect(out.messages[0].content[1].text).toBe('data:short');
  });

  test('助手停下且条件满足才算收尾，否则到上限返回未停下', async () => {
    let polls = 0;
    const server = http.createServer((req, res) => {
      polls += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ active: polls <= 2 ? { turnId: 't' } : null, turns: [] }));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const hostBaseUrl = `http://127.0.0.1:${server.address().port}`;
    try {
      const settled = await waitForCanvasIdle({ hostBaseUrl, hostToken: 'x', canvasId: 'c', timeoutMs: 5000 });
      expect(settled.idle).toBe(true);
      expect(polls).toBeGreaterThanOrEqual(4);
      const waiting = await waitForCanvasIdle({ hostBaseUrl, hostToken: 'x', canvasId: 'c', timeoutMs: 600, until: () => false });
      expect(waiting.idle).toBe(false);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('宿主不回应时等待也在上限内返回', async () => {
    const server = http.createServer(() => {}); // 接受连接但永不响应
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const startedAt = Date.now();
    try {
      const result = await waitForCanvasIdle({ hostBaseUrl: `http://127.0.0.1:${server.address().port}`, hostToken: 'x', canvasId: 'c', timeoutMs: 500 });
      expect(result.idle).toBe(false);
      expect(Date.now() - startedAt).toBeLessThan(2000);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('请求登记：迟到归回原场景、未知会话单列、在途计数准确、落盘脱敏', () => {
    const requestsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'beeftv-tracker-'));
    let context = { runIndex: 1, scenarioId: 'S5', turnId: 's5-1' };
    const tracker = createRequestTracker({ requestsDir, getContext: () => context, secrets: ['sk-secret-value-123'] });
    try {
      tracker.register('durable:s5', { runIndex: 1, scenarioId: 'S5', turnId: 's5-1' });
      context = { runIndex: 1, scenarioId: 'S6', turnId: 's6-1' };
      tracker.register('durable:s6', context);
      const late = tracker.begin({ prompt_cache_key: 'durable:s5', messages: [{ content: 'key sk-secret-value-123' }] });
      const own = tracker.begin({ prompt_cache_key: 'durable:s6' });
      const unknown = tracker.begin({ messages: [] });
      expect(late).toMatchObject({ scenarioId: 'S5', turnId: 's5-1', attribution: 'session', late: true, seq: 1 });
      expect(own).toMatchObject({ scenarioId: 'S6', attribution: 'session', late: false, seq: 2 });
      expect(unknown).toMatchObject({ scenarioId: 'S6', attribution: 'unknown', late: false, seq: 3 });
      expect(tracker.inflight).toBe(3);
      tracker.end(late);
      tracker.end(late);
      tracker.end(null);
      expect(tracker.inflight).toBe(2);
      tracker.end(own);
      tracker.end(unknown);
      expect(tracker.inflight).toBe(0);
      const dumped = fs.readFileSync(path.join(requestsDir, '0001.json'), 'utf8');
      expect(dumped).not.toContain('sk-secret-value-123');
      expect(tracker.dispatchOf({})).toBeUndefined();
    } finally {
      fs.rmSync(requestsDir, { recursive: true, force: true });
    }
    const broken = createRequestTracker({ requestsDir: path.join(os.tmpdir(), `missing-${crypto.randomUUID()}`), getContext: () => context });
    expect(() => broken.begin({ prompt_cache_key: 'durable:x' })).toThrow();
    expect(broken.inflight).toBe(0);
  });

  test('迟到请求不进当前场景证据，也不消费下一场景的改向钩子', async () => {
    const observed = [];
    const steered = [];
    let hook = async ({ reqIndex }) => { steered.push(reqIndex); };
    const hooks = {
      observe: (_body, dispatch) => observed.push(dispatch.seq),
      takeSteerHook: () => { const taken = hook; hook = null; return taken; },
    };
    await runOwnRequestHooks({}, { seq: 1, late: true }, 1, hooks);
    expect(observed).toEqual([]);
    expect(steered).toEqual([]);
    expect(hook).not.toBeNull();
    await runOwnRequestHooks({}, { seq: 2, late: false }, 2, hooks);
    await runOwnRequestHooks({}, { seq: 3, late: false }, 3, hooks);
    expect(observed).toEqual([2, 3]);
    expect(steered).toEqual([2]);
  });

  test('S7 用节点配置改提示词也算修正，只改其他参数不算', () => {
    const s7 = SCENARIOS.find((scenario) => scenario.code === 'S7');
    const turnRecords = [{ turnId: 't1' }, { turnId: 't2' }];
    const evaluateWith = (correction) => s7.evaluate({
      canvasId: 'c',
      turnRecords,
      simGo: { snapshot: () => ({
        proposals: [{ canvasId: 'c', confirmed: true }, { canvasId: 'c', confirmed: false }],
        tasks: [{ canvasId: 'c', status: 'succeeded' }],
        canvases: { c: { nodes: [{ id: 'n1' }] } },
        opLog: [
          { op: 'media.inspect', status: 'ok', turnId: 't2', params: { canvasId: 'c' } },
          { op: 'canvas.node.configure', status: 'ok', turnId: 't2', params: { canvasId: 'c', nodeId: 'n1', patch: correction } },
          { op: 'canvas.generation.propose', status: 'ok', turnId: 't2', params: { canvasId: 'c' } },
        ],
      }) },
    }).checks.find((check) => check.name === 'result_inspected_and_prompt_corrected').passed;
    expect(evaluateWith({ prompt: '手部自然，五根手指' })).toBe(true);
    expect(evaluateWith({ size: '1024x1024' })).toBe(false);
  });
});

describe('模拟器分镜准备的标题模板与真实后端一致', () => {
  const prepare = (simGo, canvasId, extra) => simGo.executeOp('canvas.script.prepare', {
    canvasId,
    expectedRevision: simGo.ensureCanvas(canvasId).revision,
    script: { title: `分镜-${crypto.randomUUID()}`, rows: [
      { plotDescription: '一', imageGenerationPrompt: '一', videoMotionPrompt: '一', durationSeconds: 5 },
      { plotDescription: '二', imageGenerationPrompt: '二', videoMotionPrompt: '二', durationSeconds: 5 },
    ] },
    ...extra,
  }, crypto.randomUUID(), 'turn-t');

  test('按模板命名，非法模板与重名整批拒绝', () => {
    const simGo = createSimGo({ hostToken: 't' });
    const canvasId = 'c-title';
    simGo.ensureCanvas(canvasId);
    prepare(simGo, canvasId, { image: { model: 'seedream-3.0', title: '镜 {n} 首帧' } });
    const imageTitles = simGo.ensureCanvas(canvasId).nodes.filter((node) => node.type === 'image').map((node) => node.title);
    expect(imageTitles).toEqual(['镜 1 首帧', '镜 2 首帧']);
    for (const title of [null, '镜 首帧', `${'镜'.repeat(38)}{n}`]) {
      expect(() => prepare(simGo, canvasId, { image: { model: 'seedream-3.0', title } })).toThrow();
    }
    const nodesBefore = simGo.ensureCanvas(canvasId).nodes.length;
    expect(() => prepare(simGo, canvasId, { image: { model: 'seedream-3.0', title: '镜 {n} 首帧' } })).toThrow();
    expect(() => prepare(simGo, canvasId, {
      image: { model: 'seedream-3.0', title: '镜 {n}' }, video: { model: 'seedance-1.0', generateAudio: 'false', title: '镜 {n}' },
    })).toThrow();
    for (const [image, video] of [
      [{ model: 'seedream-3.0' }, { model: 'seedance-1.0', generateAudio: 'false', title: '镜头 {n} · 首帧' }],
      [{ model: 'seedream-3.0', title: '镜头 {n} · 视频' }, { model: 'seedance-1.0', generateAudio: 'false' }],
    ]) {
      expect(() => prepare(simGo, canvasId, { image, video })).toThrow();
    }
    expect(simGo.ensureCanvas(canvasId).nodes.length).toBe(nodesBefore);
  });
});
