export const PLUGIN_API_VERSION = "beeftv.plugin/v1";
export const PLUGIN_API_VERSION_V2 = "beeftv.plugin/v2";
export const PLUGIN_API_VERSION_V3 = "beeftv.plugin/v3";

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
 * 定义 pi 助手扩展入口函数。
 * @param {(pi: import("./index.d.ts").PiExtensionAPI) => void | Promise<void>} register
 */
export function definePiExtension(register) {
  return register;
}

export default definePlugin;
