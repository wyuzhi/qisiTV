package asset

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"time"

	"qisitv/backend/internal/kernel"
	"qisitv/backend/internal/mediatools"
	"qisitv/backend/internal/model"
)

const videoDeriveTimeout = 90 * time.Second

type ExtractVideoFramesRequest struct {
	Preset  string  `json:"preset,omitempty"`
	TimesMs []int64 `json:"timesMs,omitempty"`
}

type ExtractedFrameResource struct {
	TimeMs   int64          `json:"timeMs"`
	Resource model.Resource `json:"resource"`
}

type ExtractedFrameFailure struct {
	TimeMs int64  `json:"timeMs"`
	Reason string `json:"reason"`
}

type ExtractVideoFramesResult struct {
	Frames     []ExtractedFrameResource `json:"frames"`
	Failures   []ExtractedFrameFailure  `json:"failures,omitempty"`
	DurationMs int64                    `json:"durationMs,omitempty"`
}

type SeparateVideoAudioResult struct {
	Audio      model.Resource `json:"audio"`
	MutedVideo model.Resource `json:"mutedVideo"`
	DurationMs int64          `json:"durationMs,omitempty"`
}

type derivedOutputSpec struct {
	kind       string
	fileName   string
	mimeType   string
	size       int64
	width      int
	height     int
	durationMs int64
	path       string
	identity   string
}

func (s *Service) ExtractVideoFrames(ctx context.Context, userID, resourceID string, req ExtractVideoFramesRequest, idempotencyKey string) (*ExtractVideoFramesResult, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	preset := strings.TrimSpace(req.Preset)
	if preset != "" && preset != "first" && preset != "last" {
		return nil, kernel.BadAuthRequest("不支持的截帧模式")
	}
	if preset == "" && len(req.TimesMs) == 0 {
		return nil, kernel.BadAuthRequest("请选择要截取的时间点")
	}
	if len(req.TimesMs) > mediatools.MaxExtractedFrames {
		return nil, kernel.BadAuthRequest(fmt.Sprintf("单次最多截取 %d 帧", mediatools.MaxExtractedFrames))
	}
	srcResource, srcFile, cleanupSrc, err := s.openLocalVideoSource(userID, resourceID)
	if err != nil {
		return nil, err
	}
	defer cleanupSrc()

	runCtx, cancel := context.WithTimeout(ctx, videoDeriveTimeout)
	defer cancel()

	workDir, err := s.makeDeriveTempDir()
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(workDir)

	extracted, err := mediatools.ExtractVideoFrames(runCtx, srcFile, workDir, preset, req.TimesMs)
	if err != nil {
		return nil, mapVideoDeriveError(ctx, runCtx, err)
	}

	baseKey := scopedDeriveBaseKey(userID, srcResource, "frames", frameRequestFingerprint(preset, req.TimesMs), idempotencyKey)
	specs := make([]derivedOutputSpec, 0, len(extracted.Frames))
	for index, frame := range extracted.Frames {
		var itemIdentity string
		if baseKey != "" {
			itemIdentity = fmt.Sprintf("%s:frame:%d:%d", baseKey, index, frame.TimeMs)
		}
		specs = append(specs, derivedOutputSpec{
			kind:     "image",
			fileName: fmt.Sprintf("video-frame-%dms.png", frame.TimeMs),
			mimeType: frame.Mime,
			size:     frame.Size,
			width:    frame.Width,
			height:   frame.Height,
			path:     frame.Path,
			identity: itemIdentity,
		})
	}
	stored, err := s.storeDerivedBatch(runCtx, userID, baseKey, specs)
	if err != nil {
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			return nil, mapVideoDeriveError(ctx, runCtx, err)
		}
		return nil, err
	}
	items := make([]ExtractedFrameResource, 0, len(stored))
	for index, res := range stored {
		items = append(items, ExtractedFrameResource{
			TimeMs:   extracted.Frames[index].TimeMs,
			Resource: *res,
		})
	}
	var failures []ExtractedFrameFailure
	if len(extracted.Failures) > 0 {
		failures = make([]ExtractedFrameFailure, 0, len(extracted.Failures))
		for _, item := range extracted.Failures {
			failures = append(failures, ExtractedFrameFailure{
				TimeMs: item.TimeMs,
				Reason: item.Reason,
			})
		}
	}
	return &ExtractVideoFramesResult{
		Frames:     items,
		Failures:   failures,
		DurationMs: extracted.DurationMs,
	}, nil
}

