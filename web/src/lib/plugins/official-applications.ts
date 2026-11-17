import { EDITOR_SHELL_PLUGIN_ID } from "@/lib/plugins/builtin/editor/editor-shell";

/**
 * Built-in official applications whose policy stays hardcoded in Go (`officialApplicationPolicies`).
 * Migrated community plugins (`eagle-asset-connector`, `prompt-optimizer`, `ai-art-critique`, `media-conversion`)
 * are distributed via `beeftv-plugins` and installed on demand as user-managed packages.
 */
export const OFFICIAL_APPLICATION_PLUGIN_IDS = [
    EDITOR_SHELL_PLUGIN_ID,
] as const;

export const BUILTIN_APPLICATION_PLUGIN_IDS = new Set<string>(OFFICIAL_APPLICATION_PLUGIN_IDS);

export function isOfficialApplicationPluginId(pluginId: string): boolean {
    return BUILTIN_APPLICATION_PLUGIN_IDS.has(pluginId.trim());
}
