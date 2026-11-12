package mediaattempt

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"gorm.io/gorm"
	"qisitv/backend/internal/beeftv"
	"qisitv/backend/internal/generation"
	"qisitv/backend/internal/model"
	"qisitv/backend/internal/outbound"
	localtask "qisitv/backend/internal/task"
	"net/http"
	"strings"
	"time"
)

// This adapter owns only the existing local send fence. BeefTV owns the
// asynchronous task, provider retry and recovery after the first write.
type managedMediaPort struct{ service *Service }

func ManagedTaskConnection(task model.Task) bool {
	return beeftv.IsManagedTaskInput(task.InputJSON)
}

func (p managedMediaPort) Project(ctx context.Context, projection beeftv.MediaTask) {
	task, ok := ctx.Value(TaskContext{}).(model.Task)
	if !ok || p.service == nil {
		return
	}
	if projection.TaskID != "" {
		_ = p.service.repo.UpdateTaskImageJobID(task.ID, projection.TaskID)
	}
	var deadline *string
	if projection.ReconcileDeadline != nil {
		value := time.Unix(*projection.ReconcileDeadline, 0).UTC().Format(time.RFC3339)
		deadline = &value
	}
	_ = p.service.repo.UpdateTaskBeefImageSettlement(task.ID, projection.BillingState, deadline)
	if projection.MediaType != "image" {
		_ = p.service.repo.UpdateTaskBeefVideoSettlement(task.ID, projection.UsageState, deadline)
	}
}

func (p managedMediaPort) Sent(ctx context.Context) (bool, error) {
	task, ok := ctx.Value(TaskContext{}).(model.Task)
	attempt, _ := ctx.Value(AttemptContext{}).(string)
	if p.service == nil || !ok || attempt == "" {
		return false, generation.ErrImageOwnerMissing
	}
	row, err := p.service.repo.ImageSubmission(attempt, task.ID, task.UserID)
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return row.SendCount > 0 || row.ResponseAccepted, nil
}
func (p managedMediaPort) Begin(req *http.Request) (bool, error) {
	row, handled, err := PrepareImageSubmission(p.service, req)
	if err != nil {
		return false, err
	}
	if !handled {
		return false, generation.ErrImageOwnerMissing
	}
	if row.SendCount > 0 || row.ResponseAccepted {
		return true, nil
	}
	wire, err := p.service.ImageSubmissionWire(row)
	if err != nil {
		return false, err
	}
	if wire.ReplayProtocol != beeftv.MediaProtocolVersion || wire.Header.Get("Idempotency-Key") != req.Header.Get("Idempotency-Key") || wire.URL != req.URL.String() {
		return false, errors.New("媒体任务原始提交身份不一致")
	}
	task := req.Context().Value(TaskContext{}).(model.Task)
	if err := p.service.repo.ClaimImageSubmissionSend(row, task.LeaseOwner, 1); err != nil {
		current, loadErr := p.service.repo.ImageSubmission(row.AttemptID, row.TaskID, row.UserID)
		if loadErr == nil && (current.SendCount > 0 || current.ResponseAccepted) {
			return true, nil
		}
		return false, err
	}
	req.Body = ioReadCloser(wire.Body)
	req.ContentLength = int64(len(wire.Body))
	return false, nil
}

type memoryReadCloser struct{ *bytes.Reader }

func (memoryReadCloser) Close() error            { return nil }
func ioReadCloser(data []byte) *memoryReadCloser { return &memoryReadCloser{bytes.NewReader(data)} }

func isManagedMediaRequest(req *http.Request) bool {
	return req != nil && req.URL != nil && req.Method == http.MethodPost && strings.HasSuffix(req.URL.Path, "/media/tasks") && req.Header.Get(beeftv.MediaProtocolHeader) == beeftv.MediaProtocolVersion
}
func managedFrozenImage(task model.Task, wire WireRequest) bool {
	return wire.ReplayProtocol == beeftv.MediaProtocolVersion || ManagedTaskConnection(task) || wire.ChannelID == beeftv.ChannelID
}

