import { beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createModels } from '@earendil-works/pi-ai/models';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { newTurnAccumulator } from './canvas-turn.mjs';
import { createDurableSessionStore, isCorruptSessionArtifactError, isSkippableSessionError } from './durable-session-owner.mjs';
import { canvasKey } from './session-owner.mjs';
import { createDurableTurnLifecycle } from './durable-watch-observer.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let receipt;
beforeAll(() => {
  const scratch = mkdtempSync(path.join(tmpdir(), 'beeftv runtime receipt '));
  try {
    const output = path.join(scratch, 'receipt.json');
    const child = spawnSync('node', [path.join(root, 'agent-host/test-support/host-runtime-probe.mjs'), root, output], { cwd: root, encoding: 'utf8', timeout: 150000 });
    if (child.error) throw child.error;
    receipt = JSON.parse(readFileSync(output, 'utf8'));
    if (!receipt.results?.length) throw new Error('Runtime probe returned no scenario results');
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}, 170000);

describe('真实 Node 与 pi SDK 的隔离执行链（模型和操作端点均为本地替身）', () => {
  for (const name of [
    'budget-exhaustion-is-an-explicit-failed-turn',
    'new-turn-after-budget-exhaustion-still-works',
    'asset-tool-does-not-inject-unknown-canvasId',
    'explicit-reference-canvas-can-reach-backend-read-guard',
    'history-and-sessions-survive-unresumable-turn-and-corrupt-manifest',
    'transient-frozen-model-resumes-when-restored-and-allows-continue-when-superseded',
    'corrupt-current-session-and-pointer-self-heal-without-500',
  ]) {
    test(name, () => {
      const result = receipt.results.find((item) => item.name === name);
      expect(result, JSON.stringify(receipt.results)).toBeDefined();
      expect(result.passed, result.error).toBe(true);
    });
  }

  test('isSkippableSessionError classifies corrupt session artifacts without swallowing unexpected errors', () => {
    expect(isSkippableSessionError(new SyntaxError('Unexpected token'))).toBe(true);
    for (const code of ['ENOENT', 'EACCES', 'EPERM', 'EISDIR']) {
      expect(isSkippableSessionError(Object.assign(new Error(code), { code }))).toBe(true);
    }
    for (const reason of ['corrupt_session_manifest', 'durable_version_mismatch', 'session_not_found']) {
      expect(isSkippableSessionError(Object.assign(new Error(reason), { reason }))).toBe(true);
    }
    expect(isSkippableSessionError(Object.assign(new Error('SQLITE_NOTADB: file is not a database'), { code: 'ERR_SQLITE_ERROR' }))).toBe(true);
    expect(isSkippableSessionError(Object.assign(new Error('database disk image is malformed'), { code: 'SQLITE_CORRUPT' }))).toBe(true);
    expect(isSkippableSessionError(new RangeError('unexpected programming bug'))).toBe(false);
    expect(isSkippableSessionError(Object.assign(new Error('out of memory'), { code: 'ENOMEM' }))).toBe(false);

    expect(isCorruptSessionArtifactError(new SyntaxError('Unexpected token'))).toBe(false);
    expect(isCorruptSessionArtifactError(Object.assign(new Error('EACCES'), { code: 'EACCES' }))).toBe(false);
    expect(isCorruptSessionArtifactError(Object.assign(new Error('corrupt_session_manifest'), { reason: 'corrupt_session_manifest' }))).toBe(true);
    expect(isCorruptSessionArtifactError(Object.assign(new Error('durable_version_mismatch'), { reason: 'durable_version_mismatch' }))).toBe(true);
    expect(isCorruptSessionArtifactError(Object.assign(new Error('SQLITE_NOTADB: file is not a database'), { code: 'ERR_SQLITE_ERROR' }))).toBe(true);
  });

  test('recoverForRead settle race does not abort or settle a newer turn started before lock acquisition', async () => {
    let doc = {
      active: { requestId: 'req-A', turnId: 'turn-A', stopped: false },
      turns: [],
      stopRequests: [],
    };
    let aborts = 0;
    let lockQueue = Promise.resolve();
    const lock = (_canvasId, fn) => {
      const run = lockQueue.then(fn, fn);
      lockQueue = run.catch(() => {});
      return run;
    };
    let releaseAuthA;
    const authGate = new Promise((resolve) => { releaseAuthA = resolve; });
    const entry = {
      canvasId: 'race-canvas',
      sessionId: 'durable:00000000-0000-4000-8000-000000000001',
      busy: true,
      waiters: 0,
      running: null,
      submittedRequest: null,
      submittingRequest: null,
      recovering: null,
      log: [],
      turn: newTurnAccumulator(),
      generation: {},
      root: {
        id: 'root-1',
        abort: async () => { aborts += 1; },
      },
      harness: {
        commit: async () => null,
      },
    };
    const lifecycle = createDurableTurnLifecycle({
      stateDoc: {},
      state: async () => doc,
      update: async (_entry, mutator) => { mutator(doc); },
      lock,
      hydrate: () => {},
      authorization: async (_entry, turnId) => {
        if (turnId === 'turn-A') {
          await authGate;
          throw Object.assign(new Error('turn_not_open'), { reason: 'turn_not_open' });
        }
        return { open: true };
      },
      turnModel: async () => ({ provider: 'beeftv', modelId: 'synthetic-model' }),
      submit: async () => null,
      officialSubmission: async () => null,
      stopBeforeSubmit: async () => null,
      undoUnsubmittedSkills: async () => {},
      flushPendingSkillRollback: async () => {},
      stopIntended: () => false,
      forgetStop: () => {},
      completeTurn: async () => {},
    });

    const readPromise = lifecycle.recoverForRead(entry);
    // Simulate concurrent request settling req-A and admitting req-B while lock is held right as authGate rejects.
    const concurrentTurnB = lock('race-canvas', async () => {
      doc.turns = [{ requestId: 'req-A', turnId: 'turn-A', errorReason: 'turn_interrupted' }];
      doc.active = { requestId: 'req-B', turnId: 'turn-B', stopped: false };
      entry.submittedRequest = 'req-B';
      entry.busy = true;
      releaseAuthA();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    await Promise.all([readPromise, concurrentTurnB]);
    expect(aborts).toBe(0);
    expect(doc.active?.requestId).toBe('req-B');
    expect(doc.turns.map((t) => t.requestId)).toEqual(['req-A']);
    expect(entry.busy).toBe(true);
    expect(entry.submittedRequest).toBe('req-B');
  });

  test('recoverForRead treats model_not_configured as transient without mutating active on disk', async () => {
    const doc = {
      active: { requestId: 'req-no-model', turnId: 'turn-no-model', content: [{ type: 'text', text: 'hi' }], stopped: false },
      turns: [],
      stopRequests: [],
    };
    const entry = {
      canvasId: 'no-model-canvas',
      sessionId: 'durable:00000000-0000-4000-8000-000000000002',
      busy: true,
      waiters: 0,
      running: null,
      submittedRequest: null,
      submittingRequest: null,
      recovering: null,
      log: [],
      turn: newTurnAccumulator(),
      generation: {},
      root: { id: 'root-2', abort: async () => {} },
      harness: { commit: async () => null },
    };
    const lifecycle = createDurableTurnLifecycle({
      stateDoc: {},
      state: async () => doc,
      update: async (_entry, mutator) => { mutator(doc); },
      lock: (_id, fn) => Promise.resolve().then(fn),
      hydrate: () => {},
      authorization: async () => ({ open: true }),
      turnModel: async () => { throw Object.assign(new Error('model_not_configured'), { reason: 'model_not_configured' }); },
      submit: async () => null,
      officialSubmission: async () => null,
      stopBeforeSubmit: async () => null,
      undoUnsubmittedSkills: async () => {},
      flushPendingSkillRollback: async () => {},
      stopIntended: () => false,
      forgetStop: () => {},
      completeTurn: async () => {},
    });
    const res = await lifecycle.recoverForRead(entry);
    expect(res.submission).toBeNull();
    expect(res.unresumableReason).toBe('model_not_configured');
    expect(res.unresumableTurn?.errorReason).toBe('turn_interrupted');
    expect(doc.active?.requestId).toBe('req-no-model');
    expect(entry.busy).toBe(false);
  });

  test('in-flight recoverOnce re-checks active after authorization and never resurrects a settled turn', async () => {
    const doc = {
      active: { requestId: 'req-A', turnId: 'turn-A', stopped: false },
      turns: [],
      stopRequests: [],
    };
    let submitCalls = 0;
    let releaseAuthA;
    const authGate = new Promise((resolve) => { releaseAuthA = resolve; });
    const entry = {
      canvasId: 'recover-race-canvas',
      sessionId: 'durable:00000000-0000-4000-8000-000000000003',
      busy: true,
      waiters: 0,
      running: null,
      submittedRequest: null,
      submittingRequest: null,
      recovering: null,
      log: [],
      turn: newTurnAccumulator(),
      generation: {},
      root: { id: 'root-3', abort: async () => {} },
      harness: { commit: async () => null },
    };
    const lifecycle = createDurableTurnLifecycle({
      stateDoc: {},
      state: async () => doc,
      update: async (_entry, mutator) => { mutator(doc); },
      lock: (_id, fn) => Promise.resolve().then(fn),
      hydrate: () => {},
      authorization: async () => {
        await authGate;
        return { open: true };
      },
      turnModel: async () => ({ provider: 'beeftv', modelId: 'synthetic-model' }),
      submit: async () => { submitCalls += 1; return { id: 'sub' }; },
      officialSubmission: async () => null,
      stopBeforeSubmit: async () => null,
      undoUnsubmittedSkills: async () => {},
      flushPendingSkillRollback: async () => {},
      stopIntended: () => false,
      forgetStop: () => {},
      completeTurn: async () => {},
    });
    const recovering = lifecycle.recoverForRead(entry);
    // While recoverOnce is paused in authorization, req-A is settled and req-B becomes active in this process.
    doc.turns = [{ requestId: 'req-A', turnId: 'turn-A', errorReason: 'turn_interrupted' }];
    doc.active = { requestId: 'req-B', turnId: 'turn-B', stopped: false };
    entry.submittingRequest = 'req-B';
    releaseAuthA();
    const res = await recovering;
    expect(res).toEqual({ submission: null, unresumableReason: null, unresumableTurn: null });
    expect(submitCalls).toBe(0);
    expect(doc.active?.requestId).toBe('req-B');
  });

  test('settleTurnWithConfirmation preserves committed done answers without aborting and retries Go /complete twice on 502 before clearing active', async () => {
    const doc = {
      active: { requestId: 'req-done', turnId: 'turn-done', submissionId: 'sub-done', userText: 'Hi', stopped: false },
      turns: [],
      stopRequests: [],
    };
    const answerEntry = {
      id: 2,
      model: [{ role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'Committed answer text.' }] }],
    };
    let abortCalls = 0;
    let completeAttempts = 0;
    const entry = {
      canvasId: 'done-settle-canvas',
      sessionId: 'durable:00000000-0000-4000-8000-000000000004',
      busy: true,
      waiters: 0,
      running: null,
      submittedRequest: null,
      submittingRequest: null,
      recovering: null,
      log: [],
      turn: newTurnAccumulator(),
      generation: {},
      root: {
        id: 'root-4',
        abort: async () => { abortCalls += 1; },
        context: async () => ({ entries: [answerEntry], head: { head: 2 } }),
      },
      harness: {
        commit: async (fn) => fn({
          submissionByRequest: () => ({ id: 'sub-done', entry: 1 }),
          entry: (id) => (id === 2 ? answerEntry : null),
        }),
        submission: async () => ({
          status: async () => ({ status: 'done', entry: 1, answer: 2 }),
        }),
      },
    };
    const lifecycle = createDurableTurnLifecycle({
      stateDoc: {},
      state: async () => doc,
      update: async (_entry, mutator) => { mutator(doc); },
      lock: (_id, fn) => Promise.resolve().then(fn),
      hydrate: () => {},
      authorization: async () => ({ open: false }),
      turnModel: async () => ({ provider: 'beeftv', modelId: 'synthetic-model' }),
      submit: async () => null,
      officialSubmission: async () => null,
      stopBeforeSubmit: async () => null,
      undoUnsubmittedSkills: async () => {},
      flushPendingSkillRollback: async () => {},
      stopIntended: () => false,
      forgetStop: () => {},
      completeTurn: async () => {
        completeAttempts += 1;
        if (completeAttempts <= 2) throw new Error('go_complete_502');
      },
    });
    const firstAttempt = await lifecycle.settleTurnWithConfirmation(entry, 'req-done', { abortIfRunning: true });
    expect(firstAttempt.settled).toBe(false);
    expect(firstAttempt.busy).toBe(true);
    expect(abortCalls).toBe(0);
    expect(doc.active?.result?.reply).toBe('Committed answer text.');
    expect(doc.turns).toHaveLength(0);

    const secondAttempt = await lifecycle.settleTurnWithConfirmation(entry, 'req-done', { abortIfRunning: true });
    expect(secondAttempt.settled).toBe(false);
    expect(doc.active?.requestId).toBe('req-done');

    const thirdAttempt = await lifecycle.settleTurnWithConfirmation(entry, 'req-done', { abortIfRunning: true });
    expect(thirdAttempt.settled).toBe(true);
    expect(thirdAttempt.busy).toBe(false);
    expect(thirdAttempt.record?.status).toBe('done');
    expect(thirdAttempt.record?.reply).toBe('Committed answer text.');
    expect(thirdAttempt.record?.error).toBeNull();
    expect(abortCalls).toBe(0);
    expect(completeAttempts).toBe(3);
    expect(doc.active).toBeNull();
    expect(doc.turns).toHaveLength(1);
    expect(doc.turns[0].reply).toBe('Committed answer text.');
    entry.disposed = true;
  });

  test('wait() keeps entry busy when official submission is still running and clears busy once submission is not running', async () => {
    const doc = {
      active: { requestId: 'req-fail', turnId: 'turn-fail', stopped: false },
      turns: [],
      stopRequests: [],
    };
    let watchClosed = false;
    let currentSubStatus = 'running';
    const emittedTypes = [];
    const entry = {
      canvasId: 'wait-fail-canvas',
      sessionId: 'durable:00000000-0000-4000-8000-000000000005',
      busy: true,
      waiters: 0,
      running: null,
      submittedRequest: 'req-fail',
      submittingRequest: null,
      recovering: null,
      log: [],
      turn: newTurnAccumulator(),
      generation: {},
      root: {
        id: 'root-5',
        abort: async () => {},
        watch: async () => ({
          value: { entries: [], docs: {} },
          stop: () => { watchClosed = true; },
        }),
      },
      harness: {
        commit: async () => null,
        watchDoc: async () => { throw new Error('storage_io_error'); },
      },
    };
    const lifecycle = createDurableTurnLifecycle({
      stateDoc: {},
      state: async () => doc,
      update: async (_entry, mutator) => { mutator(doc); },
      lock: (_id, fn) => Promise.resolve().then(fn),
      hydrate: () => {},
      authorization: async () => ({ open: true }),
      turnModel: async () => ({ provider: 'beeftv', modelId: 'synthetic-model' }),
      submit: async () => null,
      officialSubmission: async () => null,
      stopBeforeSubmit: async () => null,
      undoUnsubmittedSkills: async () => {},
      flushPendingSkillRollback: async () => {},
      stopIntended: () => false,
      forgetStop: () => {},
      completeTurn: async () => {},
    });
    const failingSubmission = {
      status: async () => ({ status: currentSubStatus, entry: 1, requestId: 'req-fail' }),
    };
    // 1. Official submission still running: observer failure marks detachedRunning and keeps entry.busy=true!
    entry.running = lifecycle.wait(entry, failingSubmission, {
      onEvent: (event) => { emittedTypes.push(event.type); },
    }).finally(() => {
      entry.running = null;
    });
    await expect(entry.running).rejects.toThrow('storage_io_error');
    expect(emittedTypes).toContain('snapshot');
    expect(watchClosed).toBe(true);
    expect(entry.waiters).toBe(0);
    expect(entry.running).toBeNull();
    expect(entry.detachedRunning).toBe(true);
    expect(entry.busy).toBe(true);

    // 2. When the background submission later finishes on its own (without a second wait() call),
    // monitorDetachedSubmission reaps detachedRunning and settles entry.busy back to false!
    currentSubStatus = 'unanswered';
    const reapDeadline = Date.now() + 2000;
    while (entry.busy && Date.now() < reapDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
    expect(entry.detachedRunning).toBe(false);
    expect(entry.busy).toBe(false);
    expect(doc.active).toBeNull();
    expect(doc.turns.map((item) => item.requestId)).toEqual(['req-fail']);

    // 3. Observer failure when submission is already not running clears detachedRunning and busy immediately!
    doc.active = { requestId: 'req-fail-2', turnId: 'turn-fail-2', stopped: false };
    entry.busy = true;
    entry.submittedRequest = 'req-fail-2';
    entry.running = lifecycle.wait(entry, failingSubmission).finally(() => {
      entry.running = null;
    });
    await expect(entry.running).rejects.toThrow('storage_io_error');
    expect(entry.detachedRunning).toBe(false);
    expect(entry.busy).toBe(false);
  });

  test('detached reconciliation preserves busy on state/status errors and retries Go completeTurn before clearing active', async () => {
    const doc = {
      active: { requestId: 'req-detach', turnId: 'turn-detach', submissionId: 'sub-detach', userText: 'Hi', stopped: false },
      turns: [],
      stopRequests: [],
    };
    const answerEntry = {
      id: 2,
      model: [{ role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'Recovered detached answer.' }] }],
    };
    let failStateRead = true;
    let failStatusRead = false;
    let currentSubStatus = 'running';
    let failCompleteTurn = true;
    let abortCalls = 0;
    const completedPayloads = [];
    const submissionObj = {
      status: async () => {
        if (failStatusRead) throw new Error('transient_sqlite_busy');
        return currentSubStatus === 'done'
          ? { status: 'done', entry: 1, answer: 2, requestId: 'req-detach' }
          : { status: currentSubStatus, entry: 1, requestId: 'req-detach' };
      },
    };
    const entry = {
      canvasId: 'detach-safe-canvas',
      sessionId: 'durable:00000000-0000-4000-8000-000000000006',
      busy: true,
      detachedRunning: false,
      pendingCompleteRetry: false,
      waiters: 0,
      running: null,
      submittedRequest: 'req-detach',
      submittingRequest: null,
      recovering: null,
      log: [],
      turn: newTurnAccumulator(),
      generation: {},
      root: {
        id: 'root-6',
        abort: async () => { abortCalls += 1; },
        context: async () => ({ entries: [answerEntry], head: { head: 2 } }),
        watch: async () => ({
          value: { entries: [], docs: {} },
          stop: () => {},
        }),
      },
      harness: {
        commit: async (fn) => fn({
          submissionByRequest: () => ({ id: 'sub-detach', entry: 1 }),
          entry: (id) => (id === 2 ? answerEntry : null),
        }),
        submission: async () => submissionObj,
        watchDoc: async () => {
          failStatusRead = true;
          throw new Error('watch_dropped');
        },
      },
    };
    let failSettleUpdate = false;
    const lifecycle = createDurableTurnLifecycle({
      stateDoc: {},
      state: async () => {
        if (failStateRead) throw new Error('transient_state_error');
        return doc;
      },
      update: async (_entry, mutator) => {
        if (failSettleUpdate) throw new Error('sqlite_settle_error');
        mutator(doc);
      },
      lock: (_id, fn) => Promise.resolve().then(fn),
      hydrate: () => {},
      authorization: async () => ({ open: true }),
      turnModel: async () => ({ provider: 'beeftv', modelId: 'synthetic-model' }),
      submit: async () => null,
      officialSubmission: async () => submissionObj,
      stopBeforeSubmit: async () => null,
      undoUnsubmittedSkills: async () => {},
      flushPendingSkillRollback: async () => {},
      stopIntended: () => false,
      forgetStop: () => {},
      completeTurn: async (payload) => {
        if (failCompleteTurn) throw new Error('go_ops_temporary_502');
        completedPayloads.push(payload);
      },
    });

    // Trigger detached mode via observer failure while submission.status() also fails transiently in catch:
    // entry.submittedRequest ensures detachedRunning stays true and monitor starts!
    await expect(lifecycle.wait(entry, submissionObj)).rejects.toThrow('watch_dropped');
    expect(entry.detachedRunning).toBe(true);
    expect(entry.busy).toBe(true);

    // 1. Both state() and status() throwing must keep detachedRunning=true, busy=true, zero aborts, zero settlements!
    expect(await lifecycle.reconcileDetachedEntry(entry)).toBe(true);
    expect(entry.detachedRunning).toBe(true);
    expect(entry.busy).toBe(true);
    expect(abortCalls).toBe(0);
    expect(doc.active?.requestId).toBe('req-detach');

    failStateRead = false;
    expect(await lifecycle.reconcileDetachedEntry(entry)).toBe(true);
    expect(entry.detachedRunning).toBe(true);
    expect(entry.busy).toBe(true);
    expect(abortCalls).toBe(0);

    // Wait >250ms while status() throws so monitorDetachedSubmission also hits catch and does NOT settle!
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(entry.detachedRunning).toBe(true);
    expect(entry.busy).toBe(true);
    expect(doc.active?.requestId).toBe('req-detach');

    // 2. Submission finishes ('done'), but Go /complete fails transiently on first attempt:
    // doc.active.result is committed, pendingCompleteRetry=true, busy=true, doc.active NOT cleared yet!
    failStatusRead = false;
    currentSubStatus = 'done';
    expect(await lifecycle.reconcileDetachedEntry(entry)).toBe(true);
    expect(entry.detachedRunning).toBe(false);
    expect(entry.pendingCompleteRetry).toBe(true);
    expect(entry.busy).toBe(true);
    expect(doc.active?.result?.reply).toBe('Recovered detached answer.');
    expect(doc.turns).toHaveLength(0);
    expect(abortCalls).toBe(0);

    // 3. If settleLocal (second lock update) throws a storage error after Go /complete succeeds,
    // reconcileDetachedEntry still resolves cleanly to true (never unhandled-rejects!) and retries until settled!
    failCompleteTurn = false;
    failSettleUpdate = true;
    expect(await lifecycle.reconcileDetachedEntry(entry)).toBe(true);
    expect(entry.pendingCompleteRetry).toBe(true);
    expect(entry.busy).toBe(true);

    failSettleUpdate = false;
    expect(await lifecycle.reconcileDetachedEntry(entry)).toBe(false);
    expect(entry.pendingCompleteRetry).toBe(false);
    expect(entry.busy).toBe(false);
    expect(doc.active).toBeNull();
    expect(doc.turns).toHaveLength(1);
    expect(doc.turns[0].reply).toBe('Recovered detached answer.');
    expect(completedPayloads).toHaveLength(2);
    expect(completedPayloads[0].turnId).toBe('turn-detach');
    entry.disposed = true;
  });

  test('resolveCurrentSession is pure on read fallback and handles directory or missing pointers', async () => {
    const scratch = mkdtempSync(path.join(tmpdir(), 'beeftv-resolve-live-'));
    const store = createDurableSessionStore({
      sessionRoot: path.join(scratch, 'sessions'),
      workspaceRoot: path.join(scratch, 'workspace'),
      getModels: () => createModels(),
      getModelRef: () => ({ provider: 'beeftv', modelId: 'synthetic-model' }),
      buildTools: () => [],
      authorizeTurn: async () => ({ open: true, canvasId: 'live-canvas', permissionMode: 'canvas' }),
    });
    try {
      const first = await store.createSession('live-canvas');
      const second = await store.createSession('live-canvas');
      expect(second.sessionId).not.toBe(first.sessionId);
      const pointerPath = path.join(scratch, 'sessions', canvasKey('live-canvas'), 'current.json');

      // 1. Stale pointer pointing to first while second is busy in memory -> live busy wins without 409 session_busy!
      second.busy = true;
      mkdirSync(path.dirname(pointerPath), { recursive: true });
      writeFileSync(pointerPath, JSON.stringify({ sessionId: first.sessionId }));
      const busyActive = await store.resolveCurrentSession('live-canvas');
      expect(busyActive.sessionId).toBe(second.sessionId);
      expect(busyActive.entry).toBe(second);
      const busyPreloaded = await store.resolveCurrentSession('live-canvas', {
        persist: false,
        activateDurable: false,
        preloadedList: [
          { sessionId: first.sessionId, updatedAt: '2026-01-02T00:00:00.000Z' },
          { sessionId: second.sessionId, updatedAt: '2026-01-01T00:00:00.000Z' },
        ],
      });
      expect(busyPreloaded.sessionId).toBe(second.sessionId);

      // 2. Missing pointer (ENOENT) while second is idle live owner -> keeps second instead of switching away!
      second.busy = false;
      rmSync(pointerPath, { force: true });
      expect(store.readSafeCurrentPointer('live-canvas')).toBe(second.sessionId);
      const missingPtrResolved = await store.resolveCurrentSession('live-canvas');
      expect(missingPtrResolved.sessionId).toBe(second.sessionId);
      expect(missingPtrResolved.entry).toBe(second);

      // 3. Cold-start (no live owner): corrupt pointer or directory pointer falls back purely without mutating current.json!
      await store.releaseIdleSession('live-canvas');
      rmSync(pointerPath, { force: true });
      mkdirSync(pointerPath, { recursive: true });
      expect(store.readSafeCurrentPointer('live-canvas')).toBe('');
      const pureFallback = await store.resolveCurrentSession('live-canvas', { persist: false, activateDurable: false });
      expect(pureFallback.entry).toBeNull();
      expect([first.sessionId, second.sessionId]).toContain(pureFallback.sessionId);
      expect(store.sessions.has('live-canvas')).toBe(false);

      // 4. Explicit legacy sessionId without handoffLegacy throws session_not_found instead of creating durable session.
      await expect(store.ensureSession('live-canvas', 'legacy-readonly-id')).rejects.toMatchObject({ reason: 'session_not_found' });
    } finally {
      await store.disposeAll();
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  test('submit deduplicates an already-finished requestId without settling a paused active turn, and refreshCanvasBusy settles finished detached turns', async () => {
    const scratch = mkdtempSync(path.join(tmpdir(), 'beeftv-submit-dedup-'));
    const completedTurns = [];
    const runtime = await ModelRuntime.create({
      authPath: path.join(scratch, 'auth.json'),
      modelsPath: null,
      refreshOnCreate: false,
    });
    runtime.registerProvider('beeftv', {
      api: 'openai-completions',
      apiKey: 'synthetic',
      baseUrl: 'http://127.0.0.1:1/v1',
      models: [{
        id: 'synthetic-model',
        name: 'synthetic-model',
        reasoning: false,
        input: ['text'],
        contextWindow: 200000,
        maxTokens: 100,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      }],
    });
    const registeredModels = createModels();
    registeredModels.setProvider(runtime.getProvider('beeftv'));
    const store = createDurableSessionStore({
      sessionRoot: path.join(scratch, 'sessions'),
      workspaceRoot: path.join(scratch, 'workspace'),
      getModels: () => registeredModels,
      getModelRef: () => ({ provider: 'beeftv', modelId: 'synthetic-model' }),
      buildTools: () => [],
      authorizeTurn: async ({ turnId, canvasId }) => ({ open: true, turnId, canvasId, permissionMode: 'canvas' }),
      completeTurn: async ({ turnId }) => { completedTurns.push(turnId); },
      settings: { retry: { maxRetries: 0 } },
    });
    try {
      const entry = await store.createSession('dedup-canvas');
      // Stop req-finished-1 before submit so it records a finished turn in doc.turns with zero model calls!
      await store.cancelRequest('dedup-canvas', entry.sessionId, 'req-finished-1');
      const stoppedSub = await store.submit(entry, {
        requestId: 'req-finished-1',
        turnId: 'turn-finished-1',
        content: [{ type: 'text', text: 'first' }],
        userText: 'first',
      });
      expect(stoppedSub).toBeNull();

      let allowModel = true;
      await store.disposeAll();
      const store2 = createDurableSessionStore({
        sessionRoot: path.join(scratch, 'sessions'),
        workspaceRoot: path.join(scratch, 'workspace'),
        getModels: () => (allowModel ? registeredModels : createModels()),
        getModelRef: () => ({ provider: 'beeftv', modelId: 'synthetic-model' }),
        buildTools: () => [],
        authorizeTurn: async ({ turnId, canvasId }) => ({ open: true, turnId, canvasId, permissionMode: 'canvas' }),
        completeTurn: async ({ turnId }) => { completedTurns.push(turnId); },
        settings: { retry: { maxRetries: 0 } },
      });
      try {
        const reopened = await store2.activateSession('dedup-canvas', entry.sessionId);
        // Submit req-paused-2 (loopback port 1 settles unanswered quickly with maxRetries: 0,
        // while doc.active holds req-paused-2 until wait/settle runs!).
        const pausedSub = await store2.submit(reopened, {
          requestId: 'req-paused-2',
          turnId: 'turn-paused-2',
          content: [{ type: 'text', text: 'paused' }],
          userText: 'paused',
        });
        expect(pausedSub).toBeTruthy();
        // Reset local live flags as after a cold restart with paused turn on disk (pinned model now unavailable).
        allowModel = false;
        reopened.submittingRequest = null;
        reopened.submittedRequest = null;
        reopened.busy = false;
        const pausedRead = await store2.recoverForRead(reopened);
        expect(pausedRead.unresumableReason).toBe('model_unavailable_for_resume');

        // Now resend already-finished req-finished-1 with new Go turnId 'turn-dup-1':
        // must return null (finished stopped record), complete ONLY 'turn-dup-1', and keep req-paused-2 active on disk!
        const dupSub = await store2.submit(reopened, {
          requestId: 'req-finished-1',
          turnId: 'turn-dup-1',
          content: [{ type: 'text', text: 'first' }],
          userText: 'first',
        });
        expect(dupSub).toBeNull();
        expect(completedTurns).toContain('turn-dup-1');
        expect(completedTurns).not.toContain('turn-paused-2');
        const histAfterDup = await store2.history('dedup-canvas', reopened.sessionId);
        expect(histAfterDup.active?.requestId).toBe('req-paused-2');

        // Verify steer/beginPendingInput and busyState reject detachedRunning / pendingCompleteRetry cleanly (no orphan run)!
        reopened.busy = true;
        reopened.pendingCompleteRetry = true;
        expect(() => store2.beginPendingInput(reopened)).toThrow('session_not_running');
        await expect(store2.supplement(reopened, {
          requestId: 'steer-orphan-1',
          content: [{ type: 'text', text: 'steer' }],
        })).rejects.toMatchObject({ reason: 'session_not_running' });
        reopened.pendingCompleteRetry = false;

        // Also verify busyState / refreshCanvasBusy clears detachedRunning once the official submission is no longer running,
        // unblocking createSession without 409 session_busy!
        const statusDeadline = Date.now() + 5000;
        while (!['done', 'unanswered'].includes((await pausedSub.status()).status) && Date.now() < statusDeadline) {
          await new Promise((resolve) => setTimeout(resolve, 40));
        }
        reopened.busy = true;
        reopened.detachedRunning = true;
        await expect(store2.supplement(reopened, {
          requestId: 'steer-finished-detached-1',
          content: [{ type: 'text', text: 'steer' }],
        })).rejects.toMatchObject({ reason: 'session_not_running' });
        const reconciledState = await store2.busyState('dedup-canvas');
        expect(reconciledState.busy).toBe(false);
        expect(reconciledState.runningForSteer).toBe(false);
        expect(reconciledState.stoppable).toBe(false);
        expect(reopened.detachedRunning).toBe(false);
        expect(reopened.busy).toBe(false);
        const createdAfterDetached = await store2.createSession('dedup-canvas');
        expect(createdAfterDetached.sessionId).not.toBe(reopened.sessionId);

        // Verify concurrent withSession calls share ONE refcounted readOnly:true lease (openCount +1)
        // and the slower caller still succeeds after the faster caller exits!
        const openBeforeBorrow = store2.getOpenCount();
        const [fastBorrow, slowBorrow] = await Promise.all([
          store2.withSession('dedup-canvas', reopened.sessionId, async (borrowedEntry, isMounted) => {
            expect(isMounted).toBe(false);
            expect(borrowedEntry.readOnlyHandle).toBe(true);
            return store2.historyOf(borrowedEntry);
          }),
          store2.withSession('dedup-canvas', reopened.sessionId, async (borrowedEntry, isMounted) => {
            expect(isMounted).toBe(false);
            await new Promise((resolve) => setTimeout(resolve, 60));
            const directHist = await store2.historyOf(borrowedEntry);
            const roInspect = await store2.inspectReadOnlyEntry(borrowedEntry);
            return { directHist, roInspect };
          }),
        ]);
        expect(store2.getOpenCount() - openBeforeBorrow).toBe(1);
        expect(fastBorrow.turns.length).toBeGreaterThanOrEqual(2);
        expect(slowBorrow.directHist.turns.length).toBe(fastBorrow.turns.length);
        expect(slowBorrow.roInspect.unresumableReason).toBeNull();

        // Also verify a non-current session with active turn + toolCalls/proposals + non-canvas permissionMode
        // can be read via readOnly withSession without triggering ReadOnlySession writes, while preserving toolCalls/proposals!
        let activePermissionMode = 'full-access';
        const storePerm = createDurableSessionStore({
          sessionRoot: path.join(scratch, 'sessions'),
          workspaceRoot: path.join(scratch, 'workspace'),
          getModels: () => (allowModel ? registeredModels : createModels()),
          getModelRef: () => ({ provider: 'beeftv', modelId: 'synthetic-model' }),
          buildTools: () => [{
            name: 'synthetic_tool',
            description: 'Synthetic tool',
            parameters: { type: 'object', properties: {}, additionalProperties: false },
            execute: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
          }],
          authorizeTurn: async ({ turnId, canvasId }) => ({ open: true, turnId, canvasId, permissionMode: activePermissionMode }),
          completeTurn: async ({ turnId }) => { completedTurns.push(turnId); },
          settings: { retry: { maxRetries: 0 } },
        });
        try {
          allowModel = true;
          const richSession = await storePerm.createSession('perm-canvas');
          const richSub = await storePerm.submit(richSession, {
            requestId: 'req-rich-1',
            turnId: 'turn-rich-1',
            content: [{ type: 'text', text: 'rich' }],
            userText: 'rich',
          });
          while (!['done', 'unanswered'].includes((await richSub.status()).status)) {
            await new Promise((resolve) => setTimeout(resolve, 30));
          }
          // Seed persisted log + proposals on active before switching to another current session!
          await richSession.harness.commit(async (tx) => {
            const stateDoc = [...await richSession.harness.inspect()].length;
            void stateDoc;
            void tx;
          }).catch(() => {});
          richSession.log.push({ id: 'call-1', name: 'synthetic_tool', status: 'done' });
          richSession.turn.proposals.push({ id: 'prop-1', title: 'Shot 1' });
          await richSession.generation.persistEffects();
          richSession.submittingRequest = null;
          richSession.submittedRequest = null;
          richSession.busy = false;
          await storePerm.createSession('perm-canvas');
          allowModel = false;
          const roRich = await storePerm.withSession('perm-canvas', richSession.sessionId, async (borrowedEntry) => {
            const inspection = await storePerm.inspectReadOnlyEntry(borrowedEntry);
            return inspection;
          });
          expect(roRich.unresumableReason).toBe('model_unavailable_for_resume');
          expect(roRich.unresumableTurn?.toolCalls).toEqual([{ id: 'call-1', name: 'synthetic_tool', status: 'done' }]);
          expect(roRich.unresumableTurn?.proposals).toEqual([{ id: 'prop-1', title: 'Shot 1' }]);
          activePermissionMode = 'full-access';
        } finally {
          await storePerm.disposeAll();
        }
      } finally {
        await store2.disposeAll();
      }
    } finally {
      await store.disposeAll();
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  test('recoverForRead handles committed active.result during /complete 502 without throwing and rolls back/prunes unadmitted supplements end-to-end with observer', async () => {
    // Part A: active.result committed on disk while Go /complete returns 502 twice -> recoverForRead returns unresumableTurn (zero throw) and settles into 1 turn on 3rd attempt
    let completeCalls = 0;
    const doc = {
      active: {
        requestId: 'req-committed-res',
        turnId: 'turn-committed-res',
        userText: 'Hello',
        stopped: false,
        result: {
          requestId: 'req-committed-res',
          turnId: 'turn-committed-res',
          userText: 'Hello',
          reply: 'Already committed reply.',
          cancelled: false,
          error: null,
          errorReason: null,
          toolCalls: [],
          change: null,
          proposals: [],
          scriptProposals: [],
          status: 'done',
        },
      },
      turns: [],
      stopRequests: [],
    };
    const entry = {
      canvasId: 'committed-res-canvas',
      sessionId: 'durable:00000000-0000-4000-8000-000000000009',
      busy: true,
      waiters: 0,
      running: null,
      submittedRequest: null,
      submittingRequest: null,
      recovering: null,
      log: [],
      turn: newTurnAccumulator(),
      generation: {},
      root: { id: 'root-9', abort: async () => {} },
      harness: { commit: async () => null, submission: async () => null },
    };
    const lifecycle = createDurableTurnLifecycle({
      stateDoc: {},
      state: async () => doc,
      update: async (_entry, mutator) => { mutator(doc); },
      lock: (_id, fn) => Promise.resolve().then(fn),
      hydrate: () => {},
      authorization: async () => ({ open: true }),
      turnModel: async () => ({ provider: 'beeftv', modelId: 'synthetic-model' }),
      submit: async () => null,
      officialSubmission: async () => null,
      stopBeforeSubmit: async () => null,
      undoUnsubmittedSkills: async () => {},
      flushPendingSkillRollback: async () => {},
      stopIntended: () => false,
      forgetStop: () => {},
      completeTurn: async () => {
        completeCalls += 1;
        if (completeCalls <= 2) throw new Error('transient_502');
      },
    });
    const r1 = await lifecycle.recoverForRead(entry);
    expect(r1.unresumableReason).toBeNull();
    expect(r1.unresumableTurn?.reply).toBe('Already committed reply.');
    expect(doc.active?.result?.reply).toBe('Already committed reply.');
    expect(doc.turns).toHaveLength(0);

    const r2 = await lifecycle.recoverForRead(entry);
    expect(r2.unresumableTurn?.reply).toBe('Already committed reply.');
    expect(doc.turns).toHaveLength(0);

    const r3 = await lifecycle.recoverForRead(entry);
    expect(r3.unresumableTurn).toBeNull();
    expect(doc.active).toBeNull();
    expect(doc.turns).toHaveLength(1);
    expect(doc.turns[0].reply).toBe('Already committed reply.');
    entry.disposed = true;

    // Part B: Crash window with full supplementIds + supplementInputs + supplementContents + loadedSkills + intentEpoch on an already-settled turn ->
    // recoverForRead prunes the unadmitted supplementId, loadedSkills, and intentEpoch AND lifecycle.wait(observer) settles cleanly without supplement_submission_missing!
    const suppSkillPin = {
      skillId: 'supp-skill-1',
      versionId: 'v1',
      contentHash: 'a'.repeat(64),
    };
    const baseSkillPin = {
      skillId: 'base-skill-1',
      versionId: 'v1',
      contentHash: 'b'.repeat(64),
    };
    const answerEntry = {
      id: 2,
      model: [{ role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'Completed main answer.' }] }],
    };
    const settledOrigSub = {
      id: 'sub-settled-orig',
      status: async () => ({ status: 'done', entry: 1, answer: 2, requestId: 'req-supp-idle' }),
      wait: async () => ({ status: 'done', entry: 1, answer: 2, requestId: 'req-supp-idle' }),
    };
    const idleDoc = {
      active: {
        requestId: 'req-supp-idle',
        turnId: 'turn-supp-idle',
        submissionId: 'sub-settled-orig',
        userText: 'Original',
        stopped: false,
        skills: [baseSkillPin],
        intentEpoch: 1,
        supplementIds: ['supp-1'],
        supplements: ['Extra instruction'],
        supplementInputs: [{ requestId: 'supp-1', message: 'Extra instruction', attachments: [], skills: [suppSkillPin] }],
        supplementContents: [{ requestId: 'supp-1', content: 'Extra instruction' }],
      },
      loadedSkills: [
        { ...baseSkillPin, name: 'Base Skill', version: '1.0', source: 'selected', turnId: 'turn-supp-idle' },
        { ...suppSkillPin, name: 'Supp Skill', version: '1.0', source: 'selected', turnId: 'turn-supp-idle', supplementRequestId: 'supp-1' },
      ],
      turns: [],
      stopRequests: [],
    };
    const idleEntry = {
      canvasId: 'supp-idle-canvas',
      sessionId: 'durable:00000000-0000-4000-8000-000000000010',
      busy: true,
      waiters: 0,
      running: null,
      submittedRequest: null,
      submittingRequest: null,
      recovering: null,
      log: [],
      turn: newTurnAccumulator(),
      generation: {},
      root: {
        id: 'root-10',
        abort: async () => {},
        context: async () => ({ entries: [answerEntry], head: { head: 2 } }),
        watch: async () => ({
          value: { entries: [answerEntry], docs: {} },
          start: () => {},
          stop: () => {},
        }),
        submit: async () => {
          const err = new Error('Conversation 1 is idle');
          err.name = 'ConversationIdle';
          throw err;
        },
      },
      harness: {
        commit: async (fn) => fn({
          submissionByRequest: () => undefined,
          entry: (id) => (id === 2 ? answerEntry : null),
        }),
        submission: async () => settledOrigSub,
        watchDoc: async () => ({
          value: undefined,
          start: () => {},
          stop: () => {},
        }),
      },
    };
    const idleLifecycle = createDurableTurnLifecycle({
      stateDoc: {},
      state: async () => idleDoc,
      update: async (_entry, mutator) => { mutator(idleDoc); },
      lock: (_id, fn) => Promise.resolve().then(fn),
      hydrate: () => {},
      authorization: async () => ({ open: true }),
      turnModel: async () => ({ provider: 'beeftv', modelId: 'synthetic-model' }),
      submit: async () => null,
      officialSubmission: async () => settledOrigSub,
      stopBeforeSubmit: async () => null,
      undoUnsubmittedSkills: async () => {},
      flushPendingSkillRollback: async () => {},
      stopIntended: () => false,
      forgetStop: () => {},
      completeTurn: async () => {},
    });
    const idleRecovered = await idleLifecycle.recoverForRead(idleEntry);
    expect(idleRecovered.submission).toBe(settledOrigSub);
    expect(idleDoc.active?.supplementIds).toEqual([]);
    expect(idleDoc.active?.intentEpoch).toBe(0);
    expect(idleDoc.loadedSkills.map((s) => s.skillId)).toEqual(['base-skill-1']);
    const observedRecord = await idleLifecycle.wait(idleEntry, idleRecovered.submission);
    expect(observedRecord?.status).toBe('done');
    expect(observedRecord?.reply).toBe('Completed main answer.');
    expect(observedRecord?.error).toBeNull();
    expect(idleDoc.active).toBeNull();
    expect(idleDoc.turns).toHaveLength(1);
    idleEntry.disposed = true;

    // Part B2: inspectReadOnlyEntry on a rootless entry where turnModel throws turn_not_open returns projected unresumableTurn without throwing!
    const rootlessDoc = {
      active: {
        requestId: 'req-rootless',
        turnId: 'turn-rootless',
        userText: 'Rootless prompt',
        stopped: false,
      },
      turns: [],
      stopRequests: [],
    };
    const rootlessEntry = {
      canvasId: 'rootless-ro-canvas',
      sessionId: 'durable:00000000-0000-4000-8000-000000000011',
      readOnlyHandle: true,
      busy: false,
      waiters: 0,
      running: null,
      submittedRequest: null,
      submittingRequest: null,
      recovering: null,
      log: [],
      turn: newTurnAccumulator(),
      generation: {},
      root: null,
      harness: { commit: async () => null, submission: async () => null },
    };
    const rootlessLifecycle = createDurableTurnLifecycle({
      stateDoc: {},
      state: async () => rootlessDoc,
      update: async () => { throw new Error('read-only entry must never mutate state'); },
      lock: (_id, fn) => Promise.resolve().then(fn),
      hydrate: () => {},
      authorization: async () => ({ open: true }),
      turnModel: async () => { throw Object.assign(new Error('turn_not_open'), { reason: 'turn_not_open' }); },
      submit: async () => null,
      officialSubmission: async () => null,
      stopBeforeSubmit: async () => null,
      undoUnsubmittedSkills: async () => {},
      flushPendingSkillRollback: async () => {},
      stopIntended: () => false,
      forgetStop: () => {},
      completeTurn: async () => {},
    });
    const rootlessInspected = await rootlessLifecycle.inspectReadOnlyEntry(rootlessEntry);
    expect(rootlessInspected.submission).toBeNull();
    expect(rootlessInspected.unresumableReason).toBeNull();
    expect(rootlessInspected.unresumableTurn?.turnId).toBe('turn-rootless');
    expect(rootlessInspected.unresumableTurn?.errorReason).toBe('turn_interrupted');

    // Part C: Live supplement() hitting ConversationIdle rolls back supplementIds/supplements AND pending.cancel() avoids pendingInputError!
    const scratchLive = mkdtempSync(path.join(tmpdir(), 'beeftv-steer-idle-rollback-'));
    const liveRuntime = await ModelRuntime.create({
      authPath: path.join(scratchLive, 'auth.json'),
      modelsPath: null,
      refreshOnCreate: false,
    });
    liveRuntime.registerProvider('beeftv', {
      api: 'openai-completions',
      apiKey: 'synthetic',
      baseUrl: 'http://127.0.0.1:1/v1',
      models: [{
        id: 'synthetic-model',
        name: 'synthetic-model',
        reasoning: false,
        input: ['text'],
        contextWindow: 200000,
        maxTokens: 100,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      }],
    });
    const liveModels = createModels();
    liveModels.setProvider(liveRuntime.getProvider('beeftv'));
    const liveStore = createDurableSessionStore({
      sessionRoot: path.join(scratchLive, 'sessions'),
      workspaceRoot: path.join(scratchLive, 'workspace'),
      getModels: () => liveModels,
      getModelRef: () => ({ provider: 'beeftv', modelId: 'synthetic-model' }),
      buildTools: () => [],
      authorizeTurn: async ({ turnId, canvasId }) => ({ open: true, turnId, canvasId, permissionMode: 'canvas' }),
      completeTurn: async () => {},
      settings: { retry: { maxRetries: 0 } },
    });
    try {
      const liveEntry = await liveStore.createSession('steer-race-canvas');
      const liveSub = await liveStore.submit(liveEntry, {
        requestId: 'req-steer-race',
        turnId: 'turn-steer-race',
        content: [{ type: 'text', text: 'race' }],
        userText: 'race',
      });
      // Wait for official run to become idle on port 1 while doc.active hasn't been settled by wait() yet!
      while (!['done', 'unanswered'].includes((await liveSub.status()).status)) {
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
      const pending = liveStore.beginPendingInput(liveEntry);
      await expect(liveStore.supplement(liveEntry, {
        requestId: 'late-steer-id',
        content: [{ type: 'text', text: 'too late' }],
        input: { message: 'too late', attachments: [], skills: [] },
      })).rejects.toMatchObject({ reason: 'session_not_running' });
      pending.cancel();
      expect(liveEntry.generation.pendingInputError).toBeNull();
      const settledRace = await liveStore.wait(liveEntry, liveSub);
      expect(settledRace?.supplements).toEqual([]);
      expect(settledRace?.errorReason).not.toBe('session_not_running');
    } finally {
      await liveStore.disposeAll();
      rmSync(scratchLive, { recursive: true, force: true });
    }
  });
});
