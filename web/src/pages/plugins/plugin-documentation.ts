import type { PluginManifest, PluginManifestV2 } from "@/lib/plugins/plugin-types";

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

    const capabilities = manifest.permissions.map((permission) => PLUGIN_PERMISSION_LABELS[permission] || permission);
    return [
        `# ${manifest.name}`,
        "",
        manifest.description || "该插件没有提供简介。",
        "",
        "## 插件信息",
        "",
        `- 作者：${manifest.author || "未声明"}`,
        `- 版本：${manifest.version}`,
        `- 能力：${capabilities.join("、") || "未声明"}`,
        "",
        manifest.contributes.providers?.length
            ? "> 此插件没有提供接入文档。请联系插件作者补充 `documentation`，不要仅凭清单字段推测上游接口。"
            : "> 该插件当前没有单独的使用文档。",
    ].join("\n");
}
