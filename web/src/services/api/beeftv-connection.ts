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
    balanceCny?: string;
    catalogFailed?: boolean;
    errorReason?: string;
    connectedAt?: string;
    credentialRef?: string;
    hasCredential?: boolean;
};

export type BeefTVTopUpMethod = {
    type: "wxpay" | "alipay" | string;
    name: string;
    minTopup?: number;
};

export type BeefTVTopUpBonusTier = {
    threshold: number;
    bonus: number;
};

export type BeefTVTopUpCardInfo = {
    paymentCurrency: string;
    creditCurrency: string;
    minAmount: number;
    maxAmount: number;
    usdCnyRate: string;
};

export type BeefTVTopUpInfo = {
    currency: string;
    enableOnlineTopup: boolean;
    payMethods: BeefTVTopUpMethod[];
    minTopup: number;
    maxTopup: number;
    amountOptions: number[];
    bonusEnabled: boolean;
    bonusTiers?: BeefTVTopUpBonusTier[];
    enableCardTopup: boolean;
    card?: BeefTVTopUpCardInfo | null;
    balanceCny?: string;
};

export type BeefTVTopUpCheckoutRequest = {
    paymentMethod: "wxpay" | "alipay" | "card";
    amount?: number;
    amountUsd?: string;
    tradeNo?: string;
};

export type BeefTVTopUpCheckoutResult = {
    tradeNo: string;
    paymentMethod: string;
    fxRate?: string;
    amount: { currency: string; value: string };
    credit: { currency: string; value: string };
    opened: boolean;
    openError?: string;
};

export type BeefTVTopUpReconcileResult = {
    status: "pending" | "success" | "expired" | string;
    credited: boolean;
    settled?: boolean;
    retryAfter?: number;
    message?: string;
    balanceCny?: string;
    connection: BeefTVConnectionSummary;
};

export function getBeefTVConnection(signal?: AbortSignal, options?: { refresh?: boolean }) {
    const url = options?.refresh ? "/beeftv/connection?refresh=1" : "/beeftv/connection";
    return http.get<BeefTVConnectionSummary>(url, { signal });
}

export function getBeefTVTopUpInfo(signal?: AbortSignal) {
    return http.get<BeefTVTopUpInfo>("/beeftv/connection/topup/info", { signal });
}

export function startBeefTVTopUpCheckout(payload: BeefTVTopUpCheckoutRequest, signal?: AbortSignal) {
    return http.post<BeefTVTopUpCheckoutResult>("/beeftv/connection/topup/checkout", payload, { signal, timeout: 25_000 });
}

export function reconcileBeefTVTopUp(tradeNo: string, signal?: AbortSignal) {
    return http.post<BeefTVTopUpReconcileResult>("/beeftv/connection/topup/reconcile", { tradeNo }, { signal, timeout: 15_000 });
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

export function isBeefTVAuthenticated(summary: BeefTVConnectionSummary | null | undefined) {
    return Boolean(summary && (summary.state === "connected" || (summary.state === "catalog_failed" && summary.hasCredential)));
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
