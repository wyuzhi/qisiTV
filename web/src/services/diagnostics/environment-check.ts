import { http } from "@/services/api/request";
import { isBrowserWorkspace } from "@/services/browser-workspace";
import { getDesktopBootSnapshot } from "@/services/workspace-startup-state";

export type EnvironmentCheck = { id: string; title: string; status: "pass" | "warning" | "error" | "repaired" | "skipped" | "unknown"; detail: string; cases: string[] };
export type EnvironmentReport = { checkedAt: string; os: string; arch: string; catalog: { repository: string; revision: string; cases: { id: string; title: string; status: string }[] }; checks: EnvironmentCheck[] };

export { browserChecks, browserCapabilities } from "./browser-environment";

export function desktopTransportChecks(transportMode = getDesktopBootSnapshot().transportMode): EnvironmentCheck[] {
    if (transportMode === "same-origin-fallback") {
        return [
            {
                id: "desktop-loopback",
                title: "桌面本地直连通道",
                status: "warning",
                detail: "本机回环端口（127.0.0.1）直连受阻，已自动切换至窗口内同源通道运行；部分实时流已改为轮询更新，可在防火墙或安全软件中放行本应用。",
                cases: [],
            },
        ];
    }
    if (transportMode === "loopback") {
        return [
            {
                id: "desktop-loopback",
                title: "桌面本地直连通道",
                status: "pass",
                detail: "本机回环流式通道连接正常。",
                cases: [],
            },
        ];
    }
    return [];
}

export async function checkEnvironment(repair = false, signal?: AbortSignal): Promise<EnvironmentReport> {
    if (signal?.aborted) throw new DOMException("检查已取消", "AbortError");
    // Callers append browser capability/storage probes. Native directory and
    // media-runtime inspection is opt-in with an active local engine.
    if (isBrowserWorkspace()) return { checkedAt: new Date().toISOString(), os: "browser", arch: "unknown", catalog: { repository: "", revision: "", cases: [] }, checks: [] };
    return http.post<EnvironmentReport>("/diagnostics/environment", { repair }, { signal });
}
