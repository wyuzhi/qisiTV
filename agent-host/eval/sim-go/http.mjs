// HTTP 路由：把 /api/ops、/api/canvas、回合、技能上下文和生成任务端点接到模拟器，统一回 {code, data, msg} 信封。

import http from 'node:http';
import { clone, OpError, notFound, permissionDenied } from './common.mjs';
import { ensureCanvas, saveCanvas } from './canvas-store.mjs';
import { beginTurn, undoTurn } from './turns.mjs';
import { confirmProposals } from './generation.mjs';
import { getOrInitSkillContext, changeSkillContext, registerSkill } from './skills.mjs';
import { executeOp, executeHttpOp } from './operations.mjs';

async function readJsonBody(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

function sendEnvelope(res, status, code, data, msg = 'ok', reason = undefined, details = undefined) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(
    JSON.stringify({
      code,
      data,
      msg,
      ...(reason ? { reason } : {}),
      ...(details ? { details } : {}),
    }),
  );
}

function sendOk(res, data) {
  sendEnvelope(res, 200, 0, data, 'ok');
}

function sendError(res, error) {
  if (error instanceof OpError) {
    sendEnvelope(res, error.status, error.status, null, error.message, error.reason, error.details);
    return;
  }
  sendEnvelope(res, 500, 500, null, String(error?.message || error), error?.reason || 'internal_error');
}

// 带对 host token 的请求算内置宿主；外部 Agent 用 owner token，不会碰到这个值。
function requestIsHost(state, req) {
  return Boolean(state.hostToken) && req.headers['x-beeftv-agent-token'] === state.hostToken;
}

