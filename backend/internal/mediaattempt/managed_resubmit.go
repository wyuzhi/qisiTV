package mediaattempt

import (
	"context"
	"errors"
	"net/http"
	"time"

	"qisitv/backend/internal/beefapi"
	"qisitv/backend/internal/model"
	localtask "qisitv/backend/internal/task"
)

// managedRecoveryCollectWait 是一次恢复里等待托管任务结果的上限。
const managedRecoveryCollectWait = 20 * time.Second

// ErrManagedResubmitted 表示刚用原编号补交了原请求，结果要等下一轮查询。
var ErrManagedResubmitted = errors.New("已用原编号补交原请求，正在等待结果")

// ResolveMissingManagedSubmission 处理「BeefAPI 用原 Key 查不到原编号」（beefapi.IsMediaTaskNotFound）。
// 返回非空 outcome 时，调用方把它写成恢复结论；resubmitted 表示已补交、应尽快再查。
//
//   - 本地已有 BeefAPI 结算记录：BeefAPI 记过这次提交，只是暂时不可见，继续等它的结论。
//   - 原请求已超过保存期：既不能补交，也无法确认，结论为「无法取回」，重新生成前要确认。
//   - 用户手动继续取回、原请求还在：用原 Key、原编号、原内容补交一次。BeefAPI 按编号去重，
//     收到过就返回原任务，没收到才第一次执行，所以不会产生第二次付费生成。
//   - 后台恢复：只查询，不补交。
func (s *Service) ResolveMissingManagedSubmission(ctx context.Context, task model.Task) (string, bool, error) {
	// 已下过的「无法取回」保持不变：复查仍查不到时不能把它清掉，否则节点会在锁住和解锁之间来回跳。
	if task.RecoveryOutcome != nil && *task.RecoveryOutcome == localtask.RecoveryUnrecoverable {
		return localtask.RecoveryUnrecoverable, false, nil
	}
	if task.BeefUsageState != nil || task.BeefBillingState != nil || task.BeefReconcileDeadline != nil {
		return "", false, nil
	}
	attempt, err := s.repo.LatestRouteAttempt(task.ID)
	if err != nil || attempt == nil || attempt.RouteRun != task.RouteRun {
		return "", false, err
	}
	row, err := s.repo.ImageSubmission(attempt.ID, task.ID, task.UserID)
	if err != nil {
		return "", false, err
	}
	if FrozenRequestExpired(row) {
		return localtask.RecoveryUnrecoverable, false, nil
	}
	if !localtask.ManualRecovery(ctx) {
		return "", false, nil
	}
	wire, err := s.ImageSubmissionWire(row)
	if err != nil {
		return "", false, err
	}
	if wire.ReplayProtocol != beefapi.MediaProtocolVersion {
		return "", false, errors.New("原请求不是托管媒体提交，不能补交")
	}
	query, managed, err := s.ManagedTaskQuery(ctx, task, row)
	if err != nil || !managed {
		return "", false, err
	}
	resubmitted, err := query.Client.Resubmit(ctx, wire.URL, wire.Header, wire.Body, query.Key, query.Kind)
	switch {
	case err == nil && resubmitted.Status == "failed":
		return localtask.RecoveryNoResult, false, nil
	case err == nil:
		return "", true, nil
	case beefapi.IsIdempotencyConflict(err):
		return localtask.RecoveryUnrecoverable, false, nil
	case beefapi.IsTerminalMediaTaskError(err):
		return localtask.RecoveryNoResult, false, nil
	case beefapi.IsDefiniteMediaRejection(err):
		return resubmitRejectionOutcome(err), false, nil
	default:
		return "", false, err
	}
}

// resubmitRejectionOutcome 区分补交被拒的原因。BeefAPI 拒绝了请求内容（400/413/422）：这次补交没有执行，
// 相同请求体的原请求也不会被受理，结论是「没有结果」。余额不足（402）、Key 失效、无权限、地址不存在、
// 编号被别的内容占用：只反映补交当时的状态，不能证明原请求没执行，结论是「无法取回」，重新生成前要确认。
func resubmitRejectionOutcome(err error) string {
	var httpErr *beefapi.MediaHTTPError
	if errors.As(err, &httpErr) {
		switch httpErr.StatusCode {
		case http.StatusBadRequest, http.StatusRequestEntityTooLarge, http.StatusUnprocessableEntity:
			return localtask.RecoveryNoResult
		}
	}
	return localtask.RecoveryUnrecoverable
}