func (s *Service) isManagedImageSubmission(task model.Task, attempt *model.RouteAttempt, row *model.ImageSubmission) bool {
	if ManagedTaskConnection(task) || (attempt != nil && attempt.ID != "" && (row == nil || attempt.ID == row.AttemptID) && attempt.ChannelID == beeftv.ChannelID) {
		return true
	}
	if row == nil {
		return false
	}
	if row.QueryCipher != "" {
		plain, err := s.secrets.Decrypt(row.QueryCipher)
		var wire WireRequest
		if err != nil || json.Unmarshal([]byte(plain), &wire) != nil {
			return true
		}
		return managedFrozenImage(task, wire)
	}
	wire, err := s.ImageSubmissionWire(row)
	return err == nil && managedFrozenImage(task, wire)
}

func (s *Service) ManagedImageQueryCipher(task model.Task, wire WireRequest) (string, error) {
	if !managedFrozenImage(task, wire) {
		return "", nil
	}
	wire.Body = nil
	raw, err := json.Marshal(wire)
	if err != nil {
		return "", err
	}
	return s.secrets.Encrypt(string(raw))
}

func (s *Service) ExpireImageSubmissionRequests() error {
	for {
		rows, err := s.repo.ExpiredImageSubmissionRequests()
		if err != nil {
			return err
		}
		for _, row := range rows {
			query := row.QueryCipher
			if query == "" {
				// Old frozen requests can contain 64MiB of inline bytes. Read and
				// decrypt one at a time; the cleanup batch only contains small fields.
				full, err := s.repo.ImageSubmission(row.AttemptID, row.TaskID, row.UserID)
				if err != nil {
					return err
				}
				row = *full
				query = row.QueryCipher
				if wire, err := s.ImageSubmissionWire(&row); query == "" && err == nil {
					if task, err := s.repo.TaskForUser(row.UserID, row.TaskID); err == nil {
						if attempt, err := s.repo.LatestRouteAttempt(task.ID); err == nil && attempt.ID == row.AttemptID && attempt.ChannelID == beeftv.ChannelID {
							wire.ChannelID = beeftv.ChannelID
						}
						query, err = s.ManagedImageQueryCipher(*task, wire)
						if err != nil {
							return err
						}
					}
				}
			}
			if err := s.repo.ExpireImageSubmissionRequest(row, query); err != nil {
				return err
			}
		}
		if len(rows) < 100 {
			return nil
		}
	}
}

type Query struct {
	Client    *beeftv.MediaClient
	Key, Kind string
	Legacy    bool
}

func (s *Service) ManagedTaskQuery(ctx context.Context, task model.Task, row *model.ImageSubmission) (Query, bool, error) {
	managed := ManagedTaskConnection(task)
	if attempt, err := s.repo.LatestRouteAttempt(task.ID); err == nil && attempt != nil && attempt.ID == row.AttemptID && attempt.ChannelID == beeftv.ChannelID {
		managed = true
	}
	var wire WireRequest
	var err error
	if row.QueryCipher != "" {
		var plain string
		plain, err = s.secrets.Decrypt(row.QueryCipher)
		if err == nil {
			err = json.Unmarshal([]byte(plain), &wire)
		}
	} else {
		wire, err = s.ImageSubmissionWire(row)
	}
	if err != nil {
		return Query{}, managed || row.QueryCipher != "", imageRecoveryError{errors.New("原任务查询信息暂不可用，尚未确认结果")}
	}
	managed = managed || managedFrozenImage(task, wire)
	if !managed {
		return Query{}, false, nil
	}
	if row.QueryCipher == "" {
		wire.ChannelID = beeftv.ChannelID
		cipher, cipherErr := s.ManagedImageQueryCipher(task, wire)
		if cipherErr != nil {
			return Query{}, true, cipherErr
		}
		if cipher != "" {
			if err := s.repo.SaveImageQueryCipher(*row, cipher); err != nil {
				return Query{}, true, err
			}
		}
	}
	key := strings.TrimSpace(wire.Header.Get("Idempotency-Key"))
	if key == "" {
		return Query{}, true, imageRecoveryError{errors.New("历史媒体任务缺少原始查询编号")}
	}
	base := wire.URL
	for _, part := range []string{"/media/tasks", "/images/generations", "/images/edits"} {
		if index := strings.LastIndex(base, part); index >= 0 {
			base = base[:index]
			break
		}
	}
	client := &beeftv.MediaClient{BaseURL: base, APIKey: strings.TrimPrefix(wire.Header.Get("Authorization"), "Bearer "), Headers: wire.Header.Clone()}
	runtime, _ := generation.RuntimeFromContext(ctx)
	client.AllowHTTPTest = runtime.Endpoints.BeefTVVideoBaseURL != ""
	client.Project = managedMediaPort{service: s}.Project
	startedAt := time.Now()
	client.Observe = func(req *http.Request, resp *http.Response, body []byte, callErr error) {
		started := startedAt
		startedAt = time.Now()
		if runtime.Receipts == nil {
			return
		}
		observation := generation.TransportObservation{Request: req, Body: body, Err: callErr, StartedAt: started, Dispatched: true}
		if resp != nil {
			observation.StatusCode = resp.StatusCode
			observation.HTTPStatus = resp.StatusCode
			observation.Headers = resp.Header.Clone()
		}
		runtime.Receipts.Observe(observation)
	}
	kind := wire.MediaType
	if kind == "" {
		kind = "image"
	}
	if kind == "upscale" {
		client.ExpectedOutputKind = strings.TrimPrefix(task.Type, "canvas_")
		if client.ExpectedOutputKind != "image" && client.ExpectedOutputKind != "video" {
			return Query{}, true, errors.New("原超分任务素材类型无效")
		}
	}
	return Query{Client: client, Key: key, Kind: kind, Legacy: wire.ReplayProtocol != beeftv.MediaProtocolVersion}, true, nil
}

