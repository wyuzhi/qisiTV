package generation

import (
	"context"
	"errors"
	"infinite-canvas/backend/internal/beefapi"
	"testing"
)

func completeBeefAPISeedanceMultipart(ctx context.Context, config Config, session BeefAPISeedanceUploadSession, data []byte) (BeefAPISeedanceUploadComplete, error) {
	return CompleteBeefAPISeedanceUpload(ctx, config, session, data)
}
func retrySeedanceUpload(ctx context.Context, err error, _ bool) bool {
	return ctx.Err() == nil && beefapi.RetryUploadError(err)
}

func TestPrepareBeefAPIVideoReferencesSkipsTextAndAudioTasks(t *testing.T) {
	cfg := Config{
		BaseURL:       "https://beeftv.app/v1",
		APIKey:        "test-key",
		Model:         "claude-fable-5",
		CredentialRef: beefapi.CredentialRef,
	}
	for _, mode := range []string{"text", "audio"} {
		input := Input{
			Mode:            mode,
			Config:          cfg,
			ReferenceImages: []Media{{DataURL: "data:image/png;base64,aGVsbG8=", MimeType: "image/png"}},
		}
		err := PrepareBeefAPIVideoReferences(context.Background(), cfg, &input, func(string, Media) ([]byte, string, bool, error) {
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
