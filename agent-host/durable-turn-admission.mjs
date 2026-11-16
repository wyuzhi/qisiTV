// Durable 回合准入与忙碌状态仲裁：
// 统一收敛 busyState、submit 陈旧回合两阶段结算、停止意图记账与运行中补充输入。
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { resetTurnAccumulator } from './canvas-turn.mjs';
import { skillsToLoad } from './skill-resource.mjs';
import { publicPlan } from './plan.mjs';
import { prependStudioChanges, supplementContent } from './durable-extensions.mjs';
import { isTerminalSubmissionStatus, rollbackSupplementsInDoc } from './durable-detached-reconciler.mjs';
import {
  hasLiveLocalOwner,
  isEntryActiveOrDetached,
  PERMANENT_UNRESUMABLE_REASONS,
} from './durable-watch-observer.mjs';

const CTX = BACKGROUND_CONTEXT;
const continuationRevoked = (error) => ['continuation_cancelled', 'continuation_scope_changed'].includes(error?.reason);

export function createDurableTurnAdmission({
  sessions,
  lock,
  state,
  update,
  hydrate,
  authorization,
  authorizeContinuation,
  turnModel,
  skills,
  skillController,
  refreshStudioDigest,
  completeTurn,
  isDurableSessionId,
  handoffSessionId,
  hasSession,
  open,
  prepareSession,
  rememberStop,
  forgetStop,
  stopIntended,
  stopIntentLimit,
  stoppedRequest,
  stopBeforeSubmit,
  settleTurnWithConfirmation,
  reconcileDetachedEntry,
  fail,
}) {
  const {
    expandSelectedSkills,
    readSkillContext,
    resetPendingScope,
    prepareSkillContext,
    activateTurnSkills,
    flushPendingSkillRollback,
  } = skillController;

  const isEntryBusy = (entry) => Boolean(entry?.busy || isEntryActiveOrDetached(entry));

  async function refreshCanvasBusy(canvasId) {
    const entry = sessions.get(canvasId);
    if (!entry) return false;
    if (!entry.detachedRunning && !entry.pendingCompleteRetry) return isEntryBusy(entry);
    return reconcileDetachedEntry(entry);
  }

  async function busyState(canvasId) {
    const entry = sessions.get(canvasId) || null;
    if (!entry) return { entry: null, busy: false, runningForSteer: false, stoppable: false };
    const busy = (entry.detachedRunning || entry.pendingCompleteRetry)
      ? await reconcileDetachedEntry(entry)
      : isEntryBusy(entry);
    const current = sessions.get(canvasId) || null;
    if (!current || current !== entry) {
      const nextBusy = Boolean(current && isEntryBusy(current));
      return { entry: current, busy: nextBusy, runningForSteer: false, stoppable: false };
    }
    const runningForSteer = Boolean(
      busy &&
      !entry.completing &&
      !entry.pendingCompleteRetry &&
      !entry.generation.aborted &&
      !entry.recovering,
    );
    const stoppable = Boolean(busy && !entry.pendingCompleteRetry);
    return { entry, busy, runningForSteer, stoppable };
  }

  async function settleStaleActiveBeforeSubmit(entry, input, requestId) {
    let snap;
    try {
      snap = await state(entry);
    } catch {
      throw fail('session_busy');
    }
    if (!snap?.active || snap.active.requestId === requestId) return;
    if (snap.turns?.some((turn) => turn.requestId === requestId)) return;
    if (hasLiveLocalOwner(entry) || entry.recovering) throw fail('session_busy');
    if (entry.detachedRunning || entry.pendingCompleteRetry) {
      if (await reconcileDetachedEntry(entry)) throw fail('session_busy');
      snap = await state(entry);
      if (!snap?.active || snap.active.requestId === requestId) return;
    }
    if (input.continuationId) {
      let staleOpen = true;
      try {
        const staleAuth = await authorization(entry, snap.active.turnId, true);
        staleOpen = staleAuth?.open !== false;
      } catch (error) {
        if (!PERMANENT_UNRESUMABLE_REASONS.has(error?.reason || '')) throw fail('session_busy');
        staleOpen = false;
      }
      if (staleOpen) throw fail('session_busy');
    }
    const settled = await settleTurnWithConfirmation(entry, snap.active.requestId, { abortIfRunning: true });
    if (!settled.settled) throw fail('session_busy');
  }

  async function submit(entry, input, { fromRecovery = false, onSubmitted = null } = {}) {
    if (input.continuationId && sessions.get(entry.canvasId) !== entry) throw fail('session_not_current');
    if (!fromRecovery && !input.continuationId && entry.recovering) {
      await entry.recovering.catch(() => null);
    }
    const requestId = String(input.requestId || input.turnId || '').trim();
    if (!fromRecovery && requestId) {
      await settleStaleActiveBeforeSubmit(entry, input, requestId);
    }
    return lock(entry.canvasId, async () => {
      if (input.continuationId && sessions.get(entry.canvasId) !== entry) throw fail('session_not_current');
      const existing = await state(entry);
      if (!requestId || !input.turnId || !input.content) throw fail('invalid_request');
      if (fromRecovery && (!existing.active || existing.active.requestId !== requestId)) {
        return null;
      }
      const finished = existing.turns.find((turn) => turn.requestId === requestId);
      if (finished) {
        if (JSON.stringify(skillsToLoad(finished.skills || [])) !== JSON.stringify(skillsToLoad(input.skills || []))) throw fail('submission_request_conflict');
        if (finished.turnId !== input.turnId) await completeTurn({ canvasId: entry.canvasId, turnId: input.turnId, sessionId: entry.sessionId, record: finished });
        return finished.submissionId === undefined ? null : entry.harness.submission(finished.submissionId, CTX);
      }
      if (existing.active && existing.active.requestId !== requestId) {
        throw fail('session_busy');
      }
      if (!fromRecovery) entry.submittingRequest = requestId;
      try {
        if (stopIntended(entry, existing, requestId)) {
          return existing.active ? stoppedRequest(entry, existing.active)
            : stopBeforeSubmit(entry, { ...input, requestId, createdAt: new Date().toISOString() });
        }
        if (existing.active && (existing.active.turnId !== input.turnId || JSON.stringify(existing.active.content) !== JSON.stringify(input.content) ||
          JSON.stringify(skillsToLoad(existing.active.skills || [])) !== JSON.stringify(skillsToLoad(input.skills || [])))) throw fail('submission_request_conflict');
        let auth;
        try { auth = await authorization(entry, input.turnId); }
        catch (error) {
          if (input.continuationId && continuationRevoked(error)) return stoppedRequest(entry, existing.active || { ...input, requestId });
          throw error;
        }
        const modelRef = await turnModel(entry, existing.active);
        const admittedInput = { ...input, modelRef, permissionMode: auth?.permissionMode || 'canvas' };
        if (stopIntended(entry, await state(entry), requestId)) {
          return existing.active ? stoppedRequest(entry, existing.active)
            : stopBeforeSubmit(entry, { ...admittedInput, requestId, createdAt: new Date().toISOString() });
        }
        if (!existing.active) {
          if (skills) {
            await flushPendingSkillRollback(entry);
            await resetPendingScope(entry, await readSkillContext(entry, admittedInput.turnId));
          }
          entry.budget = null;
          resetTurnAccumulator(entry.turn, admittedInput.revisionBefore, admittedInput.turnId);
          entry.turn.canvasId = entry.canvasId;
          entry.turn.supplements = [];
          entry.turn.plan = publicPlan((await state(entry)).plan);
          entry.log.length = 0;
          entry.generation = Object.assign(entry.generation, {
            aborted: false,
            intentEpoch: 0,
            modelEpoch: 0,
            pendingInput: null,
            pendingInputError: null,
            skillContextFailure: null,
            preparedRequests: new Set(),
            planTouchedInTurn: false,
            toolCalledSinceYield: false,
            planContinuations: 0,
            unboundReminderSent: false,
          });
          entry.submittedRequest = null;
          entry.lifecycle = null;
          entry.turnProjection = null;
          entry.turnProjectionTurnId = null;
          entry.turnProjectionReady = null;
          const expansion = await expandSelectedSkills(entry, existing, admittedInput.skills, admittedInput.content, admittedInput.turnId);
          const studioDiff = await refreshStudioDigest(entry, admittedInput.turnId, { selectedNodeIds: admittedInput.selectedNodeIds || [], computeDiff: true });
          const submittedContent = prependStudioChanges(expansion.content, studioDiff);
          await update(entry, (doc) => {
            doc.active = {
              ...admittedInput,
              requestId,
              createdAt: new Date().toISOString(),
              stopped: false,
              effects: JSON.parse(JSON.stringify(entry.turn)),
              log: [],
              supplements: [],
              intentEpoch: 0,
              modelEpoch: 0,
              ...(publicPlan(doc.plan) ? { plan: publicPlan(doc.plan) } : {}),
              ...((expansion.records.length || studioDiff) ? { submittedContent } : {}),
            };
            if (expansion.records.length) doc.loadedSkills = [...(doc.loadedSkills || []), ...expansion.records];
          });
        }
        const prepared = await state(entry);
        if (stopIntended(entry, prepared, requestId)) return stoppedRequest(entry, prepared.active);
        await activateTurnSkills(entry);
        const current = await state(entry);
        const admitted = current.active;
        hydrate(entry, admitted);
        if (stopIntended(entry, current, requestId)) return stoppedRequest(entry, admitted);
        if (admittedInput.continuationId) {
          if (!authorizeContinuation) throw fail('continuation_unavailable');
          try { await authorizeContinuation({ id: admittedInput.continuationId, turnId: admitted.turnId, sessionId: entry.sessionId }); }
          catch (error) {
            if (continuationRevoked(error)) return stoppedRequest(entry, admitted);
            throw error;
          }
          if (stopIntended(entry, await state(entry), requestId)) return stoppedRequest(entry, admitted);
        }
        entry.submittedRequest = requestId;
        const official = await entry.root.submit({ type: 'input', requestId, content: admitted.submittedContent ?? admitted.content, whenBusy: 'reject' }, CTX);
        await update(entry, (doc) => { if (doc.active) doc.active.submissionId = official.id; });
        onSubmitted?.(official);
        return official;
      } finally {
        if (entry.submittingRequest === requestId) entry.submittingRequest = null;
      }
    });
  }

  async function recordStopIntent(entry, requestId) {
    let finished = false;
    await update(entry, (doc) => {
      finished = doc.turns.some((turn) => turn.requestId === requestId);
      if (finished) return;
      doc.stopRequests = [...(doc.stopRequests || []).filter((id) => id !== requestId), requestId].slice(-stopIntentLimit);
      if (doc.active?.requestId === requestId) doc.active.stopped = true;
    });
    return finished;
  }

  async function cancelRequest(canvasId, sessionId, requestId) {
    const target = isDurableSessionId(sessionId) ? sessionId : handoffSessionId(canvasId, sessionId);
    rememberStop(canvasId, target, requestId);
    const live = sessions.get(canvasId);
    if (live?.sessionId === target && live.busy && !live.pendingCompleteRetry && live.input?.requestId === requestId && live.submittedRequest === requestId) {
      live.generation.aborted = true;
      live.generation.pendingInput?.cancel?.();
      return { state: 'running', entry: live };
    }
    const finished = live?.sessionId === target ? await recordStopIntent(live, requestId)
      : await lock(canvasId, async () => {
        const current = sessions.get(canvasId);
        if (current?.sessionId === target) return recordStopIntent(current, requestId);
        const exists = hasSession(canvasId, target);
        if (!exists && isDurableSessionId(sessionId)) return false;
        const entry = exists ? await open(canvasId, target) : await prepareSession(canvasId, sessionId);
        try { return await recordStopIntent(entry, requestId); }
        finally { entry.disposed = true; await entry.harness.close(CTX); }
      });
    if (finished) { forgetStop(canvasId, target, requestId); return { state: 'finished' }; }
    return { state: 'pending' };
  }

  async function supplement(entry, { requestId, content, input = {} }) {
    if (!entry.busy || entry.completing || entry.pendingCompleteRetry || entry.generation.aborted) {
      throw fail('session_not_running');
    }
    return lock(entry.canvasId, async () => {
      if (!entry.busy || entry.completing || entry.pendingCompleteRetry || entry.generation.aborted) {
        throw fail('session_not_running');
      }
      const active = (await state(entry)).active;
      if (!active || active.stopped || active.result || !requestId || !content) throw fail('session_not_running');
      if (entry.detachedRunning && active.submissionId != null) {
        const sub = await entry.harness.submission(active.submissionId, CTX).catch(() => null);
        const subStatus = sub ? await sub.status(CTX).catch(() => null) : null;
        if (sub && isTerminalSubmissionStatus(subStatus?.status)) throw fail('session_not_running');
      }
      await authorization(entry, active.turnId);
      if (entry.generation.aborted || entry.pendingCompleteRetry) throw fail('session_not_running');
      const submitSteer = async (steerContent) => {
        try {
          return await entry.root.submit({
            type: 'input',
            requestId: `supplement:${requestId}`,
            content: supplementContent(requestId, steerContent),
            whenBusy: 'steer',
            whenIdle: 'reject',
          }, CTX);
        } catch (error) {
          if (error?.name === 'ConversationIdle' || /idle/i.test(String(error?.message || ''))) {
            throw fail('session_not_running');
          }
          throw error;
        }
      };
      const previous = (active.supplementContents || []).find((item) => item.requestId === requestId);
      if (previous && JSON.stringify(previous.rawContent ?? previous.content) !== JSON.stringify(content)) throw fail('submission_request_conflict');
      const previousInput = (active.supplementInputs || []).find((item) => item.requestId === requestId);
      if (previous && previousInput && JSON.stringify(skillsToLoad(previousInput.skills || [])) !== JSON.stringify(skillsToLoad(input.skills || []))) {
        throw fail('submission_request_conflict');
      }
      if (previous) return submitSteer(previous.content);
      const expansion = await expandSelectedSkills(entry, await state(entry), input.skills, content, active.turnId);
      if (skills) await prepareSkillContext(entry, input.skills, `supplement:${requestId}`, active.turnId, { append: true });
      if (entry.generation.aborted || entry.pendingCompleteRetry) throw fail('session_not_running');
      const prevIntentEpoch = entry.generation.intentEpoch;
      let appendedSupplement = false;
      entry.generation.intentEpoch += 1;
      await update(entry, (doc) => {
        if (!doc.active || doc.active.stopped || doc.active.result || entry.generation.aborted) throw fail('session_not_running');
        const ids = doc.active.supplementIds || [];
        if (!ids.includes(requestId)) {
          appendedSupplement = true;
          doc.active.supplementIds = [...ids, requestId];
          const message = String(input.message ?? (typeof content === 'string' ? content : ''));
          doc.active.supplements = [...doc.active.supplements, message];
          doc.active.supplementInputs = [...(doc.active.supplementInputs || []), {
            requestId,
            message,
            attachments: input.attachments || [],
            skills: input.skills || [],
          }];
          doc.active.supplementContents = [...(doc.active.supplementContents || []),
            expansion.records.length ? { requestId, content: expansion.content, rawContent: content } : { requestId, content }];
          if (expansion.records.length) {
            doc.loadedSkills = [
              ...(doc.loadedSkills || []),
              ...expansion.records.map((record) => ({ ...record, supplementRequestId: requestId })),
            ];
          }
          doc.active.intentEpoch = entry.generation.intentEpoch;
        }
      });
      entry.turn.supplements = (await state(entry)).active?.supplements || [];
      hydrate(entry, (await state(entry)).active);
      try {
        if (entry.generation.aborted || entry.pendingCompleteRetry) throw fail('session_not_running');
        return await submitSteer(expansion.content);
      } catch (error) {
        if (appendedSupplement) {
          await update(entry, (doc) => {
            rollbackSupplementsInDoc(doc, active.requestId, [requestId]);
          }).catch(() => {});
          entry.generation.intentEpoch = prevIntentEpoch;
          const reverted = (await state(entry).catch(() => null))?.active;
          entry.turn.supplements = reverted?.supplements || [];
          if (reverted) hydrate(entry, reverted);
        }
        throw error;
      }
    });
  }

  function beginPendingInput(entry) {
    if (!entry.busy || entry.completing || entry.pendingCompleteRetry || entry.generation.aborted) {
      throw fail('session_not_running');
    }
    if (entry.generation.pendingInput?.state === 'pending') throw fail('supplement_preparation_pending');
    if (entry.generation.pendingInputError) throw fail('session_not_running');
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    promise.catch(() => {});
    const pending = { state: 'pending', promise };
    pending.cancel = () => {
      if (pending.state !== 'pending') return;
      pending.state = 'cancelled';
      resolve();
      if (entry.generation.pendingInput === pending) entry.generation.pendingInput = null;
    };
    entry.generation.pendingInput = pending;
    entry.generation.modelEpoch = -1;
    return {
      cancel() {
        pending.cancel();
      },
      resolve() {
        if (pending.state !== 'pending') return;
        pending.state = 'resolved';
        resolve();
        if (entry.generation.pendingInput === pending) entry.generation.pendingInput = null;
      },
      reject(error) {
        if (pending.state !== 'pending') return;
        const reason = error?.reason || 'supplement_preparation_failed';
        entry.generation.pendingInputError = { reason, message: String(error?.message || reason) };
        pending.state = 'rejected';
        reject(fail(reason));
        void entry.root.abort(CTX).catch(() => {});
      },
    };
  }

  return {
    isEntryBusy,
    refreshCanvasBusy,
    busyState,
    submit,
    cancelRequest,
    supplement,
    beginPendingInput,
  };
}