// CollectManagedImage 在生成过程中（含重启后接着跟进）等待原任务结果。查不到编号也继续等：
// 原请求可能还在路上，这时下「被拒」的结论会让用户重新生成而原请求之后照样扣费。
func (s *Service) CollectManagedImage(ctx context.Context, task model.Task, row *model.ImageSubmission) (map[string]any, bool, error) {
	query, managed, err := s.ManagedTaskQuery(ctx, task, row)
	if err != nil || !managed {
		return nil, managed, err
	}
	result, err := query.Client.Wait(ctx, query.Key, query.Kind, query.Legacy)
	if err != nil {
		return nil, true, imageRecoveryError{err}
	}
	return result, true, nil
}

// RecoverManagedImage 在失败任务的恢复里取原任务结果。查不到原编号时立即返回 404，
// 交给 ResolveMissingManagedSubmission 决定补交还是下结论；其余错误按暂时失败处理。
func (s *Service) RecoverManagedImage(ctx context.Context, task model.Task, row *model.ImageSubmission) (map[string]any, bool, error) {
	query, managed, err := s.ManagedTaskQuery(ctx, task, row)
	if err != nil || !managed {
		return nil, managed, err
	}
	result, err := query.Client.Collect(ctx, query.Key, query.Kind, query.Legacy)
	if beeftv.IsMediaTaskNotFound(err) {
		return nil, true, err
	}
	if err != nil {
		return nil, true, imageRecoveryError{err}
	}
	return result, true, nil
}

func (s *Service) ManagedTaskRecoveryQuery(ctx context.Context, task model.Task) (Query, bool, error) {
	attempt, err := s.repo.LatestRouteAttempt(task.ID)
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return Query{}, false, nil
	}
	if err != nil {
		return Query{}, false, err
	}
	if attempt.RouteRun != task.RouteRun {
		return Query{}, false, nil
	}
	row, err := s.repo.ImageSubmission(attempt.ID, task.ID, task.UserID)
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return Query{}, false, nil
	}
	if err != nil {
		return Query{}, false, err
	}
	return s.ManagedTaskQuery(ctx, task, row)
}

const (
	videoRecoveryRetentionWindow = 24 * time.Hour
	managedVideoUnreportedAge    = 7 * 24 * time.Hour
)

func ManagedFailureInfo(err error) (statusCode int, explicitRejection, terminalFailure bool) {
	var managedHTTP *beeftv.MediaHTTPError
	if errors.As(err, &managedHTTP) {
		statusCode = managedHTTP.StatusCode
		explicitRejection = beeftv.IsDefiniteMediaRejection(err)
	}
	var managedTask *beeftv.MediaTaskError
	if errors.As(err, &managedTask) && !managedTask.Pending() {
		if managedTask.Code == "media_submission_rejected" && strings.TrimSpace(managedTask.TaskID) == "" {
			explicitRejection = true
		} else {
			terminalFailure = true
		}
	}
	return statusCode, explicitRejection, terminalFailure
}

