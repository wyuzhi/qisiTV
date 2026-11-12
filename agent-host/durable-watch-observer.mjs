// Durable 1.5.0 会话视图监听、回合恢复、停止围栏与结算：
// 使用官方 Conversation.watch 与 LiveDoc 驱动流式事件投影，保持与 durable-session-owner 解耦。
import { BACKGROUND_CONTEXT, withAbortSignal } from '@earendil-works/chord/context';
import { AssistantEntry, CompactionEntry, LiveDoc, ToolResultEntry, UserEntry } from '@earendil-works/pi-durable';
import { turnChange } from './canvas-turn.mjs';
import { publicPlan } from './plan.mjs';
import { supplementContent } from './durable-extensions.mjs';
import {
  durableCompletion,
  durableReasoningSegments,
  durableTurnReplyText,
  publicDurableTurn,
} from './durable-turn-projection.mjs';

const CTX = BACKGROUND_CONTEXT;
const fail = (reason) => Object.assign(new Error(reason), { reason });
const continuationRevoked = (error) => ['continuation_cancelled', 'continuation_scope_changed'].includes(error?.reason);

async function scanConversationEntries(entry, query, context = CTX) {
  const items = [];
  let cursor;
  do {
    const page = await entry.root.entries(query, 256, cursor, context);
    items.push(...(page?.items || []));
    cursor = page?.next;
  } while (cursor !== undefined);
  return items;
}

function mergeEntriesById(left, right) {
  const byId = new Map();
  for (const item of left || []) if (item?.id !== undefined) byId.set(item.id, item);
  for (const item of right || []) if (item?.id !== undefined) byId.set(item.id, item);
  return [...byId.values()].sort((a, b) => a.id - b.id);
}

