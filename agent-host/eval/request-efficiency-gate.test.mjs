import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'bun:test';
import {
  analyzeCapturedRequests,
  parseGateCliArgs,
  raiseBudget,
  ratchetBudget,
  runRequestEfficiencyGate,
} from './request-efficiency-gate.mjs';

describe('请求效率门禁（Request Efficiency Gate）', () => {
  test('S1–S11 假模型全量运行：完整覆盖 11 个场景、头部 system 逐字节不变、末尾瞬态上下文有效、相邻前缀 100% 覆盖且体积不超上限', async () => {
    const report = await runRequestEfficiencyGate({ scenario: 'all' });
    expect(report.passed, report.violations.join('\n')).toBe(true);
    expect(report.sessions.map((s) => s.scenarioCode)).toEqual(['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9', 'S10', 'S11']);
    expect(report.overallPrefixHitRatio).toBeGreaterThanOrEqual(0.95);
    expect(report.fullPrefixHitPairs).toBe(report.totalAdjacentPairs);
    for (const session of report.sessions) {
      expect(session.adjacentPairs).toBeGreaterThanOrEqual(1);
      expect(session.systemByteIdentical).toBe(true);
      expect(session.headerClean).toBe(true);
      expect(session.tailValid).toBe(true);
    }
  }, 45_000);

  test('当缺少预期场景、缺少末尾瞬态上下文、头部混入动态区块或顺序颠倒、前缀断裂、超出字符上限时应失败', () => {
    const baseTools = [{ type: 'function', function: { name: 'canvas_get', parameters: {} } }];
    const badRequests = [
      {
        runIndex: 1,
        scenarioCode: 'S6',
        scenarioId: 'skill-across-turns',
        canvasId: 'c1',
        sessionId: 'durable:1',
        body: {
          tools: baseTools,
          messages: [
            {
              role: 'developer',
              content: '<beeftv_skill_catalog>\ncat\n</beeftv_skill_catalog>\n\n<instructions>\ninstr\n</instructions>\n\n<beeftv_studio>\n画布版本 1\n</beeftv_studio>',
            },
            { role: 'user', content: 'turn 1' },
          ],
        },
      },
      {
        runIndex: 1,
        scenarioCode: 'S6',
        scenarioId: 'skill-across-turns',
        canvasId: 'c1',
        sessionId: 'durable:1',
        body: {
          tools: baseTools,
          messages: [
            {
              role: 'developer',
              content: '<beeftv_skill_catalog>\ncat\n</beeftv_skill_catalog>\n\n<instructions>\ninstr\n</instructions>\n\n<beeftv_studio>\n画布版本 2\n</beeftv_studio>',
            },
            { role: 'user', content: 'turn 1' },
            { role: 'assistant', content: 'ok' },
          ],
        },
      },
    ];

    const report = analyzeCapturedRequests(
      badRequests,
      {
        minAdjacentPrefixCoverageRatio: 0.95,
        maxHeaderChars: 50,
        maxToolsChars: 50,
        maxHeaderPlusToolsChars: 100,
      },
      { expectedScenarios: ['S1', 'S6'] },
    );
    expect(report.passed).toBe(false);
    expect(report.overallPrefixHitRatio).toBe(0);
    expect(report.violations.some((v) => v.includes('头部 system 仍包含动态区块'))).toBe(true);
    expect(report.violations.some((v) => v.includes('排在 <instructions>'))).toBe(true);
    expect(report.violations.some((v) => v.includes('缺少非 system 的 <beeftv_studio>'))).toBe(true);
    expect(report.violations.some((v) => v.includes('会话内头部 system 文本发生变化'))).toBe(true);
    expect(report.violations.some((v) => v.includes('缺少预期评测场景请求记录: S1'))).toBe(true);
    expect(report.violations.some((v) => v.includes('超过上限'))).toBe(true);
  });

  test('ratchetBudget（--update）只允许收紧字符上限，绝不调高已有上限', () => {
    const existing = {
      minAdjacentPrefixCoverageRatio: 0.95,
      maxHeaderChars: 7377,
      maxToolsChars: 31398,
      maxHeaderPlusToolsChars: 38775,
    };
    const regressed = ratchetBudget(existing, {
      maxHeaderChars: 8000,
      maxToolsChars: 32000,
      maxHeaderPlusToolsChars: 40000,
    });
    expect(regressed).toEqual(existing);

    const improved = ratchetBudget(existing, {
      maxHeaderChars: 7359,
      maxToolsChars: 31398,
      maxHeaderPlusToolsChars: 38757,
    });
    expect(improved).toEqual({
      minAdjacentPrefixCoverageRatio: 0.95,
      maxHeaderChars: 7359,
      maxToolsChars: 31398,
      maxHeaderPlusToolsChars: 38757,
    });
  });

  // 各工具字符数要和上限对应：超限时不能用变大后的值覆盖，否则下次说不出是谁变大了。
  test('ratchetBudget 只在没超限时刷新各工具字符数，并保留调高记录', () => {
    const existing = {
      minAdjacentPrefixCoverageRatio: 0.95,
      maxHeaderChars: 100,
      maxToolsChars: 1000,
      maxHeaderPlusToolsChars: 1100,
      toolChars: { canvas_get: 400, canvas_node_configure: 600 },
      raises: [{ reason: '补齐节点参数', maxToolsChars: 1000 }],
    };
    const grown = ratchetBudget(existing, {
      maxHeaderChars: 100,
      maxToolsChars: 1200,
      maxHeaderPlusToolsChars: 1300,
      toolChars: { canvas_get: 400, canvas_node_configure: 800 },
    });
    expect(grown).toEqual(existing);

    const shrunk = ratchetBudget(existing, {
      maxHeaderChars: 90,
      maxToolsChars: 950,
      maxHeaderPlusToolsChars: 1040,
      toolChars: { canvas_get: 350, canvas_node_configure: 600 },
    });
    expect(shrunk.maxToolsChars).toBe(950);
    expect(shrunk.toolChars).toEqual({ canvas_get: 350, canvas_node_configure: 600 });
    expect(shrunk.raises).toEqual(existing.raises);
  });

  test('raiseBudget（--raise）必须写明原因，只调高超出的上限并记下原因', () => {
    const existing = { minAdjacentPrefixCoverageRatio: 0.95, maxHeaderChars: 100, maxToolsChars: 1000, maxHeaderPlusToolsChars: 1100 };
    const measured = {
      maxHeaderChars: 90,
      maxToolsChars: 1200,
      maxHeaderPlusToolsChars: 1290,
      toolChars: { canvas_node_configure: 800 },
    };
    expect(() => raiseBudget(existing, measured, '')).toThrow('写明原因');
    expect(() => raiseBudget(existing, measured, '   ')).toThrow('写明原因');

    const raised = raiseBudget(existing, measured, '节点配置补上音高和音量');
    expect(raised).toEqual({
      minAdjacentPrefixCoverageRatio: 0.95,
      maxHeaderChars: 100,
      maxToolsChars: 1200,
      maxHeaderPlusToolsChars: 1290,
      toolChars: { canvas_node_configure: 800 },
      raises: [{ reason: '节点配置补上音高和音量', maxToolsChars: 1200, maxHeaderPlusToolsChars: 1290 }],
    });
    // 没有超限时不改预算，也不记一条空的调高。
    expect(raiseBudget(raised, measured, '再来一次')).toBe(raised);
    // 空白预算从头创建时补全默认前缀覆盖阈值。
    expect(raiseBudget(null, measured, '首次建立预算')).toMatchObject({
      minAdjacentPrefixCoverageRatio: 0.95,
      maxHeaderChars: 90,
      maxToolsChars: 1200,
      maxHeaderPlusToolsChars: 1290,
    });
    // 禁止把链接、本机路径或密钥写入公开预算文件。
    expect(() => raiseBudget(existing, measured, '详见 https://internal.example.com')).toThrow('公开仓库');
    expect(() => raiseBudget(existing, measured, '来自 /home/dev/file')).toThrow('公开仓库');
    expect(() => raiseBudget(existing, measured, '使用 sk-1234567890abcdef')).toThrow('公开仓库');
  });

  test('parseGateCliArgs 支持 --raise=原因，拒绝未知参数和 --update/--raise 混用', () => {
    expect(parseGateCliArgs(['--raise', '补充参数'])).toEqual({
      scenario: 'all',
      updateBudget: false,
      raiseReason: '补充参数',
    });
    expect(parseGateCliArgs(['--raise=补充参数', '--scenario=S1'])).toEqual({
      scenario: 'S1',
      updateBudget: false,
      raiseReason: '补充参数',
    });
    expect(parseGateCliArgs(['--raise='])).toEqual({
      scenario: 'all',
      updateBudget: false,
      raiseReason: '',
    });
    expect(() => parseGateCliArgs(['--update', '--raise', 'x'])).toThrow('不能同时使用');
    expect(() => parseGateCliArgs(['--unknown'])).toThrow('未知参数');
  });

  test('runRequestEfficiencyGate --raise 只在超限时写入预算文件并复查通过', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beeftv-eff-gate-'));
    try {
      const budgetPath = path.join(dir, 'budget.json');
      fs.writeFileSync(
        budgetPath,
        JSON.stringify({
          minAdjacentPrefixCoverageRatio: 0.95,
          maxHeaderChars: 10,
          maxToolsChars: 10,
          maxHeaderPlusToolsChars: 20,
        }),
      );
      const stubEval = async ({ onModelRequest }) => {
        const tools = [{ type: 'function', function: { name: 'canvas_get', description: 'read' } }];
        const header = { role: 'developer', content: '<instructions>\ni\n</instructions>' };
        onModelRequest({
          runIndex: 1,
          scenarioCode: 'S1',
          scenarioId: 's1',
          canvasId: 'c1',
          sessionId: 'durable:1',
          body: {
            tools,
            messages: [
              header,
              { role: 'user', content: 'hi' },
              { role: 'user', content: '<beeftv_studio>\ns1\n</beeftv_studio>' },
            ],
          },
        });
        onModelRequest({
          runIndex: 1,
          scenarioCode: 'S1',
          scenarioId: 's1',
          canvasId: 'c1',
          sessionId: 'durable:1',
          body: {
            tools,
            messages: [
              header,
              { role: 'user', content: 'hi' },
              { role: 'assistant', content: 'ok' },
              { role: 'user', content: '<beeftv_studio>\ns2\n</beeftv_studio>' },
            ],
          },
        });
        return { report: null };
      };
      const raisedReport = await runRequestEfficiencyGate({
        scenario: 'S1',
        budgetPath,
        raiseReason: '新增字段参数',
        evalRunner: stubEval,
      });
      expect(raisedReport.passed).toBe(true);
      const saved = JSON.parse(fs.readFileSync(budgetPath, 'utf8'));
      expect(saved.raises).toHaveLength(1);
      expect(saved.raises[0].reason).toBe('新增字段参数');
      expect(saved.toolChars.canvas_get).toBeGreaterThan(0);

      // 没再超限时再次 --raise 不追加重复记录。
      await runRequestEfficiencyGate({
        scenario: 'S1',
        budgetPath,
        raiseReason: '无需再次记录',
        evalRunner: stubEval,
      });
      expect(JSON.parse(fs.readFileSync(budgetPath, 'utf8')).raises).toHaveLength(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('工具定义超限时说出变大最多的工具，并给出调高的办法', () => {
    const tool = (name, size) => ({ type: 'function', function: { name, description: 'x'.repeat(size) } });
    const request = {
      runIndex: 1,
      scenarioCode: 'S1',
      scenarioId: 's1',
      canvasId: 'c1',
      sessionId: 'durable:1',
      body: {
        tools: [tool('canvas_get', 100), tool('canvas_node_configure', 600)],
        messages: [{ role: 'developer', content: '<instructions>\ni\n</instructions>' }, { role: 'user', content: 'hi' }],
      },
    };
    const measured = analyzeCapturedRequests([request], null, { expectedScenarios: ['S1'] });
    const baseline = { ...measured.toolChars, canvas_node_configure: measured.toolChars.canvas_node_configure - 500 };
    const report = analyzeCapturedRequests(
      [request],
      { maxToolsChars: measured.maxToolsChars - 500, toolChars: baseline },
      { expectedScenarios: ['S1'] },
    );
    const sizeViolation = report.violations.find((v) => v.startsWith('工具定义字符数'));
    expect(sizeViolation).toContain('（+500）');
    expect(sizeViolation).toContain('变大最多：canvas_node_configure +500');
    expect(report.violations.some((v) => v.includes('--raise "原因"'))).toBe(true);
  });
});
