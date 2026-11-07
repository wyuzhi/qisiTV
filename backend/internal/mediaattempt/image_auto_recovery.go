package mediaattempt

import (
	"context"
	"encoding/json"
	"errors"
	"gorm.io/gorm"
	"infinite-canvas/backend/internal/beefapi"
	"infinite-canvas/backend/internal/generation"
	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/outbound"
	"infinite-canvas/backend/internal/repository"
	localtask "infinite-canvas/backend/internal/task"
	"net/http"
	"strings"
	"time"
)

const imageRecoveryBatch = 8
const imageRecoveryPassTimeout = 15 * time.Second

// 每次下载循环最多挂一个短图片恢复批次；慢上游不阻塞下载、画布写回。
func (s *Service) StartImageRecoveryPass(ctx context.Context) {
	if !s.imageRecoveryActive.CompareAndSwap(false, true) {
		return
	}
	started := s.runtime.Go(func() {
		defer s.imageRecoveryActive.Store(false)
		if ctx.Err() != nil || s.runtime.IsDraining() {
			return
		}
		bounded, cancel := context.WithTimeout(ctx, imageRecoveryPassTimeout)
		defer cancel()
		if err := s.RecoverFailedImages(bounded, imageRecoveryBatch); err != nil {
			// 不记录原请求、响应或上游错误正文。
			_ = s.log("", "", "warn", "图片自动取回暂缓，将稍后再试", "")
		}
	})
	if !started {
		s.imageRecoveryActive.Store(false)
	}
}

func (s *Service) RecoverFailedImages(ctx context.Context, limit int) error {
	s.scanMu.Lock()
	defer s.scanMu.Unlock()
	if limit <= 0 {
		limit = imageRecoveryBatch
	}
	tasks, err := s.repo.FailedImagesForRecovery(s.imageRecoveryAfterID, limit)
	if err != nil {
		return err
	}
	if len(tasks) == 0 && s.imageRecoveryAfterID != "" {
		tasks, err = s.repo.FailedImagesForRecovery("", limit)
		if err != nil {
			return err
		}
	}
	var last error
	for _, candidate := range tasks {
		if ctx.Err() != nil || s.runtime.IsDraining() {
			return ctx.Err()
		}
		s.imageRecoveryAfterID = candidate.ID
		if err := s.RecoverFailedImage(ctx, candidate); err != nil && !errors.Is(err, repository.ErrTaskProviderRecoveryConflict) {
			last = err
		}
	}
	if len(tasks) < limit {
		s.imageRecoveryAfterID = ""
	}
	return last
}

func imageSettlementNeedsPolling(task model.Task) bool {
	return task.MediaSettlementPending()
}

func ImageRecoveryNeedsPolling(task model.Task) bool {
	return task.RecoveryOutcome == nil || *task.RecoveryOutcome == "" || imageSettlementNeedsPolling(task)
}

// 托管任务的「无法取回」会定期向 BeefAPI 复查：早期客户端曾只凭本地请求时长下这个结论；
// 现在本地只在「原 Key 查不到原编号、冻结原请求也已过期」时下（ResolveMissingManagedSubmission），
// BeefAPI 之后能查到这次提交时，复查会按它的结论纠正。
func (s *Service) ManagedImageNeedsRecheck(task model.Task) bool {
	if task.RecoveryOutcome == nil || *task.RecoveryOutcome != localtask.RecoveryUnrecoverable {
		return false
	}
	if ManagedTaskConnection(task) {
		return true
	}
	attempt, err := s.repo.LatestRouteAttempt(task.ID)
	if err != nil || attempt == nil || attempt.RouteRun != task.RouteRun {
		return false
	}
	row, _ := s.repo.ImageSubmission(attempt.ID, task.ID, task.UserID)
	return s.isManagedImageSubmission(task, attempt, row)
}

