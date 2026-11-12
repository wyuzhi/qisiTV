package handler

import (
	"encoding/json"
	"fmt"
	"path/filepath"
	"strings"
	"testing"
)

type e2eReportConfirmation struct {
	Approved bool     `json:"approved"`
	Reason   string   `json:"reason"`
	TaskIDs  []string `json:"taskIds"`
}

type e2eReportOutput struct {
	ResourceID               string `json:"resourceId"`
	MaterializationErrorCode string `json:"materializationErrorCode"`
}

type e2eReportTask struct {
	ID      string            `json:"id"`
	Type    string            `json:"type"`
	Status  string            `json:"status"`
	Model   string            `json:"model"`
	Error   string            `json:"error"`
	Outputs []e2eReportOutput `json:"outputs"`
}

type e2eReportArtifact struct {
	File       string `json:"file"`
	ResourceID string `json:"resourceId"`
	Kind       string `json:"kind"`
	Mime       string `json:"mime"`
	Bytes      int64  `json:"bytes"`
}

type e2eReportRound struct {
	Round         int                     `json:"round"`
	Status        string                  `json:"status"`
	Message       string                  `json:"message"`
	Error         string                  `json:"error"`
	StopReason    string                  `json:"stopReason"`
	Confirmations []e2eReportConfirmation `json:"confirmations"`
	Tasks         []e2eReportTask         `json:"tasks"`
	Artifacts     []e2eReportArtifact     `json:"artifacts"`
}

// e2eGenerationReport 是驱动写出的最小可判定报告；只保留测评需要的字段。
type e2eGenerationReport struct {
	Mode        string           `json:"mode"`
	Rounds      []e2eReportRound `json:"rounds"`
	MediaReview struct {
		OK     bool   `json:"ok"`
		Model  string `json:"model"`
		Reason string `json:"reason"`
	} `json:"mediaReview"`
	PendingTasks []struct {
		ID                string `json:"id"`
		Type              string `json:"type"`
		Status            string `json:"status"`
		ProviderRequestID string `json:"providerRequestId"`
		PossiblyRunning   bool   `json:"possiblyRunning"`
	} `json:"pendingTasks"`
	CancelAttempts []struct {
		TaskID    string `json:"taskId"`
		Requested bool   `json:"requested"`
		Error     string `json:"error"`
	} `json:"cancelAttempts"`
	Interrupted                string   `json:"interrupted"`
	SettleError                string   `json:"settleError"`
	ShutdownError              string   `json:"shutdownError"`
	ConfirmationOutcomeUnknown bool     `json:"confirmationOutcomeUnknown"`
	RelatedProposalIDs         []string `json:"relatedProposalIds"`
	Issues                     []string `json:"issues"`
}

func assertCompleteGenerationReport(t *testing.T, raw []byte) {
	t.Helper()
	var report e2eGenerationReport
	if err := json.Unmarshal(raw, &report); err != nil {
		t.Fatal(err)
	}
	if gaps := generationReportGaps(report); len(gaps) > 0 {
		t.Fatalf("真实生成结果不完整：%s", strings.Join(gaps, "；"))
	}
}

func generationReportGapSummary(raw []byte) string {
	var report e2eGenerationReport
	if err := json.Unmarshal(raw, &report); err != nil {
		return "report.json 无法解析: " + err.Error()
	}
	gaps := generationReportGaps(report)
	if len(gaps) == 0 {
		return "报告没有可判定的缺口"
	}
	return strings.Join(gaps, "；")
}

