// BeefTV 插件包运行时装配：单包隔离解析、pi 扩展工具桥接、内置 npm 与镜像源切换。
// 严格只从 Go 明确启用的插件包目录加载扩展，不扫描 ~/.agents/skills，不读取全局 settings.json。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DefaultPackageManager, SettingsManager, discoverAndLoadExtensions } from '@earendil-works/pi-coding-agent';
import { defineExtension, defineTool } from '@earendil-works/pi-durable';

export const DEFAULT_CN_NPM_REGISTRY = 'https://registry.npmmirror.com';
export const DEFAULT_GLOBAL_NPM_REGISTRY = 'https://registry.npmjs.org';
export const NPM_SEARCH_REGISTRY = 'https://registry.npmjs.org';

const READ_ONLY_SAFE_TOOLS = new Set([
  'canvas_get',
  'canvas_search',
  'media_overview',
  'media_inspect',
  'media_check',
  'media_review',
  'plan_update',
  'skill_get',
  'skill_catalog',
  'asset_get',
  'asset_list',
]);

function normalizeRegistryValue(raw) {
  const value = String(raw || '').trim().replace(/\/+$/, '');
  if (!value) return '';
  if (value === 'global' || value === 'npmjs') return DEFAULT_GLOBAL_NPM_REGISTRY;
  if (value === 'cn' || value === 'npmmirror') return DEFAULT_CN_NPM_REGISTRY;
  return value;
}

export function resolveRegistryUrl(options = {}) {
  if (typeof options === 'string') {
    return normalizeRegistryValue(options) || DEFAULT_CN_NPM_REGISTRY;
  }
  const env = options?.env || process.env;
  const explicit = normalizeRegistryValue(options?.registryUrl);
  if (explicit) return explicit;
  const fromEnv = normalizeRegistryValue(env?.BEEFTV_NPM_REGISTRY);
  if (fromEnv) return fromEnv;
  const locale = String(options?.locale || env?.BEEFTV_LOCALE || '').trim().toLowerCase();
  if (locale.startsWith('en')) return DEFAULT_GLOBAL_NPM_REGISTRY;
  return DEFAULT_CN_NPM_REGISTRY;
}

export function resolveBundledNpmCliPath({
  execPath = process.execPath,
  platform = process.platform,
  existsSync = fs.existsSync,
} = {}) {
  const execDir = path.dirname(path.resolve(execPath));
  const unixCandidate = path.resolve(execDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const winCandidate = path.resolve(execDir, 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const candidates = platform === 'win32' ? [winCandidate, unixCandidate] : [unixCandidate, winCandidate];
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) return candidate;
    } catch {
      // Ignore inaccessible path candidates.
    }
  }
  return null;
}

export function resolveNpmCommand(options = {}) {
  const registryUrl = resolveRegistryUrl(options);
  const execPath = options?.execPath || process.execPath;
  const bundledNpmCliPath = resolveBundledNpmCliPath({
    execPath,
    platform: options?.platform,
    existsSync: options?.existsSync,
  });
  const flags = [`--registry=${registryUrl}`, '--no-audit', '--no-fund'];
  if (bundledNpmCliPath) {
    return [execPath, bundledNpmCliPath, ...flags];
  }
  return ['npm', ...flags];
}

export function createPluginPackageManager({
  cwd,
  agentDir,
  registryUrl,
  locale,
  execPath,
  platform,
  existsSync,
  env = process.env,
} = {}) {
  const resolvedRegistryUrl = resolveRegistryUrl({ registryUrl, locale, env });
  const npmCommand = resolveNpmCommand({
    registryUrl: resolvedRegistryUrl,
    locale,
    execPath,
    platform,
    existsSync,
    env,
  });
  const resolvedCwd = cwd ? path.resolve(cwd) : process.cwd();
  const resolvedAgentDir = agentDir ? path.resolve(agentDir) : path.join(resolvedCwd, '.no-global-extensions');
  const settingsManager = SettingsManager.inMemory({ npmCommand });
  const packageManager = new DefaultPackageManager({
    cwd: resolvedCwd,
    agentDir: resolvedAgentDir,
    settingsManager,
  });
  return {
    packageManager,
    settingsManager,
    npmCommand,
    registryUrl: resolvedRegistryUrl,
  };
}

