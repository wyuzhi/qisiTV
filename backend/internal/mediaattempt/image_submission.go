package mediaattempt

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"gorm.io/gorm"
	"infinite-canvas/backend/internal/beefapi"
	"infinite-canvas/backend/internal/generation"
	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/platform"
	"infinite-canvas/backend/internal/repository"
	"io"
	"net"
	"net/http"
	"strings"
	"time"
)

const MaxSends = 12
const RecoveryLifetime = 23 * time.Hour

// FrozenRequestExpired 表示发出前冻结的完整原请求已不可用：已被清理，或超过 23 小时
// 保存期（比 BeefAPI 24 小时回执保留期早一小时，留出余量）。之后既不能按原字节重发，也不能补交。
func FrozenRequestExpired(row *model.ImageSubmission) bool {
	return row == nil || row.RequestCipher == "" || time.Since(row.CreatedAt) >= RecoveryLifetime
}

const RecoveryWait = 10 * time.Minute
const MaxRequestBytes = 64 << 20

type AttemptContext struct{}
type TaskContext struct{}

type WireRequest struct {
	ChannelID      string
	URL            string
	Header         http.Header
	Body           []byte
	ReplayProtocol string
	MediaType      string
}

func (s *Service) ValidateImageTaskRetry(task *model.Task) error {
	if task.Type != "canvas_image" {
		return nil
	}
	attempt, err := s.repo.LatestRouteAttempt(task.ID)
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	row, err := s.repo.ImageSubmission(attempt.ID, task.ID, task.UserID)
	if errors.Is(err, gorm.ErrRecordNotFound) {
		if attempt.DispatchState == "accepted" || attempt.DispatchState == "submission_unknown" {
			return kernel.BadAuthRequest("图片请求可能已经生成，请保留任务记录并联系支持查询结果，不要重复提交")
		}
		return nil
	}
	if err != nil {
		return err
	}
	if attempt.DispatchState == "rejected_no_job" && !row.ResponseAccepted {
		return nil
	}
	return kernel.BadAuthRequest("图片请求可能已经生成，请保留任务记录并联系支持查询结果，不要重复提交")
}

func DefiniteImageThrottle(err error) bool {
	var upstream generation.HTTPError
	return !IsImageRecoveryError(err) && errors.As(err, &upstream) && upstream.StatusCode == 429 && classifyHTTP(upstream).Category == generation.CategoryThrottled
}

func DefiniteMidjourneyCountRejection(err error) bool {
	var upstream generation.HTTPError
	if !errors.As(err, &upstream) || upstream.StatusCode < 400 {
		return false
	}
	var body struct {
		TaskID string `json:"task_id"`
		ID     string `json:"id"`
		Error  struct {
			Code    string `json:"code"`
			Message string `json:"message"`
			TaskID  string `json:"task_id"`
		} `json:"error"`
	}
	if json.Unmarshal([]byte(upstream.Body), &body) != nil || body.TaskID != "" || body.ID != "" || body.Error.TaskID != "" {
		return false
	}
	return body.Error.Code == "invalid_request" && strings.HasPrefix(strings.ToLower(strings.TrimSpace(body.Error.Message)), "midjourney generates four images per request; n must be 4 or omitted")
}

// A structured VOD parameter failure is a terminal response, even if VOD created
// a task before rejecting its parameters. It is never evidence for an automatic resend.
func DefiniteVODImageParameterFailure(err error) bool {
	if IsImageRecoveryError(err) {
		return false
	}
	var unknown generation.SubmissionUnknownError
	if errors.As(err, &unknown) {
		return false
	}
	var upstream generation.HTTPError
	if !errors.As(err, &upstream) || upstream.StatusCode != http.StatusBadRequest {
		return false
	}
	var body struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if json.Unmarshal([]byte(upstream.Body), &body) != nil {
		return false
	}
	return body.Error.Code == "vod_image_invalid_params" || body.Error.Code == "vod_image_invalid_media"
}

