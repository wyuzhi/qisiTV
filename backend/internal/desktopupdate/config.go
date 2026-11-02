package desktopupdate

import (
	"crypto/ed25519"
	"encoding/base64"
	"net/url"
	"os"
	"runtime"
	"strings"
	"time"
)

// Link-time variables. Release builds inject an HTTPS feed and a base64 raw
// 32-byte Ed25519 public key. Both empty disables the updater.
var (
	FeedURL   = ""
	PublicKey = ""
)

const (
	DefaultFeedURL  = ""
	LegacyFeedURL   = ""
	helperFlag      = "--qisitv-update-helper"
	appBundleName   = "qisiTV.app"
	linuxBundleName = "qisiTV-linux"
	windowsExeName  = "qisiTV.exe"
	pluginDirName   = "plugin-packages"
	// 随包 CLI：外部 Agent 的接入入口，升级包里必须带上，否则升级一次就断了接入。
	// 它必须待在自己的 cli 目录里：macOS 与 Windows 的文件名都不分大小写，
	// qisitv 直接放在主程序旁边会和 qisiTV / qisiTV.exe 撞成同一个文件。
	cliDirName                = "cli"
	darwinCLIName             = "qisitv"
	windowsCLIName            = "qisitv.exe"
	pluginExtension           = ".qisitv-plugin"
	payloadSchema             = 1
	payloadSchemaV2           = 2
	maxFeedBytes              = 1 << 20
	maxRedirects              = 8
	maxZipFiles               = 50000
	maxZipEntry               = 1 << 30
	maxZipTotal               = 2 << 30
	defaultMinTransferSpeed   = int64(64 * 1024)
	defaultSlowTransferWindow = 10 * time.Second
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
	case "linux-amd64":
		return "linux-amd64", nil
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

func preferDomesticSource(locale, timezone string) bool {
	if strings.TrimSpace(locale) == "" && strings.TrimSpace(timezone) == "" {
		locale = systemLocale()
		timezone = systemTimezone()
	}
	return isMainlandChinaTimezone(timezone) || isMainlandChinaLocale(locale)
}

func systemLocale() string {
	for _, key := range []string{"LC_ALL", "LC_MESSAGES", "LANG", "LANGUAGE"} {
		if val := strings.TrimSpace(os.Getenv(key)); val != "" {
			return val
		}
	}
	return ""
}

func systemTimezone() string {
	if tz := strings.TrimSpace(os.Getenv("TZ")); tz != "" {
		return tz
	}
	if loc := time.Local.String(); loc != "" && !strings.EqualFold(loc, "Local") {
		return loc
	}
	if link, err := os.Readlink("/etc/localtime"); err == nil && link != "" {
		return link
	}
	if data, err := os.ReadFile("/etc/timezone"); err == nil {
		if tz := strings.TrimSpace(string(data)); tz != "" {
			return tz
		}
	}
	name, offset := time.Now().Zone()
	if name == "CST" && offset == 8*3600 {
		return "Asia/Shanghai"
	}
	return ""
}

func isMainlandChinaLocale(raw string) bool {
	raw = strings.ToLower(strings.TrimSpace(raw))
	if raw == "" {
		return false
	}
	fields := strings.FieldsFunc(raw, func(r rune) bool {
		return r == ':' || r == ';' || r == ',' || r == ' ' || r == '\t'
	})
	for _, token := range fields {
		if idx := strings.IndexAny(token, ".@"); idx >= 0 {
			token = token[:idx]
		}
		token = strings.ReplaceAll(strings.TrimSpace(token), "_", "-")
		if token == "" {
			continue
		}
		if strings.HasPrefix(token, "zh-tw") || strings.HasPrefix(token, "zh-hk") ||
			strings.HasPrefix(token, "zh-mo") || strings.HasPrefix(token, "zh-hant") ||
			strings.HasPrefix(token, "zh-sg") {
			return false
		}
		if token == "zh-cn" || token == "zh-hans" || token == "zh" ||
			strings.HasPrefix(token, "zh-cn-") || strings.HasPrefix(token, "zh-hans-") ||
			strings.Contains(token, "simplified") || strings.Contains(token, "china") {
			return true
		}
	}
	return false
}

func isMainlandChinaTimezone(raw string) bool {
	tz := strings.ToLower(strings.ReplaceAll(strings.TrimSpace(raw), "\\", "/"))
	if tz == "" {
		return false
	}
	switch tz {
	case "asia/shanghai", "asia/chongqing", "asia/chungking", "asia/harbin", "asia/urumqi", "asia/kashgar", "prc", "china standard time":
		return true
	}
	for _, suffix := range []string{"/asia/shanghai", "/asia/chongqing", "/asia/chungking", "/asia/harbin", "/asia/urumqi", "/asia/kashgar", "/prc"} {
		if strings.HasSuffix(tz, suffix) {
			return true
		}
	}
	return false
}

func isDomesticArtifactURL(rawURL string) bool {
	parsed, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil {
		return false
	}
	host := strings.ToLower(parsed.Hostname())
	return host == "cheeser.link"
}

func orderArtifactURLs(urls []string, preferDomestic bool) []string {
	if len(urls) <= 1 {
		return append([]string(nil), urls...)
	}
	var primary, secondary []string
	for _, raw := range urls {
		if isDomesticArtifactURL(raw) == preferDomestic {
			primary = append(primary, raw)
		} else {
			secondary = append(secondary, raw)
		}
	}
	return append(primary, secondary...)
}
