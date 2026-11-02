// 产品扩展、技能上下文与工具装配：与会话拥有者分离，只负责把业务工具、计划/现场/技能 section
// 与模型请求前后的钩子装配进官方 Durable Registry。
import crypto from 'node:crypto';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { defineExtension, defineTool, GenerationTask, hook } from '@earendil-works/pi-durable';
import { officialNativeHistory } from './native-history.mjs';
import { SYSTEM_PROMPT } from './system-prompt.mjs';
import { SKILL_LOAD_PARAMETERS, createSkillCatalogSection, expandSkillContent, loadPinnedSkills, loadedSkillRecord,
  normalizeSkillCatalog, sameSkillPin, skillsToLoad, activeSkillProjection, guardSkillModelRequests } from './skill-resource.mjs';
import { missingSkillResources, restoredSkillMessage } from './active-skills.mjs';
import { PLAN_UPDATE_PARAMETERS, applyPlanUpdate, emptyPlan, planContinuation, publicPlan, renderPlanSection } from './plan.mjs';
import { withCurrentStudio } from './studio-digest.mjs';
import { normalizeModelTransportError } from './model-transport-error.mjs';

const CTX = BACKGROUND_CONTEXT;
const fail = (reason) => Object.assign(new Error(reason), { reason });
const requestSignature = (messages) => crypto.createHash('sha256').update(JSON.stringify(messages)).digest('hex');

export const supplementMarker = (id) => `[BEEFTV_INPUT:${id}]`;

export function supplementContent(id, content) {
  return [{ type: 'text', text: supplementMarker(id) }, ...(typeof content === 'string' ? [{ type: 'text', text: content }] : content)];
}

export function prependStudioChanges(content, diffText) {
  if (!diffText) return content;
  const text = `<canvas_changes>\n${diffText}\n</canvas_changes>`;
  if (typeof content === 'string') return `${text}\n\n${content}`;
  return [{ type: 'text', text }, ...content];
}

export function durableToolReplay(tool) {
  return tool.replay === 'safe' ? 'safe' : 'unsafe';
}

