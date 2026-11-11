// 助手评测尺子：确定性内存版 Go 业务权威模拟器（sim-go）。
// 零外部网络请求、零真实生成扣费；加载真实 operation-descriptors.fixture.json，
// 还原画布 revision CAS、分镜行与产出连线绑定、生成提议与用户确认、任务交付、历史撤销及技能上下文。
//
// 实现按职责放在 sim-go/ 目录，各模块显式接收同一份共享状态（state.mjs）：
// canvas-store / canvas-ops 画布，storyboard 分镜，generation 生成提案与提交，tasks 任务生命周期与耗时，
// media 媒体与素材，skills 技能，turns 回合授权与撤销，operations 操作分发，http HTTP 路由。
// 本文件只组装对外接口。

import { createSimState, snapshotState } from './sim-go/state.mjs';
import { ensureCanvas, userEditNode } from './sim-go/canvas-store.mjs';
import { beginTurn, undoTurn } from './sim-go/turns.mjs';
import { executeOp, enableTaskWait } from './sim-go/operations.mjs';
import { confirmProposals } from './sim-go/generation.mjs';
import { setTaskTiming, waitForTasks, failNextTask, flagNextTaskDefect } from './sim-go/tasks.mjs';
import { armNextMediaInspectError } from './sim-go/media.mjs';
import { registerSkill, getSkillPin, getOrInitSkillContext, changeSkillContext } from './sim-go/skills.mjs';
import { createSimServer } from './sim-go/http.mjs';

export function createSimGo(options = {}) {
  const state = createSimState(options);
  ensureCanvas(state, state.defaultCanvasId, options.seed);
  const server = createSimServer(state);

  const sim = {
    server,
    port: 0,
    baseUrl: '',
    opsUrl: '',
    descriptors: state.descriptors,
    counts: state.counts,
    canvases: state.canvases,
    turns: state.turns,
    proposals: state.proposals,
    tasks: state.tasks,
    assets: state.assets,
    resources: state.resources,
    skills: state.skills,
    events: state.events,
    opLog: state.opLog,
    ensureCanvas: (...args) => ensureCanvas(state, ...args),
    beginTurn: (...args) => beginTurn(state, ...args),
    executeOp: (...args) => executeOp(state, ...args),
    confirmProposals: (...args) => confirmProposals(state, ...args),
    setTaskTiming: (...args) => setTaskTiming(state, ...args),
    enableTaskWait: () => enableTaskWait(state),
    waitForTasks: (...args) => waitForTasks(state, ...args),
    failNextTask: (...args) => failNextTask(state, ...args),
    flagNextTaskDefect: (...args) => flagNextTaskDefect(state, ...args),
    armNextMediaInspectError: (...args) => armNextMediaInspectError(state, ...args),
    userEditNode: (...args) => userEditNode(state, ...args),
    undoTurn: (...args) => undoTurn(state, ...args),
    registerSkill: (...args) => registerSkill(state, ...args),
    getSkillPin: (...args) => getSkillPin(state, ...args),
    getOrInitSkillContext: (...args) => getOrInitSkillContext(state, ...args),
    changeSkillContext: (...args) => changeSkillContext(state, ...args),
    snapshot: () => snapshotState(state),
    async listen(port = 0) {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => resolve());
      });
      const addr = server.address();
      sim.port = typeof addr === 'object' && addr ? addr.port : port;
      sim.baseUrl = `http://127.0.0.1:${sim.port}`;
      sim.opsUrl = `${sim.baseUrl}/api`;
      return sim;
    },
    async close() {
      for (const timer of state.pendingTimers) clearTimeout(timer);
      state.pendingTimers.clear();
      if (server.listening) {
        server.closeAllConnections?.();
        await new Promise((resolve) => server.close(() => resolve()));
      }
    },
  };

  return sim;
}
