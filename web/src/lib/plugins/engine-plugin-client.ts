// Engine plugins can contain executable JavaScript. A local installation and a
// grant to run that code in this website are separate decisions.
import { http } from "@/services/api/request";
import { captureEngineSessionGuard, getEngineSession } from "@/services/engine-session";
import type { ClientPluginModule } from "./plugin-client-loader";

type ClientPermission = { pluginId: string; name: string; version: string; digest: string; sessionId: string; revision: string };
const prefix = "qisitv.plugin-client-grant:";
const granted = new Map<string, string>();
const listeners = new Set<() => void>();
let pending: readonly ClientPermission[] = [];

export const pendingClientPermissions = () => pending;
export function subscribeClientPermissions(listener: () => void) {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}
function updatePending(next: readonly ClientPermission[]) {
    pending = next;
    listeners.forEach((listener) => listener());
}
export function forgetPendingClient(pluginId: string) {
    if (pending.some(item => item.pluginId === pluginId)) updatePending(pending.filter(item => item.pluginId !== pluginId));
}
function grantKey(item: ClientPermission) { return prefix + JSON.stringify([item.sessionId, item.pluginId]); }
export function approvePluginClient(item: ClientPermission) {
    if (item.sessionId !== getEngineSession()?.sessionId || !pending.includes(item)) return;
    const key = grantKey(item);
    granted.set(key, item.digest);
    try { sessionStorage.setItem(key, item.digest); } catch { /* In-memory grant lasts until refresh. */ }
    forgetPendingClient(item.pluginId);
}

export async function importEnginePluginClient(pluginId: string, name: string, version: string, revision: string, stillEnabled: () => boolean): Promise<ClientPluginModule | undefined> {
    const sessionId = getEngineSession()?.sessionId;
    if (!sessionId || pending.some(item => item.pluginId === pluginId && item.sessionId === sessionId && item.revision === revision)) return;
    const checkSession = captureEngineSessionGuard();
    const { data, headers } = await http.raw<Blob>({ method: "get", url: "/plugins/" + encodeURIComponent(pluginId) + "/client-bundle", responseType: "blob", timeout: 15000 });
    if (!/^(?:application|text)\/javascript\b/i.test(String(headers["content-type"]))) throw new Error("引擎未返回插件界面模块");
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", await data.arrayBuffer()));
    const digest = Array.from(hash, byte => byte.toString(16).padStart(2, "0")).join("");
    checkSession();
    if (!stillEnabled()) return;
    const item = { sessionId, pluginId, name, version, revision, digest };
    const key = grantKey(item);
    let approved = granted.get(key);
    try { approved ??= sessionStorage.getItem(key) ?? undefined; } catch { /* In-memory grants remain available. */ }
    if (approved !== digest) {
        updatePending([...pending.filter(entry => entry.pluginId !== pluginId), item]);
        return;
    }
    const url = URL.createObjectURL(new Blob([data], { type: "text/javascript" }));
    try { return await import(/* @vite-ignore */ url) as ClientPluginModule; }
    finally { URL.revokeObjectURL(url); }
}
