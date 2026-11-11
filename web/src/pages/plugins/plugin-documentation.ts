import type { PluginManifest, PluginManifestV2, RegisteredPlugin } from "@/lib/plugins/plugin-types";
import { isOfficialApplicationPluginId } from "@/lib/plugins/official-applications";
import { MEDIA_CONVERSION_PLUGIN_ID } from "@/lib/plugins/builtin/media-conversion";

export const PLUGIN_ORIGIN_LABELS = { official: "官方", custom: "自定义", thirdParty: "第三方" };

export function pluginOrigin(plugin: RegisteredPlugin): keyof typeof PLUGIN_ORIGIN_LABELS {
    if (plugin.source === "uploaded" || plugin.source === "local") return "custom";
    if (["bundled", "official", "system"].includes(plugin.source || "")) return "official";
    if (!plugin.source && (isOfficialApplicationPluginId(plugin.manifest.id) || plugin.manifest.id === MEDIA_CONVERSION_PLUGIN_ID)) return "official";
    return "thirdParty";
}

export const PLUGIN_PERMISSION_LABELS: Record<string, string> = {
    "canvas.read": "读取画布",
    "canvas.write": "修改画布",
    "asset.read": "读取素材",
    "asset.search": "搜索素材",
    "asset.import": "导入素材",
    "asset.upload": "上传素材",
    "generation.run": "调用生成",
    "ai.text": "调用已配置的文本/视觉理解模型",
    "media.read": "读取输入媒体",
    "usage.read": "读取用量",
    "external.open": "打开外部详情",
    "ui.slot": "挂载界面扩展位",
    "settings.write": "写入插件模型渠道设置",
    "timeline.read": "读取时间线",
    "timeline.command": "修改时间线",
    "export.run": "导出",
};

export function getPluginDocumentation(manifest: PluginManifest | PluginManifestV2) {
    if (manifest.documentation?.trim()) return manifest.documentation.trim();

    return manifest.contributes.providers?.length
        ? "此插件未提供接入说明，请联系插件作者获取。"
        : "此插件未提供单独的使用说明。";
}
