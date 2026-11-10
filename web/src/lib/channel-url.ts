// 渠道地址的纯函数：拼接请求地址、解析本地后端地址、识别系统代理渠道。不依赖 store 状态。
// 这里是 backend/internal/channelurl 的逐行移植：浏览器直连渠道和后台生成任务必须拼出同一个地址，
// 否则同一个渠道在设置页能用、跑任务却 404，或反过来。
const API_PREFIXES = ["/api/plan/v3", "/api/v3", "/api/v1", "/v1beta", "/v1", "/v2", "/v3", "/v4"];

function requestApiPathPrefix(value: string) {
    const lower = value.toLowerCase();
    return API_PREFIXES.find((prefix) =>
        lower === prefix || lower.startsWith(`${prefix}/`) || lower.startsWith(`${prefix}?`) || lower.startsWith(`${prefix}#`),
    ) || "";
}

function baseApiPathPrefix(value: string) {
    const lower = value.toLowerCase().replace(/\/+$/, "");
    return API_PREFIXES.find((prefix) => lower === prefix || lower.endsWith(prefix)) || "";
}

function unversionedEndpointCandidates(rest: string) {
    const candidates: string[] = [];
    const add = (path: string) => {
        if (!path || path === "/") return;
        candidates.push(path);
        const slash = path.slice(1).indexOf("/");
        if (slash > 0) candidates.push(path.slice(0, 1 + slash));
    };
    add(rest);
    if (rest.startsWith("/query/")) add(rest.slice("/query".length));
    return candidates;
}

function matchedRequestPathOverlap(base: string, fullRequestPath: string) {
    let pathOnly = fullRequestPath;
    const cut = pathOnly.search(/[?#]/);
    if (cut >= 0) pathOnly = pathOnly.slice(0, cut);
    pathOnly = pathOnly.replace(/\/+$/, "");
    if (!pathOnly || pathOnly === "/") return 0;
    const lowerBase = base.toLowerCase();
    const lowerPath = pathOnly.toLowerCase();
    if (lowerBase.endsWith(lowerPath)) return pathOnly.length;
    const prefix = requestApiPathPrefix(lowerPath);
    if (prefix && lowerPath.length > prefix.length + 1) {
        const rest = lowerPath.slice(prefix.length);
        for (const endpoint of unversionedEndpointCandidates(rest)) {
            if (lowerBase.endsWith(prefix + endpoint)) return prefix.length + endpoint.length;
            for (const versionPrefix of API_PREFIXES) {
                if (lowerBase.endsWith(versionPrefix + endpoint)) return versionPrefix.length + endpoint.length;
            }
            if (lowerBase.endsWith(endpoint)) return endpoint.length;
        }
    }
    return 0;
}

export function joinChannelUrl(baseUrl: string, path: string, defaultPrefix = "/v1") {
    const base = baseUrl.trim().replace(/\/+$/, "");
    let requestPath = path.trim();
    if (!requestPath) return base;
    if (!requestPath.startsWith("/")) requestPath = `/${requestPath}`;

    const requestPrefix = requestApiPathPrefix(requestPath);
    const basePrefix = baseApiPathPrefix(base);
    if (requestPrefix) {
        if (basePrefix === requestPrefix) return base + requestPath.slice(requestPrefix.length);
        const trimmedBase = basePrefix ? base.slice(0, -basePrefix.length) : base;
        const overlap = matchedRequestPathOverlap(trimmedBase, requestPath);
        if (overlap > 0) return trimmedBase.slice(0, trimmedBase.length - overlap) + requestPath;
        return trimmedBase + requestPath;
    }
    if (basePrefix) {
        const overlap = matchedRequestPathOverlap(base, requestPath);
        if (overlap > 0) return base.slice(0, base.length - overlap) + requestPath;
        return base + requestPath;
    }
    const prefixedPath = defaultPrefix + requestPath;
    let overlap = matchedRequestPathOverlap(base, prefixedPath);
    if (overlap > 0) return base.slice(0, base.length - overlap) + prefixedPath;
    overlap = matchedRequestPathOverlap(base, requestPath);
    if (overlap > 0) return base.slice(0, base.length - overlap) + requestPath;
    return base + prefixedPath;
}

export function buildApiUrl(baseUrl: string, path: string) {
    let normalizedBaseUrl = resolveBackendApiUrl(baseUrl).replace(/\/+$/, "");
    normalizedBaseUrl = normalizeArkPlanBaseUrl(normalizedBaseUrl);
    const requestPath = path.startsWith("/") ? path : `/${path}`;
    if (isSystemProxyBaseUrl(normalizedBaseUrl)) return `${normalizedBaseUrl}${requestPath}`;
    return joinChannelUrl(normalizedBaseUrl, requestPath, "/v1");
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
