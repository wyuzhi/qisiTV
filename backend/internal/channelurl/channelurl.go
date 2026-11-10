// Package channelurl 是渠道 Base URL 与接口路径拼接的唯一实现。
// 生成任务和内置助手都从这里得出请求地址，同一个渠道在两处不能拼出不同的版本前缀。
package channelurl

import "strings"

var apiPrefixes = []string{"/api/plan/v3", "/api/v3", "/api/v1", "/v1beta", "/v1", "/v2", "/v3", "/v4"}

// Join 拼出完整请求地址：baseURL 或 path 中显式出现的版本前缀优先，
// 都没有时才补 defaultPrefix；baseURL 已经带上接口路径时不重复拼接。
func Join(baseURL string, path string, defaultPrefix string) string {
	base := strings.TrimRight(strings.TrimSpace(baseURL), "/")
	requestPath := strings.TrimSpace(path)
	if requestPath == "" {
		return base
	}
	if !strings.HasPrefix(requestPath, "/") {
		requestPath = "/" + requestPath
	}

	requestPrefix := requestAPIPathPrefix(requestPath)
	basePrefix := BasePrefix(base)
	if requestPrefix != "" {
		if basePrefix == requestPrefix {
			return base + strings.TrimPrefix(requestPath, requestPrefix)
		}
		trimmedBase := strings.TrimSuffix(base, basePrefix)
		if overlap := matchedRequestPathOverlap(trimmedBase, requestPath); overlap > 0 {
			return trimmedBase[:len(trimmedBase)-overlap] + requestPath
		}
		return trimmedBase + requestPath
	}
	if basePrefix != "" {
		if overlap := matchedRequestPathOverlap(base, requestPath); overlap > 0 {
			return base[:len(base)-overlap] + requestPath
		}
		return base + requestPath
	}
	prefixedPath := defaultPrefix + requestPath
	if overlap := matchedRequestPathOverlap(base, prefixedPath); overlap > 0 {
		return base[:len(base)-overlap] + prefixedPath
	}
	if overlap := matchedRequestPathOverlap(base, requestPath); overlap > 0 {
		return base[:len(base)-overlap] + requestPath
	}
	return base + prefixedPath
}

// BasePrefix 返回 baseURL 结尾已经带上的版本前缀，没有时返回空串。
func BasePrefix(value string) string {
	lower := strings.ToLower(strings.TrimRight(value, "/"))
	for _, prefix := range apiPrefixes {
		if lower == prefix || strings.HasSuffix(lower, prefix) {
			return prefix
		}
	}
	return ""
}

func matchedRequestPathOverlap(base string, fullRequestPath string) int {
	pathOnly := fullRequestPath
	if idx := strings.IndexAny(pathOnly, "?#"); idx >= 0 {
		pathOnly = pathOnly[:idx]
	}
	pathOnly = strings.TrimRight(pathOnly, "/")
	if pathOnly == "" || pathOnly == "/" {
		return 0
	}
	lowerBase := strings.ToLower(base)
	lowerPath := strings.ToLower(pathOnly)
	if strings.HasSuffix(lowerBase, lowerPath) {
		return len(pathOnly)
	}
	if prefix := requestAPIPathPrefix(lowerPath); prefix != "" && len(lowerPath) > len(prefix)+1 {
		rest := lowerPath[len(prefix):]
		for _, endpoint := range unversionedEndpointCandidates(rest) {
			if strings.HasSuffix(lowerBase, prefix+endpoint) {
				return len(prefix) + len(endpoint)
			}
			for _, verPrefix := range apiPrefixes {
				if strings.HasSuffix(lowerBase, verPrefix+endpoint) {
					return len(verPrefix) + len(endpoint)
				}
			}
			if strings.HasSuffix(lowerBase, endpoint) {
				return len(endpoint)
			}
		}
	}
	return 0
}

func unversionedEndpointCandidates(rest string) []string {
	candidates := make([]string, 0, 4)
	addCandidate := func(path string) {
		if path == "" || path == "/" {
			return
		}
		candidates = append(candidates, path)
		if slash := strings.IndexByte(path[1:], '/'); slash > 0 {
			candidates = append(candidates, path[:1+slash])
		}
	}
	addCandidate(rest)
	if strings.HasPrefix(rest, "/query/") {
		addCandidate(strings.TrimPrefix(rest, "/query"))
	}
	return candidates
}

func requestAPIPathPrefix(value string) string {
	lower := strings.ToLower(value)
	for _, prefix := range apiPrefixes {
		if lower == prefix || strings.HasPrefix(lower, prefix+"/") || strings.HasPrefix(lower, prefix+"?") || strings.HasPrefix(lower, prefix+"#") {
			return prefix
		}
	}
	return ""
}
