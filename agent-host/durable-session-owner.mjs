// New conversations have one official Durable owner. Legacy JSONL sessions are
// deliberately never imported or run here. Go remains the business authority.
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { defineDoc } from '@earendil-works/pi-durable';
import { emptyPlan } from './plan.mjs';
import { buildStudioDigest, describeChangesSince } from './studio-digest.mjs';
import {
  durableCompletion,
  durableLifecycleState,
  durableRetryReason,
  durableStreamEvents,
  publicDurableTurn,
} from './durable-turn-projection.mjs';
import { createDurableTurnLifecycle, TRANSIENT_UNRESUMABLE_REASONS } from './durable-watch-observer.mjs';
import {
  createDurablePointerResolver,
  isCorruptSessionArtifactError,
  isSkippableSessionError,
} from './durable-pointer-resolver.mjs';
import {
  createDurableSkillController,
  durableToolReplay,
} from './durable-extensions.mjs';
import { createDurableSessionRepository } from './durable-session-repository.mjs';
import { createDurableTurnAdmission } from './durable-turn-admission.mjs';

export {
  durableCompletion,
  durableLifecycleState,
  durableRetryReason,
  durableStreamEvents,
  durableToolReplay,
  isCorruptSessionArtifactError,
  isSkippableSessionError,
  publicDurableTurn,
  TRANSIENT_UNRESUMABLE_REASONS,
};

// On-disk format tag written into manifests and host state since 1.0.4; not the
// package version. Changing it rejects every existing session as mismatched.
export const DURABLE_VERSION = '1.0.4';
export const HOST_STATE_CHECKPOINT_DELTAS = 32;
const STATE = defineDoc({
  kind: 'beeftv.host',
  version: 1,
  scope: 'session',
  initial: () => ({
    version: DURABLE_VERSION,
    canvasId: '',
    sessionId: '',
    active: null,
    turns: [],
    loadedSkills: [],
    plan: emptyPlan(),
    studioDigestText: '',
    lastStudioSnapshot: null,
    lastStudioSnapshotRevision: null,
  }),
  checkpointWhen: (value, _ops, { deltasSinceBase }) => value.active === null || deltasSinceBase >= HOST_STATE_CHECKPOINT_DELTAS,
});
export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high'];
export function agentThinkingLevel(env = process.env) {
  const value = String(env.BEEFTV_AGENT_THINKING || '').trim().toLowerCase();
  return THINKING_LEVELS.includes(value) ? value : 'low';
}
const CTX = BACKGROUND_CONTEXT;
const idPattern = /^durable:([a-f0-9-]{36})$/;
const fail = (reason) => Object.assign(new Error(reason), { reason });
export const isDurableSessionId = (id) => idPattern.test(String(id || ''));