export function createSimServer(state) {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
      const pathname = url.pathname.replace(/\/+$/, '') || '/';

      if (state.hostToken) {
        const gotToken = req.headers['x-beeftv-agent-token'];
        if (gotToken !== undefined && gotToken !== state.hostToken) {
          sendEnvelope(res, 403, 403, null, 'unauthorized', 'unauthorized');
          return;
        }
      }

      // 1. 操作描述符与共享操作层路由 (/api/ops, /api/ops/:id, /api/canvas/operations)
      if (req.method === 'GET' && (pathname === '/api/ops' || pathname === '/ops' || pathname === '/api/canvas/operations')) {
        sendOk(res, { ops: state.descriptors });
        return;
      }

      if (req.method === 'POST' && (pathname.startsWith('/api/ops/') || pathname.startsWith('/ops/'))) {
        const opIdName = decodeURIComponent(pathname.replace(/^(\/api)?\/ops\//, ''));
        const body = await readJsonBody(req);
        const turnId = String(req.headers['x-beeftv-agent-turn'] || body.turnId || '').trim();
        const opKey = String(body.opId || body.operationId || body.params?.operationId || '').trim();
        const params = body.params !== undefined ? body.params : body;
        const data = await executeHttpOp(state, opIdName, params, opKey, turnId, { host: requestIsHost(state, req) });
        sendOk(res, data);
        return;
      }

      if (req.method === 'POST' && pathname === '/api/canvas/operations') {
        const body = await readJsonBody(req);
        const opIdName = String(body.op || body.operation || body.id || '').trim();
        const turnId = String(req.headers['x-beeftv-agent-turn'] || body.turnId || '').trim();
        const opKey = String(body.opId || body.operationId || body.params?.operationId || '').trim();
        const params = body.params !== undefined ? body.params : body;
        const data = await executeHttpOp(state, opIdName, params, opKey, turnId, { host: requestIsHost(state, req) });
        sendOk(res, data);
        return;
      }

      // 2. 画布直接读写端点 (/api/canvas, /api/canvas/:id)
      if (pathname === '/api/canvas' || pathname.startsWith('/api/canvas/')) {
        const subId = pathname.startsWith('/api/canvas/') ? decodeURIComponent(pathname.slice('/api/canvas/'.length)) : '';
        if (req.method === 'GET') {
          const canvasId = subId || url.searchParams.get('canvasId') || state.defaultCanvasId;
          const doc = state.canvases.get(canvasId);
          if (!doc) throw notFound('canvas_not_found', `画布不存在: ${canvasId}`);
          sendOk(res, { canvasId, canvas: clone(doc) });
          return;
        }
        if (req.method === 'POST' || req.method === 'PUT') {
          const body = await readJsonBody(req);
          const canvasId = subId || String(body.canvasId || body.id || state.defaultCanvasId);
          if (body.seed === true || !state.canvases.has(canvasId)) {
            const doc = ensureCanvas(state, canvasId, body.canvas || body);
            sendOk(res, { canvasId, revision: doc.revision, canvas: clone(doc) });
            return;
          }
          const current = ensureCanvas(state, canvasId);
          const expectedRevision = body.expectedRevision !== undefined ? Number(body.expectedRevision) : current.revision;
          const nextDoc = { ...clone(current), ...(body.canvas || body), id: canvasId };
          const saved = saveCanvas(state, canvasId, nextDoc, expectedRevision, 'api.canvas.put');
          sendOk(res, { canvasId, revision: saved.revision, canvas: clone(saved) });
          return;
        }
      }

      // 3. 回合授权与生命周期端点 (/api/assistant/runtime/turns/:id..., /api/assistant/turns...)
      const runtimeTurnMatch = /^(\/api)?\/assistant\/(runtime\/)?turns\/([^/]+)(?:\/([^/]+))?(?:\/([^/]+)\/run)?$/.exec(pathname);
      if (runtimeTurnMatch) {
        const turnId = decodeURIComponent(runtimeTurnMatch[3]);
        const action = runtimeTurnMatch[4] || '';
        const subParam = runtimeTurnMatch[5] || '';

        if (req.method === 'GET' && !action) {
          let rec = state.turns.get(turnId);
          if (!rec && state.options.autoAuthorizeTurns !== false) {
            rec = beginTurn(state, { turnId, canvasId: state.defaultCanvasId, permissionMode: 'canvas' });
          }
          if (!rec) throw permissionDenied('turn_not_open', '任务不可恢复');
          sendOk(res, {
            turnId: rec.turnId,
            canvasId: rec.canvasId,
            permissionMode: rec.permissionMode,
            open: rec.open && !rec.undone,
            undone: rec.undone,
            sessionId: rec.sessionId,
            revisionBefore: rec.revisionBefore,
          });
          return;
        }

        if (req.method === 'POST' && action === 'bind-session') {
          const body = await readJsonBody(req);
          let rec = state.turns.get(turnId);
          if (!rec) rec = beginTurn(state, { turnId, canvasId: state.defaultCanvasId, sessionId: body.sessionId });
          rec.sessionId = String(body.sessionId || rec.sessionId || '');
          sendOk(res, { bound: true, turnId, sessionId: rec.sessionId });
          return;
        }

        if (req.method === 'POST' && action === 'native-rehydrate') {
          const body = await readJsonBody(req);
          sendOk(res, { source: body.source });
          return;
        }

        if (req.method === 'POST' && action === 'complete') {
          let rec = state.turns.get(turnId);
          if (!rec) rec = beginTurn(state, { turnId, canvasId: state.defaultCanvasId });
          rec.open = false;
          sendOk(res, {
            turnId: rec.turnId,
            canvasId: rec.canvasId,
            permissionMode: rec.permissionMode,
            open: false,
            undone: rec.undone,
          });
          return;
        }

        if (req.method === 'POST' && action === 'undo') {
          const body = await readJsonBody(req);
          const undone = undoTurn(state, turnId, body.canvasId || state.defaultCanvasId);
          sendOk(res, undone);
          return;
        }

        if (req.method === 'POST' && action === 'proposals' && subParam) {
          const proposalId = decodeURIComponent(subParam);
          const created = await confirmProposals(state, proposalId);
          sendOk(res, { proposalId, tasks: created });
          return;
        }
      }

      if (
        pathname === '/api/assistant/turns' ||
        pathname === '/api/assistant/runtime/turns' ||
        pathname === '/assistant/runtime/turns'
      ) {
        if (req.method === 'POST') {
          const body = await readJsonBody(req);
          const rec = beginTurn(state, body);
          sendOk(res, {
            turnId: rec.turnId,
            canvasId: rec.canvasId,
            permissionMode: rec.permissionMode,
            open: rec.open,
            sessionId: rec.sessionId,
            revisionBefore: rec.revisionBefore,
          });
          return;
        }
        if (req.method === 'GET') {
          sendOk(res, { turns: [...state.turns.values()].map((t) => clone(t)) });
          return;
        }
      }

      // 4. 技能与活动技能上下文端点 (/api/assistant/skills, /api/assistant/skills/active, /api/assistant/runtime/canvases/:canvasId/skill-context)
      const skillCtxMatch = /^(\/api)?\/assistant\/(runtime\/)?canvases\/([^/]+)\/skill-context$/.exec(pathname);
      if (skillCtxMatch) {
        const canvasId = decodeURIComponent(skillCtxMatch[3]);
        if (req.method === 'GET') {
          const sessionId = url.searchParams.get('sessionId') || 'default';
          sendOk(res, clone(getOrInitSkillContext(state, canvasId, sessionId)));
          return;
        }
        if (req.method === 'POST') {
          const body = await readJsonBody(req);
          sendOk(res, changeSkillContext(state, canvasId, body));
          return;
        }
      }

      if (pathname === '/api/assistant/skills') {
        if (req.method === 'GET') {
          const data = executeOp(state, 'skill.catalog', Object.fromEntries(url.searchParams));
          sendOk(res, data.result);
          return;
        }
        if (req.method === 'POST') {
          const body = await readJsonBody(req);
          sendOk(res, registerSkill(state, body));
          return;
        }
      }

      if (pathname === '/api/assistant/skills/active') {
        if (req.method === 'GET') {
          const canvasId = url.searchParams.get('canvasId') || state.defaultCanvasId;
          const sessionId = url.searchParams.get('sessionId') || 'default';
          sendOk(res, clone(getOrInitSkillContext(state, canvasId, sessionId)));
          return;
        }
        if (req.method === 'POST' || req.method === 'PUT') {
          const body = await readJsonBody(req);
          const canvasId = String(body.canvasId || state.defaultCanvasId);
          sendOk(res, changeSkillContext(state, canvasId, body));
          return;
        }
      }

      // 5. 生成任务端点 (/api/generation-tasks, /api/generation-tasks/:id)
      if (pathname === '/api/generation-tasks' || pathname.startsWith('/api/generation-tasks/')) {
        const sub = pathname.startsWith('/api/generation-tasks/')
          ? pathname.slice('/api/generation-tasks/'.length)
          : '';
        if (req.method === 'GET') {
          if (sub) {
            const task = state.tasks.get(decodeURIComponent(sub));
            if (!task) throw notFound('task_not_found', '任务不存在');
            sendOk(res, clone(task));
            return;
          }
          const canvasId = url.searchParams.get('canvasId') || '';
          const list = [...state.tasks.values()].filter((t) => !canvasId || t.canvasId === canvasId);
          sendOk(res, { tasks: clone(list), total: list.length });
          return;
        }
        if (req.method === 'POST') {
          const body = await readJsonBody(req);
          if (body.proposalId || body.confirmAll) {
            const created = await confirmProposals(state, body.proposalId || null, body);
            sendOk(res, { tasks: created });
            return;
          }
          if (body.ConfirmedByUser === false || body.confirmed === false) {
            state.counts.unconfirmedTasks += 1;
            throw permissionDenied('generation_confirmation_required', '付费生成必须经过用户确认');
          }
          // 直接为指定节点创建生成任务（测试/模拟用）
          state.seq.proposal += 1;
          const pId = `gp-${state.seq.proposal}`;
          state.proposals.set(pId, {
            proposalId: pId,
            turnId: body.turnId || '',
            canvasId: body.canvasId || state.defaultCanvasId,
            kind: body.kind || 'image',
            nodeIds: Array.isArray(body.nodeIds) ? body.nodeIds : [body.nodeId].filter(Boolean),
            model: 'Seedream 3.0',
            modelKey: 'seedream-3.0',
            note: body.note || '',
            confirmed: false,
            taskIds: [],
          });
          const created = await confirmProposals(state, pId, body);
          sendOk(res, { tasks: created });
          return;
        }
      }

      sendEnvelope(res, 404, 404, null, `未找到路由: ${req.method} ${pathname}`, 'not_found');
    } catch (error) {
      sendError(res, error);
    }
  });
}
