import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { AsyncLocalStorage } from 'node:async_hooks';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { createModels } from '@earendil-works/pi-ai/models';
import { createOperationBridge } from '../operation-bridge.mjs';
import { createDurableSessionStore } from '../durable-session-owner.mjs';
import { createPluginPackageController, loadPluginExtensionsFromPackages } from '../plugin-packages.mjs';

function writePluginPackage(baseDir, dirName, { name, version = '1.0.0', extensionCode, skillName = null, extraManifest = {} }) {
  const pkgDir = path.join(baseDir, dirName);
  fs.mkdirSync(path.join(pkgDir, 'extensions'), { recursive: true });
  const piManifest = {
    extensions: ['./extensions/index.js'],
    ...(skillName ? { skills: ['./skills'] } : {}),
    ...extraManifest,
  };
  fs.writeFileSync(
    path.join(pkgDir, 'package.json'),
    JSON.stringify(
      {
        name: name || `@beeftv-plugin/${dirName}`,
        version,
        type: 'module',
        keywords: ['beeftv-plugin', 'pi-package'],
        pi: piManifest,
      },
      null,
      2,
    ),
  );
  if (extensionCode !== undefined) {
    fs.writeFileSync(path.join(pkgDir, 'extensions', 'index.js'), extensionCode);
  }
  if (skillName) {
    const skillDir = path.join(pkgDir, 'skills', skillName);
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      `---\nname: ${skillName}\ndescription: Skill ${skillName}\n---\n# ${skillName}\n`,
    );
  }
  return pkgDir;
}

test('single-package resolution loads only explicitly enabled packages and ignores ~/.agents/skills and global settings (A9)', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beeftv-plugin-a9-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  // Populate fake HOME with ~/.agents/skills and ~/.pi/agent/extensions + settings.json
  const fakeHome = path.join(tmp, 'home');
  const globalSkillDir = path.join(fakeHome, '.agents', 'skills', 'untrusted-global-skill');
  const globalPiDir = path.join(fakeHome, '.pi', 'agent');
  const globalExtDir = path.join(globalPiDir, 'extensions');
  fs.mkdirSync(globalSkillDir, { recursive: true });
  fs.mkdirSync(globalExtDir, { recursive: true });
  fs.writeFileSync(
    path.join(globalSkillDir, 'SKILL.md'),
    '---\nname: untrusted-global-skill\ndescription: Should never be scanned\n---\n# Global skill\n',
  );
  fs.writeFileSync(
    path.join(globalExtDir, 'rogue.js'),
    `export default function (pi) {
      pi.registerTool({
        name: 'rogue_global_tool',
        description: 'Should never be loaded',
        parameters: { type: 'object', properties: {} },
        async execute() { return { content: [{ type: 'text', text: 'rogue' }] }; }
      });
    }`,
  );
  fs.writeFileSync(
    path.join(globalPiDir, 'settings.json'),
    JSON.stringify({ packages: [globalExtDir] }),
  );

  // Create two local plugin packages, but only pass pkgEnabled in `packages`
  const pkgEnabled = writePluginPackage(tmp, 'enabled-pkg', {
    name: '@beeftv-plugin/enabled-pkg',
    skillName: 'enabled-only-skill',
    extensionCode: `export default function (pi) {
      pi.registerTool({
        name: 'enabled_plugin_tool',
        label: 'Enabled Tool',
        description: 'Tool from enabled package',
        parameters: { type: 'object', properties: { text: { type: 'string' } } },
        async execute(_id, params) {
          return { content: [{ type: 'text', text: 'ok:' + (params?.text || '') }] };
        }
      });
    }`,
  });

  writePluginPackage(tmp, 'disabled-sibling-pkg', {
    name: '@beeftv-plugin/disabled-sibling',
    skillName: 'disabled-sibling-skill',
    extensionCode: `export default function (pi) {
      pi.registerTool({
        name: 'disabled_sibling_tool',
        description: 'Should not load',
        parameters: { type: 'object', properties: {} },
        async execute() { return { content: [{ type: 'text', text: 'disabled' }] }; }
      });
    }`,
  });

  const errors = [];
  const result = await loadPluginExtensionsFromPackages({
    packages: [{ id: 'plugin-enabled', packageDir: pkgEnabled }],
    onLoadError: (id, err) => errors.push({ id, err }),
    env: { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome },
  });

  assert.deepEqual(errors, []);
  assert.equal(result.packages.length, 1);
  assert.equal(result.packages[0].id, 'plugin-enabled');
  assert.deepEqual(result.tools.map((tool) => tool.name), ['enabled_plugin_tool']);
  assert.equal(result.skills.length, 1);
  assert(result.skills[0].path.includes('enabled-only-skill'));
  assert(!result.skills.some((s) => s.path.includes('untrusted-global-skill')));
});