export function createDurableSessionStore({
  sessionRoot,
  workspaceRoot,
  getModels,
  getModelRef,
  buildTools,
  authorizeTurn,
  authorizeContinuation = null,
  completeTurn = async () => {},
  runWithBudget = (_entry, fn) => fn(),
  extensions = () => [],
  settings = {},
  skills = null,
  readCanvas = null,
  legacy = null,
  maxPlanContinuations = 6,
  thinkingLevel = agentThinkingLevel(),
}) {
  if (!THINKING_LEVELS.includes(thinkingLevel)) throw fail('invalid_thinking_level');
  if (typeof authorizeTurn !== 'function') throw fail('durable_authorizer_required');
  const sessions = new Map();
  const locks = new Map();
  const STOP_INTENT_LIMIT = 64;
  const stopIntents = new Map();
  const stopIntentKey = (sessionId, requestId) => JSON.stringify([sessionId, requestId]);
  function rememberStop(canvasId, sessionId, requestId) {
    const ids = stopIntents.get(canvasId) || new Set();
    const key = stopIntentKey(sessionId, requestId);
    ids.delete(key);
    ids.add(key);
    while (ids.size > STOP_INTENT_LIMIT) ids.delete(ids.values().next().value);
    stopIntents.set(canvasId, ids);
  }
  function forgetStop(canvasId, sessionId, requestId) {
    const ids = stopIntents.get(canvasId);
    if (ids?.delete(stopIntentKey(sessionId, requestId)) && !ids.size) stopIntents.delete(canvasId);
  }
  function stopIntended(entry, doc, requestId) {
    return Boolean(
      stopIntents.get(entry.canvasId)?.has(stopIntentKey(entry.sessionId, requestId))
      || (doc?.stopRequests || []).includes(requestId)
      || (doc?.active?.requestId === requestId && doc.active.stopped),
    );
  }
  let closed = false;
  async function lock(canvasId, fn) {
    const previous = locks.get(canvasId) || Promise.resolve();
    const next = previous.catch(() => {}).then(() => {
      if (closed) throw fail('session_store_closed');
      return fn();
    });
    locks.set(canvasId, next);
    try { return await next; } finally { if (locks.get(canvasId) === next) locks.delete(canvasId); }
  }
  async function state(entry) { return entry.harness.snapshot(STATE, CTX); }
  async function update(entry, mutate) {
    return entry.harness.commit(async (tx) => mutate(await tx.doc(STATE)), CTX);
  }
  async function authorization(entry, turnId, allowClosed = false) {
    let result;
    try { result = await authorizeTurn({ canvasId: entry.canvasId, turnId, sessionId: entry.sessionId }); }
    catch (error) {
      if (error?.reason) throw error;
      throw Object.assign(fail('turn_authorization_unavailable'), { cause: error });
    }
    if (result?.continuationRevoked === true && result.canvasId === entry.canvasId && result.turnId === turnId) throw fail('continuation_cancelled');
    const mode = result?.permissionMode || 'canvas';
    if (!['read-only', 'canvas', 'full-access'].includes(mode)) throw fail('invalid_permission_mode');
    if (entry.input?.turnId === turnId && (entry.input.permissionMode || 'canvas') !== mode) throw fail('permission_mode_frozen');
    if (!entry.readOnlyHandle && entry.permissionMode !== mode) {
      entry.permissionMode = mode;
      entry.generation.permissionMode = mode;
      if (entry.configurePermission) await entry.configurePermission(mode);
    }
    if (result?.open === false) {
      if (result.canvasId !== entry.canvasId || result.turnId !== turnId) throw fail('scope_denied');
      if (!allowClosed) throw fail('turn_not_open');
    }
    return result;
  }
  async function refreshStudioDigest(entry, turnId = entry.turn.turnId, { selectedNodeIds = [], computeDiff = false, signal } = {}) {
    if (typeof readCanvas !== 'function') return '';
    try {
      const canvas = await readCanvas(entry, signal, turnId);
      if (!canvas || typeof canvas !== 'object') throw new Error('canvas_snapshot_unavailable');
      const digest = buildStudioDigest(canvas, { selectedNodeIds });
      entry.turn.studioReadAvailable = true;
      let diffText = '';
      await update(entry, (doc) => {
        if (computeDiff && Number.isSafeInteger(doc.lastStudioSnapshotRevision) && doc.lastStudioSnapshotRevision >= 0) {
          diffText = describeChangesSince(doc.lastStudioSnapshot, digest.snapshot);
        }
        doc.studioDigestText = digest.text;
        doc.lastStudioSnapshot = digest.snapshot;
        doc.lastStudioSnapshotRevision = digest.stats.revision;
      });
      return diffText;
    } catch {
      await update(entry, (doc) => { doc.studioDigestText = ''; });
      entry.turn.studioReadAvailable = false;
      return '';
    }
  }
  async function turnModel(entry, active) {
    if (!entry.root) throw fail(active ? 'turn_not_open' : 'model_not_configured');
    const agent = await entry.root.agent(CTX);
    const ref = active ? (active.modelRef || agent.model) : await getModelRef(entry);
    if (!ref?.provider || !ref?.modelId) throw fail('model_not_configured');
    const modelRef = { provider: ref.provider, modelId: ref.modelId };
    if (!(await getModels(entry)).getModel(modelRef.provider, modelRef.modelId)) {
      throw fail(active ? 'model_unavailable_for_resume' : 'model_not_configured');
    }
    if (active) {
      if (agent.model?.provider !== modelRef.provider || agent.model?.modelId !== modelRef.modelId) throw fail('turn_model_frozen');
    } else {
      if (entry.pendingPluginExtensions && typeof entry.reloadPluginExtensions === 'function') {
        const pending = entry.pendingPluginExtensions;
        entry.pendingPluginExtensions = null;
        await entry.reloadPluginExtensions(pending);
      }
      await entry.root.configure({ model: modelRef, thinkingLevel }, CTX);
    }
    return modelRef;
  }
  function hydrate(entry, active) {
    entry.busy = Boolean(active);
    if (!active) return;
    Object.assign(entry.turn, active.effects ? JSON.parse(JSON.stringify(active.effects)) : {});
    entry.turn.turnId = active.turnId;
    entry.input = active;
    entry.generation.permissionMode = active.permissionMode || 'canvas';
    entry.generation.aborted ||= Boolean(active.stopped);
    entry.generation.intentEpoch = active.intentEpoch || 0;
    entry.generation.modelEpoch = active.modelEpoch || 0;
    entry.generation.skillContextFailure = active.skillContextFailure || null;
    entry.turn.supplements = active.supplements || [];
  }
  async function persistEffects(entry) {
    await update(entry, (doc) => {
      if (doc.active && doc.active.turnId === entry.turn.turnId) {
        doc.active.effects = JSON.parse(JSON.stringify(entry.turn));
        doc.active.log = [...entry.log];
        doc.active.modelEpoch = entry.generation.modelEpoch;
        if (entry.generation.skillContextFailure) {
          doc.active.skillContextFailure = entry.generation.skillContextFailure;
        }
      }
    });
  }
  async function officialSubmission(entry, requestId) {
    const admitted = await entry.harness.commit((tx) => tx.submissionByRequest(entry.root.id, requestId), CTX);
    return admitted ? entry.harness.submission(admitted.id, CTX) : null;
  }
  const skillController = createDurableSkillController({
    skills,
    state,
    update,
    lock,
    officialSubmission: (entry, requestId) => officialSubmission(entry, requestId),
  });
  const { undoUnsubmittedSkills, flushPendingSkillRollback, skillContext, changeSkillContext } = skillController;

  const repository = createDurableSessionRepository({
    durableVersion: DURABLE_VERSION,
    sessionRoot,
    workspaceRoot,
    sessions,
    lock,
    state,
    update,
    hydrate,
    persistEffects,
    authorization,
    refreshStudioDigest,
    getModels,
    getModelRef,
    buildTools,
    skills,
    skillController,
    readCanvas,
    maxPlanContinuations,
    runWithBudget,
    extensions,
    settings,
    thinkingLevel,
    isDurableSessionId,
    fail,
  });
  const {
    currentPath,
    publish,
    install,
    open,
    withSession,
    getOpenCount,
    handoffSessionId,
    hasSession,
    prepareSession,
    historyOf,
    history,
    status,
    listCanvasSessions,
  } = repository;

  async function stopBeforeSubmit(entry, active) {
    await undoUnsubmittedSkills(entry, active);
    const record = {
      ...publicDurableTurn(active),
      reply: '',
      cancelled: true,
      error: null,
      errorReason: null,
      toolCalls: [],
      change: null,
      proposals: [],
      scriptProposals: [],
      status: 'unanswered',
      sessionId: entry.sessionId,
    };
    let pending = null;
    await update(entry, (doc) => {
      if (doc.active && doc.active.requestId !== active.requestId) return;
      if (doc.turns.some((turn) => turn.requestId === active.requestId)) return;
      doc.loadedSkills = (doc.loadedSkills || []).filter((skill) => !(skill.source === 'selected' && skill.turnId === active.turnId));
      pending = JSON.parse(JSON.stringify({ ...(doc.active || active), stopped: true, result: doc.active?.result || record }));
      doc.active = pending;
    });
    if (pending) {
      hydrate(entry, pending);
      await completeTurn({ canvasId: entry.canvasId, turnId: pending.turnId, sessionId: entry.sessionId, record: pending.result });
      await settleLocal(entry, pending, pending.result);
    }
    return null;
  }

  let admission;
  const {
    stoppedRequest,
    settleLocal,
    recover,
    recoverForRead,
    inspectReadOnlyEntry,
    settleTurnWithConfirmation,
    reconcileDetachedEntry,
    wait,
    fenceStop,
    stop,
  } = createDurableTurnLifecycle({
    stateDoc: STATE,
    state,
    update,
    lock,
    hydrate,
    authorization,
    turnModel,
    submit: (entry, active, opts) => admission.submit(entry, active, opts),
    officialSubmission,
    stopBeforeSubmit,
    undoUnsubmittedSkills,
    flushPendingSkillRollback,
    stopIntended,
    forgetStop,
    completeTurn,
  });

  admission = createDurableTurnAdmission({
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
    stopIntentLimit: STOP_INTENT_LIMIT,
    stoppedRequest,
    stopBeforeSubmit,
    settleTurnWithConfirmation,
    reconcileDetachedEntry,
    fail,
  });
  const { isEntryBusy, refreshCanvasBusy, busyState, submit, cancelRequest, supplement, beginPendingInput } = admission;

  async function createSession(canvasId) {
    if (await refreshCanvasBusy(canvasId)) throw fail('session_busy');
    return lock(canvasId, async () => {
      if (isEntryBusy(sessions.get(canvasId))) throw fail('session_busy');
      return install(await prepareSession(canvasId));
    });
  }
  async function handoffSession(canvasId, handoffNote = '', handoffSourceId = '') {
    if (await refreshCanvasBusy(canvasId)) throw fail('session_busy');
    return lock(canvasId, async () => {
      const current = sessions.get(canvasId);
      if (isEntryBusy(current)) throw fail('session_busy');
      const entry = await prepareSession(canvasId, handoffSourceId);
      if (!(await state(entry)).handoffInitialized) {
        try {
          if (handoffNote) await entry.root.reset(handoffNote, CTX);
          await update(entry, (doc) => { doc.handoffInitialized = true; });
        } catch (error) {
          entry.disposed = true;
          await entry.harness.close(CTX).catch(() => {});
          throw error;
        }
      }
      if (entry === current) { publish(entry); return entry; }
      return install(entry);
    });
  }
  async function activateSession(canvasId, sessionId, { publishPointer = true } = {}) {
    const current = sessions.get(canvasId);
    if (current && current.sessionId !== sessionId && await refreshCanvasBusy(canvasId)) {
      throw fail('session_busy');
    }
    return lock(canvasId, async () => {
      const previous = sessions.get(canvasId);
      if (previous?.sessionId === sessionId) {
        if (publishPointer) publish(previous);
        return previous;
      }
      if (isEntryBusy(previous)) throw fail('session_busy');
      const entry = await open(canvasId, sessionId);
      return install(entry, { publishPointer });
    });
  }
  async function releaseIdleSession(canvasId) {
    if (await refreshCanvasBusy(canvasId)) throw fail('session_busy');
    return lock(canvasId, async () => {
      const current = sessions.get(canvasId);
      if (!current) return;
      if (isEntryBusy(current)) throw fail('session_busy');
      sessions.delete(canvasId);
      current.disposed = true;
      await current.harness.close(CTX);
    });
  }

  const { clearCorruptPointer, readSafeCurrentPointer, resolveCurrentSession } = createDurablePointerResolver({
    currentPath,
    sessions,
    isEntryBusy,
    isDurableSessionId,
    hasSession,
    activateSession,
    releaseIdleSession,
    handoffSession,
    createSession,
    listCanvasSessions,
    legacy,
    fail,
  });

  async function ensureSession(canvasId, sessionId = '', { handoffLegacy = false } = {}) {
    if (sessionId) {
      if (isDurableSessionId(sessionId)) return activateSession(canvasId, sessionId);
      if (handoffLegacy) return handoffSession(canvasId, legacy ? legacy.readHandoffNote(canvasId, sessionId) : '', sessionId);
      throw fail('session_not_found');
    }
    const resolved = await resolveCurrentSession(canvasId, { persist: true, activateDurable: true, createIfMissing: true, handoffLegacy });
    if (!resolved.entry) throw fail('session_not_found');
    return resolved.entry;
  }
  async function ensureCurrentSession(canvasId, sessionId) {
    return lock(canvasId, async () => {
      const entry = sessions.get(canvasId);
      if (entry) {
        if (entry.sessionId !== sessionId) throw fail('session_not_current');
        return entry;
      }
      const pointer = readSafeCurrentPointer(canvasId);
      if (!sessionId || pointer !== sessionId) throw fail('session_not_current');
      return install(await open(canvasId, sessionId));
    });
  }
  const deleteSession = (canvasId, sessionId) => repository.deleteSession(canvasId, sessionId, { refreshCanvasBusy, isEntryBusy, readSafeCurrentPointer });
  const recordEvent = (canvasId, payload) => repository.recordEvent(canvasId, payload, { ensureSession, readSafeCurrentPointer });
  async function reloadPluginExtensions(newExtensions) {
    for (const entry of sessions.values()) {
      if (typeof entry.reloadPluginExtensions === 'function') await entry.reloadPluginExtensions(newExtensions);
    }
  }
  async function disposeAll() {
    closed = true;
    await Promise.allSettled([...locks.values()]);
    const entries = [...sessions.values()];
    sessions.clear();
    for (const entry of entries) {
      entry.disposed = true;
      await entry.harness.close(CTX);
    }
    return entries.length;
  }
  return {
    sessions,
    isEntryBusy,
    refreshCanvasBusy,
    busyState,
    createSession,
    handoffSession,
    activateSession,
    withSession,
    getOpenCount,
    releaseIdleSession,
    resolveCurrentSession,
    ensureSession,
    ensureCurrentSession,
    deleteSession,
    submit,
    recover,
    recoverForRead,
    inspectReadOnlyEntry,
    settleTurnWithConfirmation,
    supplement,
    beginPendingInput,
    fenceStop,
    wait,
    stop,
    cancelRequest,
    hasSession,
    readSafeCurrentPointer,
    clearCorruptPointer,
    historyOf,
    history,
    status,
    recordEvent,
    listCanvasSessions,
    reloadPluginExtensions,
    disposeAll,
    skillContext,
    changeSkillContext,
  };
}
