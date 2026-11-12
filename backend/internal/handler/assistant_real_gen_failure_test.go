package handler

import (
	"encoding/json"
	"testing"
)

// 回合失败后必须停止确认和后续轮次；报告仍要写出已完成/失败轮次的记录。
func TestE2EGenerationDriverStopsAfterTurnFailure(t *testing.T) {
	if testing.Short() {
		t.Skip("spawns the real agent host")
	}
	harness := newE2EGenerationHarness(t, true)
	out := t.TempDir()
	reportRaw := harness.runDriver(t, map[string]any{"failRound": 1, "outDir": out}, false)
	var report e2eGenerationReport
	if err := json.Unmarshal(reportRaw, &report); err != nil {
		t.Fatal(err)
	}
	if len(report.Rounds) != 1 {
		t.Fatalf("回合失败后不应继续后续轮次: %d", len(report.Rounds))
	}
	if report.Rounds[0].Status == "done" || report.Rounds[0].StopReason == "" {
		t.Fatalf("失败回合没有记录错误: %+v", report.Rounds[0])
	}
	if len(report.Rounds[0].Confirmations) != 0 || len(report.Rounds[0].Tasks) != 0 {
		t.Fatalf("回合失败后仍然确认了方案或创建了任务: %+v", report.Rounds[0])
	}
}