export function normalizePluginToolResult(rawResult) {
  if (rawResult == null) {
    return { output: [] };
  }
  if (typeof rawResult === 'string') {
    return { output: [{ type: 'text', text: rawResult }] };
  }
  if (typeof rawResult !== 'object') {
    return { output: [{ type: 'text', text: String(rawResult) }] };
  }
  const { content, output, ...rest } = rawResult;
  const normalizedOutput = Array.isArray(output)
    ? output
    : Array.isArray(content)
      ? content
      : typeof content === 'string'
        ? [{ type: 'text', text: content }]
        : [];
  return {
    ...rest,
    output: normalizedOutput,
  };
}

function extractEnabledResourcePaths(resources) {
  if (!Array.isArray(resources)) return [];
  return resources
    .filter((item) => item && (typeof item === 'string' || item.enabled !== false))
    .map((item) => (typeof item === 'string' ? item : item.path))
    .filter((p) => typeof p === 'string' && p.length > 0);
}

function validateDeclaredManifestExtensions(packageDir, packageJson) {
  const declared = packageJson?.pi?.extensions;
  if (!Array.isArray(declared)) return null;
  for (const entry of declared) {
    if (typeof entry !== 'string') continue;
    const trimmed = entry.trim();
    if (!trimmed || trimmed.startsWith('!') || trimmed.startsWith('+') || trimmed.startsWith('-') || /[*?[\]{}]/.test(trimmed)) {
      continue;
    }
    const target = path.resolve(packageDir, trimmed);
    if (!fs.existsSync(target)) {
      return `Extension entry declared in package.json does not exist: ${trimmed}`;
    }
  }
  return null;
}