func (s *Service) SeparateVideoAudio(ctx context.Context, userID, resourceID string, idempotencyKey string) (*SeparateVideoAudioResult, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	srcResource, srcFile, cleanupSrc, err := s.openLocalVideoSource(userID, resourceID)
	if err != nil {
		return nil, err
	}
	defer cleanupSrc()

	runCtx, cancel := context.WithTimeout(ctx, videoDeriveTimeout)
	defer cancel()

	workDir, err := s.makeDeriveTempDir()
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(workDir)

	separated, err := mediatools.SeparateVideoAudio(runCtx, srcFile, workDir)
	if err != nil {
		return nil, mapVideoDeriveError(ctx, runCtx, err)
	}
	baseKey := scopedDeriveBaseKey(userID, srcResource, "separate-audio", "full", idempotencyKey)
	var audioIdentity, videoIdentity string
	if baseKey != "" {
		audioIdentity = baseKey + ":audio"
		videoIdentity = baseKey + ":muted-video"
	}
	stored, err := s.storeDerivedBatch(runCtx, userID, baseKey, []derivedOutputSpec{
		{
			kind:       "audio",
			fileName:   separated.Audio.FileName,
			mimeType:   separated.Audio.Mime,
			size:       separated.Audio.Size,
			durationMs: separated.Audio.DurationMs,
			path:       separated.Audio.Path,
			identity:   audioIdentity,
		},
		{
			kind:       "video",
			fileName:   separated.MutedVideo.FileName,
			mimeType:   separated.MutedVideo.Mime,
			size:       separated.MutedVideo.Size,
			width:      separated.MutedVideo.Width,
			height:     separated.MutedVideo.Height,
			durationMs: separated.MutedVideo.DurationMs,
			path:       separated.MutedVideo.Path,
			identity:   videoIdentity,
		},
	})
	if err != nil {
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			return nil, mapVideoDeriveError(ctx, runCtx, err)
		}
		return nil, err
	}
	return &SeparateVideoAudioResult{
		Audio:      *stored[0],
		MutedVideo: *stored[1],
		DurationMs: separated.DurationMs,
	}, nil
}

func scopedDeriveBaseKey(userID string, src *model.Resource, op string, requestFingerprint string, clientKey string) string {
	trimmed := strings.TrimSpace(clientKey)
	if trimmed == "" || src == nil {
		return ""
	}
	raw := strings.Join([]string{
		"video-derive-v1",
		strings.TrimSpace(userID),
		src.ID,
		src.ObjectKey,
		strconv.FormatInt(src.Size, 10),
		src.ETag,
		op,
		requestFingerprint,
		trimmed,
	}, "\x00")
	digest := sha256.Sum256([]byte(raw))
	return hex.EncodeToString(digest[:])
}

func frameRequestFingerprint(preset string, timesMs []int64) string {
	if preset != "" {
		return "preset:" + preset
	}
	normalized := make([]int64, len(timesMs))
	for i, v := range timesMs {
		normalized[i] = max(int64(0), v)
	}
	slices.Sort(normalized)
	normalized = slices.Compact(normalized)
	parts := make([]string, len(normalized))
	for i, v := range normalized {
		parts[i] = strconv.FormatInt(v, 10)
	}
	return "times:" + strings.Join(parts, ",")
}

type stagedDerivedSlot struct {
	spec          derivedOutputSpec
	uploadKey     *string
	quotaIdentity string
	day           string
	heldQuota     bool
	createdRow    bool
	claimedFailed bool
	existingReady *model.Resource
	resource      *model.Resource
}

