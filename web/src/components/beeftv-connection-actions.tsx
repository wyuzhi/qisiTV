import { Button } from "antd";
import type { BeefTVConnectionSummary } from "@/services/api/beeftv-connection";

export function BeefTVConnectionActions({
    connection,
    busy,
    onConnect,
    onCancel,
    onRetry,
    onDisconnect,
    onWallet,
}: {
    connection: BeefTVConnectionSummary | null;
    busy: boolean;
    onConnect: () => void;
    onCancel: () => void;
    onRetry: () => void;
    onDisconnect: () => void;
    onWallet?: () => void;
}) {
    const state = connection?.state || "disconnected";
    const buttonClass = "h-10 sm:h-8";
    if (state === "connecting") {
        return <Button className={buttonClass} size="small" loading disabled>正在连接</Button>;
    }
    if (state === "pending") {
        return (
            <>
                <Button className={buttonClass} size="small" loading={busy} onClick={onCancel}>
                    取消
                </Button>
            </>
        );
    }
    if (state === "connected") {
        return (
            <>
                {onWallet ? <Button className={buttonClass} size="small" onClick={onWallet}>
                    打开算力账户
                </Button> : null}
                <Button className={buttonClass} size="small" loading={busy} onClick={onDisconnect}>
                    断开连接
                </Button>
            </>
        );
    }
    if (state === "catalog_failed") {
        return (
            <>
                <Button className={buttonClass} size="small" type="primary" loading={busy} onClick={onRetry}>
                    重新连接
                </Button>
                <Button className={buttonClass} size="small" loading={busy} onClick={onDisconnect}>
                    断开连接
                </Button>
            </>
        );
    }
    if (state === "expired" || state === "revoked" || state === "rejected" || state === "store_error" || state === "connection_error" || state === "cancelled") {
        return (
            <Button data-onboarding="official-connect" className={buttonClass} size="small" type="primary" loading={busy} onClick={onRetry}>
                重新连接
            </Button>
        );
    }
    return (
        <Button data-onboarding="official-connect" className={buttonClass} size="small" type="primary" loading={busy} onClick={onConnect}>
            连接 Topaz 算力
        </Button>
    );
}
