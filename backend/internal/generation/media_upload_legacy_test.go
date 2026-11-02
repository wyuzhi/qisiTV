package generation

import (
	"context"
	"qisitv/backend/internal/beefapi"
)

func completeBeefAPISeedanceMultipart(ctx context.Context, config Config, session BeefAPISeedanceUploadSession, data []byte) (BeefAPISeedanceUploadComplete, error) {
	return CompleteBeefAPISeedanceUpload(ctx, config, session, data)
}
func retrySeedanceUpload(ctx context.Context, err error, _ bool) bool {
	return ctx.Err() == nil && beefapi.RetryUploadError(err)
}
