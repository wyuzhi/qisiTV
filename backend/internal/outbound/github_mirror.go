package outbound

import (
	"encoding/hex"
	"strings"
)

// ChinaGitHubProxies lists public GitHub download accelerators used as
// integrity-checked fallbacks when direct GitHub archive/raw access fails.
var ChinaGitHubProxies = []string{
	"https://gh-proxy.com",
	"https://ghfast.top",
}

// ValidHexDigest reports whether raw is a valid hex digest of either 20 bytes
// (Git SHA-1 commit) or 32 bytes (SHA-256).
func ValidHexDigest(raw string) bool {
	trimmed := strings.TrimSpace(raw)
	if len(trimmed) != 40 && len(trimmed) != 64 {
		return false
	}
	_, err := hex.DecodeString(trimmed)
	return err == nil
}

// ExpandGitHubMirrorURLs builds the ordered list of download URLs to try for a
// GitHub archive, raw file, or release tarball. Third-party GitHub proxies are
// included only when verifiedDigest is a valid 40-hex commit SHA or 64-hex
// SHA-256 digest that the caller verifies after download.
func ExpandGitHubMirrorURLs(primaryURL, mirrorURL, verifiedDigest, registry string) []string {
	isChina := strings.TrimSpace(registry) == "" || strings.Contains(registry, "npmmirror.com")
	hasVerifiedDigest := ValidHexDigest(verifiedDigest)
	var urls []string
	addUnique := func(u string) {
		u = strings.TrimSpace(u)
		if u == "" {
			return
		}
		for _, existing := range urls {
			if existing == u {
				return
			}
		}
		urls = append(urls, u)
	}
	if isChina {
		addUnique(mirrorURL)
		addUnique(primaryURL)
		if hasVerifiedDigest && (strings.HasPrefix(primaryURL, "https://github.com/") ||
			strings.HasPrefix(primaryURL, "https://raw.githubusercontent.com/") ||
			strings.HasPrefix(primaryURL, "https://codeload.github.com/")) {
			for _, proxy := range ChinaGitHubProxies {
				addUnique(strings.TrimRight(proxy, "/") + "/" + strings.TrimSpace(primaryURL))
			}
		}
		return urls
	}
	addUnique(primaryURL)
	addUnique(mirrorURL)
	return urls
}