func (s *Service) RecoverFailedImage(ctx context.Context, candidate model.Task) error {
	if candidate.IsUpscale() {
		return nil
	}
	owner := "manual-recovery:" + kernel.NewID()
	if err := s.repo.ClaimFailedTaskProviderRecovery(candidate.ID, candidate.UserID, owner, providerTaskRecoveryLeaseDuration); err != nil {
		return err
	}
	defer s.repo.ReleaseTaskProviderRecovery(candidate.ID, owner)
	// 领取后重新读取，不能使用扫描时的旧 routeRun 或终态结论。
	task, err := s.repo.TaskForUser(candidate.UserID, candidate.ID)
	if err != nil {
		return err
	}
	recheck := s.ManagedImageNeedsRecheck(*task)
	if task.LeaseOwner != owner || task.Status != model.TaskStatusFailed || (!ImageRecoveryNeedsPolling(*task) && !recheck) {
		return nil
	}
	var outcome string
	var recoveryErr error
	if task.RecoveryOutcome != nil && *task.RecoveryOutcome != "" && !recheck {
		outcome = *task.RecoveryOutcome
	} else {
		var result []byte
		result, outcome, recoveryErr = s.FailedImageResult(ctx, *task)
		if task.ImageJobID == "" {
			if latest, loadErr := s.repo.Task(task.ID); loadErr == nil && latest != nil && latest.ImageJobID != "" {
				task.ImageJobID = latest.ImageJobID
			}
		}
		if len(result) > 0 && recoveryErr == nil {
			task.Error, task.FailureDiagnostics = "", nil
			if err := s.completion.Save(task, result, nil, false); err == nil {
				return nil
			} else {
				recoveryErr = err
			}
		}
	}
	settlementErr := s.SyncFailedImageBeefSettlement(ctx, task)
	if recoveryErr == nil && settlementErr != nil {
		recoveryErr = settlementErr
	}
	var conclusion *string
	var next *time.Time
	if outcome != "" {
		conclusion = &outcome
	}
	if outcome == "" || imageSettlementNeedsPolling(*task) || (task.ImageJobID != "" && task.BeefBillingState == nil && settlementErr != nil) {
		// 暂时失败或对账未完成时继续轮询。发送次数只影响退避，不再把 12 次当成结果丢失。
		delay := 30 * time.Second
		if errors.Is(recoveryErr, ErrManagedResubmitted) {
			delay = 15 * time.Second
		} else if a, loadErr := s.repo.LatestRouteAttempt(task.ID); loadErr == nil {
			if row, loadErr := s.repo.ImageSubmission(a.ID, task.ID, task.UserID); loadErr == nil {
				delay = min(15*time.Minute, 30*time.Second*time.Duration(1<<min(row.SendCount, 5)))
			}
		}
		at := time.Now().Add(delay)
		next = &at
	} else if concluded := *task; outcome == localtask.RecoveryUnrecoverable {
		// 托管图片的「无法取回」仍会定期向 BeefAPI 复查（ManagedImageNeedsRecheck），
		// 留出间隔，避免每轮扫描都查一次。
		concluded.RecoveryOutcome = &outcome
		if s.ManagedImageNeedsRecheck(concluded) {
			at := time.Now().Add(time.Hour)
			next = &at
		}
	}
	if err := s.repo.FinishFailedImageRecovery(*task, conclusion, next); err != nil {
		return err
	}
	return recoveryErr
}

func (s *Service) ResolveImageRecoveryConfig(task model.Task) (generation.Config, bool) {
	var config generation.Config
	if decrypted, err := s.secrets.DecryptInputJSON(task.InputJSON); err == nil && strings.TrimSpace(decrypted) != "" {
		var input generation.Input
		if json.Unmarshal([]byte(decrypted), &input) == nil {
			config = input.Config
		}
	}
	if attempt, err := s.repo.LatestRouteAttempt(task.ID); err == nil && attempt != nil {
		if config.ChannelID == "" && attempt.ChannelID != "" {
			config.ChannelID = attempt.ChannelID
		}
		if row, err := s.repo.ImageSubmission(attempt.ID, task.ID, task.UserID); err == nil && row != nil {
			if wire, err := s.ImageSubmissionWire(row); err == nil {
				if config.ChannelID == "" && wire.ChannelID != "" {
					config.ChannelID = wire.ChannelID
				}
				if config.BaseURL == "" && wire.URL != "" {
					if idx := strings.Index(wire.URL, "/v1/"); idx > 0 {
						config.BaseURL = wire.URL[:idx+3]
					}
				}
				if config.APIKey == "" && wire.Header != nil {
					auth := strings.TrimSpace(wire.Header.Get("Authorization"))
					if strings.HasPrefix(strings.ToLower(auth), "bearer ") {
						config.APIKey = strings.TrimSpace(auth[7:])
					}
				}
			}
		}
	}
	if resolved, err := s.connections.ResolveProviderConfig(config); err == nil {
		config = resolved
	}
	return config, strings.TrimSpace(config.BaseURL) != ""
}

