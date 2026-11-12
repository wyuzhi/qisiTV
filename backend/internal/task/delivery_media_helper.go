package task

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"io"
	"net/http"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	localasset "qisitv/backend/internal/asset"
	"qisitv/backend/internal/beeftv"
	"qisitv/backend/internal/generation"
	"qisitv/backend/internal/kernel"
	"qisitv/backend/internal/model"
	"qisitv/backend/internal/outbound"
	"qisitv/backend/internal/playback"
	"qisitv/backend/internal/protocol"
	"qisitv/backend/internal/repository"

	"gorm.io/gorm"
)

const imageHeaderDecodeLimit = 2 << 20

type DeliveryMediaDeps struct {
	Repo              *repository.Repository
	DataDir           string
	AllowHTTPForTest  bool
	Resources         *localasset.Service
	DecodeDataURL     func(string) (string, []byte, error)
	BeginDownload     func(userID, identity string, timeout time.Duration) (context.Context, func(error), error)
	MaxBytes          func() (int64, error)
	Progress          *DeliveryProgressRegistry
	DecryptTaskInput  func(string) (string, error)
	DecryptSetting    func(string) (string, error)
	ResolveConfig     func(generation.Config) (generation.Config, error)
	ProtocolRegistry  *protocol.Registry
	RefreshManagedURL func(ctx context.Context, userID, identity, kind string, cause error) (string, bool, error)
	BindRuntime       func(context.Context, generation.CallMeta) context.Context
}

func PersistRemoteGenerationArtifact(deps DeliveryMediaDeps, userID, mediaType, artifactURL, identity string, downloadTimeout time.Duration) (*model.Resource, error) {
	if deps.Resources == nil {
		return nil, errors.New("generation media adapter is not initialized")
	}
	userID = strings.TrimSpace(userID)
	artifactURL = strings.TrimSpace(artifactURL)
	identity = strings.TrimSpace(identity)
	if userID == "" || artifactURL == "" || identity == "" {
		return nil, fmt.Errorf("generation artifact identity is incomplete")
	}
	return deps.Resources.RecoverOwned(userID, identity, func() (localasset.RecoveredArtifact, error) {
		kind, data, mimeType, fileName, width, height, durationMs, err := DecodeGenerationArtifact(deps, userID, identity, mediaType, artifactURL, downloadTimeout)
		if err != nil {
			return localasset.RecoveredArtifact{}, err
		}
		return localasset.RecoveredArtifact{
			Kind: kind, FileName: fileName, MimeType: mimeType,
			Size: int64(len(data)), Width: width, Height: height, DurationMs: durationMs,
			Body: bytes.NewReader(data),
		}, nil
	})
}