export function createDurableSkillController({ skills, getModels, state, update, lock, officialSubmission }) {
  // Every fresh explicit selection expands its fixed version into the user
  // message, as official `/skill:name` does. Request receipts own retry dedup.
  async function expandSelectedSkills(entry, doc, pins, content, turnId) {
    if (!skills || !Array.isArray(pins) || !pins.length) return { content, records: [] };
    const missing = skillsToLoad(pins, doc?.loadedSkills || []);
    if (!missing.length) return { content, records: [] };
    const resources = await loadPinnedSkills({ pins: missing, readVersion: (pin, signal) => skills.readVersion(entry, pin, signal, turnId) });
    return { content: expandSkillContent(content, resources), records: resources.map((resource) => loadedSkillRecord(resource, 'selected', turnId)) };
  }

  async function readSkillContext(entry, turnId = entry.turn.turnId) {
    if (typeof skills?.readContext !== 'function') throw fail('skill_context_service_unavailable');
    const context = await skills.readContext(entry, turnId);
    if (context.canvasId !== entry.canvasId || context.sessionId !== entry.sessionId) throw fail('skill_context_identity_mismatch');
    return context;
  }

  async function resolveActiveSkills(entry, ref, signal) {
    const context = await readSkillContext(entry);
    const model = (await getModels(entry)).getModel(ref.provider, ref.modelId);
    return activeSkillProjection({ context, model, signal,
      readVersion: (pin, readSignal) => skills.readVersion(entry, pin, readSignal, entry.turn.turnId) });
  }

  async function resetPendingScope(entry, context) {
    if (context.lifecycle !== 'reset_pending') return context;
    // Repeating reset after a crash before acknowledgement is safe: no model
    // request can pass until the same Go-owned scope has been acknowledged.
    await entry.root.reset('用户开始一个独立任务。只使用当前明确选择的技能和本轮提供的资源。', CTX);
    await update(entry, (doc) => { doc.plan = emptyPlan(); doc.lastStudioSnapshot = null; doc.lastStudioSnapshotRevision = null; doc.studioDigestText = ''; });
    entry.turn.plan = null;
    return skills.changeContext(entry, { action: 'ack_reset', scopeId: context.scopeId, expectedRevision: context.revision }, '');
  }

  async function prepareSkillContext(entry, pins, requestId, turnId, { append = false, skillLoad = false } = {}) {
    let context = await resetPendingScope(entry, await readSkillContext(entry, turnId));
    if (pins?.length) {
      const values = append ? [...context.activePins.filter((pin) => !pins.some((next) => next.skillId === pin.skillId)), ...pins] : pins;
      context = await skills.changeContext(entry, { action: 'activate', pins: values, expectedRevision: context.revision, requestId: `select:${requestId}`, ...(skillLoad ? { origin: 'skill_load' } : {}) }, turnId);
      const current = await readSkillContext(entry, turnId);
      if (current.scopeId !== context.scopeId || current.revision !== context.revision) throw fail('skill_context_changed');
    }
    return context;
  }

  async function activateTurnSkills(entry) {
    const active = (await state(entry)).active;
    if (!skills || !active?.skills?.length || await officialSubmission(entry, active.requestId)) return;
    let selection = active.skillSelection;
    if (!selection) {
      const context = await readSkillContext(entry, active.turnId);
      selection = { scopeId: context.scopeId, revision: context.revision, previousPins: context.activePins, pins: active.skills };
      // Journal before the Go write: a Stop or crash can then undo only this
      // unsubmitted selection, using the same idempotent Go receipt on recovery.
      await update(entry, (doc) => { doc.active.skillSelection = selection; });
    }
    const applied = await skills.changeContext(entry, { action: 'activate', pins: selection.pins,
      expectedRevision: selection.revision, requestId: `select:${active.requestId}` }, active.turnId);
    const current = await readSkillContext(entry, active.turnId);
    if (current.scopeId !== applied.scopeId || current.revision !== applied.revision) throw fail('skill_context_changed');
  }

  async function undoUnsubmittedSkills(entry, active) {
    const selection = active.skillSelection;
    if (!selection || !skills) return;
    try {
      // Compensation belongs to the session, including when Stop already closed
      // its Go turn after a failed official admit. Scope/revision still fence it.
      let applied;
      try {
        applied = await skills.changeContext(entry, { action: 'activate', pins: selection.pins,
          expectedRevision: selection.revision, requestId: `select:${active.requestId}` }, '');
      } catch (error) {
        // Go checks the durable receipt first. A pin rejection here therefore
        // means this selection never committed, so the old choice needs no undo.
        if (error?.reason === 'skill_context_pin_unavailable' && selection.pins.some((pin) => pin.skillId === error?.details?.skillId)) return;
        throw error;
      }
      const current = await readSkillContext(entry, '');
      if (current.scopeId !== selection.scopeId || current.revision !== applied.revision) return;
      let pins = selection.previousPins;
      for (;;) {
        try {
          await skills.changeContext(entry, { action: 'activate', pins,
            expectedRevision: current.revision, requestId: `undo-select:${active.requestId}` }, '');
          break;
        } catch (error) {
          // A user may have removed an old package while this input was preparing.
          // Only Go's explicit pin-validation failure can remove it from the undo.
          const unavailable = error?.details?.skillId;
          if (error?.reason !== 'skill_context_pin_unavailable' || !pins.some((pin) => pin.skillId === unavailable)) throw error;
          pins = pins.filter((pin) => pin.skillId !== unavailable);
        }
      }
    } catch (error) {
      // A newer explicit choice owns the context. Never overwrite it on Stop.
      if (error?.reason !== 'skill_context_revision_conflict') throw error;
    }
  }

  async function skillContext(entry) {
    return lock(entry.canvasId, () => readSkillContext(entry, ''));
  }

  async function changeSkillContext(entry, change) {
    return lock(entry.canvasId, async () => {
      if (entry.busy || (await state(entry)).active) throw fail('session_busy');
      await resetPendingScope(entry, await readSkillContext(entry, ''));
      await skills.changeContext(entry, change, '');
      // A replayed new_scope receipt may predate an already acknowledged reset
      // or later tasks. Only the live Go record can request another reset.
      return resetPendingScope(entry, await readSkillContext(entry, ''));
    });
  }

  return {
    expandSelectedSkills,
    readSkillContext,
    resolveActiveSkills,
    resetPendingScope,
    prepareSkillContext,
    activateTurnSkills,
    undoUnsubmittedSkills,
    skillContext,
    changeSkillContext,
  };
}