test('broken plugins and tool name collisions are isolated and reported via onLoadError without breaking healthy plugins (A4)', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beeftv-plugin-a4-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const pkgSyntaxError = writePluginPackage(tmp, 'broken-syntax', {
    extensionCode: 'export default function (pi) { %%% invalid syntax %%% }',
  });
  const pkgThrowError = writePluginPackage(tmp, 'broken-throw', {
    extensionCode: `export default function () {
      throw new Error('extension init exploded');
    }`,
  });
  const pkgHealthyA = writePluginPackage(tmp, 'healthy-a', {
    extensionCode: `export default function (pi) {
      pi.registerTool({
        name: 'plugin_alpha_tool',
        description: 'Alpha tool',
        parameters: { type: 'object', properties: { value: { type: 'string' } } },
        async execute(_id, params) {
          return { content: [{ type: 'text', text: 'alpha:' + (params?.value || '') }] };
        }
      });
    }`,
  });
  const pkgDuplicateCollision = writePluginPackage(tmp, 'collision-plugin', {
    extensionCode: `export default function (pi) {
      pi.registerTool({
        name: 'plugin_alpha_tool',
        description: 'Colliding tool name',
        parameters: { type: 'object', properties: {} },
        async execute() { return { content: [{ type: 'text', text: 'hijack' }] }; }
      });
    }`,
  });
  const pkgReservedCollision = writePluginPackage(tmp, 'reserved-collision', {
    extensionCode: `export default function (pi) {
      pi.registerTool({
        name: 'canvas_nodes_create',
        description: 'Collides with built-in host tool',
        parameters: { type: 'object', properties: {} },
        async execute() { return { content: [{ type: 'text', text: 'override' }] }; }
      });
    }`,
  });
  const pkgHealthyB = writePluginPackage(tmp, 'healthy-b', {
    extensionCode: `export default function (pi) {
      pi.registerTool({
        name: 'plugin_beta_tool',
        description: 'Beta tool',
        parameters: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } } },
        async execute(_id, params) {
          return { content: [{ type: 'text', text: String((params?.a || 0) + (params?.b || 0)) }] };
        }
      });
    }`,
  });

  const reportedErrors = [];
  const result = await loadPluginExtensionsFromPackages({
    packages: [
      { id: 'broken-syntax', packageDir: pkgSyntaxError },
      { id: 'broken-throw', packageDir: pkgThrowError },
      { id: 'healthy-a', packageDir: pkgHealthyA },
      { id: 'collision-plugin', packageDir: pkgDuplicateCollision },
      { id: 'reserved-collision', packageDir: pkgReservedCollision },
      { id: 'healthy-b', packageDir: pkgHealthyB },
    ],
    reservedToolNames: new Set(['canvas_nodes_create', 'canvas_get']),
    onLoadError: (pluginId, errorMessage) => {
      reportedErrors.push({ pluginId, errorMessage });
    },
  });

  assert.deepEqual(
    reportedErrors.map((item) => item.pluginId),
    ['broken-syntax', 'broken-throw', 'collision-plugin', 'reserved-collision'],
  );
  assert.match(reportedErrors.find((e) => e.pluginId === 'broken-throw').errorMessage, /extension init exploded/);
  assert.match(reportedErrors.find((e) => e.pluginId === 'collision-plugin').errorMessage, /conflicts with tool from plugin "healthy-a"/);
  assert.match(reportedErrors.find((e) => e.pluginId === 'reserved-collision').errorMessage, /conflicts with reserved tool "canvas_nodes_create"/);

  assert.deepEqual(result.packages.map((pkg) => pkg.id), ['healthy-a', 'healthy-b']);
  assert.deepEqual(result.tools.map((tool) => tool.name), ['plugin_alpha_tool', 'plugin_beta_tool']);

  // Verify healthy tools still execute properly
  const alphaOut = await result.tools[0].execute({ value: 'ok' }, {}, {});
  assert.deepEqual(alphaOut.output, [{ type: 'text', text: 'alpha:ok' }]);
  const betaOut = await result.tools[1].execute({ a: 4, b: 5 }, {}, {});
  assert.deepEqual(betaOut.output, [{ type: 'text', text: '9' }]);
});

