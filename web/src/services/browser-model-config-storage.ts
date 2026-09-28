import type { StateStorage } from "zustand/middleware";
import { localForageStorageForScope } from "@/lib/localforage-storage";
import { getActiveUserScope } from "@/lib/user-scope";
import { useConfigStore, type AiConfig } from "@/stores/use-config-store";
import type { LocalModelConfigPayload } from "@/services/api/workspace";

const MODEL_CONFIG_KEY = "qisitv:browser-model-config";

export function createBrowserModelConfigStorage(storage: StateStorage = localForageStorageForScope()) {
    let writeTail: Promise<unknown> = Promise.resolve();
    const read = async (): Promise<LocalModelConfigPayload> => {
        const raw = await storage.getItem(MODEL_CONFIG_KEY);
        if (!raw) return { config: structuredClone(useConfigStore.getState().config), revision: 0, health: "default", source: "builtin+local" };
        const parsed = JSON.parse(raw) as { config?: AiConfig; revision?: number };
        if (!parsed.config || !Array.isArray(parsed.config.channels) || !Number.isSafeInteger(parsed.revision) || parsed.revision! < 0) throw new Error("本地模型配置无法读取，请保留浏览器数据后重试");
        return { config: parsed.config, revision: parsed.revision!, health: "ready", source: "builtin+local" };
    };
    const write = (config: AiConfig, expectedRevision: number) => {
        const snapshot = structuredClone(config);
        const operation = async () => {
            const current = await read();
            if (current.revision !== expectedRevision) throw Object.assign(new Error("模型配置已在其他标签页更新"), { status: 409 });
            const revision = current.revision + 1;
            await storage.setItem(MODEL_CONFIG_KEY, JSON.stringify({ config: snapshot, revision }));
            return { saved: true, revision };
        };
        const run = () => typeof navigator !== "undefined" && navigator.locks
            ? navigator.locks.request(`qisitv:model-config:${getActiveUserScope()}`, operation)
            : operation();
        const result = writeTail.catch(() => undefined).then(run);
        writeTail = result;
        return result;
    };
    return { read, write };
}
