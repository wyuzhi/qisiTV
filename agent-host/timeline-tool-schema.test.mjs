import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {scopedSchema} from './operation-bridge.mjs';
import {timelineDeliveryTool} from './timeline-delivery.mjs';

const descriptors = JSON.parse(fs.readFileSync(new URL('./operation-descriptors.fixture.json', import.meta.url)));

test('timeline model schema keeps inputs and required revision without endpoint-rejected root oneOf', () => {
  const descriptor = descriptors.find(d => d.id === 'canvas.timeline.update');
  const before = structuredClone(descriptor.params);
  for (const fullAccess of [false, true]) {
    const projected = scopedSchema(descriptor.params, fullAccess, descriptor.id);
    assert.equal(projected.oneOf, undefined);
    assert.match(projected.description, /timeline.*refreshNodeIds/);
    assert(projected.required.includes('expectedRevision'));
    assert.deepEqual(projected.properties.timeline, before.properties.timeline);
    assert.deepEqual(projected.properties.refreshNodeIds, before.properties.refreshNodeIds);
  }
  assert.deepEqual(descriptor.params, before, 'business validation contract is unchanged');
  assert.equal(before.oneOf.length, 2);
  const described = scopedSchema({ ...descriptor.params, description: '保留草稿版本说明' }, false, descriptor.id);
  assert.match(described.description, /保留草稿版本说明/);
});

test('delivery composition retains compatible standalone update schema and complete delivery timeline', async () => {
  const tools = descriptors.map(d => ({name:d.id.replaceAll('.', '_'), label:d.id,
    parameters:scopedSchema(d.params, false, d.id)}));
  const delivery = timelineDeliveryTool(tools);
  assert(delivery);
  const update = tools.find(t => t.label === 'canvas.timeline.update');
  assert.equal(update.parameters.oneOf, undefined);
  assert(delivery.parameters.properties.timeline.properties.clips.items.properties.lines);
  await assert.rejects(delivery.execute('test', {timeline:{},refreshNodeIds:['test']}, undefined, {}), /二选一/);
});
