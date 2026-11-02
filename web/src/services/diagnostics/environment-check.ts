import { http } from "@/services/api/request";
import { isBrowserWorkspace } from "@/services/browser-workspace";

export type EnvironmentCheck = { id: string; title: string; status: "pass" | "warning" | "error" | "repaired" | "skipped" | "unknown"; detail: string; cases: string[] };
export type EnvironmentReport = { checkedAt: string; os: string; arch: string; catalog: { repository: string; revision: string; cases: { id: string; title: string; status: string }[] }; checks: EnvironmentCheck[] };

export { browserChecks, browserCapabilities } from "./browser-environment";

export async function checkEnvironment(repair = false, signal?: AbortSignal): Promise<EnvironmentReport> {
    if (signal?.aborted) throw new DOMException("检查已取消", "AbortError");
    // Callers append browser capability/storage probes. Native directory and
    // media-runtime inspection is opt-in with an active local engine.
    if (isBrowserWorkspace()) return { checkedAt: new Date().toISOString(), os: "browser", arch: "unknown", catalog: { repository: "", revision: "", cases: [] }, checks: [] };
    return http.post<EnvironmentReport>("/diagnostics/environment", { repair }, { signal });
}