export async function loadPluginExtensionsFromPackages({
  packages = [],
  reservedToolNames = new Set(),
  onLoadError = null,
  readOnly = false,
  isReadOnly = null,
  isReadOnlyTool = null,
  registryUrl,
  locale,
  execPath,
  platform,
  existsSync,
  env = process.env,
} = {}) {
  const reserved = new Set(
    reservedToolNames instanceof Set
      ? [...reservedToolNames]
      : Array.isArray(reservedToolNames)
        ? reservedToolNames
        : [],
  );
  const registeredByPlugin = new Map();
  const loadedPackages = [];
  const durableExtensions = [];
  const durableTools = [];
  const discoveredSkills = [];
  const errors = [];

  async function reportLoadError(pluginId, message) {
    const errorText = String(message?.message || message || 'Unknown plugin load error');
    const id = String(pluginId || '<unknown>');
    errors.push({ pluginId: id, error: errorText });
    if (typeof onLoadError === 'function') {
      try {
        await onLoadError(id, errorText);
      } catch {
        // Reporting callback errors must not abort remaining healthy plugins.
      }
    }
  }

  for (const pkg of Array.isArray(packages) ? packages : []) {
    const pluginId = String(pkg?.id || pkg?.name || '').trim();
    const packageDir = pkg?.packageDir ? path.resolve(String(pkg.packageDir)) : '';
    if (!pluginId || !packageDir) {
      await reportLoadError(pluginId || packageDir || '<invalid>', 'Plugin package requires both id and packageDir');
      continue;
    }
    const packageJsonPath = path.join(packageDir, 'package.json');
    if (!fs.existsSync(packageDir) || !fs.existsSync(packageJsonPath)) {
      await reportLoadError(pluginId, `Plugin package.json not found in ${packageDir}`);
      continue;
    }
    let packageJson;
    try {
      packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    } catch (error) {
      await reportLoadError(pluginId, `Invalid package.json in ${packageDir}: ${error?.message || error}`);
      continue;
    }
    const manifestEntryError = validateDeclaredManifestExtensions(packageDir, packageJson);
    if (manifestEntryError) {
      await reportLoadError(pluginId, manifestEntryError);
      continue;
    }

    const isolatedAgentDir = path.join(packageDir, '.no-global-extensions');
    const { packageManager } = createPluginPackageManager({
      cwd: packageDir,
      agentDir: isolatedAgentDir,
      registryUrl,
      locale,
      execPath,
      platform,
      existsSync,
      env,
    });

    let resolved;
    try {
      resolved = await packageManager.resolveExtensionSources([packageDir]);
    } catch (error) {
      await reportLoadError(pluginId, `Failed to resolve package resources: ${error?.message || error}`);
      continue;
    }

    const extensionPaths = extractEnabledResourcePaths(resolved?.extensions);
    const skillPaths = extractEnabledResourcePaths(resolved?.skills);

    let loaded;
    try {
      loaded = await discoverAndLoadExtensions(extensionPaths, packageDir, isolatedAgentDir);
    } catch (error) {
      await reportLoadError(pluginId, `Failed to load extensions: ${error?.message || error}`);
      continue;
    }

    if (Array.isArray(loaded?.errors) && loaded.errors.length > 0) {
      const combined = loaded.errors.map((item) => item?.error || String(item)).join('; ');
      await reportLoadError(pluginId, combined);
      continue;
    }

    const candidateDefs = [];
    let validationError = null;
    for (const ext of loaded?.extensions || []) {
      const rawTools = ext?.tools instanceof Map
        ? [...ext.tools.values()]
        : Array.isArray(ext?.tools)
          ? ext.tools
          : [];
      for (const entry of rawTools) {
        const def = entry?.definition || entry;
        const toolName = String(def?.name || '').trim();
        if (!toolName || typeof def?.execute !== 'function') {
          validationError = `Invalid tool definition in plugin "${pluginId}"`;
          break;
        }
        if (reserved.has(toolName)) {
          validationError = `Tool "${toolName}" in plugin "${pluginId}" conflicts with reserved tool "${toolName}"`;
          break;
        }
        if (registeredByPlugin.has(toolName)) {
          validationError = `Tool "${toolName}" in plugin "${pluginId}" conflicts with tool from plugin "${registeredByPlugin.get(toolName)}"`;
          break;
        }
        if (candidateDefs.some((item) => item.name === toolName)) {
          validationError = `Duplicate tool "${toolName}" within plugin "${pluginId}"`;
          break;
        }
        candidateDefs.push(def);
      }
      if (validationError) break;
    }

    if (validationError) {
      await reportLoadError(pluginId, validationError);
      continue;
    }

    const packageTools = candidateDefs.map((def) => {
      registeredByPlugin.set(def.name, pluginId);
      const durableTool = defineTool({
        name: def.name,
        description: String(def.description || def.label || def.name),
        parameters: def.parameters && typeof def.parameters === 'object' && !Array.isArray(def.parameters)
          ? def.parameters
          : { type: 'object', properties: {} },
        replay: def.replay === 'safe' ? 'safe' : 'unsafe',
        executionMode: 'sequential',
        execute: async (args, api, context = {}) => {
          const checkReadOnly = () => Boolean(
            readOnly ||
            env?.BEEFTV_AGENT_READ_ONLY === '1' ||
            process.env.BEEFTV_AGENT_READ_ONLY === '1' ||
            (typeof isReadOnly === 'function' && isReadOnly()) ||
            context?.permissionMode === 'read-only' ||
            api?.permissionMode === 'read-only',
          );
          const checkAllowedInReadOnly = (targetToolName) => {
            if (typeof context?.isReadOnlyTool === 'function') return Boolean(context.isReadOnlyTool(targetToolName));
            if (typeof isReadOnlyTool === 'function') return Boolean(isReadOnlyTool(targetToolName));
            return READ_ONLY_SAFE_TOOLS.has(targetToolName);
          };
          const executeTool = async (toolName, params = {}, options = {}) => {
            const target = String(toolName || '').trim();
            if (!target) throw new Error('invalid_tool_name');
            if (checkReadOnly() && !checkAllowedInReadOnly(target)) {
              const err = new Error(`scope_denied: 本轮助手只能读取（禁止调用 ${target}）`);
              err.reason = 'scope_denied';
              throw err;
            }
            if (typeof api?.executeTool !== 'function') {
              const err = new Error(`tool_execution_unavailable: ${target}`);
              err.reason = 'tool_execution_unavailable';
              throw err;
            }
            const reply = await api.executeTool(target, params, context, options);
            if (reply?.isError) {
              const rawMessage = reply.diagnostics?.map((d) => d.message || '').filter(Boolean).join('; ')
                || reply.error
                || `tool_error: ${target}`;
              const isReadOnlyBlocked = checkReadOnly() && (
                rawMessage.includes('scope_denied') ||
                rawMessage.includes('not available') ||
                rawMessage.includes('tool_unavailable')
              );
              const message = isReadOnlyBlocked && !rawMessage.includes('scope_denied')
                ? `scope_denied: 本轮助手只能读取（禁止调用 ${target}）`
                : rawMessage;
              const err = new Error(message);
              if (message.includes('scope_denied')) err.reason = 'scope_denied';
              err.isError = true;
              err.details = reply;
              throw err;
            }
            if (reply && typeof reply === 'object' && !reply.content && typeof reply.structuredOutput === 'string') {
              return { ...reply, content: [{ type: 'text', text: reply.structuredOutput }] };
            }
            return reply;
          };
          const reportProgress = (progress) => (typeof api?.details === 'function'
            ? api.details({ beeftvProgress: progress }, context)
            : undefined);
          const ctx = {
            cwd: packageDir,
            signal: context?.abortSignal,
            pluginId,
            executeTool,
            reportProgress,
          };
          const onUpdate = Object.assign((update) => reportProgress(update), ctx);
          const toolCallId = String(api?.callId || api?.taskId || `plugin:${pluginId}:${def.name}`);
          const rawResult = await def.execute(toolCallId, args || {}, context?.abortSignal, onUpdate, ctx);
          return normalizePluginToolResult(rawResult);
        },
      });
      return Object.assign(durableTool, {
        label: def.label || def.name,
        pluginId,
        packageDir,
        readOnly: def.readOnly === true,
      });
    });

    if (packageTools.length > 0) {
      const sanitizedId = pluginId.replace(/[^a-zA-Z0-9._-]/g, '_');
      const ext = defineExtension({
        name: `beeftv.plugin.${sanitizedId}`,
        tools: packageTools,
      });
      durableExtensions.push(ext);
      durableTools.push(...packageTools);
    }

    for (const skillPath of skillPaths) {
      discoveredSkills.push({ pluginId, path: skillPath, packageDir });
    }

    loadedPackages.push({
      id: pluginId,
      name: String(pkg?.name || packageJson?.name || pluginId),
      version: String(pkg?.version || packageJson?.version || '0.0.0'),
      packageDir,
      tools: packageTools.map((t) => t.name),
      skills: skillPaths,
      extensionPaths,
    });
  }

  return {
    extensions: durableExtensions,
    tools: durableTools,
    packages: loadedPackages,
    skills: discoveredSkills,
    errors,
  };
}

