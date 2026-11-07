// New conversations have one official Durable owner. Legacy JSONL sessions are
// deliberately never imported or run here. Go remains the business authority.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { Harness, ProviderDoc, createRegistry, defineDoc } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { canvasKey } from './session-owner.mjs';
import { newTurnAccumulator, resetTurnAccumulator, sessionTitle } from './canvas-turn.mjs';
import { SYSTEM_PROMPT } from './system-prompt.mjs';
import { skillsToLoad } from './skill-resource.mjs';
import { emptyPlan, publicPlan } from './plan.mjs';
import { buildStudioDigest, describeChangesSince } from './studio-digest.mjs';
import {
  durableCompletion,
  durableLifecycleState,
  durableRetryReason,
  durableStreamEvents,
  publicDurableTurn,
} from './durable-turn-projection.mjs';
import { createDurableTurnLifecycle } from './durable-watch-observer.mjs';
import {
  createDurableSkillController,
  durableToolReplay,
  installDurableExtensions,
  prependStudioChanges,
  supplementContent,
} from './durable-extensions.mjs';

export {
  durableCompletion,
  durableLifecycleState,
  durableRetryReason,
  durableStreamEvents,
  durableToolReplay,
  publicDurableTurn,
};

// On-disk format tag written into manifests and host state since 1.0.4; not the
// package version. Changing it rejects every existing session as mismatched.
export const DURABLE_VERSION = '1.0.4';
export const HOST_STATE_CHECKPOINT_DELTAS = 32;
const STATE = defineDoc({ kind: 'beeftv.host', version: 1, scope: 'session',
  initial: () => ({ version: DURABLE_VERSION, canvasId: '', sessionId: '', active: null, turns: [], loadedSkills: [], plan: emptyPlan(), studioDigestText: '', lastStudioSnapshot: null, lastStudioSnapshotRevision: null }),
  checkpointWhen: (value, _ops, { deltasSinceBase }) => value.active === null || deltasSinceBase >= HOST_STATE_CHECKPOINT_DELTAS });
export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high'];
// The root agent's reasoning level; budgets follow pi-ai's DEFAULT_THINKING_BUDGETS.
export function agentThinkingLevel(env = process.env) {
  const value = String(env.BEEFTV_AGENT_THINKING || '').trim().toLowerCase();
  return THINKING_LEVELS.includes(value) ? value : 'low';
}
const CTX = BACKGROUND_CONTEXT;
const idPattern = /^durable:([a-f0-9-]{36})$/;
const fail = (reason) => Object.assign(new Error(reason), { reason });
const continuationRevoked = (error) => ['continuation_cancelled', 'continuation_scope_changed'].includes(error?.reason);
export const isDurableSessionId = (id) => idPattern.test(String(id || ''));

