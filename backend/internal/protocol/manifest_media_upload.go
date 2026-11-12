package protocol

import (
	"encoding/json"
	"fmt"
	"net"
	"net/url"
	"strings"
)

// firstPathJSONValue keeps scalar response fields string-like while allowing
// providers to return tool arguments as an object instead of a JSON string.
// The platform tool contract always stores arguments as JSON text.
func firstPathJSONValue(payload map[string]any, paths ...string) string {
	for _, path := range paths {
		value := pathValue(payload, path)
		switch typed := value.(type) {
		case string:
			if strings.TrimSpace(typed) != "" {
				return strings.TrimSpace(typed)
			}
		case nil:
			continue
		default:
			encoded, err := json.Marshal(typed)
			if err == nil && len(encoded) > 0 {
				return string(encoded)
			}
		}
	}
	return ""
}

func isRelativePath(path string) bool {
	parsed, err := url.Parse(strings.TrimSpace(path))
	return err == nil && parsed.Path != "" && strings.HasPrefix(parsed.Path, "/") && !strings.HasPrefix(parsed.Path, "//") && parsed.Host == "" && parsed.User == nil && parsed.Scheme == ""
}

func validateManifestMediaUpload(upload ManifestMediaUpload, providerBaseURL string) error {
	rawURL := strings.TrimSpace(upload.URL)
	rawPath := strings.TrimSpace(upload.Path)
	if rawURL == "" && rawPath == "" {
		return fmt.Errorf("url or path is required")
	}
	if rawURL != "" {
		parsed, err := url.Parse(rawURL)
		if err != nil || parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil || parsed.Fragment != "" || !strings.HasPrefix(parsed.Path, "/") {
			return fmt.Errorf("invalid url %q", upload.URL)
		}
		uploadHost := strings.ToLower(parsed.Hostname())
		if !isPublicDomainHost(uploadHost) {
			return fmt.Errorf("invalid url host %q", upload.URL)
		}
		baseParsed, baseErr := url.Parse(strings.TrimSpace(providerBaseURL))
		if baseErr != nil || baseParsed.Host == "" || !relatedUploadDomain(uploadHost, strings.ToLower(baseParsed.Hostname())) {
			return fmt.Errorf("upload url host %q must match or share domain lineage with provider baseUrl", uploadHost)
		}
	}
	if rawPath != "" && !isRelativePath(rawPath) {
		return fmt.Errorf("invalid path %q", upload.Path)
	}
	if len(upload.URLPaths) == 0 {
		return fmt.Errorf("urlPaths is required")
	}
	return nil
}

func isPublicDomainHost(host string) bool {
	if host == "" || host == "localhost" || strings.HasSuffix(host, ".localhost") || strings.HasSuffix(host, ".local") {
		return false
	}
	return net.ParseIP(host) == nil && strings.Contains(host, ".")
}

func relatedUploadDomain(a, b string) bool {
	if a == "" || b == "" {
		return false
	}
	return a == b || strings.HasSuffix(a, "."+b) || strings.HasSuffix(b, "."+a)
}

func (u ManifestMediaUpload) ParseResponse(body []byte) (string, error) {
	payload, err := decodeObject(body)
	if err != nil {
		return "", err
	}
	message := firstPathValue(payload, u.MessagePaths...)
	if manifestError(payload, u.ErrorPaths, u.SuccessCodes) {
		if message == "" {
			message = "参考素材上传失败"
		}
		return "", fmt.Errorf("%s", message)
	}
	link := firstPathValue(payload, u.URLPaths...)
	if link == "" {
		if message != "" {
			return "", fmt.Errorf("%s", message)
		}
		return "", fmt.Errorf("参考素材上传未返回访问地址")
	}
	return link, nil
}