func IsImageRecoveryError(err error) bool {
	var recovery imageRecoveryError
	return errors.As(err, &recovery)
}

// Only a definite gateway rate-limit rejection can start a new paid attempt.
// The executor caps the entire logical task to three attempts and backs off.
func (s *Service) RetryRejectedImageAttempt(task *model.Task, previous *model.RouteAttempt, taskErr error) (*model.RouteAttempt, error) {
	if config, ok := s.ResolveImageRecoveryConfig(*task); ok && config.CredentialRef == beefapi.CredentialRef {
		return nil, nil
	}
	if previous.DispatchState != "rejected_no_job" || !DefiniteImageThrottle(taskErr) {
		return nil, nil
	}
	prior, err := s.repo.ImageSubmission(previous.ID, task.ID, task.UserID)
	if err != nil {
		return nil, nil
	}
	if prior.ResponseAccepted {
		return nil, nil
	}
	id, err := s.repo.NextPrefixedID("ATTEMPT")
	if err != nil {
		return nil, err
	}
	attempt := &model.RouteAttempt{ID: id, TaskID: task.ID, RouteRun: task.RouteRun, AttemptNumber: previous.AttemptNumber + 1, ChannelModelID: task.ChannelModelID, Status: "selected", DispatchState: "not_sent", StartedAt: time.Now()}
	attempt.LogicalModelID, attempt.LogicalModelRevisionID = previous.LogicalModelID, previous.LogicalModelRevisionID
	attempt.RouteID, attempt.ChannelID = previous.RouteID, previous.ChannelID
	plain, err := s.secrets.Decrypt(prior.RequestCipher)
	if err != nil {
		return nil, err
	}
	var wire WireRequest
	if err := json.Unmarshal([]byte(plain), &wire); err != nil {
		return nil, err
	}
	if managedFrozenImage(*task, wire) {
		return nil, nil
	}
	key, _ := WithAttempt(context.Background(), attempt).Value(SubmissionKeyContext{}).(string)
	wire.Header.Set("Idempotency-Key", key)
	raw, err := json.Marshal(wire)
	if err != nil {
		return nil, err
	}
	cipher, err := s.secrets.Encrypt(string(raw))
	if err != nil {
		return nil, err
	}
	next := &model.ImageSubmission{AttemptID: id, TaskID: task.ID, UserID: task.UserID, RequestCipher: cipher, CreatedAt: time.Now()}
	if err := s.repo.CreateImageRetry(attempt, next); err != nil {
		return nil, err
	}
	return attempt, nil
}

// A worker timeout and a local result-save failure do not end the upstream
// request. Release this lease so another bounded execution can collect it.
func (s *Service) ShouldDeferImageRecovery(task model.Task, taskErr error, providerSucceeded bool) bool {
	if task.Type != "canvas_image" || errors.Is(taskErr, context.Canceled) || imageTaskEnded(taskErr) {
		return false
	}
	attempt, err := s.repo.LatestRouteAttempt(task.ID)
	if err != nil {
		return false
	}
	row, err := s.repo.ImageSubmission(attempt.ID, task.ID, task.UserID)
	if err == nil && s.isManagedImageSubmission(task, attempt, row) {
		return true
	}
	if err != nil || FrozenRequestExpired(row) {
		return false
	}
	if row.ResponseAccepted {
		return providerSucceeded || errors.Is(taskErr, context.DeadlineExceeded) || RetrySameImageSubmission(taskErr) || DefiniteImageThrottle(taskErr)
	}
	return row.SendCount < MaxSends && IsImageRecoveryError(taskErr) && errors.Is(taskErr, context.DeadlineExceeded)
}

// ImageTaskEnded 表示没有可继续取回的结果：BeefAPI 已给出终态失败、请求在发出前就失败，
// 或提交被明确拒绝（4xx，超时、冲突和限流除外）。这些任务直接按失败结束，不进入恢复轮询。
func ImageTaskEnded(err error) bool {
	return imageTaskEnded(err)
}