// generationReportGaps 同时服务假模式与真实模式：缺任何一项都返回具体缺口，
// 不允许“驱动退出码为 0 但没产物”通过。
func generationReportGaps(report e2eGenerationReport) []string {
	gaps := []string{}
	if len(report.Rounds) != 3 {
		gaps = append(gaps, fmt.Sprintf("回合数需要 3，实际 %d", len(report.Rounds)))
	}
	if !report.MediaReview.OK {
		gaps = append(gaps, "审片模型未生效："+report.MediaReview.Reason)
	}
	images, videos, renders := 0, 0, 0
	for _, round := range report.Rounds {
		if round.Status != "done" || round.Error != "" {
			gaps = append(gaps, fmt.Sprintf("第 %d 轮未完成：%s %s", round.Round, round.Status, round.Error))
		}
		for _, task := range round.Tasks {
			if task.Status != "succeeded" {
				gaps = append(gaps, fmt.Sprintf("任务 %s（%s）未成功：%s", task.ID, task.Type, task.Status))
				continue
			}
			saved := false
			for _, output := range task.Outputs {
				if output.ResourceID != "" && output.MaterializationErrorCode == "" {
					saved = true
				}
			}
			if !saved {
				gaps = append(gaps, fmt.Sprintf("任务 %s（%s）没有保存成功的资源回执", task.ID, task.Type))
				continue
			}
			switch {
			case task.Type == "canvas_image":
				images++
			case task.Type == "canvas_video":
				videos++
			case strings.Contains(task.Type, "timeline") || strings.Contains(task.Type, "render"):
				renders++
			}
		}
	}
	if images < 2 {
		gaps = append(gaps, fmt.Sprintf("首帧图任务需要 2 个，实际 %d", images))
	}
	if videos < 2 {
		gaps = append(gaps, fmt.Sprintf("视频任务需要 2 个，实际 %d", videos))
	}
	if renders < 1 {
		gaps = append(gaps, fmt.Sprintf("成片渲染任务需要 1 个，实际 %d", renders))
	}

	imageFiles, videoFiles, renderFiles := map[string]bool{}, map[string]bool{}, map[string]bool{}
	for _, round := range report.Rounds {
		for _, item := range round.Artifacts {
			if item.Bytes <= 0 {
				gaps = append(gaps, "产物为空："+item.File)
				continue
			}
			key := item.ResourceID
			if key == "" {
				key = item.File
			}
			switch {
			case strings.HasPrefix(item.Mime, "image/"):
				imageFiles[key] = true
			case strings.HasPrefix(item.Mime, "video/"):
				if item.Kind == "render" || strings.Contains(filepath.Base(item.File), "render") {
					renderFiles[key] = true
				} else {
					videoFiles[key] = true
				}
			}
		}
	}
	if len(imageFiles) < 2 {
		gaps = append(gaps, fmt.Sprintf("下载的首帧图需要 2 个，实际 %d", len(imageFiles)))
	}
	if len(videoFiles) < 2 {
		gaps = append(gaps, fmt.Sprintf("下载的视频需要 2 个，实际 %d", len(videoFiles)))
	}
	if len(renderFiles) < 1 {
		gaps = append(gaps, fmt.Sprintf("下载的成片需要 1 个，实际 %d", len(renderFiles)))
	}
	for _, issue := range report.Issues {
		if strings.TrimSpace(issue) != "" {
			gaps = append(gaps, "驱动问题："+issue)
		}
	}
	if len(report.PendingTasks) > 0 {
		gaps = append(gaps, fmt.Sprintf("收尾时仍有 %d 个任务可能仍在运行", len(report.PendingTasks)))
	}
	if strings.TrimSpace(report.Interrupted) != "" {
		gaps = append(gaps, "运行被中断："+report.Interrupted)
	}
	if report.ConfirmationOutcomeUnknown {
		gaps = append(gaps, "确认结果未知，相关方案："+strings.Join(report.RelatedProposalIDs, ","))
	}
	if strings.TrimSpace(report.SettleError) != "" {
		gaps = append(gaps, "收尾查询任务失败："+report.SettleError)
	}
	return gaps
}

