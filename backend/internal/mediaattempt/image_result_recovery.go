package mediaattempt

import (
	"context"
	"encoding/json"
	"errors"
	"qisitv/backend/internal/generation"
	"qisitv/backend/internal/kernel"
	"qisitv/backend/internal/model"
	"qisitv/backend/internal/outbound"
	"strings"
)

// Old image tasks could fail while downloading after a successful create.
// Restore only an exact, complete OpenAI image receipt. Never submit a POST.
func (s *Service) RecoverAcceptedImage(task model.Task) (*model.Task, bool, error) {
	if task.Type != "canvas_image" || task.Status != model.TaskStatusFailed {
		return nil, false, nil
	}
	receipt, err := s.repo.ImageCreateReceipt(task.UserID, task.ID)
	if err != nil {
		return nil, true, imageRecoveryError{err}
	}
	result, handled, err := imageResultFromReceipt(receipt)
	if !handled || err != nil {
		return nil, handled, err
	}
	owner := "manual-recovery:" + kernel.NewID()
	if err := s.repo.ClaimFailedTaskProviderRecovery(task.ID, task.UserID, owner, providerTaskRecoveryLeaseDuration); err != nil {
		return nil, true, err
	}
	task.LeaseOwner = owner
	defer s.repo.ReleaseTaskProviderRecovery(task.ID, owner)
	task.Error = ""
	task.FailureDiagnostics = nil
	if err := s.completion.Save(&task, result, nil, false); err != nil {
		return nil, true, err
	}
	_ = s.log(task.UserID, task.ID, "info", "已从原始成功响应恢复图片，等待取回结果", receipt.ID)
	return s.completion.Present(&task), true, nil
}

// 人工 /retry 与自动扫描共用相同的回执有效性检查。
func imageResultFromReceipt(receipt *model.ApiCallLog) ([]byte, bool, error) {
	return imageResultFromReceiptContext(context.Background(), receipt)
}

func imageResultFromReceiptContext(ctx context.Context, receipt *model.ApiCallLog) ([]byte, bool, error) {
	if receipt != nil && (receipt.StatusCode < 200 || (receipt.StatusCode >= 200 && receipt.StatusCode < 300 && (receipt.StatusCode != 200 || receipt.Status != model.ApiCallStatusSucceeded || receipt.APIFormat != "openai" || (!strings.HasSuffix(receipt.Path, "/images/generations") && !strings.HasSuffix(receipt.Path, "/images/edits"))))) {
		return nil, true, imageRecoveryError{errors.New("创建请求结果未知")}
	}
	if receipt == nil || receipt.StatusCode < 200 || receipt.StatusCode >= 300 {
		return nil, false, nil
	}
	var payload map[string]any
	if err := json.Unmarshal([]byte(receipt.ResponseBody), &payload); err != nil {
		return nil, true, imageRecoveryError{err}
	}
	if _, _, failed := generation.PayloadBusinessFailure(payload); failed {
		return nil, false, nil
	}
	var body struct {
		Error json.RawMessage `json:"error"`
		Data  []struct {
			URL string `json:"url"`
		} `json:"data"`
	}
	if err := json.Unmarshal([]byte(receipt.ResponseBody), &body); err != nil || len(body.Data) == 0 || (len(body.Error) > 0 && string(body.Error) != "null") {
		return nil, true, imageRecoveryError{errors.New("成功回执缺少完整图片结果")}
	}
	images := make([]map[string]any, 0, len(body.Data))
	for _, image := range body.Data {
		if _, err := outbound.ValidateOutboundURLContext(ctx, image.URL); err != nil {
			return nil, true, err
		}
		images = append(images, map[string]any{"url": image.URL})
	}
	result, err := json.Marshal(map[string]any{"mode": "image", "images": images})
	if err != nil {
		return nil, true, err
	}
	return result, true, nil
}