export function createDurableTurnLifecycle({
  stateDoc,
  state,
  update,
  lock,
  hydrate,
  authorization,
  turnModel,
  submit,
  officialSubmission,
  stopBeforeSubmit,
  stopIntended,
  forgetStop,
  completeTurn,
}) {
  async function stoppedRequest(entry, active) {
    const submission = await officialSubmission(entry, active.requestId);
    if (!submission) return stopBeforeSubmit(entry, active);
    await fenceStop(entry);
    await entry.root.abort(CTX);
    return submission;
  }

  async function settleLocal(entry, active, record) {
    await update(entry, (doc) => {
      if (doc.active?.requestId === active.requestId) { doc.turns = [...doc.turns, record]; doc.active = null; }
      if (doc.stopRequests?.includes(active.requestId)) doc.stopRequests = doc.stopRequests.filter((id) => id !== active.requestId);
    });
    forgetStop(entry.canvasId, entry.sessionId, active.requestId);
    entry.busy = false;
    if (entry.pendingPluginExtensions && typeof entry.reloadPluginExtensions === 'function') {
      const pending = entry.pendingPluginExtensions;
      entry.pendingPluginExtensions = null;
      await entry.reloadPluginExtensions(pending);
    }
  }

  async function completionRecord(entry, active, settled) {
    // The official settlement points at its exact answer entry. Never take the
    // last assistant in transcript: it may belong to a previous successful turn.
    const answer = settled.answer ? await entry.harness.commit((tx) => tx.entry(settled.answer), CTX) : null;
    let assistant = answer?.model?.find((message) => message.role === 'assistant');
    // 本轮范围由原提交、补充输入与确切结束条目限定：工具调用前后的助手条目都算这一轮，
    // 终态与实时流、重开历史用同一份投影，所以片段身份与顺序一致。
    const original = active.submissionId ? await entry.harness.submission(active.submissionId, CTX) : null;
    const originalStatus = original ? await original.status(CTX) : null;
    const lowerBound = originalStatus?.entry ?? settled.entry;
    const view = lowerBound === undefined ? null : await entry.root.context(CTX);
    let viewEntries = view?.entries || [];
    if (lowerBound !== undefined && view?.head?.head !== undefined && view.head.head > lowerBound + 1) {
      const compactedPrefix = await scanConversationEntries(
        entry,
        { minEntryId: lowerBound + 1, maxEntryId: view.head.head - 1, order: 'ascending' },
        CTX,
      );
      viewEntries = mergeEntriesById(compactedPrefix, viewEntries);
    }
    const turnEntries = view ? viewEntries.filter((item) => item.id > lowerBound
      && item.kind !== CompactionEntry.kind
      && (settled.answer === undefined || item.id <= settled.answer)) : (answer ? [answer] : []);
    if (active.stopped || ['aborted', 'interrupted', 'restart_limit'].includes(settled.reason)) {
      // Official abort/interruption converts its committed partial into an assistant entry.
      const partial = turnEntries.flatMap((item) => item.model || [])
        .filter((message) => message.role === 'assistant' && message.stopReason === 'aborted').at(-1);
      if (partial) assistant = partial;
    }
    const scopedEntries = turnEntries.length ? turnEntries : (answer ? [{ id: settled.answer ?? 0, ...answer }] : []);
    const replyText = durableTurnReplyText(scopedEntries)
      || ((active.stopped || ['aborted', 'interrupted', 'restart_limit'].includes(settled.reason) || entry.generation.pendingInputError || entry.generation.skillContextFailure) && assistant
        ? durableTurnReplyText([{ id: settled.answer ?? 0, model: [assistant] }])
        : '');
    const preparationError = entry.generation.pendingInputError || entry.generation.skillContextFailure;
    const completion = preparationError
      ? { reply: replyText, cancelled: false, error: preparationError.message, errorReason: preparationError.reason }
      : durableCompletion(settled, assistant, entry.budget?.failure, active.stopped, replyText);
    const planView = entry.turn.plan || active.plan || null;
    // 思考是权威值：即使为空也要写进终态和历史，界面才能区分「没有思考」与「字段缺失」并清掉旧内容。
    const reasoning = durableReasoningSegments(turnEntries);
    return { ...publicDurableTurn(active), ...completion, reasoning,
      toolCalls: [...entry.log], change: turnChange(entry.turn), proposals: [...entry.turn.proposals],
      scriptProposals: [...(entry.turn.scriptProposals || [])],
      ...(planView ? { plan: planView } : {}),
      status: settled.status, sessionId: entry.sessionId };
  }

  async function recover(entry) {
    // A live official wait already owns the turn: a read must not hydrate over its
    // in-memory effects, re-authorize, or re-submit. Concurrent reads share one recovery.
    if (entry.waiters > 0) return null;
    if (!entry.recovering) entry.recovering = recoverOnce(entry).finally(() => { entry.recovering = null; });
    return entry.recovering;
  }

  async function recoverOnce(entry) {
    const doc = await state(entry);
    const active = doc.active;
    if (!active) return null;
    hydrate(entry, active);
    // Opening/reading never schedules pending work. Only validated recovery does.
    let auth;
    try { auth = await authorization(entry, active.turnId, true); }
    catch (error) {
      if (active.continuationId && continuationRevoked(error)) return stoppedRequest(entry, active);
      throw error;
    }
    if (entry.waiters > 0) return null;
    // Completion is already committed: only acknowledge it, never re-run or rebuild it.
    // Pre-submit stops have no official submission, including after Go has already closed.
    if (active.result) {
      if (auth?.open !== false) await completeTurn({ canvasId: entry.canvasId, turnId: active.turnId, sessionId: entry.sessionId, record: active.result });
      await settleLocal(entry, active, active.result);
      return active.submissionId == null ? null : entry.harness.submission(active.submissionId, CTX);
    }
    // A stopped request is settled as stopped, never (re)submitted.
    if (stopIntended(entry, doc, active.requestId)) { await stop(entry, active.requestId); return null; }
    if (auth?.open === false) {
      const admitted = await entry.harness.commit((tx) => tx.submissionByRequest(entry.root.id, active.requestId), CTX);
      const submission = admitted ? await entry.harness.submission(admitted.id, CTX) : null;
      const settled = submission && await submission.status(CTX);
      if (!settled || !['done', 'unanswered'].includes(settled.status)) throw fail('turn_not_open');
      // No submit/resume: a closed turn may only reconstruct committed history.
      const record = active.result || await completionRecord(entry, active, settled);
      await settleLocal(entry, active, record);
      return submission;
    }
    await turnModel(entry, active);
    // Re-admit persisted supplements by stable request ID before scheduling the
    // original submission. The official queue deduplicates already placed ones.
    for (const input of active.supplementContents || []) {
      await entry.root.submit({ type: 'input', requestId: `supplement:${input.requestId}`,
        content: supplementContent(input.requestId, input.content), whenBusy: 'steer' }, CTX);
    }
    const sub = await submit(entry, active);
    return sub;
  }

  async function wait(entry, submission, options = {}) {
    // Counted before the first await so a recovery read in the same tick sees the live owner.
    entry.waiters += 1;
    try { return await observe(entry, submission, options); }
    finally { entry.waiters -= 1; }
  }

  async function observe(entry, submission, { onEvent = () => {}, signal } = {}) {
    const context = signal ? withAbortSignal(signal, CTX) : CTX;
    let initial = await submission.status(context);
    const watch = await entry.root.watch(context, initial.entry !== undefined ? { from: initial.entry + 1 } : undefined);
    let planWatch;
    try {
      if (initial.entry === undefined) {
        initial = await submission.status(context);
      }
      const initialView = watch.value;
      const initialLive = initialView.docs?.[LiveDoc.definition.kind] || {};
      const afterEntry = initial.entry ?? initialView.entries.reduce((last, item) => Math.max(last, item.id), initialView.before ?? 0);
      const fromEntry = afterEntry + 1;
      let initialEntries = (initialView.entries || []).filter((item) => item.id >= fromEntry);
      // 官方 Conversation.watch 默认窗口上限为 100 条，超过后会退回最新 50 条并设置 before。
      // 恢复或重连长轮次时按提交起点补读 (afterEntry, before]，避免面板丢失前半段正文、思考和工具记录。
      if (initialView.before !== undefined && initialView.before >= fromEntry) {
        const missing = await scanConversationEntries(
          entry,
          { minEntryId: fromEntry, maxEntryId: initialView.before, order: 'ascending' },
          context,
        );
        initialEntries = mergeEntriesById(missing, initialEntries);
      }
      let lastEntryId = initialEntries.reduce((last, item) => Math.max(last, item.id), afterEntry);
      initialEntries = initialEntries.filter((item) => item.kind !== CompactionEntry.kind);
      let liveMessage = initialLive.generation?.message ? JSON.stringify(initialLive.generation.message) : null;
      let activeRetry = initialLive.generation?.retry
        ? { attempt: initialLive.generation.attempt, ...initialLive.generation.retry }
        : null;
      const allInitialSlots = [...(initialLive.tools || []), ...(initialLive.nestedTools || [])];
      const startedTools = new Set(
        allInitialSlots.filter((slot) => slot.status === 'running' || slot.status === 'done').map((slot) => slot.callId),
      );
      const endedTools = new Set(
        allInitialSlots.filter((slot) => slot.status === 'done').map((slot) => slot.callId),
      );
      const startedSlotMeta = new Map(
        allInitialSlots
          .filter((slot) => slot.status === 'running' || slot.status === 'done')
          .map((slot) => [slot.callId, { name: slot.name, parentCallId: slot.parentCallId }]),
      );
      for (const item of initialEntries) {
        for (const msg of item.model || []) {
          if (msg?.role === 'toolResult' && msg.toolCallId) {
            startedTools.add(msg.toolCallId);
            endedTools.add(msg.toolCallId);
          }
        }
      }
      const slotDetails = new Map();
      for (const slot of [...(initialLive.nestedTools || []), ...(initialLive.tools || [])]) {
        if (slot.details !== undefined) slotDetails.set(slot.callId, JSON.stringify(slot.details));
      }
      const activeCompactions = new Map((initialLive.compactions || []).map((c) => [c.taskId, c]));

      await onEvent({
        type: 'snapshot',
        entries: initialEntries,
        ...initialLive,
        docs: initialView.docs,
        afterEntry,
        sessionId: entry.sessionId,
      });

      planWatch = await entry.harness.watchDoc(stateDoc, context);
      let previousPlan;
      const emitPlan = async (doc) => {
        if (doc?.active?.requestId !== initial.requestId) return;
        const plan = publicPlan(doc.plan);
        const serialized = JSON.stringify(plan);
        if (serialized === previousPlan) return;
        previousPlan = serialized;
        await onEvent({ type: 'plan', plan });
      };
      if (planWatch) {
        await emitPlan(planWatch.value);
        planWatch.start((call) => {
          if (call.kind === 'value') return emitPlan(call.value);
        });
      }

      const processView = async (view) => {
        const live = view.docs?.[LiveDoc.definition.kind] || {};
        const events = [];
        let viewEntries = view.entries || [];
        if (view.before !== undefined && view.before > lastEntryId) {
          const missing = await scanConversationEntries(
            entry,
            { minEntryId: lastEntryId + 1, maxEntryId: view.before, order: 'ascending' },
            context,
          );
          viewEntries = mergeEntriesById(missing, viewEntries);
        }
        const newEntries = viewEntries.filter((item) => item.id > lastEntryId);
        for (const item of newEntries) {
          lastEntryId = Math.max(lastEntryId, item.id);
          if (item.kind === ToolResultEntry.kind || (item.model || []).some((m) => m?.role === 'toolResult')) {
            for (const msg of item.model || []) {
              if (msg?.role !== 'toolResult') continue;
              if (!startedTools.has(msg.toolCallId)) {
                startedTools.add(msg.toolCallId);
                events.push({ type: 'tool_execution_start', toolCallId: msg.toolCallId, toolName: msg.toolName, args: {} });
              }
              if (!endedTools.has(msg.toolCallId)) {
                endedTools.add(msg.toolCallId);
                events.push({ type: 'tool_execution_end', toolCallId: msg.toolCallId, toolName: msg.toolName, entry: item });
              }
            }
            continue;
          }
          if (item.kind === CompactionEntry.kind) continue;
          if (item.kind === UserEntry.kind || (item.model || []).some((m) => m?.role === 'user')) {
            liveMessage = null;
            events.push({ type: 'message_end', entry: item });
            continue;
          }
          const assistant = item.kind === AssistantEntry.kind || item.model?.[0]?.role === 'assistant'
            ? item.model?.find((m) => m?.role === 'assistant')
            : null;
          if (assistant) {
            if (assistant.stopReason === 'error') {
              liveMessage = null;
              if (!activeRetry && !live.generation?.retry && live.run !== undefined && !live.runFailure) {
                const retryAttempt = Math.max(1, (live.generation?.attempt || 2) - 1);
                events.push({ type: 'auto_retry_start', attempt: retryAttempt, at: Date.now(), errorMessage: assistant.errorMessage || '' });
                events.push({ type: 'auto_retry_end', attempt: retryAttempt });
              }
            } else {
              if (!liveMessage) events.push({ type: 'message_start', message: assistant });
              events.push({ type: 'message_end', entry: item });
              liveMessage = null;
            }
          }
        }

        for (const c of live.compactions || []) {
          if (!activeCompactions.has(c.taskId)) {
            activeCompactions.set(c.taskId, c);
            events.push({ type: 'compaction_start', taskId: c.taskId, trigger: c.trigger, blocking: c.blocking });
          }
        }
        for (const [taskId] of [...activeCompactions.entries()]) {
          if (!(live.compactions || []).some((c) => c.taskId === taskId)) {
            activeCompactions.delete(taskId);
            const failed = live.compactionFailure?.taskId === taskId ? live.compactionFailure.error : undefined;
            events.push({ type: 'compaction_end', taskId, ...(failed !== undefined ? { error: failed } : {}) });
          }
        }

        const nextRetry = live.generation?.retry
          ? { attempt: live.generation.attempt, ...live.generation.retry }
          : null;
        if (activeRetry && (!nextRetry || nextRetry.attempt !== activeRetry.attempt || nextRetry.at !== activeRetry.at)) {
          events.push({ type: 'auto_retry_end', attempt: activeRetry.attempt });
          activeRetry = null;
        }
        if (nextRetry && !activeRetry) {
          activeRetry = nextRetry;
          events.push({ type: 'auto_retry_start', attempt: nextRetry.attempt, at: nextRetry.at, errorMessage: nextRetry.error });
        }

        const nextMsg = live.generation?.message || null;
        if (nextMsg) {
          const serialized = JSON.stringify(nextMsg);
          if (!liveMessage) {
            liveMessage = serialized;
            events.push({ type: 'message_start', message: nextMsg });
          } else if (serialized !== liveMessage) {
            liveMessage = serialized;
            const changes = Array.isArray(nextMsg.content) && nextMsg.content.length > 0
              ? nextMsg.content.map((block, contentIndex) => ({ type: 'block', contentIndex, block }))
              : [{ type: 'message', message: nextMsg }];
            events.push({ type: 'message_update', changes });
          }
        } else {
          liveMessage = null;
        }

        for (const slot of [...(live.tools || []), ...(live.nestedTools || [])]) {
          if ((slot.status === 'running' || slot.status === 'done') && !startedTools.has(slot.callId)) {
            startedTools.add(slot.callId);
            startedSlotMeta.set(slot.callId, { name: slot.name, parentCallId: slot.parentCallId });
            events.push({ type: 'tool_execution_start', toolCallId: slot.callId, toolName: slot.name, args: slot.arguments || {} });
          }
        }
        for (const slot of [...(live.nestedTools || []), ...(live.tools || [])]) {
          if (slot.details !== undefined) {
            const serialized = JSON.stringify(slot.details);
            if (slotDetails.get(slot.callId) !== serialized) {
              slotDetails.set(slot.callId, serialized);
              events.push({ type: 'tool_execution_update', toolCallId: slot.callId, toolName: slot.name, details: slot.details });
            }
          }
        }
        for (const slot of live.nestedTools || []) {
          if (slot.status === 'done' && !endedTools.has(slot.callId)) {
            endedTools.add(slot.callId);
            events.push({
              type: 'tool_execution_end',
              toolCallId: slot.callId,
              toolName: slot.name,
              ...(typeof slot.summary?.isError === 'boolean' ? { isError: slot.summary.isError } : {}),
            });
          }
        }
        const currentNestedCallIds = new Set((live.nestedTools || []).map((slot) => slot.callId));
        for (const [callId, meta] of startedSlotMeta.entries()) {
          if (meta.parentCallId && !endedTools.has(callId) && !currentNestedCallIds.has(callId)) {
            endedTools.add(callId);
            events.push({
              type: 'tool_execution_end',
              toolCallId: callId,
              toolName: meta.name,
            });
          }
        }
        for (const slot of live.tools || []) {
          if (slot.status === 'done' && !endedTools.has(slot.callId)) {
            endedTools.add(slot.callId);
            let resultEntry = slot.entry !== undefined ? viewEntries.find((e) => e.id === slot.entry) : undefined;
            if (slot.entry !== undefined && !resultEntry) {
              resultEntry = await entry.harness.commit((tx) => tx.entry(slot.entry), context).catch(() => undefined);
            }
            events.push({
              type: 'tool_execution_end',
              toolCallId: slot.callId,
              toolName: slot.name,
              ...(resultEntry ? { entry: resultEntry } : {}),
            });
          }
        }

        for (const event of events) await onEvent(event);
      };

      let queue = Promise.resolve();
      const enqueueView = (view) => {
        queue = queue.then(() => processView(view));
        return queue;
      };
      watch.start((call) => {
        if (call.kind === 'value') return enqueueView(call.value);
      });

      const original = await submission.wait(context);
      for (;;) {
        // Never hold the canvas admission lock while waiting for image prep or
        // official generations: supplement() needs that lock to admit inputs.
        const pending = entry.generation.pendingInput;
        if (pending?.state === 'pending') await pending.promise.catch(() => {});
        const snapshot = await state(entry);
        if (snapshot.active?.requestId !== original.requestId) return snapshot.turns.find((turn) => turn.submissionId === submission.id) || null;
        const ids = [...(snapshot.active.supplementIds || [])];
        let settled = original;
        for (const id of ids) {
          const admitted = await entry.harness.commit((tx) => tx.submissionByRequest(entry.root.id, `supplement:${id}`), CTX);
          if (!admitted) {
            if (snapshot.active.stopped || entry.generation.aborted) continue;
            throw fail('supplement_submission_missing');
          }
          const supplemental = await entry.harness.submission(admitted.id, CTX);
          settled = await supplemental.wait(context);
        }
        await enqueueView(watch.value);
        if (planWatch) await emitPlan(planWatch.value);
        const result = await lock(entry.canvasId, async () => {
          const current = await state(entry);
          if (current.active?.requestId !== original.requestId) return { done: true, record: current.turns.find((turn) => turn.submissionId === submission.id) || null };
          if (entry.generation.pendingInput?.state === 'pending' || JSON.stringify(current.active.supplementIds || []) !== JSON.stringify(ids)) return { done: false };
          entry.completing = true;
          try {
            const active = current.active;
            const record = active.result || await completionRecord(entry, active, settled);
            await update(entry, (doc) => { if (doc.active?.requestId === active.requestId) doc.active.result = record; });
            // Retain active.result until Go acknowledges. Recovery can retry
            // that completion without scheduling any more model work.
            await completeTurn({ canvasId: entry.canvasId, turnId: active.turnId, sessionId: entry.sessionId, record });
            await settleLocal(entry, active, record);
            return { done: true, record };
          } finally { entry.completing = false; }
        });
        if (result.done) return result.record;
      }
    } finally { await planWatch?.stop(); await watch.stop(); }
  }

  async function fenceStop(entry, requestId = entry.input?.requestId) {
    if (!requestId) return null;
    // Fence only the captured request, before awaiting storage. A later request may
    // reuse this entry while a caller waits for the Go completion response.
    if (entry.busy && entry.input?.requestId === requestId) {
      entry.generation.aborted = true;
      entry.generation.pendingInput?.cancel?.();
    }
    let turnId = null;
    await entry.harness.commit(async (tx) => {
      if (entry.root) await tx.doc(LiveDoc, entry.root.id);
      const doc = await tx.doc(stateDoc);
      if (doc.active?.requestId === requestId) {
        doc.active.stopped = true;
        turnId = doc.active.turnId;
      }
    }, CTX);
    return turnId;
  }

  async function stop(entry, requestId = entry.input?.requestId) {
    if (!requestId || !await fenceStop(entry, requestId)) return;
    // Official abort is conversation-wide. Keep admission locked until it finishes
    // so it cannot abort a newer request, then observe only this exact submission.
    const submission = await lock(entry.canvasId, async () => {
      if (!await fenceStop(entry, requestId)) return null;
      await entry.root.abort(CTX);
      const active = (await state(entry)).active;
      if (active?.requestId !== requestId) return null;
      const official = active.submissionId != null ? await entry.harness.submission(active.submissionId, CTX)
        : await officialSubmission(entry, requestId);
      return official || stopBeforeSubmit(entry, active);
    });
    if (submission) return wait(entry, submission);
  }

  return { stoppedRequest, settleLocal, completionRecord, recover, wait, fenceStop, stop };
}