// storeDerivedBatch stages all outputs as PENDING (holding reservations via Quota)
// and publishes READY + Commit only after every blob in the batch has been written.
// Any pre-publish failure releases reservations through Quota while rows are still
// PENDING, then removes newly staged DB rows before deleting staged blobs.
func (s *Service) storeDerivedBatch(ctx context.Context, userID string, baseKey string, specs []derivedOutputSpec) ([]*model.Resource, error) {
	if s == nil || s.repo == nil {
		return nil, ResourceMissing()
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if trimmedBase := strings.TrimSpace(baseKey); trimmedBase != "" {
		unlockBatch := workspaceWriteLocks.acquire([]string{
			s.writeSpace() + "\x00derive-batch\x00" + strings.TrimSpace(userID) + "\x00" + trimmedBase,
		})
		defer unlockBatch()
	}

	staged := make([]stagedDerivedSlot, 0, len(specs))
	rollbackStaged := func(cause error) {
		for idx := len(staged) - 1; idx >= 0; idx-- {
			slot := &staged[idx]
			if slot.heldQuota && s.quota != nil {
				s.quota.Release(userID, slot.day, slot.spec.size, slot.quotaIdentity)
				slot.heldQuota = false
			}
			if slot.createdRow && slot.resource != nil {
				_ = s.repo.DeleteResource(userID, slot.resource.ID)
				if strings.TrimSpace(slot.resource.ObjectKey) != "" && s.blobs != nil {
					_ = s.blobs.Delete(slot.resource.ObjectKey)
				}
				continue
			}
			if slot.claimedFailed && slot.resource != nil {
				_ = s.persistFailedResource(slot.resource, cause)
				if strings.TrimSpace(slot.resource.ObjectKey) != "" && s.blobs != nil {
					_ = s.blobs.Delete(slot.resource.ObjectKey)
				}
			}
		}
	}

	for _, spec := range specs {
		if err := ctx.Err(); err != nil {
			rollbackStaged(err)
			return nil, err
		}
		if spec.size <= 0 {
			err := MissingUpload()
			rollbackStaged(err)
			return nil, err
		}
		var uploadIdentity []string
		if strings.TrimSpace(spec.identity) != "" {
			uploadIdentity = []string{spec.identity}
		}
		uploadIdentity = EnsureUploadIdentity(uploadIdentity)
		uploadKey := NormalizedUploadKey(uploadIdentity)
		slot, err := s.stageOneDerivedSlot(ctx, userID, spec, uploadKey)
		if err != nil {
			rollbackStaged(err)
			if full := kernel.DiskFullError(err); full != nil {
				if full.Cause != nil {
					full.Cause = errors.New(mediatools.RedactDiagnosticText(full.Cause.Error(), s.dataDir, spec.path))
				}
				return nil, full
			}
			return nil, err
		}
		staged = append(staged, slot)
	}

	if err := ctx.Err(); err != nil {
		rollbackStaged(err)
		return nil, err
	}

	results := make([]*model.Resource, len(staged))
	toPublish := make([]*model.Resource, 0, len(staged))
	lockKeys := make([]string, 0, len(staged)*2)
	space := s.writeSpace()
	trimmedUser := strings.TrimSpace(userID)
	for i := range staged {
		slot := &staged[i]
		if slot.existingReady != nil {
			results[i] = slot.existingReady
			continue
		}
		res := slot.resource
		toPublish = append(toPublish, res)
		if trimmedUser != "" {
			if slot.uploadKey != nil {
				if key := strings.TrimSpace(*slot.uploadKey); key != "" {
					lockKeys = append(lockKeys, space+"\x00upload\x00"+trimmedUser+"\x00"+key)
				}
			}
			if resID := strings.TrimSpace(res.ID); resID != "" {
				lockKeys = append(lockKeys, space+"\x00resource\x00"+trimmedUser+"\x00"+resID)
			}
		}
	}

	if len(toPublish) > 0 {
		unlockPublish := workspaceWriteLocks.acquire(lockKeys)
		now := time.Now()
		for _, res := range toPublish {
			res.Status = model.ResourceStatusReady
			res.Error = ""
			res.UpdatedAt = now
		}
		saveErr := s.repo.SaveResources(toPublish)
		unlockPublish()
		if saveErr != nil {
			for _, res := range toPublish {
				res.Status = model.ResourceStatusPending
			}
			rollbackStaged(saveErr)
			return nil, fmt.Errorf("保存资源就绪状态失败：%w", saveErr)
		}
		for _, res := range toPublish {
			s.commitQuota(res)
			s.afterReady(res)
			res.PublicURL = ""
		}
	}
	for i := range staged {
		if results[i] == nil {
			results[i] = staged[i].resource
		}
	}
	return results, nil
}

func (s *Service) stageOneDerivedSlot(
	ctx context.Context,
	userID string,
	spec derivedOutputSpec,
	uploadKey *string,
) (stagedDerivedSlot, error) {
	existing, err := s.resourceForUploadKey(userID, uploadKey)
	if err != nil {
		return stagedDerivedSlot{}, err
	}
	if existing != nil && existing.Status == model.ResourceStatusReady {
		existing.PublicURL = ""
		return stagedDerivedSlot{spec: spec, uploadKey: uploadKey, existingReady: existing}, nil
	}

	lockResourceID := ""
	if existing != nil {
		lockResourceID = existing.ID
	}
	unlock := s.lockWrite(userID, uploadKey, lockResourceID)
	defer unlock()

	existing, err = s.resourceForUploadKey(userID, uploadKey)
	if err != nil {
		return stagedDerivedSlot{}, err
	}
	if existing != nil && existing.Status == model.ResourceStatusReady {
		existing.PublicURL = ""
		return stagedDerivedSlot{spec: spec, uploadKey: uploadKey, existingReady: existing}, nil
	}

	if existing == nil {
		qIdentity := quotaIdentity(uploadKey, "")
		// Derived outputs come from an already-owned local video (which may have been
		// uploaded via chunked upload above ResourceUploadMB), so enforce daily upload
		// and account total storage limits via ReserveChunked without a single-file cap.
		day, err := s.reserveChunked(userID, spec.size, qIdentity)
		if err != nil {
			return stagedDerivedSlot{}, err
		}
		file, err := os.Open(spec.path)
		if err != nil {
			if s.quota != nil {
				s.quota.Release(userID, day, spec.size, qIdentity)
			}
			return stagedDerivedSlot{}, err
		}
		defer file.Close()

		now := time.Now()
		kind := NormalizeKind(spec.kind, spec.mimeType)
		objectKey := ObjectKey(userID, kind, spec.fileName, spec.mimeType, now)
		res := model.Resource{
			ID: kernel.NewID(), UserID: userID, Kind: kind, Status: model.ResourceStatusPending,
			Provider: "local", ObjectKey: objectKey, MimeType: spec.mimeType, Size: spec.size,
			Width: spec.width, Height: spec.height, DurationMs: spec.durationMs, UploadKey: uploadKey,
			CreatedAt: now, UpdatedAt: now,
		}
		if err := s.repo.CreateResource(&res); err != nil {
			if s.quota != nil {
				s.quota.Release(userID, day, spec.size, qIdentity)
			}
			if latest, lookupErr := s.resourceForUploadKey(userID, uploadKey); lookupErr == nil && latest != nil && latest.Status == model.ResourceStatusReady {
				latest.PublicURL = ""
				return stagedDerivedSlot{spec: spec, uploadKey: uploadKey, existingReady: latest}, nil
			}
			return stagedDerivedSlot{}, err
		}
		etag, err := s.WriteObject(&res, spec.fileName, file)
		res.UpdatedAt = time.Now()
		if err != nil {
			if s.quota != nil {
				s.quota.Release(userID, day, spec.size, qIdentity)
			}
			_ = s.repo.DeleteResource(userID, res.ID)
			if strings.TrimSpace(res.ObjectKey) != "" && s.blobs != nil {
				_ = s.blobs.Delete(res.ObjectKey)
			}
			return stagedDerivedSlot{}, err
		}
		res.ETag = etag
		_ = s.probeMediaMetadata(ctx, &res)
		return stagedDerivedSlot{
			spec:          spec,
			uploadKey:     uploadKey,
			quotaIdentity: qIdentity,
			day:           day,
			heldQuota:     true,
			createdRow:    true,
			resource:      &res,
		}, nil
	}

	if err := uploadIdentityConflict(existing, spec.kind, spec.mimeType, spec.size); err != nil {
		return stagedDerivedSlot{}, err
	}
	claimedFailed := false
	if existing.Status == model.ResourceStatusFailed {
		claimed, claimErr := s.repo.ClaimFailedResourceUpload(userID, existing.ID)
		if claimErr != nil {
			return stagedDerivedSlot{}, claimErr
		}
		if !claimed {
			latest, latestErr := s.ownedResource(userID, existing.ID)
			if latestErr != nil {
				return stagedDerivedSlot{}, latestErr
			}
			if latest.Status == model.ResourceStatusReady {
				latest.PublicURL = ""
				return stagedDerivedSlot{spec: spec, uploadKey: existing.UploadKey, existingReady: latest}, nil
			}
			return stagedDerivedSlot{}, UploadInProgress()
		}
		existing, err = s.ownedResource(userID, existing.ID)
		if err != nil {
			return stagedDerivedSlot{}, err
		}
		claimedFailed = true
	} else if existing.Status != model.ResourceStatusPending {
		return stagedDerivedSlot{}, UploadInProgress()
	}

	qIdentity := quotaIdentity(existing.UploadKey, existing.ID)
	day, heldQuota, err := s.ensureReservation(userID, qIdentity, func() (string, error) {
		return s.reserveChunked(userID, spec.size, qIdentity)
	})
	if err != nil {
		if claimedFailed {
			_ = s.persistFailedResource(existing, err)
		}
		return stagedDerivedSlot{}, err
	}
	file, err := os.Open(spec.path)
	if err != nil {
		if heldQuota && s.quota != nil {
			s.quota.Release(userID, day, spec.size, qIdentity)
		}
		if claimedFailed {
			_ = s.persistFailedResource(existing, err)
		}
		return stagedDerivedSlot{}, err
	}
	defer file.Close()

	kind := NormalizeKind(spec.kind, spec.mimeType)
	if existing.Provider != "local" {
		existing.Provider = "local"
		existing.Endpoint = ""
		existing.Bucket = ""
		existing.StorageSettingID = ""
		existing.ObjectKey = ObjectKey(userID, kind, spec.fileName, spec.mimeType, time.Now())
	}
	existing.Status = model.ResourceStatusPending
	existing.Error = ""
	existing.Width = spec.width
	existing.Height = spec.height
	existing.DurationMs = spec.durationMs
	existing.UpdatedAt = time.Now()
	etag, err := s.WriteObject(existing, spec.fileName, file)
	existing.UpdatedAt = time.Now()
	if err != nil {
		if heldQuota && s.quota != nil {
			s.quota.Release(userID, day, spec.size, qIdentity)
		}
		if claimedFailed {
			_ = s.persistFailedResource(existing, err)
		}
		return stagedDerivedSlot{}, err
	}
	existing.ETag = etag
	_ = s.probeMediaMetadata(ctx, existing)
	return stagedDerivedSlot{
		spec:          spec,
		uploadKey:     existing.UploadKey,
		quotaIdentity: qIdentity,
		day:           day,
		heldQuota:     heldQuota,
		claimedFailed: claimedFailed,
		resource:      existing,
	}, nil
}

func (s *Service) openLocalVideoSource(userID, resourceID string) (*model.Resource, string, func(), error) {
	if s == nil || s.repo == nil {
		return nil, "", nil, ResourceMissing()
	}
	resource, err := s.ownedResource(userID, resourceID)
	if err != nil {
		return nil, "", nil, err
	}
	if resource.Status != model.ResourceStatusReady {
		return nil, "", nil, ResourceNotReady()
	}
	if NormalizeKind(resource.Kind, resource.MimeType) != "video" {
		return nil, "", nil, kernel.BadAuthRequest("仅支持从视频素材提取画面或分离音频")
	}
	if strings.TrimSpace(resource.Provider) != "local" || s.blobs == nil {
		return nil, "", nil, kernel.NewAppError(kernel.CodeUnavailable, "资源不在本地存储中")
	}
	file, err := s.blobs.Open(resource.ObjectKey)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, "", nil, ResourceFileMissing()
		}
		return nil, "", nil, err
	}
	return resource, file.Name(), func() { _ = file.Close() }, nil
}

