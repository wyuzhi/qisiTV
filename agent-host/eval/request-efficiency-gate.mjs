#!/usr/bin/env node
// 请求效率门禁（Request Efficiency Gate）
// 用评测台假模型抓包运行 S1–S7，断言：
// 1. 完整覆盖 S1–S7 共 7 个场景（每个场景至少 1 对相邻请求，且场景业务检查无失败）；
// 2. 一个会话内头部 system 文本逐字节不变，且仅含稳定内容（<instructions> 在前、<beeftv_skill_catalog> 在后，无其他段落）；
// 3. 每次请求末尾均带有非 system 的瞬态上下文（含 <beeftv_studio>）；
// 4. S1–S7 中至少 95% 的相邻请求对公共前缀覆盖前一次请求除末尾瞬态上下文外的全部内容（100% 字节一致）；
// 5. 记录头部 system + 工具定义的字符数并设只降不升上限（--update 仅允许收紧，不允许调高）。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runEval } from './run-eval.mjs';
import { isTransientStudioTailMessage } from '../studio-digest.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_BUDGET_PATH = path.join(__dirname, 'request-efficiency-budget.json');
export const DEFAULT_EXPECTED_SCENARIOS = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7'];

export function extractMessageText(msg) {
  if (!msg) return '';
  if (typeof msg.content === 'string') return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part.text === 'string') return part.text;
        return '';
      })
      .join('\n');
  }
  return '';
}

export function stripTrailingTransientContext(messages = []) {
  if (!Array.isArray(messages) || messages.length === 0) return [];
  const last = messages[messages.length - 1];
  if (isTransientStudioTailMessage(last)) {
    return messages.slice(0, -1);
  }
  return messages.slice();
}

export function commonPrefixLength(a = '', b = '') {
  const len = Math.min(a.length, b.length);
  let i = 0;
  while (i < len && a.charCodeAt(i) === b.charCodeAt(i)) {
    i++;
  }
  return i;
}

const CANONICAL_HEADER_RE =
  /^<instructions>\n[\s\S]*\n<\/instructions>(?:\n\n<beeftv_skill_catalog>\n[\s\S]*\n<\/beeftv_skill_catalog>)?$/;