func imageTaskEnded(err error) bool {
	var media *beefapi.MediaTaskError
	var preparation generation.RequestPreparationError
	var notSent generation.RequestNotSentError
	if errors.As(err, &media) {
		return !media.Pending()
	}
	return errors.As(err, &preparation) || errors.As(err, &notSent) || beefapi.IsDefiniteMediaRejection(err)
}

func (s *Service) DeferImageRecovery(task model.Task) error {
	stage, delay := "正在恢复图片结果", 15*time.Second
	attempt, err := s.repo.LatestRouteAttempt(task.ID)
	if err != nil {
		return err
	}
	row, err := s.repo.ImageSubmission(attempt.ID, task.ID, task.UserID)
	if err != nil {
		return err
	}
	if row.ResponseAccepted {
		stage = "图片已生成，保存失败，将稍后重试"
		delay = min(15*time.Minute, time.Minute*time.Duration(1<<min(max(row.SendCount-1, 0), 4)))
	}
	if task.FailureDiagnostics != nil {
		task.FailureDiagnostics.ExecutionResult = "pending"
	}
	return s.repo.DeferRunningTaskForProviderPoll(task.ID, task.LeaseOwner, stage, delay, task.FailureDiagnostics)
}

type imageRecoveryError = generation.ImageRecoveryError
type imagePreparationError = generation.ImagePreparationError

func RecoverableImageEndpoint(req *http.Request) bool {
	return generation.RecoverableImageEndpoint(req)
}

// PrepareImageSubmission runs before the first network write. The request is
// encrypted with the existing workspace key, including credentials and media.
// Recoverable BeefAPI canvas_image routes fail closed when the bound owner or
// attempt identity is missing; other hosts decline so the normal POST proceeds.
func PrepareImageSubmission(s *Service, req *http.Request) (*model.ImageSubmission, bool, error) {
	if req == nil || (!RecoverableImageEndpoint(req) && !isManagedMediaRequest(req)) {
		return nil, false, nil
	}
	if s == nil {
		return nil, true, generation.ErrImageOwnerMissing
	}
	task, taskOK := req.Context().Value(TaskContext{}).(model.Task)
	attemptID, _ := req.Context().Value(AttemptContext{}).(string)
	call, _ := generation.CallMetaFromContext(req.Context())
	canvasImage := (taskOK && task.Type == "canvas_image") || strings.HasPrefix(strings.TrimSpace(call.TaskType), "canvas_image")
	managed := isManagedMediaRequest(req) && taskOK && ManagedTaskConnection(task)
	if !canvasImage && !managed {
		return nil, false, nil
	}
	if !taskOK || attemptID == "" {
		return nil, true, generation.ErrImageOwnerMissing
	}
	key, _ := req.Context().Value(SubmissionKeyContext{}).(string)
	if key == "" {
		return nil, true, errors.New("图片请求缺少持久化提交标识")
	}
	row, err := s.repo.ImageSubmission(attemptID, task.ID, task.UserID)
	if err == nil {
		return row, true, nil
	}
	if !errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, true, err
	}
	if req.Body == nil {
		return nil, true, errors.New("图片请求内容为空")
	}
	body, err := io.ReadAll(io.LimitReader(req.Body, MaxRequestBytes+1))
	_ = req.Body.Close()
	if err != nil {
		return nil, true, err
	}
	if len(body) > MaxRequestBytes {
		return nil, true, errors.New("图片请求超过 64 MiB，暂未提交")
	}
	header := req.Header.Clone()
	header.Del("X-Idempotency-Key")
	header.Set("Idempotency-Key", key)
	original, err := s.repo.LatestRouteAttempt(task.ID)
	if err != nil {
		return nil, true, err
	}
	if original.ID != attemptID {
		return nil, true, generation.ErrImageOwnerMissing
	}
	channelID := s.resolveFrozenChannelID(task, original, call, req.URL.String(), header)
	protocol := generation.ImageReplayProtocol
	mediaType := ""
	if isManagedMediaRequest(req) {
		protocol = beefapi.MediaProtocolVersion
		var envelope beefapi.MediaRequest
		if json.Unmarshal(body, &envelope) != nil || envelope.TaskRef != key || (envelope.MediaType != "image" && envelope.MediaType != "video" && envelope.MediaType != "upscale" && envelope.MediaType != "audio") {
			return nil, true, errors.New("媒体请求的持久化身份或类型无效")
		}
		var input generation.Input
		plain, err := s.secrets.DecryptInputJSON(task.InputJSON)
		if err != nil || json.Unmarshal([]byte(plain), &input) != nil {
			return nil, true, errors.New("媒体任务的原始输入不可用")
		}
		kind := input.Mode
		if input.Upscale != nil {
			kind = "upscale"
		}
		if kind != envelope.MediaType {
			return nil, true, errors.New("媒体请求与原始任务类型不一致")
		}
		mediaType = envelope.MediaType
	}
	raw, err := json.Marshal(WireRequest{ChannelID: channelID, URL: req.URL.String(), Header: header, Body: body, ReplayProtocol: protocol, MediaType: mediaType})
	if err != nil {
		return nil, true, err
	}
	cipher, err := s.secrets.Encrypt(string(raw))
	if err != nil {
		return nil, true, err
	}
	row = &model.ImageSubmission{AttemptID: attemptID, TaskID: task.ID, UserID: task.UserID, RequestCipher: cipher, CreatedAt: time.Now()}
	var wire WireRequest
	if err := json.Unmarshal(raw, &wire); err != nil {
		return nil, true, err
	}
	row.QueryCipher, err = s.ManagedImageQueryCipher(task, wire)
	if err != nil {
		return nil, true, err
	}
	if err := s.ExpireImageSubmissionRequests(); err != nil {
		return nil, true, err
	}
	if err := s.repo.CreateImageSubmission(row); err != nil {
		return nil, true, err
	}
	// A concurrent claimant can only use the first committed request.
	row, err = s.repo.ImageSubmission(attemptID, task.ID, task.UserID)
	return row, true, err
}

