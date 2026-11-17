export const READ_ONLY_PLUGIN_OPS = new Set([
    "canvas.get",
    "canvas.nodes.get",
    "canvas.search",
    "asset.list",
    "asset.get",
    "task.get",
    "task.wait",
    "canvas.generation.propose",
    "model.catalog",
    "generation.estimate",
    "media.overview",
    "media.inspect",
    "media.check",
    "media.review",
    "skill.catalog",
    "skill.get",
    "skill.file",
    "skill.market.search",
    "skill.market.get",
    "skill.market.file",
    "skill.publish.status",
    "project.media.search",
    "project.canvas.search",
]);

export type ResolvedPluginPermissions = {
    canReadAssets: boolean;
    canUploadAssets: boolean;
    canReadMedia: boolean;
    canReadCanvas: boolean;
    canWriteCanvas: boolean;
    canWriteTimeline: boolean;
    canWriteSkill: boolean;
    canRunText: boolean;
    canRunGeneration: boolean;
};

export function resolvePluginPermissions(perms: ReadonlySet<string>): ResolvedPluginPermissions {
    const canWriteCanvas = perms.has("canvas.write");
    return {
        canReadAssets: perms.has("asset.read") || perms.has("asset.search") || perms.has("asset.import"),
        canUploadAssets: perms.has("asset.upload") || perms.has("asset.import"),
        canReadMedia: perms.has("media.read") || perms.has("asset.read"),
        canReadCanvas: perms.has("canvas.read") || canWriteCanvas,
        canWriteCanvas,
        canWriteTimeline: perms.has("timeline.command") || perms.has("timeline.write") || canWriteCanvas,
        canWriteSkill: perms.has("skill.write") || canWriteCanvas,
        canRunText: perms.has("ai.text"),
        canRunGeneration: perms.has("generation.run"),
    };
}

export function assertPluginOpPermission(pluginId: string, perms: ReadonlySet<string>, op: string): void {
    const {
        canReadAssets,
        canUploadAssets,
        canReadMedia,
        canReadCanvas,
        canWriteCanvas,
        canWriteTimeline,
        canWriteSkill,
        canRunText,
        canRunGeneration,
    } = resolvePluginPermissions(perms);
    const canRunTextOrGen = canRunText || canRunGeneration;

    let allowed = false;
    if (op.startsWith("canvas.timeline.")) {
        allowed = canWriteTimeline;
    } else if (op === "canvas.generation.submit" || op === "canvas.generation.regenerate") {
        allowed = canRunGeneration;
    } else if (op === "canvas.generation.propose") {
        allowed = canRunGeneration || canWriteCanvas;
    } else if (op === "generation.estimate") {
        allowed = canRunGeneration || canReadCanvas;
    } else if (op === "canvas.get" || op === "canvas.nodes.get" || op === "canvas.search" || op === "project.canvas.search") {
        allowed = canReadCanvas;
    } else if (op.startsWith("canvas.") || op === "conversation.message.attach") {
        allowed = canWriteCanvas;
    } else if (op === "asset.list" || op === "asset.get" || op === "project.media.search") {
        allowed = canReadAssets;
    } else if (op.startsWith("asset.")) {
        allowed = canUploadAssets;
    } else if (op === "media.review") {
        allowed = canReadMedia && canRunTextOrGen;
    } else if (op === "media.overview" || op === "media.inspect" || op === "media.check") {
        allowed = canReadMedia;
    } else if (op.startsWith("media.")) {
        allowed = canWriteCanvas;
    } else if (op.startsWith("task.")) {
        allowed = READ_ONLY_PLUGIN_OPS.has(op) ? canReadCanvas || canRunTextOrGen : canRunGeneration || canWriteCanvas;
    } else if (op.startsWith("skill.")) {
        allowed = READ_ONLY_PLUGIN_OPS.has(op) ? canReadCanvas || canRunTextOrGen : canWriteSkill;
    } else if (op === "model.catalog") {
        allowed = canReadCanvas || canRunTextOrGen;
    }

    if (!allowed) {
        throw new Error(`插件 ${pluginId} 缺少执行操作 ${op} 的权限`);
    }
}