export function stagePluginPackage({
  source,
  targetDir,
  registryUrl,
  locale,
  execPath = process.execPath,
  platform = process.platform,
  existsSync = fs.existsSync,
  env = process.env,
  spawnImpl = spawnSync,
} = {}) {
  const cleanSource = String(source || '').trim();
  const cleanTarget = targetDir ? path.resolve(String(targetDir)) : '';
  if (!cleanSource || !cleanTarget) {
    throw Object.assign(new Error('invalid_stage_request: source and targetDir are required'), { reason: 'invalid_request' });
  }
  const resolvedRegistryUrl = resolveRegistryUrl({ registryUrl, locale, env });
  const npmCommand = resolveNpmCommand({
    registryUrl: resolvedRegistryUrl,
    locale,
    execPath,
    platform,
    existsSync,
    env,
  });
  fs.mkdirSync(cleanTarget, { recursive: true });
  const rootPkgJson = path.join(cleanTarget, 'package.json');
  if (!fs.existsSync(rootPkgJson)) {
    fs.writeFileSync(rootPkgJson, JSON.stringify({ name: 'beeftv-plugin-stage', private: true }, null, 2));
  }
  const [command, ...baseArgs] = npmCommand;
  const args = [...baseArgs, 'install', '--prefix', cleanTarget, cleanSource];
  const result = spawnImpl(command, args, {
    cwd: cleanTarget,
    encoding: 'utf8',
    timeout: 180000,
    env: { ...env, npm_config_registry: resolvedRegistryUrl },
  });
  if (result.error || result.status !== 0) {
    const detail = result.error?.message || result.stderr || result.stdout || 'npm install failed';
    throw Object.assign(new Error(`plugin_stage_failed: ${detail.trim()}`), { reason: 'plugin_stage_failed' });
  }
  return {
    ok: true,
    source: cleanSource,
    targetDir: cleanTarget,
    registryUrl: resolvedRegistryUrl,
    npmCommand,
  };
}

