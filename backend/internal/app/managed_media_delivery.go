package app

import (
	"context"

	"infinite-canvas/backend/internal/beeftv"
	"infinite-canvas/backend/internal/model"
	localtask "infinite-canvas/backend/internal/task"
)

func (a generationDeliveryMediaAdapter) refreshManagedArtifactURL(ctx context.Context, userID, identity, kind string, cause error) (string, bool, error) {
	return localtask.RefreshManagedArtifactURL(ctx, a.service.repo, func(c context.Context, task model.Task) (string, []beeftv.MediaOutput, bool, bool, error) {
		query, managed, err := a.service.managedTaskRecoveryQuery(c, task)
		if err != nil || !managed || query.Legacy {
			return "", nil, managed, query.Legacy, err
		}
		query.Client.AllowHTTPTest = a.allowManagedMediaHTTPForTest
		projection, err := query.Client.Query(context.WithValue(c, imageTaskContext{}, task), query.Key, query.Kind)
		return projection.Status, projection.Outputs, true, false, err
	}, userID, identity, kind, cause)
}

func (a generationDeliveryMediaAdapter) restoreManagedUpscaleAudio(ctx context.Context, userID, identity string, data []byte) ([]byte, error) {
	return localtask.RestoreManagedUpscaleAudio(ctx, a.service.repo, a.service.decryptTaskInputJSON, a.service.bindGenerationRuntime, userID, identity, data)
}