func DecodeGenerationArtifact(deps DeliveryMediaDeps, userID, identity, mediaType, artifactURL string, downloadTimeout time.Duration) (kind string, data []byte, mimeType, fileName string, width, height int, durationMs int64, err error) {
	kind = strings.TrimSpace(mediaType)
	switch {
	case strings.HasPrefix(artifactURL, "data:"):
		decodedType, decoded, decodeErr := deps.DecodeDataURL(artifactURL)
		if decodeErr != nil {
			return "", nil, "", "", 0, 0, 0, decodeErr
		}
		mimeType, data = decodedType, decoded
		kind = localasset.NormalizeKind(kind, mimeType)
		fileName = "generated." + localasset.ExtensionFromMimeType(mimeType)
		if kind == "image" {
			width, height = decodeImageDimensions(data)
		}
		if kind == "video" {
			width, height, durationMs = playback.ProbeGeneratedVideoMedia(data)
		}
		return kind, data, mimeType, fileName, width, height, durationMs, nil
	case strings.HasPrefix(artifactURL, "http://") || strings.HasPrefix(artifactURL, "https://"):
		ctx, finish, contextErr := deps.BeginDownload(userID, identity, downloadTimeout)
		if contextErr != nil {
			return "", nil, "", "", 0, 0, 0, contextErr
		}
		defer func() { finish(err) }()
		managed, identityErr := ManagedDeliveryArtifact(deps.Repo, deps.DecryptSetting, userID, identity)
		if identityErr != nil {
			return "", nil, "", "", 0, 0, 0, identityErr
		}
		if managed && !deps.AllowHTTPForTest {
			ctx = outbound.WithPublicHTTPS(ctx)
		}
		if _, urlErr := outbound.ValidateOutboundURLContext(ctx, artifactURL); urlErr != nil {
			return "", nil, "", "", 0, 0, 0, urlErr
		}
		limit, policyErr := deps.MaxBytes()
		if policyErr != nil {
			return "", nil, "", "", 0, 0, 0, policyErr
		}
		maxBytes := limit + 1
		headers, headerErr := ImageDownloadHeaders(deps.Repo, deps.DecryptTaskInput, deps.DecryptSetting, deps.ResolveConfig, deps.ProtocolRegistry, userID, identity, kind, artifactURL)
		if headerErr != nil {
			return "", nil, "", "", 0, 0, 0, headerErr
		}
		downloadOptions := outbound.ResumableOptions{
			PartialPath: ArtifactDownloadPartialPath(deps.DataDir, userID, identity),
			Headers:     headers,
			MaxBytes:    maxBytes,
			OnProgress: func(update outbound.ResumableProgress) {
				if deps.Progress != nil {
					deps.Progress.Record(identity, DeliveryProgressFromOutbound(identity, update))
				}
			},
		}
		result, downloadErr := outbound.DownloadResumable(ctx, artifactURL, downloadOptions)
		if managed && downloadErr != nil && deps.RefreshManagedURL != nil {
			freshURL, refreshed, refreshErr := deps.RefreshManagedURL(ctx, userID, identity, kind, downloadErr)
			if refreshErr != nil {
				return "", nil, "", "", 0, 0, 0, refreshErr
			}
			if refreshed {
				downloadOptions.Headers, err = ImageDownloadHeaders(deps.Repo, deps.DecryptTaskInput, deps.DecryptSetting, deps.ResolveConfig, deps.ProtocolRegistry, userID, identity, kind, freshURL)
				if err != nil {
					return "", nil, "", "", 0, 0, 0, err
				}
				result, downloadErr = outbound.DownloadResumable(ctx, freshURL, downloadOptions)
			}
		}
		if deps.Progress != nil {
			deps.Progress.Clear(identity)
		}
		if downloadErr != nil {
			if errors.Is(downloadErr, outbound.ErrResourceTooLarge) {
				return "", nil, "", "", 0, 0, 0, kernel.BadAuthRequest(fmt.Sprintf("远程资源必须小于 %s", localasset.FormatStorageLimit(maxBytes)))
			}
			return "", nil, "", "", 0, 0, 0, downloadErr
		}
		mimeType, data = result.MimeType, result.Data
		if managed && kind == "audio" {
			mimeType, err = generation.ValidateGeneratedAudio(mimeType, data, "")
			if err != nil {
				return "", nil, "", "", 0, 0, 0, err
			}
		}
		if managed && kind == "video" {
			if err := generation.ValidateVideoArtifact(data, mimeType); err != nil {
				return "", nil, "", "", 0, 0, 0, err
			}
			data, err = RestoreManagedUpscaleAudio(ctx, deps.Repo, deps.DecryptTaskInput, deps.BindRuntime, userID, identity, data)
			if err != nil {
				return "", nil, "", "", 0, 0, 0, err
			}
		}
		if kind == "image" {
			if validationErr := generation.ValidateImageArtifact(data, mimeType); validationErr != nil {
				return "", nil, "", "", 0, 0, 0, validationErr
			}
		}
		kind = localasset.NormalizeKind(kind, mimeType)
		fileName = result.FileName
		if fileName == "" {
			fileName = "resource." + localasset.ExtensionFromMimeType(mimeType)
		}
		if kind == "image" {
			width, height = decodeImageDimensions(data)
		}
		if kind == "video" {
			probedWidth, probedHeight, probedDurationMs := playback.ProbeGeneratedVideoMedia(data)
			if width <= 0 {
				width = probedWidth
			}
			if height <= 0 {
				height = probedHeight
			}
			if durationMs <= 0 {
				durationMs = probedDurationMs
			}
		}
		return kind, data, mimeType, fileName, width, height, durationMs, nil
	default:
		return "", nil, "", "", 0, 0, 0, fmt.Errorf("unsupported generation artifact %q", artifactURL)
	}
}