func (s *Service) SyncFailedImageBeefSettlement(ctx context.Context, task *model.Task) error {
	if task == nil {
		return nil
	}
	if attempt, err := s.repo.LatestRouteAttempt(task.ID); err == nil && attempt != nil {
		if row, err := s.repo.ImageSubmission(attempt.ID, task.ID, task.UserID); err == nil {
			queryCtx := context.WithValue(ctx, TaskContext{}, *task)
			query, managed, queryErr := s.ManagedTaskQuery(queryCtx, *task, row)
			if managed {
				if queryErr != nil {
					return queryErr
				}
				if latest, err := s.repo.Task(task.ID); err == nil && latest.BeefBillingState != nil && !latest.MediaSettlementPending() {
					task.BeefBillingState, task.BeefReconcileDeadline = latest.BeefBillingState, latest.BeefReconcileDeadline
					return nil
				}
				_, err := query.Client.Query(queryCtx, query.Key, query.Kind)
				if latest, loadErr := s.repo.Task(task.ID); loadErr == nil {
					task.BeefBillingState, task.BeefReconcileDeadline = latest.BeefBillingState, latest.BeefReconcileDeadline
				}
				return err
			}
		}
	}
	if strings.TrimSpace(task.ImageJobID) == "" {
		if receipt, err := s.repo.ImageCreateReceipt(task.UserID, task.ID); err == nil && receipt != nil {
			if jobID := generation.ExtractBeefAPIImageJobID(nil, []byte(receipt.ResponseBody)); jobID != "" {
				task.ImageJobID = jobID
				_ = s.repo.UpdateTaskImageJobID(task.ID, jobID)
			}
		}
	}
	if strings.TrimSpace(task.ImageJobID) == "" || (task.BeefBillingState != nil && !task.MediaSettlementPending()) {
		return nil
	}
	config, ok := s.ResolveImageRecoveryConfig(*task)
	if !ok {
		return nil
	}
	queryCtx := ctx
	if s.runtime.HasAccounting() {
		queryCtx = s.runtime.ForTask(queryCtx, *task)
	}
	queryCtx = s.runtime.Receipts(queryCtx)
	settlement, _, err := generation.QueryBeefAPIImageJob(queryCtx, config, task.ImageJobID)
	if err != nil {
		return err
	}
	if settlement.HasBillingState && settlement.BillingState != nil {
		normalized := strings.ToLower(strings.TrimSpace(*settlement.BillingState))
		task.BeefBillingState = &normalized
	}
	if settlement.ReconcileDeadline != nil {
		trimmed := strings.TrimSpace(*settlement.ReconcileDeadline)
		if trimmed == "" {
			task.BeefReconcileDeadline = nil
		} else {
			task.BeefReconcileDeadline = &trimmed
		}
	} else if settlement.HasBillingState && task.BeefBillingState != nil && strings.TrimSpace(*task.BeefBillingState) != "" {
		task.BeefReconcileDeadline = nil
	}
	if settlement.HasBillingState || settlement.ReconcileDeadline != nil {
		_ = s.repo.UpdateTaskBeefImageSettlement(task.ID, task.BeefBillingState, task.BeefReconcileDeadline)
	}
	return nil
}

func (s *Service) FailedImageResult(ctx context.Context, task model.Task) ([]byte, string, error) {
	return s.FailedImageResultWith(ctx, task, func(req *http.Request, admit func() error) ([]byte, string, error) {
		return generation.DoBinaryWithDispatchAdmission(req.WithContext(s.runtime.Receipts(req.Context())), admit)
	})
}