export async function installDurableExtensions({
  entry,
  registry,
  canvasId,
  sessionId,
  buildTools,
  skills,
  skillController,
  readCanvas,
  maxPlanContinuations,
  authorization,
  refreshStudioDigest,
  persistEffects,
  state,
  update,
  runWithBudget,
  getModels,
  extensions,
}) {
  const { readSkillContext, resolveActiveSkills, prepareSkillContext } = skillController;

  function hostTools() {
    const items = [{
      name: 'plan_update', label: 'plan.update', readOnly: true, replay: 'safe',
      description: '更新当前创作计划（整体替换步骤清单）',
      parameters: PLAN_UPDATE_PARAMETERS,
      execute: async (toolCallId, args) => {
        const started = Date.now();
        let nextPlan;
        try {
          await update(entry, (doc) => {
            nextPlan = applyPlanUpdate(doc.plan, args);
            doc.plan = nextPlan;
            if (doc.active) doc.active.plan = publicPlan(nextPlan);
          });
          entry.turn.plan = publicPlan(nextPlan);
          entry.generation.planTouchedInTurn = true;
          entry.log.push({ toolCallId: toolCallId || null, tool: 'plan.update', args: args || {}, isError: false, ms: Date.now() - started });
          return { content: [{ type: 'text', text: renderPlanSection(nextPlan) || '当前制作计划已清空。' }] };
        } catch (error) {
          entry.log.push({ toolCallId: toolCallId || null, tool: 'plan.update', args: args || {}, isError: true, error: error.message, ms: Date.now() - started });
          throw error;
        }
      },
    }];
    if (skills) {
      items.push({
        name: 'skill_load', label: 'skill.load', readOnly: false, replay: 'safe',
        description: '按技能目录 id 加载已安装技能正文',
        parameters: SKILL_LOAD_PARAMETERS,
        execute: async (_toolCallId, args, signal) => {
          const id = String(args?.id || '').trim();
          const find = (list) => (list || []).find((item) => item.pin.skillId === id);
          const active = await readSkillContext(entry);
          const pinned = active.activePins.find((pin) => pin.skillId === id);
          let item = pinned ? { pin: pinned } : find(entry.skillCatalog.items);
          if (!item) item = find(normalizeSkillCatalog(await skills.readCatalog(entry, signal, entry.turn.turnId, { id })));
          if (!item) throw fail('skill_not_installed: 技能目录里没有这个 id');
          const [resource] = await loadPinnedSkills({ pins: [item.pin], signal,
            readVersion: (pin, readSignal) => skills.readVersion(entry, pin, readSignal, entry.turn.turnId) });
          await prepareSkillContext(entry, [item.pin], `tool:${_toolCallId}`, entry.turn.turnId, { append: true, skillLoad: true });
          await update(entry, (doc) => {
            const loaded = doc.loadedSkills || [];
            if (!loaded.some((record) => sameSkillPin(record, resource.pin))) doc.loadedSkills = [...loaded, loadedSkillRecord(resource, 'tool', entry.turn.turnId)];
          });
          return { content: [{ type: 'text', text: expandSkillContent('按上面技能的步骤继续当前任务。', [resource]) }] };
        },
      });
    }
    return items;
  }

  const tools = [...buildTools(canvasId, entry.log, entry.generation, entry.turn, sessionId), ...hostTools()].map((tool) => defineTool({
    name: tool.name, description: tool.description + (tool.label === 'canvas.generation.propose'
      ? '。成功提案会结束本轮；plan_update 与本调用同一次响应发出。' : ''), parameters: tool.parameters,
    replay: durableToolReplay(tool), executionMode: 'sequential',
    ...(['media.overview', 'media.inspect', 'media.check', 'media.review'].includes(tool.label) ? { outputLimits: { maxBytes: 64 * 1024 * 1024, maxLines: 100000 } } : {}),
    execute: async (args, api, context) => {
      if (entry.generation.aborted) throw fail('aborted');
      if (entry.generation.pendingInputError) throw fail(entry.generation.pendingInputError.reason);
      if (entry.generation.pendingInput?.state === 'pending') throw fail('supplement_preparation_pending');
      await authorization(entry, entry.turn.turnId);
      try {
        const proposalCount = entry.turn.proposals.length;
        // Bridge tools return {content}; Durable's ToolExecutionResult names it output.
        const { content, ...result } = await runWithBudget(entry, () => tool.execute(String(api.taskId), args, context.abortSignal,
          { executeTool: (name, params, options) => api.executeTool(name, params, context, options),
            reportProgress: (progress) => api.details({ beeftvProgress: progress }, context) }));
        entry.generation.toolCalledSinceYield = true;
        if (!tool.readOnly && typeof readCanvas === 'function') {
          await refreshStudioDigest(entry, entry.turn.turnId, { selectedNodeIds: entry.input?.selectedNodeIds || [], computeDiff: false, signal: context.abortSignal });
        }
        // Official Durable ends only when every call in this response requests
        // termination. Mixed/failed rounds keep their normal model continuation.
        // 提方案失败时它自己不请求结束，整轮仍按官方规则继续，所以同批计划更新请求结束是安全的。
        const proposed = tool.label === 'canvas.generation.propose' && result.isError !== true && entry.turn.proposals.length > proposalCount;
        const planWithProposal = tool.label === 'plan.update' && result.isError !== true && (await state(entry))?.roundProposes === true;
        return { ...result, output: content, ...(proposed || planWithProposal ? { control: { ...result.control, terminate: true } } : {}) };
      } finally { await persistEffects(entry); }
    },
  }));
  entry.toolNames = tools.map((tool) => tool.name);

  const operationExtension = defineExtension({
    name: 'beeftv.operations.v1',
    tools,
    hooks: [hook(GenerationTask, {
      afterResponse: async (message, ...rest) => {
        normalizeModelTransportError(message, ...rest);
        // 本次响应是否带提方案调用：同批的 plan_update 也要请求结束本轮，否则官方 Durable 因为
        // 「不是所有调用都请求结束」而多发一轮只为总结的请求。写进 Durable 文档而不是内存，
        // 重启后从工具阶段接着跑时（不会再触发本钩子）仍然生效；每次响应都会重新写。
        const proposes = Array.isArray(message?.content)
          && message.content.some((part) => part?.type === 'toolCall' && part.name === 'canvas_generation_propose');
        if (((await state(entry))?.roundProposes === true) !== proposes) await update(entry, (doc) => { doc.roundProposes = proposes; });
      },
      beforeRequest: async (request, _runtime, context) => {
        for (;;) {
          if (entry.generation.pendingInputError) throw fail(entry.generation.pendingInputError.reason);
          if (entry.generation.pendingInput?.state === 'pending') await entry.generation.pendingInput.promise;
          if (entry.generation.aborted) throw fail('aborted');
          await authorization(entry, entry.turn.turnId);
          let studioDiff = '';
          if (typeof readCanvas === 'function') {
            studioDiff = await refreshStudioDigest(entry, entry.turn.turnId, { selectedNodeIds: entry.input?.selectedNodeIds || [], computeDiff: true, signal: context.abortSignal });
          }
          if (entry.generation.aborted) throw fail('aborted');
          const nativeDoc = await state(entry);
          const active = nativeDoc.active;
          entry.nativeHistory = await officialNativeHistory(entry, nativeDoc, CTX);
          if (entry.budget) { entry.budget.nativeHistory = entry.nativeHistory; entry.budget.sessionId = entry.sessionId; }
          if (entry.generation.pendingInput?.state === 'pending') continue;
          if (entry.generation.pendingInputError) throw fail(entry.generation.pendingInputError.reason);
          // Only a new decision with current evidence can release a conflict
          // fence. Tool reads and unrelated successful writes cannot release it.
          if (entry.turn.studioReadAvailable === true) entry.turn.canvasContextChanged = false;
          // A recovered generation may already have checkpointed its prepared
          // request before steering was queued. Overlay only missing durable user
          // inputs through the official request hook; the queue still owns their
          // transcript placement. This prevents replaying a stale prepared intent.
          let baseMessages = request.messages;
          for (const input of active?.supplementContents || []) {
            if (!JSON.stringify(baseMessages).includes(supplementMarker(input.requestId))) {
              baseMessages = [...baseMessages, { role: 'user', content: supplementContent(input.requestId, input.content), timestamp: Date.now() }];
            }
          }
          let restoredSkillsText = '';
          if (skills) {
            const agent = await _runtime.agent(context);
            const ref = agent.model;
            const model = ref ? _runtime.models.getModel(ref.provider, ref.modelId) : undefined;
            try {
              const projection = await resolveActiveSkills(entry, ref, context.abortSignal);
              const missing = missingSkillResources(baseMessages, projection.resources, model?.contextWindow);
              if (missing.length > 0) {
                restoredSkillsText = restoredSkillMessage(missing).content[0].text;
              }
            } catch (error) {
              entry.generation.skillContextFailure = {
                reason: error?.reason || 'skill_context_unavailable',
                message: error?.message || '技能状态不可用',
              };
              throw error;
            }
          }
          const studioDigest =
            typeof readCanvas === 'function'
              ? [nativeDoc.studioDigestText, studioDiff].filter(Boolean).join('\n')
              : '';
          const messages = withCurrentStudio(baseMessages, studioDigest, {
            includeStudio: typeof readCanvas === 'function',
            planText: renderPlanSection(nativeDoc?.plan) || '',
            restoredSkillsText,
          });
          entry.generation.modelEpoch = active?.intentEpoch || 0;
          await persistEffects(entry);
          if (entry.generation.pendingInput?.state === 'pending') continue;
          if ((active?.intentEpoch || 0) !== entry.generation.intentEpoch) continue;
          if (entry.generation.pendingInputError) throw fail(entry.generation.pendingInputError.reason);
          // Identify generation requests without treating the SDK's separate
          // compaction summarizer request as a user-generation prompt.
          entry.generation.preparedRequests ||= new Set();
          entry.generation.preparedRequests.add(requestSignature(messages));
          if (messages !== request.messages) return { messages };
          return;
        }
      },
      onYield: async () => {
        if (entry.generation.aborted || entry.generation.pendingInput?.state === 'pending' || entry.generation.pendingInputError) return;
        if (entry.turn.proposals?.length) return;
        const doc = await state(entry);
        if (doc?.active?.stopped || (doc?.active?.supplementIds?.length || 0) > 0) return;
        if (!entry.generation.unboundReminderSent && entry.turn.createdNodeIds?.length > 0 && typeof readCanvas === 'function') {
          const canvas = await readCanvas(entry, undefined, entry.turn.turnId).catch(() => null);
          const nodes = Array.isArray(canvas?.nodes) ? canvas.nodes : [];
          const connections = Array.isArray(canvas?.connections) ? canvas.connections : [];
          const byId = new Map(nodes.map((n) => [n.id, n]));
          const scriptNodes = nodes.filter((n) => n.type === 'script' && (n.metadata?.storyboard?.rows?.length || 0) > 0);
          if (scriptNodes.length > 0) {
            const boundIds = new Set();
            for (const s of scriptNodes) {
              for (const r of s.metadata?.storyboard?.rows || []) {
                if (r.imageNodeId) boundIds.add(r.imageNodeId);
                if (r.videoNodeId) boundIds.add(r.videoNodeId);
              }
            }
            const createdSet = new Set(entry.turn.createdNodeIds);
            const unboundMedia = nodes.filter(
              (n) => createdSet.has(n.id) && (n.type === 'image' || n.type === 'video') && !boundIds.has(n.id),
            );
            const createdImages = nodes.filter((n) => createdSet.has(n.id) && n.type === 'image');
            const unlinkedVideos = createdImages.length > 0
              ? nodes.filter(
                  (n) =>
                    createdSet.has(n.id) &&
                    n.type === 'video' &&
                    !connections.some((e) => e.toNodeId === n.id && byId.get(e.fromNodeId)?.type === 'image'),
                )
              : [];
            if (unboundMedia.length > 0 || unlinkedVideos.length > 0) {
              entry.generation.unboundReminderSent = true;
              const hints = [];
              if (unboundMedia.length > 0) {
                const list = unboundMedia.map((n) => `${n.id}「${n.title || n.type}」`).join('、');
                hints.push(`本轮新建的媒体节点（${list}）尚未通过 canvas_script_row_update 的 imageNodeId/videoNodeId 写回对应分镜行`);
              }
              if (unlinkedVideos.length > 0) {
                const vList = unlinkedVideos.map((n) => `${n.id}「${n.title || n.type}」`).join('、');
                hints.push(`本轮新建的视频节点（${vList}）尚未通过 canvas_edge_create 连接对应的首帧图节点`);
              }
              return {
                continue: `[制作现场检查] ${hints.join('；')}（当前画布 expectedRevision=${canvas.revision}）。请先补齐上述绑定/连线后再回复用户。`,
              };
            }
          }
        }
        if (!entry.generation.planTouchedInTurn || !entry.generation.toolCalledSinceYield) return;
        const prompt = planContinuation(doc?.plan, {
          continuations: entry.generation.planContinuations || 0,
          maxContinuations: maxPlanContinuations,
        });
        if (!prompt) return;
        entry.generation.planContinuations = (entry.generation.planContinuations || 0) + 1;
        entry.generation.toolCalledSinceYield = false;
        return { continue: prompt };
      },
    })],
  });

  registry.install(operationExtension);
  entry.configurePermission = async (mode) => {
    entry.generation.permissionMode = mode;
    const projected = [...buildTools(canvasId, entry.log, entry.generation, entry.turn, sessionId), ...hostTools()];
    const byName = new Map(projected.map((t) => [t.name, t]));
    const selected = tools.filter((t) => byName.has(t.name)).map((t) => ({ ...t, parameters: byName.get(t.name).parameters }));
    entry.toolNames = selected.map((tool) => tool.name);
    registry.install(defineExtension({ ...operationExtension, tools: selected }));
    if (entry.root) {
      await entry.root.configure({
        tools: selected,
        instructions: SYSTEM_PROMPT,
      }, CTX);
    }
  };

  if (skills) {
    registry.install(defineExtension({
      name: 'beeftv.skills.v1',
      sections: [
        createSkillCatalogSection({ readCatalog: (signal) => skills.readCatalog(entry, signal, entry.turn.turnId), cache: entry.skillCatalog }),
      ],
    }));
  }
  for (const extension of await extensions(entry)) registry.install(extension);

  let models = await getModels(entry);
  if (skills) {
    models = guardSkillModelRequests(models, async (model, request, signal) => {
      await authorization(entry, entry.turn.turnId);
      const projection = await resolveActiveSkills(entry, { provider: model.provider, modelId: model.id }, signal);
      if (entry.generation.preparedRequests?.has(requestSignature(request.messages))) {
        if (missingSkillResources(request.messages, projection.resources, model?.contextWindow).length > 0) {
          throw fail('skill_context_changed');
        }
      }
    }, (error) => {
      entry.generation.skillContextFailure = { reason: error?.reason || 'skill_context_unavailable', message: error?.message || '技能状态不可用' };
    });
  }

  return { tools, models };
}