func (s *Service) makeDeriveTempDir() (string, error) {
	base := ""
	if s != nil && s.dataDir != "" {
		candidate := filepath.Join(s.dataDir, "tmp")
		if err := os.MkdirAll(candidate, 0o750); err == nil {
			base = candidate
		}
	}
	dir, err := os.MkdirTemp(base, "video-derive-*")
	if err != nil {
		redactedCause := errors.New(mediatools.RedactDiagnosticText(err.Error(), s.dataDir, base, os.TempDir()))
		if full := kernel.DiskFullError(err); full != nil {
			full.Cause = redactedCause
			return "", full
		}
		return "", kernel.WrapAppError(500, "创建媒体处理临时目录失败", redactedCause)
	}
	return dir, nil
}

func mapVideoDeriveError(parentCtx, runCtx context.Context, err error) error {
	if parentCtx.Err() != nil {
		return parentCtx.Err()
	}
	if errors.Is(err, context.DeadlineExceeded) || errors.Is(runCtx.Err(), context.DeadlineExceeded) {
		return context.DeadlineExceeded
	}
	if errors.Is(err, mediatools.ErrToolUnavailable) {
		return kernel.WrapAppError(kernel.CodeUnavailable, "本地视频处理工具不可用", err)
	}
	if errors.Is(err, mediatools.ErrNoAudioTrack) {
		return kernel.BadAuthRequest("原视频没有音轨，无法分离音频。画面中的人物或动作不代表文件包含声音；请换用带声音的视频。")
	}
	if errors.Is(err, mediatools.ErrNoVideoTrack) {
		return kernel.BadAuthRequest("原素材不包含有效视频画面，请检查素材是否完整")
	}
	if full := kernel.DiskFullError(err); full != nil {
		return full
	}
	if errors.Is(err, mediatools.ErrInvalidMedia) {
		return kernel.WrapAppError(400, "视频文件损坏或编码格式不受支持，请检查素材是否完整", err)
	}
	if errors.Is(err, mediatools.ErrMediaProcessFailed) {
		return kernel.WrapAppError(500, "本地视频处理失败，请稍后重试", err)
	}
	return kernel.BadAuthRequest(err.Error())
}