func isManagedTaskConnection(task model.Task) bool {
	return beeftv.IsManagedTaskInput(task.InputJSON)
}

func ImageDownloadHeaders(
	repo *repository.Repository,
	decryptTaskInput func(string) (string, error),
	decryptSetting func(string) (string, error),
	resolveConfig func(generation.Config) (generation.Config, error),
	registry *protocol.Registry,
	userID, identity, kind, artifactURL string,
) (http.Header, error) {
	if kind != "image" {
		return nil, nil
	}
	taskID, _, ok := strings.Cut(identity, ":")
	if !ok {
		return nil, errors.New("generation artifact identity is incomplete")
	}
	task, err := repo.TaskForUser(userID, taskID)
	if err != nil {
		return nil, err
	}
	if isManagedTaskConnection(*task) {
		return nil, nil
	}
	if strings.TrimSpace(task.InputJSON) == "" {
		return nil, nil
	}
	plain, err := decryptTaskInput(task.InputJSON)
	if err != nil {
		return nil, err
	}
	var input generation.Input
	if err := json.Unmarshal([]byte(plain), &input); err != nil {
		return nil, err
	}
	var retained struct {
		Cipher string `json:"imageDeliveryCipher"`
	}
	if err := json.Unmarshal([]byte(plain), &retained); err != nil {
		return nil, err
	}
	if retained.Cipher != "" {
		configJSON, err := decryptSetting(retained.Cipher)
		if err != nil {
			return nil, err
		}
		if err := json.Unmarshal([]byte(configJSON), &input.Config); err != nil {
			return nil, err
		}
	}
	if input.Config.CredentialRef == beeftv.CredentialRef || input.Config.ChannelID == beeftv.ChannelID {
		return nil, nil
	}
	if input.Config.BaseURL == "" && input.Config.ChannelID == "" {
		return nil, nil
	}
	config, err := resolveConfig(input.Config)
	if err != nil {
		return nil, err
	}
	if !generation.SameProviderOrigin(config.BaseURL, artifactURL) {
		return nil, nil
	}
	req, err := http.NewRequest(http.MethodGet, artifactURL, nil)
	if err != nil {
		return nil, err
	}
	if registry != nil {
		if adapter, ok := registry.Resolve(config.InterfaceType); ok {
			if auth, ok := adapter.(protocol.MediaAuthAdapter); ok {
				if err := generation.ApplyProtocolAuth(req, config, auth.MediaAuth()); err != nil {
					return nil, err
				}
			} else {
				generation.ApplyAuth(req, config)
			}
		} else {
			generation.ApplyAuth(req, config)
		}
	} else {
		generation.ApplyAuth(req, config)
	}
	outbound.ApplyOutboundHeaders(req, config.Headers)
	return req.Header, nil
}