func (s *Service) FailedImageResultWith(ctx context.Context, task model.Task, send func(*http.Request, func() error) ([]byte, string, error)) ([]byte, string, error) {
	all, err := s.repo.ImageRecoveryEvidence([]string{task.ID})
	if err != nil {
		return nil, "", err
	}
	evidence := all[task.ID]
	attempt, submission := evidence.Attempt, evidence.Submission
	if (ManagedTaskConnection(task) || (attempt != nil && attempt.ChannelID == beefapi.ChannelID)) && (attempt == nil || submission == nil || attempt.RouteRun != task.RouteRun) {
		return nil, "", imageRecoveryError{errors.New("原任务查询信息暂不可用，尚未确认结果")}
	}
	if attempt != nil && submission != nil && attempt.RouteRun == task.RouteRun {
		row, loadErr := s.repo.ImageSubmission(attempt.ID, task.ID, task.UserID)
		if loadErr != nil {
			return nil, "", loadErr
		}
		queryCtx := context.WithValue(s.runtime.ForTask(ctx, task), TaskContext{}, task)
		// 原任务仍在生成时会一直等；手动取回的请求不能因此一直挂着，到时照常返回「还在确认中」，后台接着跟进。
		queryCtx, cancelQuery := context.WithTimeout(queryCtx, managedRecoveryCollectWait)
		defer cancelQuery()
		if recovered, managed, collectErr := s.RecoverManagedImage(queryCtx, task, row); managed {
			if collectErr != nil {
				if beefapi.IsMediaTaskNotFound(collectErr) {
					outcome, resubmitted, resolveErr := s.ResolveMissingManagedSubmission(queryCtx, task)
					switch {
					case outcome != "":
						return nil, outcome, nil
					case resubmitted:
						return nil, "", imageRecoveryError{ErrManagedResubmitted}
					case resolveErr != nil:
						return nil, "", resolveErr
					}
					return nil, "", imageRecoveryError{collectErr}
				}
				if beefapi.IsTerminalMediaTaskError(collectErr) {
					return nil, localtask.RecoveryNoResult, nil
				}
				return nil, "", collectErr
			}
			body, marshalErr := json.Marshal(recovered)
			return body, "", marshalErr
		}
	}
	receipt, err := s.repo.ImageCreateReceipt(task.UserID, task.ID)
	// 同键恢复也会追加创建日志。历史日志有歧义时不能挑一个旧成功结果，
	// 但仍可由当前轮次的冻结请求及原键向网关取回确切回执。
	if err != nil && !errors.Is(err, repository.ErrAmbiguousImageCreateReceipts) {
		return nil, "", err
	}
	if receipt != nil && attempt != nil {
		started := receipt.StartedAt
		if started.IsZero() {
			started = receipt.CreatedAt
		}
		if attempt.RouteRun != task.RouteRun || started.Before(attempt.StartedAt) {
			receipt = nil
		}
	}
	result, _, receiptErr := imageResultFromReceiptContext(ctx, receipt)
	var dns *outbound.DNSResolutionError
	if errors.As(receiptErr, &dns) || errors.Is(receiptErr, context.Canceled) || errors.Is(receiptErr, context.DeadlineExceeded) {
		return nil, "", receiptErr
	}
	if len(result) > 0 && receiptErr == nil {
		return result, "", nil
	}

	if attempt != nil && attempt.RouteRun == task.RouteRun && attempt.DispatchState == "rejected_no_job" && (submission == nil || !submission.ResponseAccepted) {
		return nil, localtask.RecoveryNoResult, nil
	}
	if receipt != nil {
		if conclusion := ImageReceiptConclusion(receipt.StatusCode, receipt.ResponseBody); conclusion != "" {
			return nil, conclusion, nil
		}
	}
	if submission == nil || attempt == nil || attempt.RouteRun != task.RouteRun || (attempt.DispatchState != "accepted" && attempt.DispatchState != "submission_unknown") {
		return nil, localtask.RecoveryUnrecoverable, nil
	}
	// 仅实际恢复需要读取完整冻结请求，读投影始终只查询小字段。
	row, err := s.repo.ImageSubmission(attempt.ID, task.ID, task.UserID)
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, localtask.RecoveryUnrecoverable, nil
	}
	if err != nil {
		return nil, "", err
	}
	if FrozenRequestExpired(row) {
		return nil, localtask.RecoveryUnrecoverable, nil
	}
	safe, err := s.SafeFrozenImageReplay(task, attempt, row)
	if err != nil {
		return nil, "", err
	}
	if !safe {
		return nil, localtask.RecoveryUnrecoverable, nil
	}
	wire, err := s.ImageSubmissionWire(row)
	if err != nil {
		return nil, "", err
	}
	available, err := s.ImageRecoveryChannelAvailable(attempt, wire)
	if err != nil {
		return nil, "", err
	}
	if !available {
		return nil, localtask.RecoveryUnrecoverable, nil
	}
	ctx = s.runtime.ForTask(ctx, task)
	metadata := callMeta(ctx)
	metadata.ChannelID = kernel.FirstNonEmpty(attempt.ChannelID, wire.ChannelID)
	ctx = s.runtime.Bind(ctx, metadata)
	bounded, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	data, _, sendErr := s.SendImageSubmissionWithMode(bounded, task, row, send, generation.SleepContext, true)
	if sendErr != nil {
		if errors.Is(sendErr, ErrIdentityUnavailable) {
			return nil, localtask.RecoveryUnrecoverable, nil
		}
		var upstream generation.HTTPError
		if errors.As(sendErr, &upstream) {
			if upstream.StatusCode == http.StatusUnauthorized || upstream.StatusCode == http.StatusForbidden {
				return nil, localtask.RecoveryUnrecoverable, nil
			}
			switch imageReceiptErrorCode(upstream.Body) {
			case "image_result_unknown", "image_result_expired", "idempotency_conflict":
				return nil, localtask.RecoveryUnrecoverable, nil
			}
			// 原键的明确终态失败并不代表未计费。
			if upstream.IdempotencyReplayed && upstream.StatusCode >= 400 && upstream.StatusCode < 500 && upstream.StatusCode != 408 && upstream.StatusCode != 409 && upstream.StatusCode != 429 {
				return nil, localtask.RecoveryNoResult, nil
			}
		}
		return nil, "", sendErr
	}
	if conclusion := ImageReceiptConclusion(http.StatusOK, string(data)); conclusion != "" {
		return nil, conclusion, nil
	}
	var payload generation.ImageResponse
	if err := json.Unmarshal(data, &payload); err != nil {
		return nil, "", err
	}
	images, err := generation.ImageDataURLs(payload)
	if err != nil {
		return nil, "", err
	}
	result, err = json.Marshal(map[string]any{"mode": "image", "images": images})
	return result, "", err
}