func (s *Service) ImageSubmissionWire(row *model.ImageSubmission) (WireRequest, error) {
	var wire WireRequest
	plain, err := s.secrets.Decrypt(row.RequestCipher)
	if err != nil {
		return wire, err
	}
	err = json.Unmarshal([]byte(plain), &wire)
	return wire, err
}

func (s *Service) SendImageSubmission(ctx context.Context, task model.Task, row *model.ImageSubmission) ([]byte, string, error) {
	return s.SendImageSubmissionWith(ctx, task, row, func(req *http.Request, admit func() error) ([]byte, string, error) {
		return generation.DoBinaryWithDispatchAdmission(req.WithContext(s.runtime.Receipts(req.Context())), admit)
	}, generation.SleepContext)
}

func (s *Service) SendImageSubmissionWith(ctx context.Context, task model.Task, row *model.ImageSubmission, send func(*http.Request, func() error) ([]byte, string, error), wait func(context.Context, time.Duration) error) ([]byte, string, error) {
	return s.SendImageSubmissionWithMode(ctx, task, row, send, wait, false)
}

// singleReplay 只用于失败任务的后台同键取回，每轮最多发一次。
func (s *Service) SendImageSubmissionWithMode(ctx context.Context, task model.Task, row *model.ImageSubmission, send func(*http.Request, func() error) ([]byte, string, error), wait func(context.Context, time.Duration) error, singleReplay bool) ([]byte, string, error) {
	maxSends := MaxSends
	if singleReplay {
		maxSends = 0
	}
	if row.TaskID != task.ID || row.UserID != task.UserID {
		return nil, "", imageRecoveryError{errors.New("图片任务归属不一致")}
	}
	if FrozenRequestExpired(row) || (!singleReplay && !row.ResponseAccepted && row.SendCount >= MaxSends) {
		return nil, "", imageRecoveryError{errors.New("图片结果恢复等待已结束")}
	}
	wire, err := s.ImageSubmissionWire(row)
	if err != nil {
		return nil, "", imageRecoveryError{err}
	}
	if managedFrozenImage(task, wire) {
		return nil, "", imageRecoveryError{errors.New("BeefTV 图片任务只能按原编号查询")}
	}
	deadline := time.Now().Add(RecoveryWait)
	if expires := row.CreatedAt.Add(RecoveryLifetime); expires.Before(deadline) {
		deadline = expires
	}
	ctx, cancel := context.WithDeadline(ctx, deadline)
	defer cancel()
	initialSendCount := row.SendCount
	for {
		if err := ctx.Err(); err != nil {
			return nil, "", imageRecoveryError{err}
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, wire.URL, bytes.NewReader(wire.Body))
		if err != nil {
			return nil, "", imageRecoveryError{err}
		}
		req.Header = wire.Header.Clone()
		if wire.ReplayProtocol == generation.ImageReplayProtocol {
			req = req.WithContext(generation.WithImageReplayProtocol(req.Context(), wire.ReplayProtocol))
		} else {
			req, err = generation.NegotiateImageReplay(req)
			if err != nil {
				return nil, "", imageRecoveryError{err}
			}
		}
		if !RecoverableImageEndpoint(req) || req.Header.Get("Idempotency-Key") == "" {
			return nil, "", imageRecoveryError{errors.New("图片恢复记录无效")}
		}
		data, mime, sendErr := send(req, func() error {
			if err := ctx.Err(); err != nil {
				return imageRecoveryError{err}
			}
			if singleReplay || row.SendCount > 0 || row.ResponseAccepted {
				attempt, err := s.repo.LatestRouteAttempt(task.ID)
				if err != nil {
					return imageRecoveryError{err}
				}
				if attempt.ID != row.AttemptID || attempt.RouteRun != task.RouteRun {
					return imageRecoveryError{repository.ErrTaskStateConflict}
				}
				available, err := s.ImageRecoveryChannelAvailable(attempt, wire)
				if err != nil {
					return imageRecoveryError{err}
				}
				if !available {
					return imageRecoveryError{ErrIdentityUnavailable}
				}
			}
			if err := s.repo.ClaimImageSubmissionSend(row, task.LeaseOwner, maxSends); err != nil {
				return imageRecoveryError{err}
			}
			return nil
		})
		if sendErr == nil {
			if len(data) > 0 && s.repo != nil {
				if jobID := generation.ExtractBeefAPIImageJobID(nil, data); jobID != "" {
					_ = s.repo.UpdateTaskImageJobID(task.ID, jobID)
				}
			}
			if err := s.repo.MarkImageSubmissionAccepted(row); err != nil {
				return nil, "", imageRecoveryError{err}
			}
			if singleReplay {
				return data, mime, nil
			} // 自动扫描还需区分 2xx 正文中的业务失败。
			var payload generation.ImageResponse
			if err := json.Unmarshal(data, &payload); err != nil {
				return nil, "", imageRecoveryError{err}
			}
			if _, err := generation.ImageDataURLs(payload); err != nil {
				return nil, "", imageRecoveryError{err}
			}
			return data, mime, nil
		}
		if s.repo != nil {
			var httpErr generation.HTTPError
			if errors.As(sendErr, &httpErr) && httpErr.Body != "" {
				if jobID := generation.ExtractBeefAPIImageJobID(nil, []byte(httpErr.Body)); jobID != "" {
					_ = s.repo.UpdateTaskImageJobID(task.ID, jobID)
				}
			}
		}
		if singleReplay {
			return nil, "", imageRecoveryError{sendErr}
		}
		if DefiniteImageInputRejection(sendErr) && (row.ResponseAccepted || row.SendCount > 1) {
			return nil, "", imageRecoveryError{sendErr}
		}
		if !row.ResponseAccepted && DefiniteMidjourneyCountRejection(sendErr) {
			return nil, "", sendErr
		}
		if !RetrySameImageSubmission(sendErr) {
			var preparation generation.RequestPreparationError
			if errors.As(sendErr, &preparation) {
				return nil, "", sendErr
			}
			var upstream generation.HTTPError
			if errors.As(sendErr, &upstream) && (upstream.StatusCode == 409 || upstream.StatusCode == 410 || upstream.StatusCode >= 500) {
				return nil, "", imageRecoveryError{sendErr}
			}
			return nil, "", sendErr
		}
		if (!row.ResponseAccepted && row.SendCount >= MaxSends) || (row.ResponseAccepted && row.SendCount-initialSendCount >= 3) {
			return nil, "", imageRecoveryError{sendErr}
		}
		delay := time.Second * time.Duration(1<<min(row.SendCount, 5))
		var upstream generation.HTTPError
		if errors.As(sendErr, &upstream) && upstream.RetryAfter > delay {
			delay = upstream.RetryAfter
		}
		if err := s.repo.UpdateTaskProgressForLease(task.ID, task.LeaseOwner, "正在恢复图片结果", 0); err != nil {
			return nil, "", imageRecoveryError{err}
		}
		if err := wait(ctx, delay); err != nil {
			return nil, "", imageRecoveryError{err}
		}
	}
}

