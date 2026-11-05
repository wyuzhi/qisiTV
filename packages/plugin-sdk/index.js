export const BEEFTV_SLOTS = Object.freeze([
  "canvas.node",
  "canvas.addNodeMenu",
  "canvas.toolbar.main",
  "canvas.toolbar.selection",
  "canvas.toolbar.nodeHover",
  "canvas.contextMenu",
  "canvas.nodePanel",
  "canvas.promptActions",
  "canvas.sidePanel",
  "generation.beforeSubmit",
  "editor.timeline-panel",
  "editor.preview-renderer",
  "editor.inspector",
  "editor.asset-ingest",
  "editor.subtitle-tool",
  "editor.transcription-provider",
  "editor.export-renderer",
  "editor.ai-assistant",
  "assets.source",
  "assets.itemActions",
  "app.page",
  "app.sidebar",
  "app.command",
  "app.settings",
  "pluginCenter.section",
  "project.view",
  "assistant.toolCard",
]);

export const BEEFTV_EVENTS = Object.freeze([
  "generation.submitted",
  "generation.completed",
  "generation.failed",
  "assets.imported",
  "assistant.turnCompleted",
]);

/**
 * 定义 BeefTV 客户端插件入口函数。
 * @param {(host: import("./index.d.ts").BeefTVPluginHost) => void | (() => void) | Promise<void | (() => void)>} activate
 */
export function definePlugin(activate) {
  return activate;
}

/**
 * 定义插件的 JS 生成接口（submit / query），给清单里 providers[].module 指向的文件用。
 * @template {import("./index.d.ts").ProviderModule} T
 * @param {T} module
 * @returns {T}
 */
export function defineProvider(module) {
  return module;
}

/**
 * 定义 pi 助手扩展入口函数。
 * @param {(pi: import("./index.d.ts").PiExtensionAPI) => void | Promise<void>} register
 */
export function definePiExtension(register) {
  return register;
}

export default definePlugin;