func ImageReceiptConclusion(statusCode int, body string) string {
	if statusCode == http.StatusUnauthorized || statusCode == http.StatusForbidden {
		return localtask.RecoveryUnrecoverable
	}
	switch imageReceiptErrorCode(body) {
	case "image_result_unknown", "image_result_expired", "idempotency_conflict":
		return localtask.RecoveryUnrecoverable
	case "image_submission_pending", "image_submission_unavailable", "image_result_unavailable":
		return ""
	}
	// 通用 HTTP 错误正文不是生成终态；408/429/5xx 等仍可按原键取回。
	if statusCode < http.StatusOK || statusCode >= http.StatusMultipleChoices {
		return ""
	}
	var payload map[string]any
	if json.Unmarshal([]byte(body), &payload) == nil {
		if _, _, failed := generation.PayloadBusinessFailure(payload); failed {
			return localtask.RecoveryNoResult
		}
	}
	return ""
}

func imageReceiptErrorCode(body string) string {
	var payload struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	_ = json.Unmarshal([]byte(body), &payload)
	return payload.Error.Code
}

func (s *Service) SafeFrozenImageReplay(task model.Task, attempt *model.RouteAttempt, row *model.ImageSubmission) (bool, error) {
	if row == nil || attempt == nil || row.TaskID != task.ID || row.UserID != task.UserID || row.AttemptID != attempt.ID || row.RequestCipher == "" {
		return false, nil
	}
	plain, err := s.secrets.Decrypt(row.RequestCipher)
	if err != nil {
		return false, err
	}
	var wire WireRequest
	if json.Unmarshal([]byte(plain), &wire) != nil {
		return false, nil
	}
	if wire.ReplayProtocol != generation.ImageReplayProtocol || len(wire.Body) == 0 {
		return false, nil
	}
	ctx := WithAttempt(context.Background(), attempt)
	key, _ := ctx.Value(SubmissionKeyContext{}).(string)
	if wire.Header.Get("Idempotency-Key") != key {
		return false, nil
	}
	req, err := http.NewRequestWithContext(generation.WithImageReplayProtocol(ctx, wire.ReplayProtocol), http.MethodPost, wire.URL, nil)
	return err == nil && RecoverableImageEndpoint(req), nil
}