export function analyzeCapturedRequests(
  capturedRequests = [],
  budget = null,
  { evalReport = null, expectedScenarios = DEFAULT_EXPECTED_SCENARIOS } = {},
) {
  const bySession = new Map();
  for (const item of capturedRequests) {
    const key = `${item.runIndex || 1}:${item.scenarioCode || item.scenarioId}:${item.canvasId || ''}`;
    if (!bySession.has(key)) {
      bySession.set(key, {
        sessionKey: key,
        scenarioCode: item.scenarioCode || item.scenarioId,
        scenarioId: item.scenarioId,
        canvasId: item.canvasId,
        requests: [],
      });
    }
    bySession.get(key).requests.push(item);
  }

  let totalAdjacentPairs = 0;
  let fullPrefixHitPairs = 0;
  let maxHeaderChars = 0;
  let maxToolsChars = 0;
  let maxHeaderPlusToolsChars = 0;

  const sessionReports = [];
  const violations = [];

  if (evalReport?.summary) {
    if (evalReport.summary.failedRuns > 0 || evalReport.summary.abortedRuns > 0) {
      violations.push(
        `runEval 存在失败或中断场景: failedRuns=${evalReport.summary.failedRuns}, abortedRuns=${evalReport.summary.abortedRuns}`,
      );
    }
  }

  for (const session of bySession.values()) {
    const reqs = session.requests;
    if (reqs.length === 0) continue;

    const distinctSessionIds = [...new Set(reqs.map((r) => r.sessionId).filter(Boolean))];
    const missingSessionIdCount = reqs.filter((r) => !r.sessionId).length;
    if (distinctSessionIds.length !== 1 || missingSessionIdCount > 0) {
      violations.push(
        `${session.scenarioCode}: 场景请求必须归属唯一非空 sessionId（实际 sessionIds=[${distinctSessionIds.join(', ')}], 缺失=${missingSessionIdCount}）`,
      );
    }
    const resolvedSessionId = distinctSessionIds[0] || session.sessionKey;

    const firstMessages = reqs[0].body?.messages || [];
    const firstSystemMsg = firstMessages[0];
    const firstSystemText =
      firstSystemMsg && (firstSystemMsg.role === 'system' || firstSystemMsg.role === 'developer')
        ? extractMessageText(firstSystemMsg)
        : '';

    let sessionSystemByteIdentical = true;
    let sessionHeaderClean = true;
    let sessionTailValid = true;
    let sessionPairs = 0;
    let sessionFullHits = 0;
    const pairDetails = [];

    for (let idx = 0; idx < reqs.length; idx++) {
      const req = reqs[idx];
      const messages = req.body?.messages || [];
      const tools = req.body?.tools || [];
      const leadingMsg = messages[0];
      const leadingText =
        leadingMsg && (leadingMsg.role === 'system' || leadingMsg.role === 'developer')
          ? extractMessageText(leadingMsg)
          : '';

      const headerChars = leadingText.length;
      const toolsChars = JSON.stringify(tools).length;
      const combinedChars = headerChars + toolsChars;
      if (headerChars > maxHeaderChars) maxHeaderChars = headerChars;
      if (toolsChars > maxToolsChars) maxToolsChars = toolsChars;
      if (combinedChars > maxHeaderPlusToolsChars) maxHeaderPlusToolsChars = combinedChars;

      if (!leadingMsg || (leadingMsg.role !== 'system' && leadingMsg.role !== 'developer')) {
        sessionHeaderClean = false;
        violations.push(`${session.scenarioCode} req#${idx + 1}: messages[0] 必须是 system/developer 消息`);
      }

      const laterInvalidSystem = messages.slice(1).filter((m) => {
        if (m?.role !== 'system' && m?.role !== 'developer') return false;
        const hasText = extractMessageText(m).trim().length > 0;
        const hasSections = m.sections && Object.keys(m.sections).length > 0;
        const hasToolDelta = Array.isArray(m.toolsAdded) || Array.isArray(m.toolsRemoved);
        return hasText || hasSections || !hasToolDelta;
      });
      if (laterInvalidSystem.length > 0) {
        sessionHeaderClean = false;
        violations.push(
          `${session.scenarioCode} req#${idx + 1}: messages[1..] 存在非法或非空文本的 system/developer 消息（共 ${laterInvalidSystem.length} 条）`,
        );
      }

      if (
        leadingText.includes('<beeftv_studio>') ||
        leadingText.includes('<beeftv_plan>') ||
        leadingText.includes('<beeftv_active_skills>')
      ) {
        sessionHeaderClean = false;
        violations.push(
          `${session.scenarioCode} req#${idx + 1}: 头部 system 仍包含动态区块（beeftv_studio / beeftv_plan / beeftv_active_skills）`,
        );
      }

      const instrIdx = leadingText.indexOf('<instructions>');
      const catalogIdx = leadingText.indexOf('<beeftv_skill_catalog>');
      if (instrIdx < 0) {
        sessionHeaderClean = false;
        violations.push(`${session.scenarioCode} req#${idx + 1}: 头部 system 缺少 <instructions>`);
      } else if (catalogIdx >= 0 && instrIdx > catalogIdx) {
        sessionHeaderClean = false;
        violations.push(
          `${session.scenarioCode} req#${idx + 1}: <beeftv_skill_catalog> (${catalogIdx}) 排在 <instructions> (${instrIdx}) 前面`,
        );
      } else if (!CANONICAL_HEADER_RE.test(leadingText.trim())) {
        sessionHeaderClean = false;
        violations.push(
          `${session.scenarioCode} req#${idx + 1}: 头部 system 不符合规范结构（必须以 <instructions> 开头，仅允许紧跟 <beeftv_skill_catalog>）`,
        );
      }

      const lastMsg = messages[messages.length - 1];
      const lastMsgText = extractMessageText(lastMsg);
      if (
        !isTransientStudioTailMessage(lastMsg) ||
        !/<beeftv_studio>\n[\s\S]*\n<\/beeftv_studio>$/.test(lastMsgText.trim())
      ) {
        sessionTailValid = false;
        violations.push(
          `${session.scenarioCode} req#${idx + 1}: 末尾消息缺少非 system 的 <beeftv_studio> 瞬态上下文`,
        );
      }

      const hasCompletedPlanUpdate = messages.slice(0, -1).some(
        (m) =>
          m?.role === 'tool' &&
          extractMessageText(m).includes('Current plan:') &&
          !extractMessageText(m).includes('No active plan.'),
      );
      if (hasCompletedPlanUpdate && !/<beeftv_plan>\n[\s\S]*\n<\/beeftv_plan>/.test(lastMsgText)) {
        sessionTailValid = false;
        violations.push(
          `${session.scenarioCode} req#${idx + 1}: plan_update 生效后末尾瞬态消息缺少 <beeftv_plan>`,
        );
      }

      const hasCompletedSkillLoad = messages.slice(0, -1).some(
        (m) => m?.role === 'tool' && extractMessageText(m).includes('<skill_resource'),
      );
      if (hasCompletedSkillLoad) {
        const nonSystemHasSkill = messages
          .slice(1)
          .some(
            (m) =>
              m?.role !== 'system' &&
              m?.role !== 'developer' &&
              extractMessageText(m).includes('<skill_resource'),
          );
        if (!nonSystemHasSkill) {
          sessionTailValid = false;
          violations.push(
            `${session.scenarioCode} req#${idx + 1}: skill_load 生效后非 system 消息缺少 <skill_resource 正文`,
          );
        }
      }

      if (idx > 0) {
        const sameBytes = Buffer.from(leadingText, 'utf8').equals(Buffer.from(firstSystemText, 'utf8'));
        if (!sameBytes) {
          sessionSystemByteIdentical = false;
          const commonSys = commonPrefixLength(firstSystemText, leadingText);
          violations.push(
            `${session.scenarioCode} req#${idx + 1}: 会话内头部 system 文本发生变化（与首请求公共前缀仅 ${commonSys}/${firstSystemText.length} 字）`,
          );
        }

        const prev = reqs[idx - 1];
        const prevMessages = prev.body?.messages || [];
        const prevStableMessages = stripTrailingTransientContext(prevMessages);
        const prevPrefixSerialized = JSON.stringify(prevStableMessages).slice(0, -1);
        const currFullSerialized = JSON.stringify(messages);
        const commonChars = commonPrefixLength(prevPrefixSerialized, currFullSerialized);
        const toolsIdentical = JSON.stringify(prev.body?.tools || []) === JSON.stringify(tools);
        const fullCover =
          toolsIdentical &&
          prevPrefixSerialized.length > 0 &&
          commonChars === prevPrefixSerialized.length;
        const coverage =
          prevPrefixSerialized.length > 0
            ? Number((commonChars / prevPrefixSerialized.length).toFixed(4))
            : 1;

        totalAdjacentPairs += 1;
        sessionPairs += 1;
        if (fullCover) {
          fullPrefixHitPairs += 1;
          sessionFullHits += 1;
        }

        pairDetails.push({
          fromReq: idx,
          toReq: idx + 1,
          prevStableChars: prevPrefixSerialized.length,
          commonPrefixChars: commonChars,
          coverage,
          toolsIdentical,
          fullCover,
        });
      }
    }

    if (sessionPairs < 1) {
      violations.push(`${session.scenarioCode}: 至少需要 1 对相邻请求（实际请求数 ${reqs.length}）`);
    }

    sessionReports.push({
      sessionId: resolvedSessionId,
      scenarioCode: session.scenarioCode,
      scenarioId: session.scenarioId,
      requestCount: reqs.length,
      adjacentPairs: sessionPairs,
      fullPrefixHitPairs: sessionFullHits,
      prefixHitRatio: sessionPairs > 0 ? Number((sessionFullHits / sessionPairs).toFixed(4)) : 0,
      systemByteIdentical: sessionSystemByteIdentical,
      headerClean: sessionHeaderClean,
      tailValid: sessionTailValid,
      pairs: pairDetails,
    });
  }

  if (Array.isArray(expectedScenarios) && expectedScenarios.length > 0) {
    const observedCodes = new Set(sessionReports.map((s) => s.scenarioCode));
    const missingCodes = expectedScenarios.filter((code) => !observedCodes.has(code));
    if (missingCodes.length > 0) {
      violations.push(`缺少预期评测场景请求记录: ${missingCodes.join(', ')}`);
    }
  }

  const minPrefixHitRatio = budget?.minAdjacentPrefixCoverageRatio ?? 0.95;
  const overallPrefixHitRatio =
    totalAdjacentPairs > 0 ? Number((fullPrefixHitPairs / totalAdjacentPairs).toFixed(4)) : 0;

  if (overallPrefixHitRatio < minPrefixHitRatio) {
    violations.push(
      `S1–S7 相邻请求公共前缀完整覆盖率 ${(overallPrefixHitRatio * 100).toFixed(1)}% (${fullPrefixHitPairs}/${totalAdjacentPairs}) 低于门禁阈值 ${(minPrefixHitRatio * 100).toFixed(1)}%`,
    );
  }

  if (budget) {
    if (Number.isFinite(budget.maxHeaderChars) && maxHeaderChars > budget.maxHeaderChars) {
      violations.push(`头部 system 字符数 ${maxHeaderChars} 超过上限 ${budget.maxHeaderChars}（只许变小）`);
    }
    if (Number.isFinite(budget.maxToolsChars) && maxToolsChars > budget.maxToolsChars) {
      violations.push(`工具定义字符数 ${maxToolsChars} 超过上限 ${budget.maxToolsChars}（只许变小）`);
    }
    if (
      Number.isFinite(budget.maxHeaderPlusToolsChars) &&
      maxHeaderPlusToolsChars > budget.maxHeaderPlusToolsChars
    ) {
      violations.push(
        `头部+工具定义总字符数 ${maxHeaderPlusToolsChars} 超过上限 ${budget.maxHeaderPlusToolsChars}（只许变小）`,
      );
    }
  }

  return {
    passed: violations.length === 0,
    totalRequests: capturedRequests.length,
    totalAdjacentPairs,
    fullPrefixHitPairs,
    overallPrefixHitRatio,
    minPrefixHitRatio,
    maxHeaderChars,
    maxToolsChars,
    maxHeaderPlusToolsChars,
    budget: budget || null,
    sessions: sessionReports,
    violations,
  };
}