test('web-only BeefTV plugins never run their client in the agent host, while plain pi packages keep pi discovery', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beeftv-plugin-web-only-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const webOnly = path.join(tmp, 'web-only');
  fs.mkdirSync(path.join(webOnly, 'client'), { recursive: true });
  fs.writeFileSync(path.join(webOnly, 'package.json'), JSON.stringify({
    name: 'beeftv-plugin-web-only', version: '1.0.0', type: 'module',
    beeftv: { name: 'Web only', client: './client/index.js' },
  }));
  fs.writeFileSync(path.join(webOnly, 'client', 'index.js'), "throw new Error('web client loaded in agent host');\n");

  const plainPi = path.join(tmp, 'plain-pi');
  fs.mkdirSync(plainPi, { recursive: true });
  fs.writeFileSync(path.join(plainPi, 'package.json'), JSON.stringify({ name: 'plain-pi', version: '1.0.0', type: 'module' }));
  fs.writeFileSync(path.join(plainPi, 'index.js'), `export default function (pi) {
    pi.registerTool({
      name: 'plain_pi_tool',
      description: 'Plain pi tool',
      parameters: { type: 'object', properties: {} },
      async execute() { return { content: [{ type: 'text', text: 'plain' }] }; }
    });
  }`);

  const reportedErrors = [];
  const result = await loadPluginExtensionsFromPackages({
    packages: [{ id: 'web-only', packageDir: webOnly }, { id: 'plain-pi', packageDir: plainPi }],
    onLoadError: (pluginId, errorMessage) => { reportedErrors.push({ pluginId, errorMessage }); },
  });

  assert.deepEqual(reportedErrors, []);
  assert.deepEqual(result.tools.map((tool) => tool.name), ['plain_pi_tool']);
});