func ClassifyFailedVideoQueryOutcome(task model.Task, providerStatus string, err error, now time.Time) string {
	if mediaErr := (*beeftv.MediaTaskError)(nil); (errors.As(err, &mediaErr) && mediaErr.Code == "media_submission_rejected") || isUnreportedManagedInvalidQuery(task, providerStatus, err) {
		return localtask.RecoveryNoResult
	}
	if BeefTVOwnsVideoConclusion(task, now) {
		if isTerminalVideoProviderStatus(providerStatus) && (task.BeefUsageState != nil || task.BeefBillingState != nil) {
			return localtask.RecoveryNoResult
		}
		return ""
	}
	if dns := (*outbound.DNSResolutionError)(nil); errors.As(err, &dns) || errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return ""
	}
	if payloadErr := (generation.PayloadError{}); isTerminalVideoProviderStatus(providerStatus) || errors.As(err, &payloadErr) {
		return localtask.RecoveryNoResult
	}
	if isUnrecoverableVideoQueryError(err) || VideoTaskPastRetentionWindow(task, now) {
		return localtask.RecoveryUnrecoverable
	}
	return ""
}

func isUnreportedManagedInvalidQuery(task model.Task, providerStatus string, err error) bool {
	if !ManagedTaskConnection(task) || task.BeefUsageState != nil || task.BeefBillingState != nil || task.BeefReconcileDeadline != nil || (strings.TrimSpace(providerStatus) != "" && !isTerminalVideoProviderStatus(providerStatus)) {
		return false
	}
	httpErr, mediaHTTP := generation.HTTPError{}, (*beeftv.MediaHTTPError)(nil)
	return (errors.As(err, &httpErr) && (httpErr.StatusCode == http.StatusBadRequest || httpErr.StatusCode == http.StatusUnprocessableEntity)) ||
		(errors.As(err, &mediaHTTP) && (mediaHTTP.StatusCode == http.StatusBadRequest || mediaHTTP.StatusCode == http.StatusUnprocessableEntity))
}

func isTerminalVideoProviderStatus(status string) bool {
	switch strings.ToLower(strings.TrimSpace(status)) {
	case "failed", "failure", "error", "cancelled", "canceled", "expired":
		return true
	}
	return false
}

func isUnrecoverableVideoQueryError(err error) bool {
	if err == nil {
		return false
	}
	if upstream := (generation.HTTPError{}); errors.As(err, &upstream) && (upstream.StatusCode == http.StatusUnauthorized || upstream.StatusCode == http.StatusForbidden) {
		return true
	}
	msg := err.Error()
	return strings.Contains(msg, "该任务的请求协议不支持安全查询上游状态") || strings.Contains(msg, "上游返回的任务 ID 与原视频任务不一致") ||
		strings.Contains(msg, "超分回执与原任务不一致") || strings.Contains(msg, "任务输入解析失败") || strings.Contains(msg, "该任务没有可恢复的上游任务 ID")
}

func VideoTaskPastRetentionWindow(task model.Task, now time.Time) bool {
	if ManagedTaskConnection(task) {
		return !BeefTVOwnsVideoConclusion(task, now)
	}
	anchor := videoTaskAnchor(task)
	return !anchor.IsZero() && now.Sub(anchor) >= videoRecoveryRetentionWindow
}

// 托管视频结论由 BeefTV 给出；无结算记录的旧任务若回查已被 400/422 拒绝（isUnreportedManagedInvalidQuery）则立即按无结果终结，
// 若仅遇 5xx 等暂态或未知响应则保留 7 天（覆盖跨周末异步对账窗口，参见 TestManagedVideoDoesNotInferSettlementOrExpiry），超期再本地终结。
// 例外：原 Key 查不到原编号（404）且冻结原请求已过 23 小时保存期时，由 ResolveMissingManagedSubmission 先判「无法取回」，
// 不再等满 7 天（BeefTV 收到的提交 30 分钟内就会结案，查不到说明它没有这条记录）。
func BeefTVOwnsVideoConclusion(task model.Task, now time.Time) bool {
	if !ManagedTaskConnection(task) {
		return false
	}
	if task.BeefUsageState != nil || task.BeefBillingState != nil || task.BeefReconcileDeadline != nil {
		return true
	}
	anchor := videoTaskAnchor(task)
	return anchor.IsZero() || now.Sub(anchor) < managedVideoUnreportedAge
}

func VideoTaskAnchor(task model.Task) time.Time {
	return videoTaskAnchor(task)
}

func videoTaskAnchor(task model.Task) time.Time {
	if task.StartedAt != nil && !task.StartedAt.IsZero() {
		return *task.StartedAt
	}
	return task.CreatedAt
}
