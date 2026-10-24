// Offline migration fixture. The only model transport is a local mock server.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { modelFixture } from './durable-model-switch-probe.mjs';

const [action, directory] = process.argv.slice(2);
if (!['create', 'verify'].includes(action) || !path.isAbsolute(directory || '')) throw new Error('Invalid fixture arguments');
const fixture = await modelFixture(directory, 'storage-fixture', ['storage-fixture']);
const receipt = path.join(directory, 'migration-assistant-fixture.json');
try {
  if (action === 'create') {
    const entry = await fixture.store.createSession('canvas');
    const submitted = await fixture.store.submit(entry, { turnId: 'migration-turn', content: 'Keep this original local transcript through storage relocation.' });
    await fixture.store.wait(entry, submitted);
    const history = await fixture.store.history('canvas', entry.sessionId);
    assert.equal(history.turns.length, 1);
    assert.deepEqual(fixture.requests, ['storage-fixture']);
    fs.writeFileSync(receipt, JSON.stringify({ sessionId: entry.sessionId, history }));
  } else {
    const saved = JSON.parse(fs.readFileSync(receipt, 'utf8'));
    const entry = await fixture.store.ensureCurrentSession('canvas', saved.sessionId);
    assert.equal(entry.sessionId, saved.sessionId);
    const restored = await fixture.store.history('canvas', saved.sessionId);
    assert.deepEqual(restored, saved.history);
    assert.deepEqual(fixture.requests, [], 'Reading relocated history must not call a model');
  }
} finally {
  await fixture.close();
}