export function createDurableSessionStore({ sessionRoot, workspaceRoot, getModels, getModelRef,
  buildTools, authorizeTurn, authorizeContinuation = null, completeTurn = async () => {}, runWithBudget = (_entry, fn) => fn(),
  extensions = () => [], settings = {}, skills = null, readCanvas = null, maxPlanContinuations = 6, thinkingLevel = agentThinkingLevel() }) {
  if (!THINKING_LEVELS.includes(thinkingLevel)) throw fail('invalid_thinking_level');
  if (typeof authorizeTurn !== 'function') throw fail('durable_authorizer_required');
  const sessions = new Map();
  const locks = new Map();
  // A Stop names one request ID and may arrive before that request reaches this host.
  // Memory covers this process synchronously (a submit holding the canvas lock still sees
  // it); STATE.stopRequests and active.stopped carry it across restarts (cancelRequest).
  const STOP_INTENT_LIMIT = 64;
  const stopIntents = new Map();
  const stopIntentKey = (sessionId, requestId) => JSON.stringify([sessionId, requestId]);
  function rememberStop(canvasId, sessionId, requestId) {
    const ids = stopIntents.get(canvasId) || new Set();
    const key = stopIntentKey(sessionId, requestId);
    ids.delete(key); ids.add(key);
    while (ids.size > STOP_INTENT_LIMIT) ids.delete(ids.values().next().value);
    stopIntents.set(canvasId, ids);
  }
  function forgetStop(canvasId, sessionId, requestId) {
    const ids = stopIntents.get(canvasId);
    if (ids?.delete(stopIntentKey(sessionId, requestId)) && !ids.size) stopIntents.delete(canvasId);
  }
  function stopIntended(entry, doc, requestId) {
    return Boolean(stopIntents.get(entry.canvasId)?.has(stopIntentKey(entry.sessionId, requestId)) || (doc?.stopRequests || []).includes(requestId)
      || (doc?.active?.requestId === requestId && doc.active.stopped));
  }
  let closed = false;
  const directory = (canvasId) => path.join(sessionRoot, canvasKey(canvasId));
  const durableDirectory = (canvasId) => path.join(directory(canvasId), 'durable');
  const currentPath = (canvasId) => path.join(directory(canvasId), 'current.json');
  async function lock(canvasId, fn) {
    const previous = locks.get(canvasId) || Promise.resolve();
    const next = previous.catch(() => {}).then(() => { if (closed) throw fail('session_store_closed'); return fn(); });
    locks.set(canvasId, next);
    try { return await next; } finally { if (locks.get(canvasId) === next) locks.delete(canvasId); }
  }
  function publish(entry) {
    const temporary = `${currentPath(entry.canvasId)}.${crypto.randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify({ sessionId: entry.sessionId, kind: 'durable', version: DURABLE_VERSION }), { mode: 0o600 });
      fs.renameSync(temporary, currentPath(entry.canvasId));
    } catch (cause) {
      try { fs.rmSync(temporary, { force: true }); } catch (cleanup) { cause = new AggregateError([cause, cleanup], 'session_pointer_cleanup_failed'); }
      throw Object.assign(fail('session_pointer_failed'), { cause });
    }
  }
  async function install(entry) {
    try { publish(entry); }
    catch (error) {
      try { await entry.harness.close(CTX); }
      catch (cleanup) { error.cause = new AggregateError([error.cause, cleanup], 'session_candidate_cleanup_failed'); }
      throw error;
    }
    const previous = sessions.get(entry.canvasId);
    sessions.set(entry.canvasId, entry);
    if (previous) await previous.harness.close(CTX);
    return entry;
  }
  async function state(entry) { return await entry.harness.snapshot(STATE, CTX); }
  async function authorization(entry, turnId, allowClosed = false) {
    let result;
    try { result = await authorizeTurn({ canvasId: entry.canvasId, turnId, sessionId: entry.sessionId }); }
    catch (error) {
      // This preflight shares the skill guard but a transport failure is not a
      // missing/invalid skill. Preserve typed denials; never infer interruption.
      if (error?.reason) throw error;
      throw Object.assign(fail('turn_authorization_unavailable'), { cause: error });
    }
    if (result?.continuationRevoked === true && result.canvasId === entry.canvasId && result.turnId === turnId) throw fail('continuation_cancelled');
    const mode=result?.permissionMode || 'canvas';
    if (!['read-only','canvas','full-access'].includes(mode)) throw fail('invalid_permission_mode');
    if (entry.input?.turnId===turnId && (entry.input.permissionMode || 'canvas')!==mode) throw fail('permission_mode_frozen');
    if (entry.permissionMode!==mode) {entry.permissionMode=mode;entry.generation.permissionMode=mode;if(entry.configurePermission) await entry.configurePermission(mode);}
    if (result?.open === false) {
      // Only an explicit identity-matching response can mean owned but closed.
      if (result.canvasId !== entry.canvasId || result.turnId !== turnId) throw fail('scope_denied');
      if (!allowClosed) throw fail('turn_not_open');
    }
    return result;
  }
  async function update(entry, mutate) {
    return entry.harness.commit(async (tx) => mutate(await tx.doc(STATE)), CTX);
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
        // Older hosts could persist the operation wrapper as an empty snapshot.
        // Only compare against a baseline tied to a successful document read.
        if (computeDiff && Number.isSafeInteger(doc.lastStudioSnapshotRevision) && doc.lastStudioSnapshotRevision >= 0) {
          diffText = describeChangesSince(doc.lastStudioSnapshot, digest.snapshot);
        }
        doc.studioDigestText = digest.text;
        doc.lastStudioSnapshot = digest.snapshot;
        doc.lastStudioSnapshotRevision = digest.stats.revision;
      });
      return diffText;
    } catch {
      // Do not present the previous turn's digest as current after a failed read.
      // Preserve the last successful snapshot so recovery compares real states.
      await update(entry, (doc) => { doc.studioDigestText = ''; });
      entry.turn.studioReadAvailable = false;
      return '';
    }
  }
  async function turnModel(entry, active) {
    const agent = await entry.root.agent(CTX);
    // Only the backend-launched host chooses a NEW round's model. An unfinished
    // round retains its official model, including old rounds without this pin.
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
      // Existing conversations pick up the host's current reasoning level on
      // their next new round, as they pick up the model.
      await entry.root.configure({ model: modelRef, thinkingLevel }, CTX);
    }
    return modelRef;
  }
  function hydrate(entry, active) {
    entry.busy = Boolean(active);
    if (!active) return;
    // 官方快照与会话状态可能共享同一份嵌套数组。直接展开会让工具执行在原地改写
    // 「已提交」的文档值，persistEffects 比较不出差异，重启后本轮写入与提案就丢了。
    Object.assign(entry.turn, active.effects ? JSON.parse(JSON.stringify(active.effects)) : {});
    entry.turn.turnId = active.turnId;
    entry.input = active;
    entry.generation.permissionMode=active.permissionMode || 'canvas';
    entry.generation.aborted ||= Boolean(active.stopped);
    entry.generation.intentEpoch = active.intentEpoch || 0;
    entry.generation.modelEpoch = active.modelEpoch || 0;
    entry.turn.supplements = active.supplements || [];
  }
  async function persistEffects(entry) {
    await update(entry, (doc) => {
      if (doc.active && doc.active.turnId === entry.turn.turnId) {
        doc.active.effects = JSON.parse(JSON.stringify(entry.turn));
        doc.active.log = [...entry.log];
        doc.active.modelEpoch = entry.generation.modelEpoch;
      }
    });
  }
  const skillController = createDurableSkillController({
    skills,
    getModels,
    state,
    update,
    lock,
    officialSubmission: (entry, requestId) => officialSubmission(entry, requestId),
  });
  const {
    expandSelectedSkills,
    readSkillContext,
    resetPendingScope,
    prepareSkillContext,
    activateTurnSkills,
    undoUnsubmittedSkills,
    skillContext,
    changeSkillContext,
  } = skillController;
  async function open(canvasId, sessionId) {
    if (!isDurableSessionId(sessionId)) throw fail('session_not_found');
    const uuid = idPattern.exec(sessionId)[1];
    const dir = durableDirectory(canvasId);
    const manifestPath = path.join(dir, `${uuid}.json`);
    if (!fs.existsSync(manifestPath)) throw fail('session_not_found');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (manifest.canvasId !== canvasId || manifest.sessionId !== sessionId || manifest.version !== DURABLE_VERSION) throw fail('durable_version_mismatch');
    const cwd = path.join(workspaceRoot, canvasKey(canvasId));
    fs.mkdirSync(cwd, { recursive: true });
    const entry = { kind: 'durable', canvasId, sessionId, identity: { prefix: sessionId, source: 'durable-session-id' },
      log: [], generation: { durable: true, aborted: false, intentEpoch: 0, modelEpoch: 0 }, turn: newTurnAccumulator(), busy: false, persistence: 'restored',
      budgetDirectory: path.join(dir, `${uuid}.budget`), skillCatalog: {}, waiters: 0, recovering: null, submittedRequest: null };
    fs.mkdirSync(entry.budgetDirectory, { recursive: true, mode: 0o700 });
    const registry = createRegistry();
    entry.generation.persistEffects = () => persistEffects(entry);
    entry.generation.permissionMode = 'full-access';
    const { tools, models } = await installDurableExtensions({
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
    });
    entry.harness = await Harness.open(await openNodeSqliteStorage(path.join(dir, `${uuid}.sqlite`)), {
      models, registry,
      // Do not repeat a failed model request: the upstream may already have billed it.
      // pi 1.5 counts a request cut off by a host restart as a failed attempt too, so that
      // turn ends interrupted instead of resending; landed changes stay.
      settings: { stream: { timeoutMs: 180000, maxRetries: 0 }, retry: { maxRetries: 0 },
        afterFailedRun: 'continue', toolExecution: 'sequential', steeringMode: 'all', ...settings },
    }, CTX);
    try {
      entry.root = await entry.harness.root(CTX, {
        agent: { model: await getModelRef(entry), tools, instructions: SYSTEM_PROMPT, thinkingLevel, cwd },
        // 固定官方 provider 身份为 Durable 会话 ID，使缓存亲和性跨重启保持稳定。
        init: async (tx, id) => { (await tx.doc(ProviderDoc, id)).sessionId = sessionId; },
      });
      let hostState = await state(entry);
      if (!hostState) {
        await update(entry, (doc) => { doc.canvasId = canvasId; doc.sessionId = sessionId; doc.affinityMinEntryId = 1; });
        hostState = await state(entry);
      } else if (typeof hostState.affinityMinEntryId !== 'number') {
        // 升级前的会话没有固定过渠道亲和性：从下一条条目开始视为已固定，
        // 旧条目的 thinking 签名在恢复时降级，避免重发到不同上游节点。
        const latest = await entry.root.entries({ order: 'descending' }, 1, undefined, CTX);
        const affinityMinEntryId = (latest.items[0]?.id ?? 0) + 1;
        await update(entry, (doc) => { doc.affinityMinEntryId = affinityMinEntryId; });
        hostState = await state(entry);
      }
      if (hostState.canvasId !== canvasId || hostState.sessionId !== sessionId || hostState.version !== DURABLE_VERSION) throw fail('durable_version_mismatch');
      hydrate(entry, hostState.active);
      entry.log.push(...(hostState.active?.log || []));
      return entry;
    } catch (error) { await entry.harness.close(CTX); throw error; }
  }
  function handoffSessionId(canvasId, handoffSourceId) {
    const digest = crypto.createHash('sha256').update(JSON.stringify([canvasId, handoffSourceId])).digest('hex');
    return `durable:${digest.slice(0,8)}-${digest.slice(8,12)}-${digest.slice(12,16)}-${digest.slice(16,20)}-${digest.slice(20,32)}`;
  }
  // Whether this durable session was created for this canvas (its manifest lives in that canvas).
  function hasSession(canvasId, sessionId) {
    if (!isDurableSessionId(sessionId)) return false;
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(durableDirectory(canvasId), `${idPattern.exec(sessionId)[1]}.json`), 'utf8'));
      return manifest.canvasId === canvasId && manifest.sessionId === sessionId;
    } catch { return false; }
  }
  // 新建候选：写清单、打开官方 Harness，但不发布指针、不写入 sessions。
  async function prepareSession(canvasId, handoffSourceId = '') {
    // A legacy source has one durable successor even if the process dies before
    // publishing current.json or the client receives no response.
    const sessionId = handoffSourceId ? handoffSessionId(canvasId, handoffSourceId) : `durable:${crypto.randomUUID()}`;
    fs.mkdirSync(durableDirectory(canvasId), { recursive: true, mode: 0o700 });
    const file = path.join(durableDirectory(canvasId), `${idPattern.exec(sessionId)[1]}.json`);
    const created = !handoffSourceId || !fs.existsSync(file);
    if (created) {
      const temporary = `${file}.${crypto.randomUUID()}.tmp`;
      try {
        fs.writeFileSync(temporary, JSON.stringify({ sessionId, canvasId, handoffSourceId, version: DURABLE_VERSION, createdAt: new Date().toISOString() }), { flag: 'wx', mode: 0o600 });
        fs.renameSync(temporary, file);
      } finally { fs.rmSync(temporary, { force: true }); }
    } else if (JSON.parse(fs.readFileSync(file, 'utf8')).handoffSourceId !== handoffSourceId) {
      throw fail('handoff_source_conflict');
    }
    const current = sessions.get(canvasId);
    if (current?.sessionId === sessionId) return current;
    const entry = await open(canvasId, sessionId);
    entry.persistence = created ? 'created' : 'restored';
    return entry;
  }
  async function createSession(canvasId) {
    return lock(canvasId, async () => {
      if (sessions.get(canvasId)?.busy) throw fail('session_busy');
      return install(await prepareSession(canvasId));
    });
  }
  // An initialized successor must never reset when an old client retries.
  async function handoffSession(canvasId, handoffNote = '', handoffSourceId = '') {
    return lock(canvasId, async () => {
      const current = sessions.get(canvasId);
      if (current?.busy) throw fail('session_busy');
      const entry = await prepareSession(canvasId, handoffSourceId);
      if (!(await state(entry)).handoffInitialized) {
        try {
          if (handoffNote) await entry.root.reset(handoffNote, CTX);
          await update(entry, (doc) => { doc.handoffInitialized = true; });
        }
        catch (error) { await entry.harness.close(CTX).catch(() => {}); throw error; }
      }
      if (entry === current) { publish(entry); return entry; }
      return install(entry);
    });
  }
  async function activateSession(canvasId, sessionId) {
    return lock(canvasId, async () => {
      const previous = sessions.get(canvasId);
      if (previous?.sessionId === sessionId) { publish(previous); return previous; }
      if (previous?.busy) throw fail('session_busy');
      const entry = await open(canvasId, sessionId);
      return install(entry);
    });
  }
  async function ensureSession(canvasId, sessionId = '') {
    if (!sessionId) {
      if (sessions.has(canvasId)) return sessions.get(canvasId);
      try { sessionId = JSON.parse(fs.readFileSync(currentPath(canvasId), 'utf8')).sessionId; }
      catch (error) { if (error.code !== 'ENOENT') throw fail('session_pointer_failed'); }
    }
    if (!sessionId) return createSession(canvasId);
    return activateSession(canvasId, sessionId);
  }
  // Restore only the current pointer, under the same lock as explicit switches.
  // A delayed automatic request must never install its old session.
  async function ensureCurrentSession(canvasId, sessionId) {
    return lock(canvasId, async () => {
      const entry = sessions.get(canvasId);
      if (entry) {
        if (entry.sessionId !== sessionId) throw fail('session_not_current');
        return entry;
      }
      let pointer;
      try { pointer = JSON.parse(fs.readFileSync(currentPath(canvasId), 'utf8')).sessionId; }
      catch (error) { throw fail(error.code === 'ENOENT' ? 'session_not_current' : 'session_pointer_failed'); }
      if (!sessionId || pointer !== sessionId) throw fail('session_not_current');
      return install(await open(canvasId, sessionId));
    });
  }
  async function submit(entry, input) {
    return lock(entry.canvasId, async () => {
      // Automatic work must never activate an old conversation. The same lock
      // serializes explicit session changes and this final admission.
      if (input.continuationId && sessions.get(entry.canvasId) !== entry) throw fail('session_not_current');
      const existing = await state(entry);
      const requestId = String(input.requestId || input.turnId || '').trim();
      if (!requestId || !input.turnId || !input.content) throw fail('invalid_request');
      if (existing.active && existing.active.requestId !== requestId) throw fail('session_busy');
      const finished = existing.turns.find((turn) => turn.requestId === requestId);
      if (finished) {
        if (JSON.stringify(skillsToLoad(finished.skills || [])) !== JSON.stringify(skillsToLoad(input.skills || []))) throw fail('submission_request_conflict');
        // The same request sent again never runs again. Go opened a new turn for this send;
        // nothing can use it, so it is closed here and the original record answers.
        if (finished.turnId !== input.turnId) await completeTurn({ canvasId: entry.canvasId, turnId: input.turnId, sessionId: entry.sessionId, record: finished });
        // A request stopped before submit has a record but no official submission.
        return finished.submissionId === undefined ? null : entry.harness.submission(finished.submissionId, CTX);
      }
      // A Stop named this request before it got here: record it stopped, with no model request.
      if (stopIntended(entry, existing, requestId)) {
        return existing.active ? stoppedRequest(entry, existing.active)
          : stopBeforeSubmit(entry, { ...input, requestId, createdAt: new Date().toISOString() });
      }
      if (existing.active && (existing.active.turnId !== input.turnId || JSON.stringify(existing.active.content) !== JSON.stringify(input.content) ||
        JSON.stringify(skillsToLoad(existing.active.skills || [])) !== JSON.stringify(skillsToLoad(input.skills || [])))) throw fail('submission_request_conflict');
      let auth;
      try { auth = await authorization(entry, input.turnId); }
      catch (error) {
        if (input.continuationId && continuationRevoked(error)) return stoppedRequest(entry, existing.active || {...input, requestId});
        throw error;
      }
      const modelRef = await turnModel(entry, existing.active);
      input={...input,modelRef,permissionMode:auth?.permissionMode || 'canvas'};
      if (stopIntended(entry, await state(entry), requestId)) {
        return existing.active ? stoppedRequest(entry, existing.active)
          : stopBeforeSubmit(entry, { ...input, requestId, createdAt: new Date().toISOString() });
      }
      if (!existing.active) {
        if (skills) await resetPendingScope(entry, await readSkillContext(entry, input.turnId));
        entry.budget = null;
        resetTurnAccumulator(entry.turn, input.revisionBefore, input.turnId);
        entry.turn.canvasId=entry.canvasId;
        entry.turn.supplements = [];
        entry.turn.plan = publicPlan((await state(entry)).plan);
        entry.log.length = 0;
        entry.generation = Object.assign(entry.generation, { aborted: false, intentEpoch: 0, modelEpoch: 0, pendingInput: null, pendingInputError: null, skillContextFailure: null, preparedRequests: new Set(), planTouchedInTurn: false, toolCalledSinceYield: false, planContinuations: 0, unboundReminderSent: false });
        entry.submittedRequest = null;
        const expansion = await expandSelectedSkills(entry, existing, input.skills, input.content, input.turnId);
        const studioDiff = await refreshStudioDigest(entry, input.turnId, { selectedNodeIds: input.selectedNodeIds || [], computeDiff: true });
        const submittedContent = prependStudioChanges(expansion.content, studioDiff);
        await update(entry, (doc) => {
          // content stays the client's own input (idempotency and history);
          // submittedContent is what the transcript receives, skills included.
          doc.active = { ...input, requestId, createdAt: new Date().toISOString(), stopped: false,
            effects: JSON.parse(JSON.stringify(entry.turn)), log: [], supplements: [], intentEpoch: 0, modelEpoch: 0,
            ...(publicPlan(doc.plan) ? { plan: publicPlan(doc.plan) } : {}),
            ...((expansion.records.length || studioDiff) ? { submittedContent } : {}) };
          if (expansion.records.length) doc.loadedSkills = [...(doc.loadedSkills || []), ...expansion.records];
        });
      }
      const prepared = await state(entry);
      if (stopIntended(entry, prepared, requestId)) return stoppedRequest(entry, prepared.active);
      await activateTurnSkills(entry);
      const current = await state(entry);
      const admitted = current.active;
      hydrate(entry, admitted);
      // The reset above must not swallow a Stop sent while this request was being prepared.
      // Checked synchronously before the official submit; a later Stop finds it running.
      if (stopIntended(entry, current, requestId)) return stoppedRequest(entry, admitted);
      if (input.continuationId) {
        if (!authorizeContinuation) throw fail('continuation_unavailable');
        try { await authorizeContinuation({id:input.continuationId,turnId:admitted.turnId,sessionId:entry.sessionId}); }
        catch (error) {
          if (continuationRevoked(error)) return stoppedRequest(entry, admitted);
          throw error;
        }
        if (stopIntended(entry, await state(entry), requestId)) return stoppedRequest(entry, admitted);
      }
      entry.submittedRequest = requestId;
      const submission = await entry.root.submit({ type: 'input', requestId, content: admitted.submittedContent ?? admitted.content, whenBusy: 'reject' }, CTX);
      await update(entry, (doc) => { if (doc.active) doc.active.submissionId = submission.id; });
      return submission;
    });
  }
  async function officialSubmission(entry, requestId) {
    const admitted = await entry.harness.commit((tx) => tx.submissionByRequest(entry.root.id, requestId), CTX);
    return admitted ? entry.harness.submission(admitted.id, CTX) : null;
  }
  // Never submitted: no model request, tool or canvas write. Recorded as stopped so
  // history (and a waiting panel) shows it; skills it would have loaded are not kept.
  async function stopBeforeSubmit(entry, active) {
    await undoUnsubmittedSkills(entry, active);
    const record = { ...publicDurableTurn(active), reply: '', cancelled: true, error: null, errorReason: null,
      toolCalls: [], change: null, proposals: [], scriptProposals: [], status: 'unanswered', sessionId: entry.sessionId };
    let pending = null;
    // Use the same acknowledgement ordering as a submitted turn. A crash or failed
    // Go completion leaves active.result available to recovery, even without a submission.
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
  const { stoppedRequest, settleLocal, recover, wait, fenceStop, stop } = createDurableTurnLifecycle({
    stateDoc: STATE,
    state,
    update,
    lock,
    hydrate,
    authorization,
    turnModel,
    submit: (entry, active) => submit(entry, active),
    officialSubmission,
    stopBeforeSubmit,
    stopIntended,
    forgetStop,
    completeTurn,
  });
  // One commit: a settled request reports finished; otherwise the intent is journaled so a
  // later /chat, a resend or recovery after a restart records it stopped instead of running it.
  async function recordStopIntent(entry, requestId) {
    let finished = false;
    await update(entry, (doc) => {
      finished = doc.turns.some((turn) => turn.requestId === requestId);
      if (finished) return;
      doc.stopRequests = [...(doc.stopRequests || []).filter((id) => id !== requestId), requestId].slice(-STOP_INTENT_LIMIT);
      if (doc.active?.requestId === requestId) doc.active.stopped = true;
    });
    return finished;
  }
  // A Stop that names one request of one conversation. Other requests are never touched.
  // running: the caller fences Go and aborts (as a canvas Stop does); finished: already
  // settled; pending: not running here, and it will not run when it arrives or recovers.
  async function cancelRequest(canvasId, sessionId, requestId) {
    const target = isDurableSessionId(sessionId) ? sessionId : handoffSessionId(canvasId, sessionId);
    rememberStop(canvasId, target, requestId);
    const live = sessions.get(canvasId);
    if (live?.sessionId === target && live.busy && live.input?.requestId === requestId && live.submittedRequest === requestId) {
      live.generation.aborted = true;
      live.generation.pendingInput?.cancel?.();
      return { state: 'running', entry: live };
    }
    // The live owner is written without the canvas lock: a submit preparing this very
    // request holds that lock, and it reads the in-memory intent before its official submit.
    const finished = live?.sessionId === target ? await recordStopIntent(live, requestId)
      : await lock(canvasId, async () => {
        const current = sessions.get(canvasId);
        if (current?.sessionId === target) return recordStopIntent(current, requestId);
        // Persist an early legacy stop in its deterministic successor, without
        // publishing it or scheduling a model turn. Handoff later keeps this doc.
        const exists = hasSession(canvasId, target);
        if (!exists && isDurableSessionId(sessionId)) return false;
        const entry = exists ? await open(canvasId, target) : await prepareSession(canvasId, sessionId);
        try { return await recordStopIntent(entry, requestId); }
        finally { await entry.harness.close(CTX); }
      });
    if (finished) { forgetStop(canvasId, target, requestId); return { state: 'finished' }; }
    return { state: 'pending' };
  }
  async function supplement(entry, { requestId, content, input = {} }) {
    if (entry.completing || entry.generation.aborted) throw fail('session_not_running');
    return lock(entry.canvasId, async () => {
      if (entry.completing || entry.generation.aborted) throw fail('session_not_running');
      const active = (await state(entry)).active;
      if (!active || active.stopped || !requestId || !content) throw fail('session_not_running');
      await authorization(entry, active.turnId);
      if (entry.generation.aborted) throw fail('session_not_running');
      const previous = (active.supplementContents || []).find((input) => input.requestId === requestId);
      if (previous && JSON.stringify(previous.rawContent ?? previous.content) !== JSON.stringify(content)) throw fail('submission_request_conflict');
      const previousInput=(active.supplementInputs || []).find(item=>item.requestId===requestId);
      if(previous && previousInput && JSON.stringify(skillsToLoad(previousInput.skills || []))!==JSON.stringify(skillsToLoad(input.skills || [])))throw fail('submission_request_conflict');
      if (previous) return entry.root.submit({ type: 'input', requestId: `supplement:${requestId}`, content: supplementContent(requestId, previous.content), whenBusy: 'steer' }, CTX);
      const expansion = await expandSelectedSkills(entry, await state(entry), input.skills, content, active.turnId);
      if (skills) await prepareSkillContext(entry,input.skills,`supplement:${requestId}`,active.turnId,{append:true});
      if (entry.generation.aborted) throw fail('session_not_running');
      entry.generation.intentEpoch += 1;
      await update(entry, (doc) => {
        if (!doc.active || doc.active.stopped || entry.generation.aborted) throw fail('session_not_running');
        const ids = doc.active.supplementIds || [];
        if (!ids.includes(requestId)) {
          doc.active.supplementIds = [...ids, requestId];
          const message = String(input.message ?? (typeof content === 'string' ? content : ''));
          doc.active.supplements = [...doc.active.supplements, message];
          doc.active.supplementInputs = [...(doc.active.supplementInputs || []), { requestId, message,
            attachments: input.attachments || [], skills: input.skills || [] }];
          doc.active.supplementContents = [...(doc.active.supplementContents || []),
            expansion.records.length ? { requestId, content: expansion.content, rawContent: content } : { requestId, content }];
          if (expansion.records.length) doc.loadedSkills = [...(doc.loadedSkills || []), ...expansion.records];
          doc.active.intentEpoch = entry.generation.intentEpoch;
        }
      });
      entry.turn.supplements = (await state(entry)).active?.supplements || [];
      hydrate(entry, (await state(entry)).active);
      if (entry.generation.aborted) throw fail('session_not_running');
      const queued = await entry.root.submit({ type: 'input', requestId: `supplement:${requestId}`, content: supplementContent(requestId, expansion.content), whenBusy: 'steer' }, CTX);
      return queued;
    });
  }
  function beginPendingInput(entry) {
    if (entry.completing) throw fail('session_not_running');
    if (entry.generation.pendingInput?.state === 'pending') throw fail('supplement_preparation_pending');
    if (entry.generation.pendingInputError || entry.generation.aborted) throw fail('session_not_running');
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    // The HTTP preparation may reject before the next official generation hook
    // awaits it. Keep rejection handled while retaining the rejecting promise.
    promise.catch(() => {});
    const pending = { state: 'pending', promise };
    pending.cancel = () => {
      if (pending.state !== 'pending') return;
      pending.state = 'cancelled'; resolve();
      if (entry.generation.pendingInput === pending) entry.generation.pendingInput = null;
    };
    entry.generation.pendingInput = pending;
    entry.generation.modelEpoch = -1;
    return {
      resolve() {
        if (pending.state !== 'pending') return;
        pending.state = 'resolved'; resolve();
        if (entry.generation.pendingInput === pending) entry.generation.pendingInput = null;
      },
      reject(error) {
        if (pending.state !== 'pending') return;
        const reason = error?.reason || 'supplement_preparation_failed';
        entry.generation.pendingInputError = { reason, message: String(error?.message || reason) };
        pending.state = 'rejected'; reject(fail(reason));
        // End any older in-flight response as well; it must not finish the
        // business turn successfully after the latest user input was rejected.
        void entry.root.abort(CTX).catch(() => {});
      },
    };
  }
  async function history(canvasId, sessionId) {
    const cached = sessions.get(canvasId);
    const entry = cached?.sessionId === sessionId ? cached : await open(canvasId, sessionId);
    try { const value = await state(entry); const plan = publicPlan(value.plan); return { sessionId, turns: value.turns.map((turn) => publicDurableTurn(turn)), active: publicDurableTurn(value.active, true), ...(plan ? { plan } : {}) }; }
    finally { if (entry !== cached) await entry.harness.close(CTX); }
  }
  async function status(entry) {
    const value = await state(entry);
    const inspection = await entry.harness.inspect(CTX);
    return { sessionId: entry.sessionId, kind: 'durable', active: publicDurableTurn(value.active, true), plan: publicPlan(value.plan),
      inspection: { scheduling: inspection.scheduling,
        tasks: inspection.tasks.map((task) => ({ id: task.record.id, state: task.state.kind })),
        submissions: inspection.submissions.map((submission) => ({ id: submission.id, status: submission.status })) } };
  }
  async function recordEvent(canvasId, { sessionId = '', requestId = crypto.randomUUID(), kind = 'event', message = '', data = {} } = {}) {
    const cleanCanvasId = String(canvasId || '').trim();
    const cleanKind = String(kind || 'event').trim();
    const cleanMessage = String(message || '').trim();
    const requestedSessionId = String(sessionId || '').trim();
    if (!cleanCanvasId || !cleanKind || !cleanMessage) throw fail('invalid_request');
    let currentSessionId = sessions.get(cleanCanvasId)?.sessionId || '';
    if (!currentSessionId) {
      try { currentSessionId = JSON.parse(fs.readFileSync(currentPath(cleanCanvasId), 'utf8')).sessionId || ''; }
      catch (error) { if (error.code !== 'ENOENT') throw fail('session_pointer_failed'); }
    }
    if (requestedSessionId && isDurableSessionId(requestedSessionId) && requestedSessionId !== currentSessionId) {
      return lock(cleanCanvasId, async () => {
        const cached = sessions.get(cleanCanvasId);
        const entry = cached?.sessionId === requestedSessionId ? cached : await open(cleanCanvasId, requestedSessionId);
        try {
          const submission = await entry.root.submit({
            type: 'write',
            requestId: `event:${requestId}`,
            entry: {
              kind: `beeftv.${cleanKind}`,
              data,
              model: [{
                role: 'user',
                content: [{ type: 'text', text: `<canvas_event kind="${cleanKind}">\n${cleanMessage}\n</canvas_event>` }],
                timestamp: Date.now(),
              }],
            },
          }, CTX);
          return { accepted: true, sessionId: entry.sessionId, submissionId: submission.id, requestId: `event:${requestId}` };
        } finally {
          if (entry !== cached) await entry.harness.close(CTX);
        }
      });
    }
    const entry = await ensureSession(cleanCanvasId, requestedSessionId);
    return lock(cleanCanvasId, async () => {
      const submission = await entry.root.submit({
        type: 'write',
        requestId: `event:${requestId}`,
        entry: {
          kind: `beeftv.${cleanKind}`,
          data,
          model: [{
            role: 'user',
            content: [{ type: 'text', text: `<canvas_event kind="${cleanKind}">\n${cleanMessage}\n</canvas_event>` }],
            timestamp: Date.now(),
          }],
        },
      }, CTX);
      return { accepted: true, sessionId: entry.sessionId, submissionId: submission.id, requestId: `event:${requestId}` };
    });
  }
  async function listCanvasSessions(canvasId) {
    const dir = durableDirectory(canvasId);
    if (!fs.existsSync(dir)) return [];
    const out = [];
    for (const name of fs.readdirSync(dir).filter((file) => /^[a-f0-9-]{36}\.json$/.test(file))) {
      const info = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      const value = await history(canvasId, info.sessionId);
      out.push({ sessionId: info.sessionId, kind: 'durable', title: sessionTitle(value.turns),
        updatedAt: value.turns.at(-1)?.createdAt || info.createdAt, turnCount: value.turns.length });
    }
    return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  async function deleteSession(canvasId, sessionId) {
    return lock(canvasId, async () => {
      if (!isDurableSessionId(sessionId) || !hasSession(canvasId, sessionId)) throw fail('session_not_found');
      const current = sessions.get(canvasId);
      if (current?.busy) throw fail('session_busy');
      const uuid = idPattern.exec(sessionId)[1];
      const dir = durableDirectory(canvasId);
      if (current?.sessionId === sessionId) {
        sessions.delete(canvasId);
        await current.harness.close(CTX);
      }
      for (const suffix of ['.json', '.sqlite', '.sqlite-wal', '.sqlite-shm', '.budget']) {
        fs.rmSync(path.join(dir, `${uuid}${suffix}`), { recursive: true, force: true });
      }
      let currentPointer = '';
      try { currentPointer = JSON.parse(fs.readFileSync(currentPath(canvasId), 'utf8')).sessionId || ''; }
      catch { currentPointer = ''; }
      if (currentPointer === sessionId) {
        const remaining = await listCanvasSessions(canvasId);
        if (remaining.length > 0) {
          const next = await open(canvasId, remaining[0].sessionId);
          await install(next);
        } else {
          fs.rmSync(currentPath(canvasId), { force: true });
        }
      }
      return { deleted: true, sessionId };
    });
  }
  async function reloadPluginExtensions(newExtensions) {
    for (const entry of sessions.values()) {
      if (typeof entry.reloadPluginExtensions === 'function') {
        await entry.reloadPluginExtensions(newExtensions);
      }
    }
  }
  async function disposeAll() {
    closed = true;
    await Promise.allSettled([...locks.values()]);
    const entries = [...sessions.values()]; sessions.clear();
    for (const entry of entries) await entry.harness.close(CTX);
    return entries.length;
  }
  return { sessions, createSession, handoffSession, activateSession, ensureSession, ensureCurrentSession, deleteSession, submit, recover, supplement, beginPendingInput, fenceStop, wait,
    stop, cancelRequest, hasSession, history, status, recordEvent, listCanvasSessions, reloadPluginExtensions, disposeAll, skillContext, changeSkillContext };
}
