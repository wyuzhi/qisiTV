package desktopupdate

import (
	"crypto/ed25519"
	"encoding/base64"
	"net/url"
	"runtime"
	"strings"
)

// Link-time variables. Release builds inject an HTTPS feed and a base64 raw
// 32-byte Ed25519 public key. Both empty disables the updater.
var (
	FeedURL   = ""
	PublicKey = ""
)

const (
	helperFlag      = "--qisitv-update-helper"
	appBundleName   = "qisiTV.app"
	windowsExeName  = "qisiTV.exe"
	pluginDirName   = "plugin-packages"
	pluginExtension = ".qisitv-plugin"
	payloadSchema   = 1
	maxFeedBytes    = 1 << 20
	maxRedirects    = 8
	maxZipFiles     = 50000
	maxZipEntry     = 1 << 30
	maxZipTotal     = 2 << 30
)

func ParsePublicKey(value string) (ed25519.PublicKey, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil, ErrIncompleteConfig
	}
	raw, err := base64.StdEncoding.DecodeString(value)
	if err != nil {
		return nil, ErrIncompleteConfig
	}
	if len(raw) != ed25519.PublicKeySize {
		return nil, ErrIncompleteConfig
	}
	return ed25519.PublicKey(raw), nil
}

func CurrentPlatform() (string, error) {
	switch runtime.GOOS + "-" + runtime.GOARCH {
	case "darwin-arm64":
		return "darwin-arm64", nil
	case "darwin-amd64":
		return "darwin-amd64", nil
	case "windows-amd64":
		return "windows-amd64", nil
	default:
		return "", ErrUnsupported
	}
}

func normalizeFeedURL(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", ErrIncompleteConfig
	}
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" {
		return "", ErrIncompleteConfig
	}
	return parsed.String(), nil
}

func configFromVars() (feed string, key ed25519.PublicKey, enabled bool, reason string) {
	feedRaw := strings.TrimSpace(FeedURL)
	keyRaw := strings.TrimSpace(PublicKey)
	if feedRaw == "" && keyRaw == "" {
		return "", nil, false, ""
	}
	if feedRaw == "" || keyRaw == "" {
		return "", nil, false, ErrIncompleteConfig.Error()
	}
	feed, err := normalizeFeedURL(feedRaw)
	if err != nil {
		return "", nil, false, "更新地址无效。"
	}
	key, err = ParsePublicKey(keyRaw)
	if err != nil {
		return "", nil, false, "更新配置无效。"
	}
	return feed, key, true, ""
}