export function ratchetBudget(existingBudget, measured) {
  const clamp = (prev, curr) => {
    if (!Number.isFinite(curr) || curr <= 0) return prev;
    return Number.isFinite(prev) ? Math.min(prev, curr) : curr;
  };
  return {
    minAdjacentPrefixCoverageRatio: existingBudget?.minAdjacentPrefixCoverageRatio ?? 0.95,
    maxHeaderChars: clamp(existingBudget?.maxHeaderChars, measured.maxHeaderChars),
    maxToolsChars: clamp(existingBudget?.maxToolsChars, measured.maxToolsChars),
    maxHeaderPlusToolsChars: clamp(
      existingBudget?.maxHeaderPlusToolsChars,
      measured.maxHeaderPlusToolsChars,
    ),
  };
}

export async function runRequestEfficiencyGate({
  scenario = 'all',
  budgetPath = DEFAULT_BUDGET_PATH,
  updateBudget = false,
} = {}) {
  const captured = [];
  const budget = fs.existsSync(budgetPath)
    ? JSON.parse(fs.readFileSync(budgetPath, 'utf8'))
    : null;

  const expectedScenarios =
    scenario === 'all'
      ? DEFAULT_EXPECTED_SCENARIOS
      : String(scenario)
          .split(',')
          .map((s) => s.trim().toUpperCase())
          .filter(Boolean);

  const { report: evalReport } = await runEval({
    scenario,
    model: 'fake',
    runs: 1,
    maxRequests: 25,
    budgetCny: 25,
    onModelRequest: (event) => {
      captured.push(event);
    },
  });

  if (updateBudget) {
    const measured = analyzeCapturedRequests(captured, null, { evalReport, expectedScenarios });
    if (measured.passed && measured.maxHeaderChars > 0 && measured.maxToolsChars > 0) {
      const nextBudget = ratchetBudget(budget, measured);
      fs.writeFileSync(budgetPath, JSON.stringify(nextBudget, null, 2) + '\n', 'utf8');
      return analyzeCapturedRequests(captured, nextBudget, { evalReport, expectedScenarios });
    }
    return measured;
  }

  return analyzeCapturedRequests(captured, budget, { evalReport, expectedScenarios });
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  const updateBudget = process.argv.includes('--update');
  const scenarioArgIdx = process.argv.indexOf('--scenario');
  const scenario = scenarioArgIdx >= 0 && process.argv[scenarioArgIdx + 1] ? process.argv[scenarioArgIdx + 1] : 'all';

  const report = await runRequestEfficiencyGate({ scenario, updateBudget });
  console.log(
    `[request-efficiency-gate] requests=${report.totalRequests} pairs=${report.fullPrefixHitPairs}/${report.totalAdjacentPairs} (${(report.overallPrefixHitRatio * 100).toFixed(1)}%) header=${report.maxHeaderChars} tools=${report.maxToolsChars} total=${report.maxHeaderPlusToolsChars}`,
  );
  for (const s of report.sessions) {
    const broken = s.pairs.filter((p) => !p.fullCover);
    const brokenDesc =
      broken.length > 0
        ? ` broken=[${broken.map((p) => `${p.fromReq}->${p.toReq}:${p.commonPrefixChars}/${p.prevStableChars}`).join(', ')}]`
        : '';
    console.log(
      `  ${s.scenarioCode} (${s.scenarioId}): reqs=${s.requestCount} pairs=${s.fullPrefixHitPairs}/${s.adjacentPairs} sysIdentical=${s.systemByteIdentical} headerClean=${s.headerClean} tailValid=${s.tailValid}${brokenDesc}`,
    );
  }
  if (!report.passed) {
    console.error('\n[request-efficiency-gate] FAILED:');
    for (const v of report.violations) {
      console.error(`  - ${v}`);
    }
    process.exit(1);
  }
  console.log('[request-efficiency-gate] PASSED');
}
