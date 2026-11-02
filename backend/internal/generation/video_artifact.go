package generation

import (
	"fmt"
	"net/http"
	"strings"
)

func ValidateVideoArtifact(data []byte, declared string) error {
	detected := strings.ToLower(strings.TrimSpace(strings.Split(http.DetectContentType(data), ";")[0]))
	mime := strings.ToLower(NormalizedMediaMIMEType(declared, data))
	if len(data) == 0 || strings.HasPrefix(detected, "text/") || strings.Contains(detected, "json") || strings.HasPrefix(detected, "image/") || strings.HasPrefix(detected, "audio/") || !strings.HasPrefix(mime, "video/") {
		return fmt.Errorf("视频结果无效：%s", detected)
	}
	return nil
}
