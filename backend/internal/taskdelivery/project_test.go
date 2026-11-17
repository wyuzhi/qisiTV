package taskdelivery

import (
	"errors"
	"testing"

	"qisitv/backend/internal/model"
	localtask "qisitv/backend/internal/task"
)

// 媒体任务的结果不可解析或没有媒体产物时，投影不能给出 ready；
// 交付行尚未写入时也要先给出 FAILED_PERMANENT，和 task.wait 用同一处判定。
func TestProjectNeverReadyForUnusableMediaResult(t *testing.T) {
	for _, raw := range []string{`{"images":[]}`, `{"images":[1]}`, `{`, `{}`, `null`, `{"mode":"image"}`} {
		task := model.Task{
			ID:         "task-1",
			Type:       "canvas_image",
			Status:     model.TaskStatusSucceeded,
			ResultJSON: raw,
		}
		projection := Project(task, nil, nil, false)
		if projection.ResultState != localtask.ResultStateFailedPermanent {
			t.Fatalf("%s 投影状态 = %q，应为 FAILED_PERMANENT", raw, projection.ResultState)
		}
		if projection.Outcome.Phase != "failed" {
			t.Fatalf("%s 投影阶段 = %q，应为 failed", raw, projection.Outcome.Phase)
		}
	}
	text := Project(model.Task{Type: "canvas_text", Status: model.TaskStatusSucceeded, ResultJSON: `{}`}, nil, nil, false)
	if text.ResultState != localtask.ResultStateReady || text.Outcome.Phase != "ready" {
		t.Fatalf("文本任务零产物仍应 ready: %+v", text)
	}
}

func TestProjectNeverReadyOnUnreadableRecords(t *testing.T) {
	task := model.Task{
		ID:         "task-1",
		Status:     model.TaskStatusSucceeded,
		InputJSON:  `{"metadata":{"nodeId":"node-1"}}`,
		ResultJSON: `{"images":[{"resourceId":"r1"}]}`,
	}
	stored := []localtask.CanonicalOutput{{
		OutputIndex:         0,
		MediaType:           "image",
		ResourceID:          "r1",
		MaterializedAssetID: "generation_should_not_leak",
	}}
	proj := Project(task, stored, errors.New("decode failed"), false)
	if proj.Err == nil || proj.ResultState == localtask.ResultStateReady {
		t.Fatalf("unreadable projection = %#v", proj)
	}
	if proj.ResultState != localtask.ResultStateFailedRetryable {
		t.Fatalf("unreadable state = %q", proj.ResultState)
	}
	if len(proj.Outputs) != 1 || proj.Outputs[0].MaterializedAssetID != "" || proj.Outputs[0].MaterializationErrorCode != localtask.MaterializeErrorDeliveryUnreadable {
		t.Fatalf("unreadable outputs = %#v", proj.Outputs)
	}
	if proj.Outputs[0].TargetBinding == nil || proj.Outputs[0].TargetBinding.NodeID != "node-1" {
		t.Fatalf("binding dropped on unreadable projection: %#v", proj.Outputs[0])
	}
}

func TestProjectKeepsDeliveryStageUntilEveryOutputIsReady(t *testing.T) {
	for _, unreadable := range []bool{false, true} {
		task := model.Task{Status: model.TaskStatusSucceeded, Stage: "delivery_timed_out", Type: "canvas_image", ResultJSON: `{"images":[{"resourceId":"r1"},{"resourceId":"r2"}]}`}
		stored := []localtask.CanonicalOutput{{OutputIndex: 0, MediaType: "image", ResourceID: "r1", MaterializedAssetID: "asset-1"}}
		var loadErr error
		if unreadable {
			loadErr = errors.New("unreadable")
		}
		proj := Project(task, stored, loadErr, false)
		if proj.Stage != task.Stage || proj.ResultState == localtask.ResultStateReady {
			t.Fatalf("incomplete delivery reported complete: %+v", proj)
		}
	}
}

func TestDecodeStoredOutputsFailsOnCorruptPayload(t *testing.T) {
	_, err := DecodeStoredOutputs([]model.Result{{ID: "result-1", TaskID: "task-1", Kind: localtask.ResultKindGenerationOutput, Payload: "{"}})
	if err == nil {
		t.Fatal("corrupt payload decoded")
	}
	byTask, errs := DecodeStoredOutputsByTask([]model.Result{
		{ID: "result-1", TaskID: "task-bad", Kind: localtask.ResultKindGenerationOutput, Payload: "{"},
		{ID: "result-2", TaskID: "task-ok", Kind: localtask.ResultKindGenerationOutput, Payload: `{"outputIndex":0,"resourceId":"r1"}`},
	})
	if errs["task-bad"] == nil {
		t.Fatal("per-task decode error missing")
	}
	if len(byTask["task-ok"]) != 1 || byTask["task-ok"][0].ResourceID != "r1" {
		t.Fatalf("healthy task lost: %#v", byTask)
	}
}

func TestProjectWithFactsReflectsRecoveryOutcomeForVideoAndUpscale(t *testing.T) {
	noResult := localtask.RecoveryNoResult
	unrecoverable := localtask.RecoveryUnrecoverable

	videoPending := model.Task{
		ID:                "vid-pending",
		Type:              "canvas_video",
		Status:            model.TaskStatusFailed,
		ProviderRequestID: "req-1",
	}
	proj := ProjectWithFacts(videoPending, nil, nil, false, localtask.OutcomeFacts{})
	if proj.Outcome.Phase != "retrievable" || proj.Outcome.Reason != "provider_result_pending" {
		t.Fatalf("expected retrievable video outcome, got %+v", proj.Outcome)
	}

	videoNoResult := videoPending
	videoNoResult.RecoveryOutcome = &noResult
	proj = ProjectWithFacts(videoNoResult, nil, nil, false, localtask.OutcomeFacts{})
	if proj.Outcome.Phase != "failed" || proj.Outcome.Reason != "no_result" || proj.Outcome.Regenerate != "confirm" {
		t.Fatalf("expected no_result failed video outcome, got %+v", proj.Outcome)
	}

	upscaleUnrecoverable := model.Task{
		ID:                "upscale-unrecoverable",
		Type:              "canvas_image",
		Model:             "topaz-standard-v2",
		Status:            model.TaskStatusFailed,
		ProviderRequestID: "req-2",
		RecoveryOutcome:   &unrecoverable,
	}
	proj = ProjectWithFacts(upscaleUnrecoverable, nil, nil, false, localtask.OutcomeFacts{})
	if proj.Outcome.Phase != "failed" || proj.Outcome.Reason != "result_unrecoverable" || proj.Outcome.Regenerate != "confirm" {
		t.Fatalf("expected result_unrecoverable failed upscale outcome, got %+v", proj.Outcome)
	}
}
