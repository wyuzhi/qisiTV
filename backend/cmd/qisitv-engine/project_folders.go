package main

import (
	"context"
	"errors"
	"net/http"
	"os"
	"strings"

	"gorm.io/gorm"
	"qisitv/backend/internal/projectfolder"
)

func (s *engineShell) checkWritable(ctx context.Context) error {
	if s.maintenance.Load() {
		return errors.New("engine is entering maintenance")
	}
	if !s.configured() {
		return errors.New("project folder is not configured")
	}
	ownerID, err := s.runtime.ProjectFolderOwnerID()
	if err != nil {
		return err
	}
	return s.runtime.ProjectFolders().CheckWritable(ctx, ownerID)
}

func (s *engineShell) projectFolders(w http.ResponseWriter, r *http.Request, path string) {
	if !s.configured() {
		shellJSON(w, 409, nil, "folder_required", "请先选择并确认本机项目文件夹")
		return
	}
	ownerID, err := s.runtime.ProjectFolderOwnerID()
	if err != nil {
		shellJSON(w, 503, nil, "engine_unavailable", "本机工作区尚未就绪")
		return
	}
	folders := s.runtime.ProjectFolders()
	var result any
	switch path {
	case "/project-folders/list":
		if r.Method != http.MethodGet {
			break
		}
		result, err = folders.List(r.Context(), ownerID)
	case "/project-folders/status", "/project-folders/receipts":
		if r.Method != http.MethodGet {
			break
		}
		canvasID := strings.TrimSpace(r.URL.Query().Get("canvasId"))
		if canvasID == "" {
			shellJSON(w, 400, nil, "canvas_required", "缺少画布 ID")
			return
		}
		if path == "/project-folders/receipts" {
			result, err = folders.Receipts(r.Context(), ownerID, canvasID)
		} else {
			result, err = folders.Status(r.Context(), ownerID, canvasID)
		}
	case "/project-folders/import":
		if r.Method != http.MethodPost {
			break
		}
		var input projectfolder.ImportRequest
		if shellBody(w, r, &input, projectfolder.MaxReceiptBytes+(64<<10)) != nil {
			shellJSON(w, 400, nil, "invalid_import", "项目迁移请求无效或过大")
			return
		}
		result, err = folders.Import(r.Context(), ownerID, input)
	case "/project-folders/flush", "/project-folders/recheck":
		if r.Method != http.MethodPost {
			break
		}
		var input struct {
			CanvasID string `json:"canvasId"`
		}
		if shellBody(w, r, &input, 8192) != nil || strings.TrimSpace(input.CanvasID) == "" {
			shellJSON(w, 400, nil, "canvas_required", "缺少画布 ID")
			return
		}
		if path == "/project-folders/recheck" {
			result, err = folders.Recheck(r.Context(), ownerID, input.CanvasID)
		} else {
			result, err = folders.Flush(r.Context(), ownerID, input.CanvasID)
		}
	default:
		shellJSON(w, 404, nil, "not_found", "本机操作不存在")
		return
	}
	if result == nil && err == nil {
		shellJSON(w, 405, nil, "method_not_allowed", "请求方式无效")
		return
	}
	if err != nil {
		switch {
		case errors.Is(err, projectfolder.ErrConflict):
			shellJSON(w, 409, nil, "project_conflict", err.Error())
		case errors.Is(err, projectfolder.ErrUnbound), errors.Is(err, gorm.ErrRecordNotFound), errors.Is(err, os.ErrNotExist):
			shellJSON(w, 404, nil, "project_not_found", err.Error())
		default:
			shellJSON(w, 400, nil, "project_folder_failed", err.Error())
		}
		return
	}
	shellJSON(w, 200, result, "", "")
}
