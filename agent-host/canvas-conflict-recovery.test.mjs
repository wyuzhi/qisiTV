import test from 'node:test';
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createOperationBridge } from './operation-bridge.mjs';
import { newTurnAccumulator, resetTurnAccumulator } from './canvas-turn.mjs';
import * as studio from './studio-digest.mjs';
import { getCurrentSystemMessage } from '@earendil-works/pi-ai/utils/transcript';

test('request overlay strips transient studio/plan from system sections, orders instructions first, and appends transient context at tail', () => {
  assert.equal(typeof studio.withCurrentStudio, 'function');
  const history = [
    {
      role: 'system',
      content: 'instructions',
      toolsAdded: [{ name: 'canvas_get' }],
      sections: {
        beeftv_skill_catalog: '<beeftv_skill_catalog>\ncatalog\n</beeftv_skill_catalog>',
        instructions: '<instructions>\nrules\n</instructions>',
        beeftv_plan: 'keep plan',
        beeftv_studio: 'revision 22',
      },
    },
    { role: 'user', content: 'continue', timestamp: 1 },
  ];
  const messages = studio.withCurrentStudio(history, 'revision 23', { planText: 'keep plan' });
  const system = getCurrentSystemMessage(messages);
  assert.deepEqual(Object.keys(system.sections), ['instructions', 'beeftv_skill_catalog']);
  assert.equal(system.sections.beeftv_studio, undefined);
  assert.equal(system.sections.beeftv_plan, undefined);
  assert.equal(system.toolsAdded[0].name, 'canvas_get');
  assert.equal(history[0].sections.beeftv_studio, 'revision 22');
  assert.equal(messages[1], history[1]);
  assert.equal(messages.at(-1).role, 'user');
  assert.match(messages.at(-1).content[0].text, /<beeftv_plan>\nkeep plan\n<\/beeftv_plan>/);
  assert.match(messages.at(-1).content[0].text, /<beeftv_studio>\nrevision 23\n<\/beeftv_studio>/);
  assert.doesNotMatch(JSON.stringify(messages), /revision 22/);
  const failedReadMessages = studio.withCurrentStudio(messages, '');
  assert.equal(failedReadMessages.length, messages.length);
  assert.match(failedReadMessages.at(-1).content[0].text, /无法读取/);
});

async function bridgeFixture(run, { readFailure = false, unknownOutcome = false } = {}) {
  const original = globalThis.fetch;
  const requests = [];
  const generation = { permissionMode: 'canvas', modelEpoch: 0, intentEpoch: 0 };
  const turn = newTurnAccumulator(); turn.turnId = 'conflict-test';
  globalThis.fetch = async (url, options) => {
    requests.push({ url, body: options.body && JSON.parse(options.body) });
    if (url.endsWith('/ops')) return Response.json({ code: 0, data: { ops: [{
      id: 'canvas.nodes.create', summary: 'create', assistantModes: ['canvas'], readOnly: false,
      params: { type: 'object', properties: { canvasId: { type: 'string' }, expectedRevision: { type: 'integer' }, nodes: { type: 'array' } } },
    }] } });
    if (url.endsWith('/canvas.get') && readFailure) throw new Error('read connection failed');
    if (url.endsWith('/canvas.get')) return Response.json({ code: 0, data: { result: {
      canvasId: 'canvas', canvas: { revision: 23, nodes: [{ id: 'kept', type: 'text', title: 'User edit' }], connections: [] },
    } } });
    if (unknownOutcome) throw new Error('connection closed after dispatch');
    return Response.json({ code: 409, reason: 'stale_revision', msg: 'changed' }, { status: 409 });
  };
  try {
    const bridge = createOperationBridge({ opsUrl: 'http://fixture', hostToken: 'synthetic', turnBudgetContext: new AsyncLocalStorage() });
    await bridge.loadDescriptors();
    const tool = bridge.buildTools('canvas', [], generation, turn, 'session')[0];
    await run({ tool, bridge, turn, generation, requests });
  } finally { globalThis.fetch = original; }
}

test('a rejected canvas write returns current evidence and fences queued writes without replaying the operation', async () => {
  await bridgeFixture(async ({ tool, bridge, turn, generation, requests }) => {
    await assert.rejects(tool.execute('first', { expectedRevision: 22, nodes: [] }), error => {
      assert.match(error.message, /stale_revision/);
      assert.match(error.message, /23/);
      assert.match(error.message, /User edit/);
      return true;
    });
    await assert.rejects(tool.execute('queued', { expectedRevision: 23, nodes: [] }), /canvas_context_changed/);
    const restored = JSON.parse(JSON.stringify(turn));
    const resumed = bridge.buildTools('canvas', [], generation, restored, 'session')[0];
    await assert.rejects(resumed.execute('after-restart', { expectedRevision: 23, nodes: [] }), /canvas_context_changed/);
    assert.equal(requests.filter(r => r.url.endsWith('/canvas.nodes.create')).length, 1);
    assert.equal(turn.operationIds.length, 0);
    resetTurnAccumulator(turn, 23, 'new-turn');
    assert.equal(turn.canvasContextChanged, undefined);
    turn.studioReadAvailable = false;
    await assert.rejects(tool.execute('unavailable', { expectedRevision: 23, nodes: [] }), /canvas_snapshot_unavailable/);
    assert.equal(requests.filter(r => r.url.endsWith('/canvas.nodes.create')).length, 1);
  });
});

test('failed conflict recovery leaves the scene unknown and persists the write fence', async () => {
  await bridgeFixture(async ({ tool, turn, requests }) => {
    await assert.rejects(tool.execute('conflict', { expectedRevision: 22, nodes: [] }), /最新画布读取失败/);
    assert.equal(turn.studioReadAvailable, false);
    assert.equal(turn.canvasContextChanged, true);
    await assert.rejects(tool.execute('queued', { expectedRevision: 23, nodes: [] }), /canvas_snapshot_unavailable/);
    assert.equal(requests.filter(r => r.url.endsWith('/canvas.nodes.create')).length, 1);
  }, { readFailure: true });
});

test('unknown network outcomes neither rebase nor retry a potentially committed operation', async () => {
  await bridgeFixture(async ({ tool, turn, requests }) => {
    await assert.rejects(tool.execute('unknown', { expectedRevision: 22, nodes: [] }), /connection closed/);
    assert.equal(requests.filter(r => r.url.endsWith('/canvas.nodes.create')).length, 1);
    assert.equal(requests.filter(r => r.url.endsWith('/canvas.get')).length, 0);
    assert.equal(turn.canvasContextChanged, undefined);
    assert.equal(turn.writeRequests[0].sentRevision, 22);
    assert.equal(turn.operationIds.length, 0);
  }, { unknownOutcome: true });
});
