// 渠道地址的纯函数：拼接请求地址、解析本地后端地址、识别系统代理渠道。不依赖 store 状态。
export function buildApiUrl(baseUrl: string, path: string) {
    let normalizedBaseUrl = resolveBackendApiUrl(baseUrl).replace(/\/+$/, "");
    normalizedBaseUrl = normalizeArkPlanBaseUrl(normalizedBaseUrl);
    const requestPath = path.startsWith("/") ? path : `/${path}`;
    if (isSystemProxyBaseUrl(normalizedBaseUrl)) return `${normalizedBaseUrl}${requestPath}`;

    const knownPrefixes = ["/api/plan/v3", "/api/v3", "/v1beta", "/v1", "/v2", "/v3"];
    const requestPrefixFor = (value: string) =>
        knownPrefixes.find((prefix) => {
            const lower = value.toLowerCase();
            return lower === prefix || lower.startsWith(`${prefix}/`) || lower.startsWith(`${prefix}?`) || lower.startsWith(`${prefix}#`);
        }) || "";
    const basePrefixFor = (value: string) =>
        knownPrefixes.find((prefix) => {
            const lower = value.toLowerCase();
            return lower.endsWith(prefix) || lower.includes(`${prefix}/`) || lower.includes(`${prefix}?`) || lower.includes(`${prefix}#`);
        }) || "";
    const basePrefix = basePrefixFor(normalizedBaseUrl);
    const requestPrefix = requestPrefixFor(requestPath);
    if (requestPrefix) {
        const root = basePrefix ? normalizedBaseUrl.slice(0, -basePrefix.length) : normalizedBaseUrl;
        return `${root}${requestPath}`;
    }
    return `${normalizedBaseUrl}${basePrefix ? "" : "/v1"}${requestPath}`;
}

export function resolveBackendApiUrl(value: string) {
    const url = value.trim();
    if (!url.startsWith("/api/")) return url;
    const backendBaseUrl = String(import.meta.env.VITE_CANVAS_BACKEND_URL || "/api")
        .trim()
        .replace(/\/+$/, "");
    return backendBaseUrl === "/api" ? url : `${backendBaseUrl}${url.slice("/api".length)}`;
}

export function isSystemProxyBaseUrl(baseUrl: string) {
    return Boolean(systemProxyChannelId(baseUrl));
}

export function systemProxyChannelId(baseUrl: string) {
    const value = baseUrl.trim();
    const lowerValue = value.toLowerCase();
    // `/api/<id>` 只认相对路径；第三方绝对地址（如 https://open.bigmodel.cn/api/paas）同样以 /api/<词> 结尾，必须仍按用户渠道处理。
    const markers = value.startsWith("/") && !value.startsWith("//") ? ["/api/ai/system/", "/api/"] : ["/api/ai/system/"];
    for (const marker of markers) {
        const index = lowerValue.lastIndexOf(marker);
        if (index < 0) continue;
        const remainder = value.slice(index + marker.length);
        if (/[/?#]/.test(remainder)) continue;
        const channelId = remainder.trim();
        if (channelId && !channelId.includes("\\") && !["v1", "v1beta", "v2", "v3", "plan", "ai"].includes(channelId.toLowerCase())) return channelId;
    }
    return "";
}

function normalizeArkPlanBaseUrl(baseUrl: string) {
    try {
        const url = new URL(baseUrl);
        const path = url.pathname.replace(/\/+$/, "");
        const lowerPath = path.toLowerCase();
        const arkPlanIndex = lowerPath.indexOf("/api/plan/v3");
        if (arkPlanIndex < 0) return baseUrl;
        const end = arkPlanIndex + "/api/plan/v3".length;
        if (lowerPath.length !== end && lowerPath[end] !== "/") return baseUrl;
        url.pathname = path.slice(0, end);
        url.search = "";
        url.hash = "";
        return url.toString().replace(/\/+$/, "");
    } catch {
        return baseUrl;
    }
}
