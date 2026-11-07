import { http } from "@/services/api/request";

let connectionEpoch = 0;
export function getBeefTVConnectionEpoch() {
    return connectionEpoch;
}

/** 请求期间 BeefTV 连接被重连或断开：丢弃旧连接的结果，不能当成新连接的数据。 */
export class BeefTVConnectionChangedError extends Error {
    constructor() {
        super("BeefTV 连接已变更，请重新读取");
        this.name = "BeefTVConnectionChangedError";
    }
}

export type BeefTVAccount = {
    id: string;
    username?: string;
    display_name?: string;
    email?: string;
};

export type BeefTVConnectionState = "disconnected" | "connecting" | "connection_error" | "pending" | "connected" | "expired" | "cancelled" | "rejected" | "store_error" | "catalog_failed" | "revoked";

export type BeefTVConnectionSummary = {
    state: BeefTVConnectionState | string;
    userCode?: string;
    verificationUri?: string;
    expiresAt?: string;
    account?: BeefTVAccount | null;
    keyName?: string;
    tokenId?: string;
    market?: string;
    walletUrl?: string;
    balance?: "unknown" | "zero" | "available" | string;
    catalogFailed?: boolean;
    errorReason?: string;
    connectedAt?: string;
    credentialRef?: string;
    hasCredential?: boolean;
};

export function getBeefTVConnection(signal?: AbortSignal) {
    return http.get<BeefTVConnectionSummary>("/beeftv/connection", { signal });
}

export function startBeefTVConnection(signal?: AbortSignal) {
    connectionEpoch++;
    // Authorization may need a proxy handshake and one safe direct attempt.
    return http.post<BeefTVConnectionSummary>("/beeftv/connection/start", {}, { signal, timeout: 35_000 });
}

export function cancelBeefTVConnection(signal?: AbortSignal) {
    connectionEpoch++;
    return http.post<BeefTVConnectionSummary>("/beeftv/connection/cancel", {}, { signal });
}

export function disconnectBeefTVConnection(signal?: AbortSignal) {
    connectionEpoch++;
    return http.post<BeefTVConnectionSummary>("/beeftv/connection/disconnect", {}, { signal });
}

export function openBeefTVWallet(signal?: AbortSignal) {
    return http.post<{ opened: boolean }>("/beeftv/connection/open-wallet", {}, { signal });
}

export function beefTVConnectionLabel(summary: BeefTVConnectionSummary | null | undefined) {
    const state = summary?.state || "disconnected";
    switch (state) {
        case "connecting":
            return summary?.errorReason || "正在连接 BeefTV";
        case "connection_error":
            return summary?.errorReason || "无法连接 BeefTV 服务，请检查网络后重试";
        case "pending":
            return summary?.errorReason || (summary?.userCode ? `请在浏览器中确认 ${summary.userCode}` : "请在浏览器中确认授权");
        case "connected":
            return connectedAccountLabel(summary);
        case "expired":
            return "授权已过期，请重新连接";
        case "cancelled":
            return "已取消本次连接";
        case "rejected":
            return "授权被拒绝";
        case "store_error":
            return "保存连接失败，请重试";
        case "catalog_failed":
            return "模型列表读取失败，请重试";
        case "revoked":
            return "连接已失效，请重新连接";
        default:
            return "未连接";
    }
}

function connectedAccountLabel(summary: BeefTVConnectionSummary | null | undefined) {
    const account = summary?.account;
    const name = account?.email || account?.display_name || account?.username;
    if (name && summary?.balance === "zero") return `已连接 ${name}，余额为 0`;
    if (name) return `已连接 ${name}`;
    if (summary?.balance === "zero") return "已连接，余额为 0";
    return "已连接";
}