export async function searchNpmPlugins({
  query = '',
  size = 20,
  fetchImpl = globalThis.fetch,
} = {}) {
  const cleanQuery = String(query || '').trim();
  const text = cleanQuery ? `keywords:beeftv-plugin ${cleanQuery}` : 'keywords:beeftv-plugin';
  const clampedSize = Math.max(1, Math.min(Number(size) || 20, 100));
  const url = `${NPM_SEARCH_REGISTRY}/-/v1/search?text=${encodeURIComponent(text)}&size=${clampedSize}`;
  const response = await fetchImpl(url, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    throw Object.assign(new Error(`npm_search_failed: HTTP ${response.status}`), { reason: 'npm_search_failed' });
  }
  const payload = await response.json();
  const objects = Array.isArray(payload?.objects) ? payload.objects : [];
  return {
    registryUrl: NPM_SEARCH_REGISTRY,
    total: Number(payload?.total ?? objects.length),
    objects,
    packages: objects.map((item) => item?.package).filter(Boolean),
  };
}

export function createPluginPackageController({
  getReservedToolNames = () => new Set(),
  readOnly = false,
  isReadOnly = null,
  isReadOnlyTool = null,
  fetchEnabledPackages = null,
  reportLoadError = null,
  registryUrl,
  locale,
  execPath,
  env = process.env,
} = {}) {
  let currentRegistryUrl = resolveRegistryUrl({ registryUrl, locale, env });
  let loadedPackages = [];
  let loadedExtensions = [];
  let loadedTools = [];
  let loadedSkills = [];
  let loadErrors = [];

  async function reload(explicitPackages = undefined, options = {}) {
    if (options?.registryUrl) {
      currentRegistryUrl = resolveRegistryUrl({ registryUrl: options.registryUrl, locale, env });
    }
    let packages = explicitPackages;
    if (!Array.isArray(packages)) {
      if (typeof fetchEnabledPackages === 'function') {
        packages = await fetchEnabledPackages();
      } else {
        packages = [];
      }
    }
    const reservedToolNames = typeof getReservedToolNames === 'function'
      ? getReservedToolNames()
      : getReservedToolNames;
    const result = await loadPluginExtensionsFromPackages({
      packages,
      reservedToolNames,
      onLoadError: reportLoadError,
      readOnly,
      isReadOnly,
      isReadOnlyTool,
      registryUrl: currentRegistryUrl,
      locale,
      execPath,
      env,
    });
    loadedPackages = result.packages;
    loadedExtensions = result.extensions;
    loadedTools = result.tools;
    loadedSkills = result.skills;
    loadErrors = result.errors;
    return {
      packages: loadedPackages,
      extensions: loadedExtensions,
      tools: loadedTools,
      skills: loadedSkills,
      errors: loadErrors,
      registryUrl: currentRegistryUrl,
    };
  }

  return {
    reload,
    reloadFromHost: (options) => reload(undefined, options),
    getExtensions: () => [...loadedExtensions],
    getTools: () => [...loadedTools],
    getToolNames: () => loadedTools.map((tool) => tool.name),
    getSkills: () => [...loadedSkills],
    listLoaded: () => [...loadedPackages],
    getErrors: () => [...loadErrors],
    getRegistryUrl: () => currentRegistryUrl,
    setRegistryUrl: (nextUrl) => {
      currentRegistryUrl = resolveRegistryUrl({ registryUrl: nextUrl, locale, env });
      return currentRegistryUrl;
    },
  };
}
