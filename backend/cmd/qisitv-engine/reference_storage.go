package main

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"time"

	"qisitv/backend/internal/model"
	"qisitv/backend/internal/outbound"
	"qisitv/backend/internal/referencestorage"
)

func (s *engineShell) referenceStorage(w http.ResponseWriter, r *http.Request, path string) {
	if path == "/reference-storage/upload-status" && r.Method == http.MethodGet {
		s.progressMu.RLock()
		progress := s.referenceProgress
		s.progressMu.RUnlock()
		shellJSON(w, 200, progress, "", "")
		return
	}
	if path == "/reference-storage" && r.Method == http.MethodGet {
		config, err := referencestorage.Load(s.dataDir)
		if err != nil {
			shellJSON(w, 400, nil, "storage_failed", err.Error())
			return
		}
		shellJSON(w, 200, config.Public(), "", "")
		return
	}
	if !((path == "/reference-storage" && r.Method == http.MethodPut) || (r.Method == http.MethodPost && (path == "/reference-storage/upload" || path == "/reference-storage/test"))) {
		shellJSON(w, 405, nil, "method_not_allowed", "请求方式无效")
		return
	}
	if !s.referenceMu.TryLock() {
		shellJSON(w, 409, nil, "storage_busy", "参考素材操作正在进行，请稍后重试")
		return
	}
	defer s.referenceMu.Unlock()
	if path == "/reference-storage" {
		var input struct {
			referencestorage.Config
			HasSecret bool `json:"hasSecret"`
		}
		if shellBody(w, r, &input, 64<<10) != nil {
			shellJSON(w, 400, nil, "invalid_storage_config", "参考存储配置无效")
			return
		}
		result, err := referencestorage.Save(s.dataDir, input.Config)
		if err != nil {
			shellJSON(w, 400, nil, "storage_failed", err.Error())
			return
		}
		shellJSON(w, 200, result, "", "")
		return
	}
	config, err := referencestorage.Load(s.dataDir)
	if err != nil {
		shellJSON(w, 400, nil, "storage_failed", err.Error())
		return
	}
	staging, err := os.MkdirTemp(s.dataDir, ".reference-upload-*")
	if err != nil {
		shellJSON(w, 400, nil, "storage_failed", "无法准备本机临时目录")
		return
	}
	defer os.RemoveAll(staging)
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Minute)
	defer cancel()
	if path == "/reference-storage/test" {
		if err := referencestorage.Check(ctx, config, staging); err != nil {
			shellJSON(w, 400, nil, "storage_failed", err.Error())
			return
		}
		shellJSON(w, 200, map[string]bool{"ok": true}, "", "")
		return
	}
	var input struct {
		IDs []string `json:"ids"`
	}
	if shellBody(w, r, &input, 16<<10) != nil || len(input.IDs) == 0 || len(input.IDs) > 20 {
		shellJSON(w, 400, nil, "invalid_resources", "请选择 1 至 20 个参考素材")
		return
	}
	if err := s.checkWritable(ctx); err != nil {
		shellJSON(w, 409, nil, "project_folder_conflict", "请先确认项目目录可写")
		return
	}
	links, err := s.uploadReferences(ctx, config, staging, input.IDs)
	if err != nil {
		shellJSON(w, 400, nil, "upload_failed", err.Error())
		return
	}
	shellJSON(w, 200, links, "", "")
}

func (s *engineShell) uploadReferences(ctx context.Context, config referencestorage.Config, staging string, ids []string) (map[string]string, error) {
	defer func() {
		s.progressMu.Lock()
		s.referenceProgress = model.TaskReferenceProgress{}
		s.progressMu.Unlock()
	}()
	links := map[string]string{}
	for index, id := range ids {
		if id == "" {
			return nil, errors.New("素材 ID 不能为空")
		}
		if _, done := links[id]; done {
			continue
		}
		started := time.Now().UnixMilli()
		label := "参考素材 " + strconv.Itoa(index+1)
		s.progressMu.Lock()
		s.referenceProgress = model.TaskReferenceProgress{Label: label, Phase: "preparing", StartedAt: started, UpdatedAt: started}
		s.progressMu.Unlock()
		local := filepath.Join(staging, strconv.Itoa(index))
		// Only workspace-owned resource IDs reach disk; a browser cannot upload an arbitrary host path.
		if err := s.runtime.CopyOwnedResourceTo(id, local); err != nil {
			return nil, fmt.Errorf("参考素材 %d 读取失败：%w", index+1, err)
		}
		var rate outbound.ProgressRate
		link, err := referencestorage.Upload(ctx, config, local, func(loaded, total int64, phase string) {
			s.progressMu.Lock()
			defer s.progressMu.Unlock()
			if ctx.Err() != nil {
				return
			}
			now := time.Now()
			rate.Observe(now, loaded)
			s.referenceProgress.LoadedBytes, s.referenceProgress.TotalBytes = loaded, total
			s.referenceProgress.Phase, s.referenceProgress.UpdatedAt = phase, now.UnixMilli()
			s.referenceProgress.BytesPerSecond = rate.Rate(now, loaded)
		})
		if err != nil {
			return nil, fmt.Errorf("参考素材 %d 上传失败：%w", index+1, err)
		}
		links[id] = link
	}
	return links, nil
}
