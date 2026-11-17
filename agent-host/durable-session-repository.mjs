// Durable 会话存储库：负责清单校验、SQLite Harness 打开/只读借用、指针写入、历史与列表读取、会话删除与事件追加。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { Harness, ProviderDoc, createRegistry } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { canvasKey } from './session-owner.mjs';
import { newTurnAccumulator, sessionTitle } from './canvas-turn.mjs';
import { SYSTEM_PROMPT } from './system-prompt.mjs';
import { publicPlan } from './plan.mjs';
import { publicDurableTurn } from './durable-turn-projection.mjs';
import { isCorruptSessionArtifactError, isSkippableSessionError } from './durable-pointer-resolver.mjs';
import { installDurableExtensions } from './durable-extensions.mjs';

const CTX = BACKGROUND_CONTEXT;
const idPattern = /^durable:([a-f0-9-]{36})$/;

export function createDurableSessionRepository({
  durableVersion,
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
}) {
  const directory = (canvasId) => path.join(sessionRoot, canvasKey(canvasId));
  const durableDirectory = (canvasId) => path.join(directory(canvasId), 'durable');
  const currentPath = (canvasId) => path.join(directory(canvasId), 'current.json');
  const borrowed = new Map();
  let openCount = 0;

  function publish(entry) {
    const temporary = `${currentPath(entry.canvasId)}.${crypto.randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify({ sessionId: entry.sessionId, kind: 'durable', version: durableVersion }), { mode: 0o600 });
      fs.renameSync(temporary, currentPath(entry.canvasId));
    } catch (cause) {
      try { fs.rmSync(temporary, { force: true }); } catch (cleanup) { cause = new AggregateError([cause, cleanup], 'session_pointer_cleanup_failed'); }
      throw Object.assign(fail('session_pointer_failed'), { cause });
    }
  }

  async function install(entry, { publishPointer = true } = {}) {
    if (publishPointer) {
      try { publish(entry); }
      catch (error) {
        entry.disposed = true;
        try { await entry.harness.close(CTX); }
        catch (cleanup) { error.cause = new AggregateError([error.cause, cleanup], 'session_candidate_cleanup_failed'); }
        throw error;
      }
    }
    const previous = sessions.get(entry.canvasId);
    sessions.set(entry.canvasId, entry);
    if (previous && previous !== entry) {
      previous.disposed = true;
      await previous.harness.close(CTX);
    }
    return entry;
  }

  async function open(canvasId, sessionId, { readOnly = false } = {}) {
    if (!isDurableSessionId(sessionId)) throw fail('session_not_found');
    const uuid = idPattern.exec(sessionId)[1];
    const dir = durableDirectory(canvasId);
    const manifestPath = path.join(dir, `${uuid}.json`);
    let rawManifest;
    try {
      rawManifest = fs.readFileSync(manifestPath, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') throw fail('session_not_found');
      if (error?.code === 'EISDIR') throw fail('corrupt_session_manifest');
      throw error;
    }
    let manifest;
    try {
      manifest = JSON.parse(rawManifest);
    } catch (error) {
      throw Object.assign(fail('corrupt_session_manifest'), { cause: error });
    }
    if (!manifest || typeof manifest !== 'object') throw fail('corrupt_session_manifest');
    if (manifest.canvasId !== canvasId || manifest.sessionId !== sessionId || manifest.version !== durableVersion) throw fail('durable_version_mismatch');
    const cwd = path.join(workspaceRoot, canvasKey(canvasId));
    if (!readOnly) fs.mkdirSync(cwd, { recursive: true });
    const entry = {
      kind: 'durable',
      canvasId,
      sessionId,
      readOnlyHandle: readOnly,
      identity: { prefix: sessionId, source: 'durable-session-id' },
      log: [],
      generation: { durable: true, aborted: false, intentEpoch: 0, modelEpoch: 0 },
      turn: newTurnAccumulator(),
      busy: false,
      persistence: 'restored',
      budgetDirectory: path.join(dir, `${uuid}.budget`),
      skillCatalog: {},
      waiters: 0,
      recovering: null,
      submittedRequest: null,
      submittingRequest: null,
    };
    if (!readOnly) fs.mkdirSync(entry.budgetDirectory, { recursive: true, mode: 0o700 });
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
    openCount += 1;
    try {
      entry.harness = await Harness.open(await openNodeSqliteStorage(path.join(dir, `${uuid}.sqlite`)), {
        models,
        registry,
        readOnly,
        // Do not repeat a failed model request: the upstream may already have billed it.
        // pi 1.5 counts a request cut off by a host restart as a failed attempt too, so that
        // turn ends interrupted instead of resending; landed changes stay.
        settings: {
          stream: { timeoutMs: 180000, maxRetries: 0 },
          retry: { maxRetries: 0 },
          afterFailedRun: 'continue',
          toolExecution: 'sequential',
          steeringMode: 'all',
          ...settings,
        },
      }, CTX);
    } catch (error) {
      if (isCorruptSessionArtifactError(error)) {
        throw Object.assign(fail('corrupt_session_manifest'), { cause: error });
      }
      throw error;
    }
    try {
      if (readOnly) {
        entry.root = await entry.harness.conversation(1, CTX);
        const hostState = await state(entry);
        if (hostState && hostState.canvasId && (hostState.canvasId !== canvasId || hostState.sessionId !== sessionId || hostState.version !== durableVersion)) {
          throw fail('durable_version_mismatch');
        }
        if (hostState?.active) {
          hydrate(entry, hostState.active);
          entry.busy = false;
          entry.log.push(...(hostState.active.log || []));
        }
        return entry;
      }
      const configuredModel = await getModelRef(entry);
      const initialModel = configuredModel?.provider && configuredModel?.modelId
        ? configuredModel
        : { provider: configuredModel?.provider || 'beeftv', modelId: 'unconfigured' };
      entry.root = await entry.harness.root(CTX, {
        agent: { model: initialModel, tools, instructions: SYSTEM_PROMPT, thinkingLevel, cwd },
        // 固定官方 provider 身份为 Durable 会话 ID，使缓存亲和性跨重启保持稳定。
        init: async (tx, id) => { (await tx.doc(ProviderDoc, id)).sessionId = sessionId; },
      });
      let hostState = await state(entry);
      if (!hostState) {
        await update(entry, (doc) => { doc.canvasId = canvasId; doc.sessionId = sessionId; doc.affinityMinEntryId = 1; });
        hostState = await state(entry);
      } else if (typeof hostState.affinityMinEntryId !== 'number') {
        const latest = await entry.root.entries({ order: 'descending' }, 1, undefined, CTX);
        const affinityMinEntryId = (latest.items[0]?.id ?? 0) + 1;
        await update(entry, (doc) => { doc.affinityMinEntryId = affinityMinEntryId; });
        hostState = await state(entry);
      }
      if (hostState.canvasId !== canvasId || hostState.sessionId !== sessionId || hostState.version !== durableVersion) throw fail('durable_version_mismatch');
      hydrate(entry, hostState.active);
      entry.log.push(...(hostState.active?.log || []));
      return entry;
    } catch (error) {
      entry.disposed = true;
      await entry.harness.close(CTX);
      throw error;
    }
  }

  async function withSession(canvasId, sessionId, fn, { readOnly = true } = {}) {
    const cached = sessions.get(canvasId);
    if (cached?.sessionId === sessionId) return fn(cached, true);
    if (!readOnly) {
      const entry = await open(canvasId, sessionId, { readOnly: false });
      try {
        return await fn(entry, false);
      } finally {
        entry.disposed = true;
        await entry.harness.close(CTX);
      }
    }
    const borrowKey = `${canvasId}\0${sessionId}`;
    let lease = borrowed.get(borrowKey);
    if (!lease) {
      lease = {
        refs: 0,
        entryPromise: open(canvasId, sessionId, { readOnly: true }),
      };
      borrowed.set(borrowKey, lease);
    }
    lease.refs += 1;
    let entry;
    try {
      entry = await lease.entryPromise;
    } catch (error) {
      lease.refs -= 1;
      if (lease.refs <= 0 && borrowed.get(borrowKey) === lease) borrowed.delete(borrowKey);
      throw error;
    }
    try {
      return await fn(entry, false);
    } finally {
      lease.refs -= 1;
      if (lease.refs <= 0) {
        if (borrowed.get(borrowKey) === lease) borrowed.delete(borrowKey);
        entry.disposed = true;
        await entry.harness.close(CTX);
      }
    }
  }

  function handoffSessionId(canvasId, handoffSourceId) {
    const digest = crypto.createHash('sha256').update(JSON.stringify([canvasId, handoffSourceId])).digest('hex');
    return `durable:${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`;
  }

  function hasSession(canvasId, sessionId) {
    if (!isDurableSessionId(sessionId)) return false;
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(durableDirectory(canvasId), `${idPattern.exec(sessionId)[1]}.json`), 'utf8'));
      return manifest.canvasId === canvasId && manifest.sessionId === sessionId && manifest.version === durableVersion;
    } catch { return false; }
  }

  async function prepareSession(canvasId, handoffSourceId = '') {
    const sessionId = handoffSourceId ? handoffSessionId(canvasId, handoffSourceId) : `durable:${crypto.randomUUID()}`;
    fs.mkdirSync(durableDirectory(canvasId), { recursive: true, mode: 0o700 });
    const file = path.join(durableDirectory(canvasId), `${idPattern.exec(sessionId)[1]}.json`);
    const created = !handoffSourceId || !fs.existsSync(file);
    if (created) {
      const temporary = `${file}.${crypto.randomUUID()}.tmp`;
      try {
        fs.writeFileSync(temporary, JSON.stringify({ sessionId, canvasId, handoffSourceId, version: durableVersion, createdAt: new Date().toISOString() }), { flag: 'wx', mode: 0o600 });
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

  async function historyOf(entry) {
    const value = await state(entry);
    if (!value) return { sessionId: entry.sessionId, turns: [], active: null };
    const plan = publicPlan(value.plan);
    return {
      sessionId: entry.sessionId,
      turns: (value.turns || []).map((turn) => publicDurableTurn(turn)),
      active: publicDurableTurn(value.active, true),
      ...(plan ? { plan } : {}),
    };
  }

  async function history(canvasId, sessionId) {
    return withSession(canvasId, sessionId, (entry) => historyOf(entry), { readOnly: true });
  }

  async function status(entry) {
    const value = await state(entry);
    const inspection = await entry.harness.inspect(CTX);
    return {
      sessionId: entry.sessionId,
      kind: 'durable',
      active: publicDurableTurn(value.active, true),
      plan: publicPlan(value.plan),
      inspection: {
        scheduling: inspection.scheduling,
        tasks: inspection.tasks.map((task) => ({ id: task.record.id, state: task.state.kind })),
        submissions: inspection.submissions.map((submission) => ({ id: submission.id, status: submission.status })),
      },
    };
  }

  async function listCanvasSessions(canvasId) {
    const dir = durableDirectory(canvasId);
    if (!fs.existsSync(dir)) return [];
    const out = [];
    for (const name of fs.readdirSync(dir).filter((file) => /^[a-f0-9-]{36}\.json$/.test(file))) {
      try {
        const expectedSessionId = `durable:${name.slice(0, -5)}`;
        const info = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
        if (!info || typeof info !== 'object' || info.sessionId !== expectedSessionId || info.canvasId !== canvasId || info.version !== durableVersion) {
          throw fail('corrupt_session_manifest');
        }
        const value = await history(canvasId, expectedSessionId);
        out.push({
          sessionId: info.sessionId,
          kind: 'durable',
          title: sessionTitle(value.turns),
          updatedAt: value.turns.at(-1)?.createdAt || info.createdAt || '',
          turnCount: value.turns.length,
        });
      } catch (error) {
        if (!isSkippableSessionError(error)) throw error;
        console.error(`agent-host: 跳过损坏的历史会话 ${name}: ${error?.reason || error?.message || error}`);
      }
    }
    return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async function deleteSession(canvasId, sessionId, { refreshCanvasBusy, isEntryBusy, readSafeCurrentPointer }) {
    if (await refreshCanvasBusy(canvasId)) throw fail('session_busy');
    return lock(canvasId, async () => {
      if (!isDurableSessionId(sessionId) || !hasSession(canvasId, sessionId)) throw fail('session_not_found');
      const current = sessions.get(canvasId);
      if (isEntryBusy(current)) throw fail('session_busy');
      const uuid = idPattern.exec(sessionId)[1];
      const dir = durableDirectory(canvasId);
      if (current?.sessionId === sessionId) {
        sessions.delete(canvasId);
        current.disposed = true;
        await current.harness.close(CTX);
      }
      for (const suffix of ['.json', '.sqlite', '.sqlite-wal', '.sqlite-shm', '.budget']) {
        fs.rmSync(path.join(dir, `${uuid}${suffix}`), { recursive: true, force: true });
      }
      const wasCurrent = current?.sessionId === sessionId || readSafeCurrentPointer(canvasId) === sessionId;
      if (wasCurrent) {
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

  async function recordEvent(canvasId, { sessionId = '', requestId = crypto.randomUUID(), kind = 'event', message = '', data = {} } = {}, { ensureSession, readSafeCurrentPointer }) {
    const cleanCanvasId = String(canvasId || '').trim();
    const cleanKind = String(kind || 'event').trim();
    const cleanMessage = String(message || '').trim();
    const requestedSessionId = String(sessionId || '').trim();
    if (!cleanCanvasId || !cleanKind || !cleanMessage) throw fail('invalid_request');
    const currentSessionId = sessions.get(cleanCanvasId)?.sessionId || readSafeCurrentPointer(cleanCanvasId) || '';
    const writeEventEntry = (entry) => entry.root.submit({
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
    if (requestedSessionId && isDurableSessionId(requestedSessionId) && requestedSessionId !== currentSessionId) {
      return lock(cleanCanvasId, async () => withSession(cleanCanvasId, requestedSessionId, async (entry) => {
        const submission = await writeEventEntry(entry);
        return { accepted: true, sessionId: entry.sessionId, submissionId: submission.id, requestId: `event:${requestId}` };
      }, { readOnly: false }));
    }
    const entry = await ensureSession(cleanCanvasId, requestedSessionId, { handoffLegacy: !requestedSessionId });
    return lock(cleanCanvasId, async () => {
      const submission = await writeEventEntry(entry);
      return { accepted: true, sessionId: entry.sessionId, submissionId: submission.id, requestId: `event:${requestId}` };
    });
  }

  return {
    currentPath,
    publish,
    install,
    open,
    withSession,
    getOpenCount: () => openCount,
    handoffSessionId,
    hasSession,
    prepareSession,
    historyOf,
    history,
    status,
    listCanvasSessions,
    deleteSession,
    recordEvent,
  };
}
