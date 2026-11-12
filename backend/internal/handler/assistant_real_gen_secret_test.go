package handler

import (
	"bytes"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"testing"
)

func TestE2EGenerationWritesNoSecrets(t *testing.T) {
	if testing.Short() {
		t.Skip("spawns the real agent host")
	}
	const secret = "sk-local-test-secret-123456"
	t.Setenv("BEEFTV_REAL_GEN_KEY", secret)
	t.Setenv("BEEFTV_REAL_GEN_DUMP_REQUESTS", "1")
	harness := newE2EGenerationHarness(t, true)
	out := t.TempDir()
	// 第 1 轮就失败，仍会写请求原文件、报告和画布快照，足以检查所有落盘路径。
	harness.runDriver(t, map[string]any{"failRound": 1, "outDir": out}, false)

	for _, relative := range []string{"report.json", "report.md", "canvas.json", "requests/0001.json"} {
		if _, err := os.Stat(filepath.Join(out, relative)); err != nil {
			t.Fatalf("预期写盘文件不存在 %s: %v", relative, err)
		}
	}
	bearer := regexp.MustCompile(`Bearer\s+[A-Za-z0-9]`)
	skKey := regexp.MustCompile(`sk-[A-Za-z0-9]`)
	err := filepath.WalkDir(out, func(filePath string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() {
			return nil
		}
		data, readErr := os.ReadFile(filePath)
		if readErr != nil {
			return readErr
		}
		if bytes.Contains(data, []byte(secret)) {
			t.Fatalf("写盘文件含上游密钥: %s", filePath)
		}
		if bearer.Match(data) {
			t.Fatalf("写盘文件含未脱敏 Bearer: %s", filePath)
		}
		if skKey.Match(data) {
			t.Fatalf("写盘文件含未脱敏 sk- 密钥: %s", filePath)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}
