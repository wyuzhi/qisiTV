package generation

import (
	"testing"

	"qisitv/backend/internal/modelcatalog"
)

func TestImageResponseFormatValue(t *testing.T) {
	for _, tc := range []struct {
		name    string
		profile *ImageCapabilityConfig
		want    string
	}{
		{"no profile", nil, modelcatalog.ImageResponseFormatBase64},
		{"unset value keeps inline base64", &ImageCapabilityConfig{ResponseFormat: modelcatalog.ImageResponseFormat{Supported: true}}, modelcatalog.ImageResponseFormatBase64},
		{"url", &ImageCapabilityConfig{ResponseFormat: modelcatalog.ImageResponseFormat{Supported: true, Value: modelcatalog.ImageResponseFormatURL}}, modelcatalog.ImageResponseFormatURL},
		{"url is case and space insensitive", &ImageCapabilityConfig{ResponseFormat: modelcatalog.ImageResponseFormat{Supported: true, Value: " URL "}}, modelcatalog.ImageResponseFormatURL},
		{"unknown value falls back", &ImageCapabilityConfig{ResponseFormat: modelcatalog.ImageResponseFormat{Supported: true, Value: "webp"}}, modelcatalog.ImageResponseFormatBase64},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := ImageResponseFormatValue(tc.profile); got != tc.want {
				t.Fatalf("ImageResponseFormatValue() = %q, want %q", got, tc.want)
			}
		})
	}
}