func RetrySameImageSubmission(err error) bool {
	if DefiniteMidjourneyCountRejection(err) {
		return false
	}
	var preparation generation.RequestPreparationError
	if errors.As(err, &preparation) {
		return false
	}
	if errors.Is(err, context.Canceled) {
		return false
	}
	var circuit generation.CircuitOpenError
	if errors.As(err, &circuit) {
		return true
	}
	if code, _ := platform.ChannelSlotFailureDetails(err); code != "" {
		return true
	}
	var upstream generation.HTTPError
	if errors.As(err, &upstream) {
		var body struct {
			Error struct {
				Code string `json:"code"`
			} `json:"error"`
		}
		_ = json.Unmarshal([]byte(upstream.Body), &body)
		switch body.Error.Code {
		case "image_submission_pending", "image_submission_unavailable", "image_result_unavailable":
			return true
		case "image_result_unknown", "image_result_expired", "idempotency_conflict":
			return false
		}
		if upstream.IdempotencyReplayed {
			return false
		}
		return upstream.StatusCode >= 500 || upstream.StatusCode == 408
	}
	var network net.Error
	return errors.As(err, &network) || errors.Is(err, io.ErrUnexpectedEOF) || errors.Is(err, io.EOF)
}

func (s *Service) RecoverImageSubmission(ctx context.Context, task model.Task) (map[string]interface{}, bool, error) {
	attemptID, _ := ctx.Value(AttemptContext{}).(string)
	if attemptID == "" || (task.Type != "canvas_image" && !ManagedTaskConnection(task)) {
		return nil, false, nil
	}
	row, err := s.repo.ImageSubmission(attemptID, task.ID, task.UserID)
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, false, nil
	}
	if err != nil {
		return nil, true, imageRecoveryError{err}
	}
	if result, managed, collectErr := s.CollectManagedImage(ctx, task, row); managed {
		return result, true, collectErr
	}
	if task.Type != "canvas_image" {
		return nil, false, nil
	}
	data, _, err := s.SendImageSubmission(ctx, task, row)
	if err != nil {
		return nil, true, err
	}
	var payload generation.ImageResponse
	if err := json.Unmarshal(data, &payload); err != nil {
		return nil, true, imageRecoveryError{err}
	}
	images, err := generation.ImageDataURLs(payload)
	if err != nil {
		return nil, true, imageRecoveryError{fmt.Errorf("恢复图片响应: %w", err)}
	}
	return map[string]interface{}{"mode": "image", "images": images}, true, nil
}
