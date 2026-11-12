package generation

import (
	"context"
	"errors"
	"qisitv/backend/internal/beeftv"
	"testing"
)

func completeBeefTVSeedanceMultipart(ctx context.Context, config Config, session BeefTVSeedanceUploadSession, data []byte) (BeefTVSeedanceUploadComplete, error) {
	return CompleteBeefTVSeedanceUpload(ctx, config, session, data)
}
func retrySeedanceUpload(ctx context.Context, err error, _ bool) bool {
	return ctx.Err() == nil && beeftv.RetryUploadError(err)
}

func TestPrepareBeefTVVideoReferencesSkipsTextAndAudioTasks(t *testing.T) {
	cfg := Config{
		BaseURL:       "https://beeftv.app/v1",
		APIKey:        "test-key",
		Model:         "claude-fable-5",
		CredentialRef: beeftv.CredentialRef,
	}
	for _, mode := range []string{"text", "audio"} {
		input := Input{
			Mode:            mode,
			Config:          cfg,
			ReferenceImages: []Media{{DataURL: "data:image/png;base64,aGVsbG8=", MimeType: "image/png"}},
		}
		err := PrepareBeefTVVideoReferences(context.Background(), cfg, &input, func(string, Media) ([]byte, string, bool, error) {
			return nil, "", false, errors.New("must not read or preupload reference media for non-video mode")
		})
		if err != nil {
			t.Fatalf("mode %q: unexpected error: %v", mode, err)
		}
		if input.ReferenceImages[0].DataURL == "" {
			t.Fatalf("mode %q: cleared inline DataURL", mode)
		}
	}
}
