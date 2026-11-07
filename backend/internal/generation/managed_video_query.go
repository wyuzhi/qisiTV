package generation

import (
	"context"
	"errors"
	"infinite-canvas/backend/internal/outbound"
	"net/http"
)

// Only local result delivery remains in generation. The adapter owns BeefTV
// routes, task envelopes and query credentials, including historical endpoints.
func QueryManagedLegacyVideo(ctx context.Context, input Input, id string) (map[string]any, string, BeefTVVideoSettlement, error) {
	return queryManagedLegacyVideoWithPolicy(ctx, input, id, videoPollPolicyForConfig(ctx, input.Config, DefaultVideoPollPolicy()))
}

func queryManagedLegacyVideoWithPolicy(ctx context.Context, input Input, id string, policy VideoPollPolicy) (map[string]any, string, BeefTVVideoSettlement, error) {
	ctx = WithRequestKind(ctx, "poll")
	client := managedMediaClient(ctx, input.Config)
	task, err := client.QueryLegacyVideo(ctx, id)
	settlement := BeefTVVideoSettlement{UsageState: task.UsageState, ReconcileDeadline: task.ReconcileDeadline}
	if err != nil {
		return nil, task.Status, settlement, legacyMediaError(err)
	}
	if err := task.Failure(); err != nil {
		return nil, task.Status, settlement, err
	}
	if !task.Done() {
		return nil, task.Status, settlement, nil
	}
	var data []byte
	var mime string
	if task.URL != "" {
		link := task.URL
		data, mime, err = RunVideoDownload(ctx, id, policy, func(ctx context.Context) ([]byte, string, error) {
			if link == "" {
				fresh, err := client.QueryLegacyVideo(WithRequestKind(ctx, "poll"), id)
				if err != nil {
					return nil, "", legacyMediaError(err)
				}
				link = fresh.URL
			}
			current := link
			link = "" // A later attempt re-queries this API task, never /recover.
			if !client.AllowHTTPTest {
				ctx = outbound.WithPublicHTTPS(ctx)
			}
			data, mime, err := GetExternalBinary(context.WithValue(WithRequestKind(ctx, "download"), videoDeliveryRequestContext{}, videoDeliveryIdleTimeout), current)
			var rejected HTTPError
			if errors.As(err, &rejected) && (rejected.StatusCode == http.StatusUnauthorized || rejected.StatusCode == http.StatusForbidden) {
				err = videoBackupLinkExpiredError{cause: err}
			}
			return data, mime, err
		})
	} else {
		limit, limitErr := GeneratedFileLimit(ctx)
		if limitErr != nil {
			return nil, task.Status, settlement, limitErr
		}
		data, mime, err = RunVideoDownload(ctx, id, policy, func(ctx context.Context) ([]byte, string, error) {
			data, mime, err := client.LegacyVideoContent(ctx, task.ContentPath, limit)
			return data, mime, legacyMediaError(err)
		})
	}
	if err != nil {
		return nil, task.Status, settlement, err
	}
	mime = NormalizedMediaMIMEType(mime, data)
	videoMap := map[string]any{"dataUrl": DataURL(mime, data), "mimeType": mime}
	attachOptionalLastFrame(ctx, videoMap, task.LastFrameURL, client.AllowHTTPTest)
	return map[string]any{"mode": "video", "video": videoMap}, task.Status, settlement, nil
}
