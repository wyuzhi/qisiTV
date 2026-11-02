import type { PluginEventMap, PluginEventName } from "@/lib/plugins/plugin-types";

type EventListenerEntry<E extends PluginEventName = PluginEventName> = {
    id: string;
    pluginId: string;
    eventName: E;
    handler: (payload: PluginEventMap[E]) => void | Promise<void>;
};

const listenersByEvent = new Map<PluginEventName, Map<string, EventListenerEntry>>();
let nextListenerSeq = 1;

export function onPluginEvent<E extends PluginEventName>(
    pluginId: string,
    eventName: E,
    handler: (payload: PluginEventMap[E]) => void | Promise<void>,
): () => void {
    const id = `${pluginId}:${eventName}:${nextListenerSeq++}`;
    let bucket = listenersByEvent.get(eventName);
    if (!bucket) {
        bucket = new Map();
        listenersByEvent.set(eventName, bucket);
    }
    bucket.set(id, {
        id,
        pluginId,
        eventName,
        handler: handler as (payload: PluginEventMap[PluginEventName]) => void | Promise<void>,
    });

    return () => {
        const currentBucket = listenersByEvent.get(eventName);
        if (!currentBucket) return;
        currentBucket.delete(id);
        if (currentBucket.size === 0) {
            listenersByEvent.delete(eventName);
        }
    };
}

export function emitPluginEvent<E extends PluginEventName>(
    eventName: E,
    payload: PluginEventMap[E],
): void {
    const bucket = listenersByEvent.get(eventName);
    if (!bucket || bucket.size === 0) return;

    const entries = Array.from(bucket.values());
    for (const entry of entries) {
        try {
            const result = entry.handler(payload);
            if (result && typeof (result as Promise<void>).catch === "function") {
                (result as Promise<void>).catch((err) => {
                    console.warn(`[plugin-events] Async listener error in plugin "${entry.pluginId}" for "${eventName}":`, err);
                });
            }
        } catch (err) {
            console.warn(`[plugin-events] Listener error in plugin "${entry.pluginId}" for "${eventName}":`, err);
        }
    }
}

export function disposePluginEvents(pluginId: string): void {
    for (const [eventName, bucket] of listenersByEvent.entries()) {
        for (const [id, entry] of bucket.entries()) {
            if (entry.pluginId === pluginId) {
                bucket.delete(id);
            }
        }
        if (bucket.size === 0) {
            listenersByEvent.delete(eventName);
        }
    }
}

export function getPluginEventListenerCount(eventName?: PluginEventName, pluginId?: string): number {
    let count = 0;
    for (const [name, bucket] of listenersByEvent.entries()) {
        if (eventName && name !== eventName) continue;
        for (const entry of bucket.values()) {
            if (pluginId && entry.pluginId !== pluginId) continue;
            count += 1;
        }
    }
    return count;
}

export function clearAllPluginEvents(): void {
    listenersByEvent.clear();
}
