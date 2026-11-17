import type { ImageCapabilityConfig } from "./model-capabilities";

// 与后端 providerpreset.SeedreamFamily 保持同一套识别规则：国内官方型号带
// doubao- 前缀，国际版带 dola- 前缀，去掉前缀后再分族，5.5 / Pro / Flash 必须排在通用 5.0 之前。
export function seedreamFamily(model = "") {
    const name = (model.split("::").pop() || "").trim().toLowerCase().replace(/^(?:doubao|dola)-/, "");
    if (!name.startsWith("seedream-")) return "";
    const suffix = name.slice("seedream-".length);
    if (suffix.startsWith("5-5-") || suffix.startsWith("5.5")) return "5.5";
    if (suffix.startsWith("5-0-pro-")) return "pro";
    if (suffix.startsWith("5-0-flash-")) return "flash";
    if (suffix.startsWith("5-0-")) return "lite";
    if (suffix.startsWith("4-5-")) return "4.5";
    if (suffix.startsWith("4-0-")) return "4.0";
    return "";
}

export function seedreamImageCapability(model: string): ImageCapabilityConfig | undefined {
    const family = seedreamFamily(model);
    if (!family) return;
    const modern = family === "5.5" || family === "pro" || family === "flash";
    return {
        references: { promptMaxChars: 32000, maxImages: modern ? 10 : 14, maxImageBytes: 30 * 1024 * 1024, maskSupported: false },
        size: { parameter: "size", values: modern ? ["1K", "1.5K", "2K"] : family === "lite" ? ["2K", "3K", "4K"] : family === "4.0" ? ["1K", "2K", "4K"] : ["2K", "4K"], default: "2K", allowCustom: true },
        quality: { supported: false, values: [], default: "auto" },
        transparentBackground: { supported: modern, default: false },
        sequentialGeneration: { supported: !modern, default: false },
        responseFormat: { supported: true }, outputFormat: { supported: modern || family === "lite" }, maxOutputs: 15,
    };
}