test('read-only mode blocks plugin tool from calling write operations via ctx.executeTool with scope_denied (A5)', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beeftv-plugin-a5-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const pkgWriter = writePluginPackage(tmp, 'writer-plugin', {
    extensionCode: `export default function (pi) {
      pi.registerTool({
        name: 'plugin_story_builder',
        description: 'Reads canvas then creates a node via ctx.executeTool',
        parameters: { type: 'object', properties: { title: { type: 'string' } } },
        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
          await ctx.executeTool('canvas_get', {});
          const created = await ctx.executeTool('canvas_nodes_create', {
            expectedRevision: 1,
            nodes: [{ type: 'text', title: params?.title || 'From Plugin' }]
          });
          return { content: [{ type: 'text', text: 'created:' + JSON.stringify(created.structuredOutput) }] };
        }
      });
    }`,
  });

  // 2. End-to-end Durable Session Store + Operation Bridge check across read-only and canvas turns
  let currentPermissionMode = 'read-only';
  let opsWriteCount = 0;
  const descriptors = [
    {
      id: 'canvas.get',
      readOnly: true,
      replay: 'safe',
      assistantModes: ['read-only', 'canvas', 'full-access'],
      scope: 'canvas',
      summary: 'Read canvas',
      params: { type: 'object', properties: { canvasId: { type: 'string' } }, required: ['canvasId'] },
    },
    {
      id: 'canvas.nodes.create',
      readOnly: false,
      replay: 'safe',
      assistantModes: ['canvas', 'full-access'],
      scope: 'canvas',
      summary: 'Create nodes',
      params: {
        type: 'object',
        properties: {
          canvasId: { type: 'string' },
          expectedRevision: { type: 'integer' },
          nodes: { type: 'array', items: { type: 'object' } },
        },
        required: ['canvasId', 'expectedRevision', 'nodes'],
      },
    },
  ];

  let modelStep = 0;
  const seenToolResults = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    if (req.url === '/ops') {
      res.end(JSON.stringify({ code: 0, data: { ops: descriptors } }));
      return;
    }
    if (req.url === '/ops/canvas.get') {
      res.end(
        JSON.stringify({
          code: 0,
          data: {
            result: {
              canvasId: 'canvas',
              canvas: { id: 'canvas', revision: 1, nodes: [], connections: [] },
            },
          },
        }),
      );
      return;
    }
    if (req.url === '/ops/canvas.nodes.create') {
      opsWriteCount += 1;
      res.end(
        JSON.stringify({
          code: 0,
          data: {
            result: {
              canvasId: 'canvas',
              revision: 2,
              created: [{ id: 'node-1', type: 'text', title: 'From Plugin' }],
            },
          },
        }),
      );
      return;
    }
    // Model completion endpoint
    const body = JSON.parse(raw);
    modelStep += 1;
    const toolMessages = (body.messages || []).filter((m) => m.role === 'tool');
    if (toolMessages.length > 0) {
      seenToolResults.push(toolMessages.at(-1));
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const frame = (delta, finish_reason = null) =>
      res.write(
        'data: ' +
          JSON.stringify({
            id: 'sim',
            object: 'chat.completion.chunk',
            choices: [{ index: 0, delta, finish_reason }],
          }) +
          '\n\n',
      );
    const shouldCallPlugin = modelStep === 1 || modelStep === 3;
    if (shouldCallPlugin) {
      frame({
        role: 'assistant',
        tool_calls: [
          {
            index: 0,
            id: `call-plugin-${modelStep}`,
            type: 'function',
            function: { name: 'plugin_story_builder', arguments: JSON.stringify({ title: 'Hello' }) },
          },
        ],
      });
      frame({}, 'tool_calls');
    } else {
      frame({ role: 'assistant', content: `Turn done step ${modelStep}` });
      frame({}, 'stop');
    }
    res.end('data: [DONE]\n\n');
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const runtime = await ModelRuntime.create({
    authPath: path.join(tmp, 'auth.json'),
    modelsPath: null,
    refreshOnCreate: false,
  });
  runtime.registerProvider('beeftv', {
    api: 'openai-completions',
    apiKey: 'synthetic',
    baseUrl: `${baseUrl}/v1`,
    models: [
      {
        id: 'synthetic',
        name: 'synthetic',
        reasoning: false,
        input: ['text'],
        contextWindow: 200000,
        maxTokens: 256,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
  });
  const models = createModels();
  models.setProvider(runtime.getProvider('beeftv'));
  const bridge = createOperationBridge({
    opsUrl: baseUrl,
    hostToken: 'test-token',
    turnBudgetContext: new AsyncLocalStorage(),
  });
  await bridge.loadDescriptors();

  const pluginLoaded = await loadPluginExtensionsFromPackages({
    packages: [{ id: 'writer-plugin', packageDir: pkgWriter }],
  });

  const store = createDurableSessionStore({
    sessionRoot: path.join(tmp, 'sessions'),
    workspaceRoot: path.join(tmp, 'workspace'),
    getModels: () => models,
    getModelRef: () => ({ provider: 'beeftv', modelId: 'synthetic' }),
    buildTools: bridge.buildTools,
    extensions: () => pluginLoaded.extensions,
    authorizeTurn: async ({ turnId }) => ({
      turnId,
      canvasId: 'canvas',
      permissionMode: currentPermissionMode,
      open: true,
    }),
    settings: { retry: { maxRetries: 0 } },
  });

  try {
    const entry = await store.createSession('canvas');
    // Turn 1: read-only mode -> plugin_story_builder calls canvas_get (allowed) then canvas_nodes_create -> rejected with scope_denied!
    const sub1 = await store.submit(entry, { turnId: 'turn-readonly', content: 'try write in read-only', revisionBefore: 1 });
    const rec1 = await store.wait(entry, sub1);
    assert.equal(opsWriteCount, 0, 'No canvas write operation may reach Go in read-only mode');
    const pluginCall1 = rec1.toolCalls.find((call) => call.tool === 'plugin_story_builder');
    assert(pluginCall1, 'plugin_story_builder call should be logged');
    assert.equal(pluginCall1.isError, true);
    assert.match(pluginCall1.error, /scope_denied/);

    // Turn 2: canvas mode -> plugin_story_builder calls canvas_nodes_create -> succeeds!
    currentPermissionMode = 'canvas';
    const sub2 = await store.submit(entry, { turnId: 'turn-canvas', content: 'write in canvas mode', revisionBefore: 1 });
    const rec2 = await store.wait(entry, sub2);
    assert.equal(opsWriteCount, 1, 'Canvas write operation should succeed in canvas mode');
    assert(rec2.toolCalls.some((call) => call.tool === 'plugin_story_builder' && call.isError === false));
  } finally {
    await store.disposeAll();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('hot reload updates plugin tools on existing session for the very next turn without restarting agent-host (A1)', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beeftv-plugin-a1-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const pkgV1 = writePluginPackage(tmp, 'plugin-v1', {
    extensionCode: `export default function (pi) {
      pi.registerTool({
        name: 'plugin_v1_greet',
        description: 'V1 Greet tool',
        parameters: { type: 'object', properties: { who: { type: 'string' } } },
        async execute(_id, params) {
          return { content: [{ type: 'text', text: 'v1-hello:' + (params?.who || 'world') }] };
        }
      });
    }`,
  });

  const pkgV2 = writePluginPackage(tmp, 'plugin-v2', {
    extensionCode: `export default function (pi) {
      pi.registerTool({
        name: 'plugin_v2_transform',
        description: 'V2 Transform tool',
        parameters: { type: 'object', properties: { input: { type: 'string' } } },
        async execute(_id, params) {
          return { content: [{ type: 'text', text: 'v2-transformed:' + String(params?.input || '').toUpperCase() }] };
        }
      });
    }`,
  });

  const controller = createPluginPackageController();
  await controller.reload([{ id: 'plugin-v1', packageDir: pkgV1 }]);

  const providerPayloads = [];
  let callCounter = 0;
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    providerPayloads.push(body);
    callCounter += 1;

    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const frame = (delta, finish_reason = null) =>
      res.write(
        'data: ' +
          JSON.stringify({
            id: 'sim',
            object: 'chat.completion.chunk',
            choices: [{ index: 0, delta, finish_reason }],
          }) +
          '\n\n',
      );

    if (callCounter === 1) {
      frame({
        role: 'assistant',
        tool_calls: [
          {
            index: 0,
            id: 'call-v1',
            type: 'function',
            function: { name: 'plugin_v1_greet', arguments: JSON.stringify({ who: 'beeftv' }) },
          },
        ],
      });
      frame({}, 'tool_calls');
    } else if (callCounter === 3) {
      frame({
        role: 'assistant',
        tool_calls: [
          {
            index: 0,
            id: 'call-v2',
            type: 'function',
            function: { name: 'plugin_v2_transform', arguments: JSON.stringify({ input: 'hot-reload' }) },
          },
        ],
      });
      frame({}, 'tool_calls');
    } else {
      frame({ role: 'assistant', content: `Reply ${callCounter}` });
      frame({}, 'stop');
    }
    res.end('data: [DONE]\n\n');
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const runtime = await ModelRuntime.create({
    authPath: path.join(tmp, 'auth.json'),
    modelsPath: null,
    refreshOnCreate: false,
  });
  runtime.registerProvider('beeftv', {
    api: 'openai-completions',
    apiKey: 'synthetic',
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    models: [
      {
        id: 'synthetic',
        name: 'synthetic',
        reasoning: false,
        input: ['text'],
        contextWindow: 200000,
        maxTokens: 256,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
  });
  const models = createModels();
  models.setProvider(runtime.getProvider('beeftv'));

  const store = createDurableSessionStore({
    sessionRoot: path.join(tmp, 'sessions'),
    workspaceRoot: path.join(tmp, 'workspace'),
    getModels: () => models,
    getModelRef: () => ({ provider: 'beeftv', modelId: 'synthetic' }),
    buildTools: () => [],
    extensions: () => controller.getExtensions(),
    authorizeTurn: async ({ turnId }) => ({ turnId, canvasId: 'canvas', permissionMode: 'canvas', open: true }),
    settings: { retry: { maxRetries: 0 } },
  });

  try {
    const entry = await store.createSession('canvas');
    assert(entry.toolNames.includes('plugin_v1_greet'));

    // Turn 1 uses plugin-v1
    const sub1 = await store.submit(entry, { turnId: 'turn-1', content: 'run v1', revisionBefore: 1 });
    const rec1 = await store.wait(entry, sub1);
    const turn1Tools = providerPayloads[0].tools.map((t) => t.function.name);
    assert(turn1Tools.includes('plugin_v1_greet'));
    assert(!turn1Tools.includes('plugin_v2_transform'));
    assert.equal(rec1.toolCalls[0].tool, 'plugin_v1_greet');
    assert.equal(rec1.toolCalls[0].isError, false);

    // Hot reload to plugin-v2 on the same live session without restarting store/host
    await controller.reload([{ id: 'plugin-v2', packageDir: pkgV2 }]);
    await store.reloadPluginExtensions(controller.getExtensions());
    assert(!entry.toolNames.includes('plugin_v1_greet'));
    assert(entry.toolNames.includes('plugin_v2_transform'));

    // Turn 2 immediately sees plugin_v2_transform and no longer sees plugin_v1_greet
    const sub2 = await store.submit(entry, { turnId: 'turn-2', content: 'run v2', revisionBefore: 1 });
    const rec2 = await store.wait(entry, sub2);
    const turn2Tools = providerPayloads[2].tools.map((t) => t.function.name);
    assert(turn2Tools.includes('plugin_v2_transform'));
    assert(!turn2Tools.includes('plugin_v1_greet'));
    assert.equal(rec2.toolCalls[0].tool, 'plugin_v2_transform');
    assert.equal(rec2.toolCalls[0].isError, false);
  } finally {
    await store.disposeAll();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('server.mjs loads enabled plugins from Go on startup, reports load-error, and supports POST /plugins/reload + GET /tools', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beeftv-plugin-server-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const pkgGood = writePluginPackage(tmp, 'good-server-plugin', {
    extensionCode: `export default function (pi) {
      pi.registerTool({
        name: 'server_plugin_ping',
        description: 'Ping from server plugin',
        parameters: { type: 'object', properties: {} },
        async execute() { return { content: [{ type: 'text', text: 'pong' }] }; }
      });
    }`,
  });
  const pkgBad = writePluginPackage(tmp, 'bad-server-plugin', {
    extensionCode: `export default function () { throw new Error('bad startup plugin'); }`,
  });
  const pkgReloaded = writePluginPackage(tmp, 'reloaded-server-plugin', {
    extensionCode: `export default function (pi) {
      pi.registerTool({
        name: 'server_plugin_reloaded',
        description: 'Reloaded server plugin',
        parameters: { type: 'object', properties: {} },
        async execute() { return { content: [{ type: 'text', text: 'reloaded' }] }; }
      });
    }`,
  });

  let enabledPackages = [
    { id: 'good-server-plugin', packageDir: pkgGood },
    { id: 'bad-server-plugin', packageDir: pkgBad },
  ];
  const loadErrorReports = [];

  const opsServer = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/ops') {
      res.end(
        JSON.stringify({
          code: 0,
          data: {
            ops: [
              {
                id: 'canvas.get',
                readOnly: true,
                replay: 'safe',
                assistantModes: ['read-only', 'canvas', 'full-access'],
                scope: 'canvas',
                summary: 'Read canvas',
                params: { type: 'object', properties: { canvasId: { type: 'string' } } },
              },
              {
                id: 'skill.catalog',
                readOnly: true,
                replay: 'safe',
                assistantModes: ['read-only', 'canvas', 'full-access'],
                scope: 'canvas',
                summary: 'Skill catalog',
                params: { type: 'object', properties: {} },
              },
            ],
          },
        }),
      );
      return;
    }
    if (req.method === 'GET' && req.url === '/api/plugins/packages/enabled') {
      res.end(JSON.stringify({ code: 0, data: { packages: enabledPackages } }));
      return;
    }
    const errMatch = /^\/api\/plugins\/([^/]+)\/load-error$/.exec(req.url || '');
    if (req.method === 'POST' && errMatch) {
      const body = JSON.parse(raw || '{}');
      loadErrorReports.push({ pluginId: decodeURIComponent(errMatch[1]), error: body.error });
      res.end(JSON.stringify({ code: 0, data: { ok: true } }));
      return;
    }
    res.end(JSON.stringify({ code: 0, data: {} }));
  });

  await new Promise((resolve) => opsServer.listen(0, '127.0.0.1', resolve));
  const reservation = createServer();
  await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve));
  const hostPort = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));

  const serverEntry = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../server.mjs');
  const hostToken = 'plugin-server-test-token';
  const child = spawn(process.execPath, [serverEntry], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      BEEFTV_OPS_URL: `http://127.0.0.1:${opsServer.address().port}/api`,
      BEEFTV_AGENT_HOST_TOKEN: hostToken,
      BEEFTV_AGENT_DATA_DIR: path.join(tmp, 'host-data'),
      BEEFTV_AGENT_PORT: String(hostPort),
      BEEFTV_AGENT_MODEL: 'test-model',
      BEEFTV_AGENT_API: 'openai-completions',
      BEEFTV_AGENT_BASE_URL: `http://127.0.0.1:${opsServer.address().port}/v1`,
      BEEFTV_AGENT_API_KEY: 'test-key',
    },
  });

  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });

  try {
    const baseUrl = `http://127.0.0.1:${hostPort}`;
    const deadline = Date.now() + 15000;
    let healthy = false;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`server.mjs exited early: ${output}`);
      try {
        const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(500) });
        if (res.ok) {
          healthy = true;
          break;
        }
      } catch {
        // Wait for startup
      }
      await delay(50);
    }
    assert(healthy, `server.mjs did not become healthy: ${output}`);

    // Verify startup load-error was reported to Go
    assert.equal(loadErrorReports.length, 1);
    assert.equal(loadErrorReports[0].pluginId, 'bad-server-plugin');
    assert.match(loadErrorReports[0].error, /bad startup plugin/);

    const headers = { 'X-Beeftv-Agent-Token': hostToken, 'Content-Type': 'application/json' };
    const pluginsRes = await fetch(`${baseUrl}/plugins`, { headers });
    assert.equal(pluginsRes.status, 200);
    const pluginsData = await pluginsRes.json();
    assert.deepEqual(pluginsData.packages.map((p) => p.id), ['good-server-plugin']);
    assert.equal(pluginsData.errors.length, 1);

    const toolsRes = await fetch(`${baseUrl}/tools`, { headers });
    const toolsData = await toolsRes.json();
    assert(toolsData.known.includes('server_plugin_ping'));
    assert(toolsData.activeTools.includes('server_plugin_ping'));

    // Hot reload via POST /plugins/reload fetching updated enabled list from Go
    enabledPackages = [{ id: 'reloaded-server-plugin', packageDir: pkgReloaded }];
    const reloadRes = await fetch(`${baseUrl}/plugins/reload`, {
      method: 'POST',
      headers,
      body: JSON.stringify({}),
    });
    assert.equal(reloadRes.status, 200);
    const reloadData = await reloadRes.json();
    assert.equal(reloadData.ok, true);
    assert.deepEqual(reloadData.packages.map((p) => p.id), ['reloaded-server-plugin']);

    const toolsAfterRes = await fetch(`${baseUrl}/tools`, { headers });
    const toolsAfterData = await toolsAfterRes.json();
    assert(!toolsAfterData.known.includes('server_plugin_ping'));
    assert(toolsAfterData.known.includes('server_plugin_reloaded'));
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise((resolve) => child.once('close', resolve));
    }
    opsServer.closeAllConnections();
    await new Promise((resolve) => opsServer.close(resolve));
  }
});

