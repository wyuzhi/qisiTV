import { App } from "antd";
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";

import { mergeManagedBeefTVCatalog, shouldRefreshBeefTVCatalog } from "@/lib/managed-beeftv-catalog";
import { localWorkspaceConfig } from "@/lib/user-session";
import { cancelBeefTVConnection, disconnectBeefTVConnection, getBeefTVConnection, getBeefTVConnectionEpoch, openBeefTVWallet, startBeefTVConnection, type BeefTVConnectionSummary } from "@/services/api/beeftv-connection";
import { getLocalModelConfig } from "@/services/api/workspace";
import { normalizeConfigSnapshot, useConfigStore } from "@/stores/use-config-store";

const BeefTVConnectionContext = createContext<ReturnType<typeof useConnectionState> | null>(null);

export function BeefTVConnectionProvider({ children }: { children: ReactNode }) {
    const connection = useConnectionState();
    return <BeefTVConnectionContext.Provider value={connection}>{children}</BeefTVConnectionContext.Provider>;
}

export function useBeefTVConnection() {
    const connection = useContext(BeefTVConnectionContext);
    if (!connection) throw new Error("BeefTVConnectionProvider is required");
    return connection;
}

function useConnectionState() {
    const { message } = App.useApp();
    const [connection, setConnection] = useState<BeefTVConnectionSummary | null>(null);
    const [busy, setBusy] = useState(false);
    const [loading, setLoading] = useState(true);
    const [syncing, setSyncing] = useState(false);
    const [catalogSyncFailed, setCatalogSyncFailed] = useState(false);
    const currentConnection = useRef<BeefTVConnectionSummary | null>(null);
    const appliedState = useRef<string | undefined>(undefined);
    const catalogSync = useRef<{ state: string; selection: string; adopt: boolean; pending: boolean } | null>(null);
    const actionPending = useRef(false);
    const mutationSeq = useRef(0);
    const scheduleNextPoll = useRef<((state?: string) => void) | null>(null);

    const applyConnection = async (summary: BeefTVConnectionSummary, options?: { allowRetry?: boolean }) => {
        const previousState = currentConnection.current?.state;
        currentConnection.current = summary;
        setConnection(summary);
        scheduleNextPoll.current?.(summary.state);
        const retry = catalogSync.current?.state === summary.state ? catalogSync.current : null;
        if (retry?.pending) return;
        if (appliedState.current === summary.state && !(retry && options?.allowRetry)) return;
        appliedState.current = summary.state;
        if (!retry && !shouldRefreshBeefTVCatalog(previousState, summary.state)) {
            catalogSync.current = null;
            setCatalogSyncFailed(false);
            return;
        }
        const intent = retry || { state: summary.state, selection: useConfigStore.getState().config.assistantModel, adopt: summary.state === "connected" && Boolean(previousState && previousState !== "connected"), pending: false };
        catalogSync.current = intent;
        intent.pending = true;
        setSyncing(true);
        try {
            const result = await getLocalModelConfig();
            if (catalogSync.current !== intent) return;
            const current = useConfigStore.getState().config;
            useConfigStore.getState().replaceConfig(localWorkspaceConfig(normalizeConfigSnapshot({
                config: mergeManagedBeefTVCatalog(current, result.config, intent.adopt && current.assistantModel === intent.selection),
            }).config));
            catalogSync.current = null;
            setCatalogSyncFailed(false);
        } catch {
            if (catalogSync.current === intent) setCatalogSyncFailed(true);
        } finally {
            intent.pending = false;
            if (!catalogSync.current || catalogSync.current === intent) setSyncing(false);
        }
    };

    const refresh = async (options?: { allowRetry?: boolean }) => applyConnection(await getBeefTVConnection(), options);

    useEffect(() => {
        let stopped = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const arm = (state = currentConnection.current?.state) => {
            clearTimeout(timer);
            if (stopped) return;
            timer = setTimeout(poll, state === "pending" || state === "connecting" ? 2000 : 30000);
        };
        scheduleNextPoll.current = arm;
        const poll = async () => {
            if (!actionPending.current) {
                const epoch = getBeefTVConnectionEpoch();
                const seq = mutationSeq.current;
                try {
                    const summary = await getBeefTVConnection();
                    if (!stopped && !actionPending.current && epoch === getBeefTVConnectionEpoch() && seq === mutationSeq.current) {
                        await applyConnection(summary);
                    }
                } catch { /* 后台状态读取失败时保留已确认的连接，手动操作显示错误。 */ }
            }
            if (!stopped) {
                setLoading(false);
                arm();
            }
        };
        void poll();
        return () => {
            stopped = true;
            scheduleNextPoll.current = null;
            clearTimeout(timer);
        };
    }, []);

    const runAction = async (action: () => Promise<BeefTVConnectionSummary>, options?: { allowRetry?: boolean }) => {
        if (actionPending.current) return;
        actionPending.current = true;
        mutationSeq.current += 1;
        setBusy(true);
        const previous = currentConnection.current;
        try {
            await applyConnection(await action(), options);
        } catch (error) {
            try { await refresh(); } catch { setConnection(previous); }
            message.error(error instanceof Error ? error.message : "无法更新 BeefTV 连接，请重试");
        } finally {
            actionPending.current = false;
            setLoading(false);
            setBusy(false);
        }
    };

    const connect = () => runAction(async () => {
        const state = currentConnection.current?.state;
        if (state === "expired" || state === "revoked" || state === "rejected") await disconnectBeefTVConnection();
        setConnection({ state: "connecting", hasCredential: currentConnection.current?.hasCredential || false });
        return startBeefTVConnection();
    });

    const retryCatalog = () => {
        const current = currentConnection.current;
        if (current?.catalogFailed || current?.state === "catalog_failed") return connect();
        return runAction(getBeefTVConnection, { allowRetry: true });
    };

    return {
        connection,
        busy,
        loading,
        syncing,
        catalogSyncFailed: catalogSyncFailed || Boolean(connection?.catalogFailed || connection?.state === "catalog_failed"),
        connect,
        cancel: () => runAction(cancelBeefTVConnection),
        disconnect: () => runAction(disconnectBeefTVConnection),
        refresh: () => runAction(getBeefTVConnection, { allowRetry: true }),
        retryCatalog,
        openAccount: () => openBeefTVWallet().catch((error) => message.error(error instanceof Error ? error.message : "无法打开 BeefTV 账户")),
    };
}
