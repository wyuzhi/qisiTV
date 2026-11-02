// BeefTV 插件包运行时装配：单包隔离解析与 pi 扩展工具桥接。
// 严格只从 Go 明确启用的插件包目录加载扩展，不扫描 ~/.agents/skills，不读取全局 settings.json。
// 下载与安装由 Go 负责；读写权限由 Durable 宿主按 Go 的操作描述把关，这里不再重复判断。
import fs from 'node:fs';
import path from 'node:path';
import { DefaultPackageManager, SettingsManager, discoverAndLoadExtensions } from '@earendil-works/pi-coding-agent';
import { defineExtension, defineTool } from '@earendil-works/pi-durable';

export function createPluginPackageManager({ cwd, agentDir } = {}) {
  const resolvedCwd = cwd ? path.resolve(cwd) : process.cwd();
  const resolvedAgentDir = agentDir ? path.resolve(agentDir) : path.join(resolvedCwd, '.no-global-extensions');
  const settingsManager = SettingsManager.inMemory({});
  return {
    packageManager: new DefaultPackageManager({ cwd: resolvedCwd, agentDir: resolvedAgentDir, settingsManager }),
    settingsManager,
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
    const { packageManager } = createPluginPackageManager({ cwd: packageDir, agentDir: isolatedAgentDir });

    let resolved;
    try {
      resolved = await packageManager.resolveExtensionSources([packageDir]);
    } catch (error) {
      await reportLoadError(pluginId, `Failed to resolve package resources: ${error?.message || error}`);
      continue;
    }

    // With no agent resources declared, pi falls back to scanning the whole
    // package as an extension directory, which would run a BeefTV plugin's web
    // client here. A BeefTV plugin's agent side is only what it declares.
    const extensionPaths = extractEnabledResourcePaths(resolved?.extensions)
      .filter((entry) => !(packageJson.beeftv && path.resolve(entry) === packageDir));
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
          const executeTool = async (toolName, params = {}, options = {}) => {
            const target = String(toolName || '').trim();
            if (!target) throw new Error('invalid_tool_name');
            if (typeof api?.executeTool !== 'function') {
              const err = new Error(`tool_execution_unavailable: ${target}`);
              err.reason = 'tool_execution_unavailable';
              throw err;
            }
            const reply = await api.executeTool(target, params, context, options);
            if (reply?.isError) {
              const message = reply.diagnostics?.map((d) => d.message || '').filter(Boolean).join('; ')
                || reply.error
                || `tool_error: ${target}`;
              const err = new Error(message);
              err.isError = true;
              err.details = reply;
              throw err;
            }
            const rawContent = Array.isArray(reply?.content)
              ? reply.content
              : Array.isArray(reply?.output)
                ? reply.output
                : Array.isArray(reply?.result?.content)
                  ? reply.result.content
                  : typeof reply?.structuredOutput === 'string'
                    ? [{ type: 'text', text: reply.structuredOutput }]
                    : reply?.structuredOutput && typeof reply.structuredOutput === 'object'
                      ? [{ type: 'text', text: JSON.stringify(reply.structuredOutput) }]
                      : [];
            const combinedText = rawContent
              .map((part) => (part && typeof part.text === 'string' ? part.text : ''))
              .join('');
            let parsedStructured =
              reply?.structuredContent ??
              reply?.result?.structuredContent ??
              (typeof reply?.structuredOutput === 'object' ? reply.structuredOutput : undefined);
            if (!parsedStructured && combinedText) {
              try {
                parsedStructured = JSON.parse(combinedText);
              } catch {
                // non-JSON text tool output
              }
            }
            const flattenedStructured =
              parsedStructured &&
              typeof parsedStructured === 'object' &&
              !Array.isArray(parsedStructured) &&
              parsedStructured.result &&
              typeof parsedStructured.result === 'object' &&
              !Array.isArray(parsedStructured.result)
                ? { ...parsedStructured, ...parsedStructured.result }
                : parsedStructured;
            const normalizedResult = {
              ...(reply?.result && typeof reply.result === 'object' ? reply.result : {}),
              ...(flattenedStructured && typeof flattenedStructured === 'object' ? flattenedStructured : {}),
              content: rawContent,
              structuredContent: flattenedStructured,
            };
            return {
              ...(reply && typeof reply === 'object' ? reply : {}),
              isError: Boolean(reply?.isError),
              content: rawContent,
              output: rawContent,
              structuredContent: flattenedStructured,
              result: normalizedResult,
            };
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

export function createPluginPackageController({
  getReservedToolNames = () => new Set(),
  fetchEnabledPackages = null,
  reportLoadError = null,
} = {}) {
  let loadedPackages = [];
  let loadedExtensions = [];
  let loadedTools = [];
  let loadedSkills = [];
  let loadErrors = [];
  let lastPackagesFingerprint = null;

  function computeFingerprint(pkgs) {
    if (!Array.isArray(pkgs)) return '';
    return pkgs
      .map((p) => `${p?.id || p?.name || ''}:${p?.version || ''}:${p?.packageDir || ''}`)
      .sort()
      .join('|');
  }

  async function reload(explicitPackages = undefined) {
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
    });
    loadedPackages = result.packages;
    loadedExtensions = result.extensions;
    loadedTools = result.tools;
    loadedSkills = result.skills;
    loadErrors = result.errors;
    lastPackagesFingerprint = computeFingerprint(packages);
    return {
      packages: loadedPackages,
      extensions: loadedExtensions,
      tools: loadedTools,
      skills: loadedSkills,
      errors: loadErrors,
    };
  }

  return {
    reload,
    reloadFromHost: () => reload(undefined),
    syncIfChanged: async () => {
      if (typeof fetchEnabledPackages !== 'function') {
        return { changed: false, extensions: loadedExtensions };
      }
      let packages;
      try {
        packages = await fetchEnabledPackages();
      } catch {
        return { changed: false, extensions: loadedExtensions };
      }
      const nextFingerprint = computeFingerprint(packages);
      if (nextFingerprint === lastPackagesFingerprint) {
        return { changed: false, extensions: loadedExtensions };
      }
      const res = await reload(packages);
      return { changed: true, ...res };
    },
    getExtensions: () => [...loadedExtensions],
    getTools: () => [...loadedTools],
    getToolNames: () => loadedTools.map((tool) => tool.name),
    getSkills: () => [...loadedSkills],
    listLoaded: () => [...loadedPackages],
    getErrors: () => [...loadErrors],
  };
}