func ManagedDeliveryArtifact(repo *repository.Repository, decryptSetting func(string) (string, error), userID, identity string) (bool, error) {
	taskID, _, ok := strings.Cut(identity, ":")
	if !ok {
		return false, errors.New("generation artifact identity is incomplete")
	}
	task, err := repo.TaskForUser(userID, taskID)
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if isManagedTaskConnection(*task) {
		return true, nil
	}
	var retained struct {
		Cipher string `json:"imageDeliveryCipher"`
	}
	if strings.TrimSpace(task.InputJSON) != "" {
		if err := json.Unmarshal([]byte(task.InputJSON), &retained); err != nil {
			return false, err
		}
	}
	if retained.Cipher != "" {
		plain, err := decryptSetting(retained.Cipher)
		if err != nil {
			return false, err
		}
		var config generation.Config
		if err := json.Unmarshal([]byte(plain), &config); err != nil {
			return false, err
		}
		if config.CredentialRef == beeftv.CredentialRef || config.ChannelID == beeftv.ChannelID {
			return true, nil
		}
		if strings.TrimSpace(config.BaseURL) != "" || strings.TrimSpace(config.APIKey) != "" || strings.TrimSpace(config.ChannelID) != "" {
			return false, nil
		}
	}
	if attempt, err := repo.LatestRouteAttempt(task.ID); err == nil && attempt != nil {
		if attempt.ChannelID == beeftv.ChannelID {
			return true, nil
		}
		if row, err := repo.ImageSubmission(attempt.ID, task.ID, task.UserID); err == nil && row.QueryCipher != "" {
			return true, nil
		}
	}
	return false, nil
}

func ArtifactDownloadPartialPath(dataDir, userID, identity string) string {
	sum := sha256.Sum256([]byte(userID + "\x00" + identity))
	return filepath.Join(dataDir, "cache", "artifact-downloads", hex.EncodeToString(sum[:])+".part")
}

func RefreshManagedArtifactURL(
	ctx context.Context,
	repo *repository.Repository,
	queryManaged func(ctx context.Context, task model.Task) (status string, outputs []beeftv.MediaOutput, managed, legacy bool, err error),
	userID, identity, kind string,
	cause error,
) (string, bool, error) {
	var response *outbound.HTTPStatusError
	if !errors.As(cause, &response) || (response.StatusCode != 401 && response.StatusCode != 403) {
		return "", false, nil
	}
	taskID, rawIndex, ok := strings.Cut(identity, ":")
	index, err := strconv.Atoi(rawIndex)
	if !ok || err != nil || index < 0 {
		return "", false, errors.New("生成结果身份无效")
	}
	task, err := repo.TaskForUser(userID, taskID)
	if err != nil {
		return "", false, err
	}
	status, outputs, managed, legacy, err := queryManaged(ctx, *task)
	if err != nil || !managed {
		return "", managed, err
	}
	if legacy {
		return "", false, nil
	}
	if status != "completed" || index >= len(outputs) || outputs[index].Kind != kind || outputs[index].URL == "" {
		return "", true, errors.New("原任务结果暂不可用，请稍后继续取回")
	}
	return outputs[index].URL, true, nil
}

func RestoreManagedUpscaleAudio(
	ctx context.Context,
	repo *repository.Repository,
	decryptTaskInput func(string) (string, error),
	bindRuntime func(context.Context, generation.CallMeta) context.Context,
	userID, identity string,
	data []byte,
) ([]byte, error) {
	taskID, _, ok := strings.Cut(identity, ":")
	if !ok {
		return nil, errors.New("生成结果身份无效")
	}
	task, err := repo.TaskForUser(userID, taskID)
	if err != nil {
		return nil, err
	}
	plain, err := decryptTaskInput(task.InputJSON)
	if err != nil {
		return nil, err
	}
	var input generation.Input
	if err := json.Unmarshal([]byte(plain), &input); err != nil {
		return nil, err
	}
	if input.Upscale == nil || input.Mode != "video" {
		return data, nil
	}
	if bindRuntime != nil {
		ctx = bindRuntime(ctx, generation.CallMeta{UserID: userID, TaskID: taskID, TaskType: task.Type})
	}
	return generation.RestoreUpscaleSourceAudio(ctx, input, data)
}

func decodeImageDimensions(data []byte) (int, int) {
	config, _, err := image.DecodeConfig(io.LimitReader(bytes.NewReader(data), imageHeaderDecodeLimit))
	if err != nil {
		return 0, 0
	}
	return config.Width, config.Height
}