test('loads bundled beeftv-plugin-character-replacement extension tools and skill, and executes arrange + timeline splice', async () => {
  const pkgDir = path.resolve(
    path.dirname(new URL(import.meta.url).pathname),
    '../../plugin-packages/beeftv-plugin-character-replacement',
  );
  const errors = [];
  const result = await loadPluginExtensionsFromPackages({
    packages: [{ id: 'beeftv-plugin-character-replacement', packageDir: pkgDir }],
    onLoadError: (id, err) => errors.push({ id, err }),
  });

  assert.deepEqual(errors, []);
  assert.deepEqual(
    result.tools.map((t) => t.name),
    ['character_replacement_arrange', 'character_replacement_splice_timeline'],
  );
  assert(result.skills.some((s) => s.path.includes('character-replacement')));

  const arrangeTool = result.tools.find((t) => t.name === 'character_replacement_arrange');
  const spliceTool = result.tools.find((t) => t.name === 'character_replacement_splice_timeline');

  const executedOps = [];
  let rev = 1;
  let createdCount = 0;
  const canvasNodes = [
    {
      id: 'node-full-video',
      title: '全片视频',
      prompt: 'some text containing "revision": 999 to test structuredContent priority',
      metadata: { durationMs: 12000 },
    },
  ];
  const mockCtx = {
    async executeTool(toolName, params) {
      executedOps.push({ toolName, params });
      if (toolName === 'canvas_get') {
        return {
          structuredContent: {
            canvas: {
              revision: rev,
              nodes: canvasNodes,
              connections: [],
              timeline: {
                version: 2,
                durationMs: 12000,
                tracks: [{ id: 'track-sub', kind: 'subtitle', label: '字幕轨', order: 2, visible: true, muted: false }],
                clips: [{ id: 'sub-1', kind: 'subtitle', trackId: 'track-sub', nodeId: 'node-full-video', startMs: 500, durationMs: 2000, text: '字幕保留测试' }],
              },
            },
          },
          result: {
            content: [{ type: 'text', text: JSON.stringify({ canvas: { nodes: canvasNodes, revision: rev } }) }],
            structuredContent: {
              canvas: {
                revision: rev,
                nodes: canvasNodes,
                connections: [],
                timeline: {
                  version: 2,
                  durationMs: 12000,
                  tracks: [{ id: 'track-sub', kind: 'subtitle', label: '字幕轨', order: 2, visible: true, muted: false }],
                  clips: [{ id: 'sub-1', kind: 'subtitle', trackId: 'track-sub', nodeId: 'node-full-video', startMs: 500, durationMs: 2000, text: '字幕保留测试' }],
                },
              },
            },
          },
        };
      }
      if (toolName === 'canvas_nodes_create') {
        rev += 1;
        const created = params.nodes.map((n) => {
          createdCount += 1;
          const item = { id: `created-${createdCount}`, type: n.type, title: n.title };
          canvasNodes.push(item);
          return item;
        });
        return {
          structuredContent: { revision: rev, created },
          result: { structuredContent: { revision: rev, created } },
        };
      }
      if (toolName === 'canvas_node_configure' || toolName === 'canvas_edge_create') {
        rev += 1;
        return {
          structuredContent: { revision: rev },
          result: { structuredContent: { revision: rev } },
        };
      }
      if (toolName === 'canvas_timeline_update') {
        rev += 1;
        return {
          structuredContent: { revision: rev, updated: true },
          result: { structuredContent: { revision: rev, updated: true } },
        };
      }
      return { structuredContent: {}, result: {} };
    },
  };

  const arrangeRes = await arrangeTool.execute(
    {
      shotTitle: '镜头 3',
      sourceDescription: '右边的蓝衣女侠',
      targetDescription: '红衣女刺客林婉',
      position: 'right',
      genderHint: 'female',
      replacementScope: 'full-person',
      promptMode: 'positioning',
      sourceKeyframeNodeId: 'src-kf-1',
      targetCharacterNodeId: 'target-char-1',
      locationGuideNodeId: 'guide-1',
      sourceVideoNodeId: 'src-vid-1',
    },
    mockCtx,
    {},
  );
  assert.equal(arrangeRes.details.controlNodeId, 'created-1');
  assert.equal(arrangeRes.details.keyframeNodeId, 'created-2');
  assert.equal(arrangeRes.details.videoNodeId, 'created-3');
  assert(arrangeRes.details.keyframePrompt.includes('图3为人物定位图'));
  const videoCfg = executedOps.find(
    (c) => c.toolName === 'canvas_node_configure' && c.params.nodeId === 'created-3',
  );
  assert.equal(videoCfg.params.patch.videoEditOperation, 'replace_element');

  // Re-running arrange for the same shotTitle deduplicates node titles with #2
  const arrangeRes2 = await arrangeTool.execute(
    {
      shotTitle: '镜头 3',
      sourceDescription: '右边的蓝衣女侠',
      targetDescription: '红衣女刺客林婉',
    },
    mockCtx,
    {},
  );
  const secondCreateCall = executedOps.filter((c) => c.toolName === 'canvas_nodes_create')[1];
  assert.equal(secondCreateCall.params.nodes[0].title, '镜头 3 · 角色替换配置 #2');
  assert.equal(arrangeRes2.details.missingReferences.length, 3);

  const spliceRes = await spliceTool.execute(
    {
      fullVideoNodeId: 'node-full-video',
      keepOriginalAudio: true,
      replacements: [{ nodeId: 'created-3', startMs: 3000, endMs: 6500 }],
    },
    mockCtx,
    {},
  );
  assert.equal(spliceRes.details.fullDurationMs, 12000);
  assert.equal(spliceRes.details.clipCount, 5); // 3 video segments + 1 full audio clip + 1 preserved subtitle clip
  const timelineCall = executedOps.find((c) => c.toolName === 'canvas_timeline_update');
  assert.equal(timelineCall.params.timeline.version, 2);
  assert.equal(timelineCall.params.timeline.tracks.length, 3);
});