func completeE2EReport() e2eGenerationReport {
	report := e2eGenerationReport{Mode: "fake"}
	report.MediaReview.OK = true
	report.MediaReview.Model = "gemini-3.8-flash"
	task := func(id, kind string, round, index int) e2eReportTask {
		return e2eReportTask{ID: id, Type: kind, Status: "succeeded",
			Outputs: []e2eReportOutput{{ResourceID: fmt.Sprintf("res-%d-%d", round, index)}}}
	}
	artifact := func(file, resourceID, kind, mime string) e2eReportArtifact {
		return e2eReportArtifact{File: file, ResourceID: resourceID, Kind: kind, Mime: mime, Bytes: 1024}
	}
	report.Rounds = []e2eReportRound{
		{Round: 1, Status: "done",
			Tasks:     []e2eReportTask{task("1-task-0", "canvas_image", 1, 0), task("1-task-1", "canvas_image", 1, 1)},
			Artifacts: []e2eReportArtifact{artifact("artifacts/01-image-a.png", "res-1-0", "image", "image/png"), artifact("artifacts/01-image-b.png", "res-1-1", "image", "image/png")}},
		{Round: 2, Status: "done",
			Tasks:     []e2eReportTask{task("2-task-0", "canvas_video", 2, 0), task("2-task-1", "canvas_video", 2, 1)},
			Artifacts: []e2eReportArtifact{artifact("artifacts/02-video-a.mp4", "res-2-0", "video", "video/mp4"), artifact("artifacts/02-video-b.mp4", "res-2-1", "video", "video/mp4")}},
		{Round: 3, Status: "done",
			Tasks:     []e2eReportTask{task("3-task-0", "timeline_render", 3, 0)},
			Artifacts: []e2eReportArtifact{artifact("artifacts/03-render-final.mp4", "res-3-0", "render", "video/mp4")}},
	}
	return report
}

func TestE2EGenerationReportRequiresArtifacts(t *testing.T) {
	if gaps := generationReportGaps(completeE2EReport()); len(gaps) > 0 {
		t.Fatalf("完整报告不应有缺口: %v", gaps)
	}

	t.Run("missing render", func(t *testing.T) {
		report := completeE2EReport()
		report.Rounds[2].Artifacts = nil
		report.Rounds[2].Tasks = nil
		gaps := generationReportGaps(report)
		if !strings.Contains(strings.Join(gaps, "|"), "成片") {
			t.Fatalf("缺少成片必须判失败: %v", gaps)
		}
	})
	t.Run("missing first frame", func(t *testing.T) {
		report := completeE2EReport()
		report.Rounds[0].Artifacts = report.Rounds[0].Artifacts[:1]
		gaps := generationReportGaps(report)
		if !strings.Contains(strings.Join(gaps, "|"), "首帧") {
			t.Fatalf("缺少首帧必须判失败: %v", gaps)
		}
	})
	t.Run("failed task", func(t *testing.T) {
		report := completeE2EReport()
		report.Rounds[1].Tasks[0].Status = "failed"
		gaps := generationReportGaps(report)
		if !strings.Contains(strings.Join(gaps, "|"), "未成功") {
			t.Fatalf("失败任务必须判失败: %v", gaps)
		}
	})
	t.Run("media review missing", func(t *testing.T) {
		report := completeE2EReport()
		report.MediaReview.OK = false
		report.MediaReview.Reason = "protocol_unsupported"
		gaps := generationReportGaps(report)
		if !strings.Contains(strings.Join(gaps, "|"), "审片模型") {
			t.Fatalf("审片模型未生效必须判失败: %v", gaps)
		}
	})
	t.Run("pending task at exit", func(t *testing.T) {
		report := completeE2EReport()
		report.PendingTasks = append(report.PendingTasks, struct {
			ID                string `json:"id"`
			Type              string `json:"type"`
			Status            string `json:"status"`
			ProviderRequestID string `json:"providerRequestId"`
			PossiblyRunning   bool   `json:"possiblyRunning"`
		}{ID: "task-late", Status: "running", PossiblyRunning: true})
		gaps := generationReportGaps(report)
		if !strings.Contains(strings.Join(gaps, "|"), "可能仍在运行") {
			t.Fatalf("退出时仍在运行的任务必须判失败: %v", gaps)
		}
	})
	t.Run("settle error", func(t *testing.T) {
		report := completeE2EReport()
		report.SettleError = "tasks_unavailable"
		gaps := generationReportGaps(report)
		if !strings.Contains(strings.Join(gaps, "|"), "收尾查询") {
			t.Fatalf("收尾查询失败必须判失败: %v", gaps)
		}
	})
}
