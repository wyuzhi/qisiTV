import fs from 'node:fs';

export function isCorruptSessionArtifactError(error) {
  if (['durable_version_mismatch', 'corrupt_session_manifest'].includes(error?.reason)) return true;
  const detail = `${error?.code || ''} ${error?.message || ''}`;
  return /SQLITE_(?:CORRUPT|NOTADB|IOERR_SHORT_READ)|not a database|database disk image is malformed/i.test(detail);
}

export function isSkippableSessionError(error) {
  if (isCorruptSessionArtifactError(error)) return true;
  if (error instanceof SyntaxError) return true;
  if (['ENOENT', 'EACCES', 'EPERM', 'EISDIR', 'ENOTDIR'].includes(error?.code)) return true;
  if (error?.reason === 'session_not_found') return true;
  const detail = `${error?.code || ''} ${error?.message || ''}`;
  return /SQLITE_CANTOPEN|corrupt/i.test(detail);
}

export function createDurablePointerResolver({
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
}) {
  function clearCorruptPointer(canvasId) {
    try {
      const target = currentPath(canvasId);
      if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
    } catch {}
  }

  function readSafeCurrentPointer(canvasId, { persist = false } = {}) {
    const live = sessions.get(canvasId);
    let raw;
    try {
      raw = fs.readFileSync(currentPath(canvasId), 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return live?.sessionId || '';
      if (live) return live.sessionId;
      if (error?.code === 'EISDIR' || error?.code === 'ENOTDIR') {
        console.error(`agent-host: 忽略非文件当前会话指针 ${canvasId}: ${error.code}`);
        if (persist) clearCorruptPointer(canvasId);
        return '';
      }
      if (['EACCES', 'EPERM', 'EIO'].includes(error?.code)) {
        throw Object.assign(fail('session_pointer_unavailable'), { cause: error });
      }
      throw fail('session_pointer_failed');
    }
    try {
      const parsed = JSON.parse(raw);
      const id = typeof parsed?.sessionId === 'string' ? parsed.sessionId.trim() : '';
      if (!id) {
        if (live) return live.sessionId;
        console.error(`agent-host: 忽略缺少 sessionId 的当前会话指针 ${canvasId}`);
        if (persist) clearCorruptPointer(canvasId);
        return '';
      }
      return id;
    } catch (error) {
      if (live) return live.sessionId;
      console.error(`agent-host: 忽略损坏的当前会话指针 ${canvasId}: ${error.message}`);
      if (persist) clearCorruptPointer(canvasId);
      return '';
    }
  }

  async function resolveCurrentSession(
    canvasId,
    { persist = false, activateDurable = false, createIfMissing = false, handoffLegacy = false, preloadedList = null, skipSessionId = '' } = {},
  ) {
    const live = sessions.get(canvasId) || null;
    if (isEntryBusy(live)) {
      return { sessionId: live.sessionId, entry: live, kind: 'durable' };
    }
    const rawPointerId = readSafeCurrentPointer(canvasId, { persist });
    const pointerId = rawPointerId && rawPointerId !== skipSessionId ? rawPointerId : '';
    if (pointerId && live?.sessionId === pointerId) {
      return { sessionId: live.sessionId, entry: live, kind: 'durable' };
    }
    if (pointerId && isDurableSessionId(pointerId)) {
      if (!activateDurable) {
        const listedValid = Array.isArray(preloadedList)
          ? preloadedList.some((item) => item.sessionId === pointerId)
          : hasSession(canvasId, pointerId);
        if (listedValid) {
          return { sessionId: pointerId, entry: null, kind: 'durable' };
        }
        console.error(`agent-host: 跳过未通过清单校验的当前会话 ${pointerId}`);
      } else {
        try {
          const entry = await activateSession(canvasId, pointerId);
          return { sessionId: entry.sessionId, entry, kind: 'durable' };
        } catch (error) {
          if (error?.reason === 'session_busy') {
            const busyLive = sessions.get(canvasId);
            if (busyLive) return { sessionId: busyLive.sessionId, entry: busyLive, kind: 'durable' };
          }
          if (!isSkippableSessionError(error)) throw error;
          console.error(`agent-host: 跳过损坏的当前会话 ${pointerId}: ${error?.reason || error?.message || error}`);
        }
      }
    } else if (pointerId) {
      if (handoffLegacy) {
        const entry = await handoffSession(canvasId, legacy ? legacy.readHandoffNote(canvasId, pointerId) : '', pointerId);
        return { sessionId: entry.sessionId, entry, kind: 'durable' };
      }
      return { sessionId: pointerId, entry: null, kind: 'legacy' };
    }

    const currentLive = sessions.get(canvasId) || null;
    if (isEntryBusy(currentLive)) {
      return { sessionId: currentLive.sessionId, entry: currentLive, kind: 'durable' };
    }
    const candidates = [...(Array.isArray(preloadedList)
      ? preloadedList
      : [...(legacy ? await legacy.listCanvasSessions(canvasId) : []), ...await listCanvasSessions(canvasId)])]
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    const fallback = candidates[0]?.sessionId || '';
    if (fallback) {
      if (isDurableSessionId(fallback)) {
        if (!persist && !activateDurable) {
          return { sessionId: fallback, entry: null, kind: 'durable' };
        }
        const entry = await activateSession(canvasId, fallback);
        return { sessionId: entry.sessionId, entry, kind: 'durable' };
      }
      if (persist) {
        if (currentLive) await releaseIdleSession(canvasId);
        legacy?.writeCurrentSessionId(canvasId, fallback);
      }
      if (handoffLegacy) {
        const entry = await handoffSession(canvasId, legacy ? legacy.readHandoffNote(canvasId, fallback) : '', fallback);
        return { sessionId: entry.sessionId, entry, kind: 'durable' };
      }
      return { sessionId: fallback, entry: null, kind: 'legacy' };
    }
    if (currentLive) {
      return { sessionId: currentLive.sessionId, entry: currentLive, kind: 'durable' };
    }
    if (persist) clearCorruptPointer(canvasId);
    if (createIfMissing) {
      const entry = await createSession(canvasId);
      return { sessionId: entry.sessionId, entry, kind: 'durable' };
    }
    return { sessionId: null, entry: null, kind: null };
  }

  return { clearCorruptPointer, readSafeCurrentPointer, resolveCurrentSession };
}
