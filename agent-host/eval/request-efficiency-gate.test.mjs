import { describe, expect, test } from 'bun:test';
import {
  analyzeCapturedRequests,
  ratchetBudget,
  runRequestEfficiencyGate,
} from './request-efficiency-gate.mjs';

describe('请求效率门禁（Request Efficiency Gate）', () => {
  test('S1–S7 假模型全量运行：完整覆盖 7 个场景、头部 system 逐字节不变、末尾瞬态上下文有效、相邻前缀 100% 覆盖且体积不超上限', async () => {
    const report = await runRequestEfficiencyGate({ scenario: 'all' });
    expect(report.passed, report.violations.join('\n')).toBe(true);
    expect(report.sessions.map((s) => s.scenarioCode)).toEqual(['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7']);
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
});
