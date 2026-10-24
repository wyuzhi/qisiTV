package main

import (
	"context"
	"net/http"
	"time"
)

func (s *engineShell) stopForMaintenance(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		shellJSON(w, 405, nil, "method_not_allowed", "POST required")
		return
	}
	var input struct {
		Confirmed bool `json:"confirmed"`
	}
	if shellBody(w, r, &input, 1024) != nil || !input.Confirmed {
		shellJSON(w, 400, nil, "confirmation_required", "请确认暂停使用并进入本机存储维护")
		return
	}
	if s.stop == nil {
		shellJSON(w, 503, nil, "maintenance_unavailable", "当前运行方式不支持维护停机")
		return
	}
	if !s.maintenance.CompareAndSwap(false, true) {
		shellJSON(w, 409, nil, "engine_maintenance", "引擎已在停止")
		return
	}
	if !s.referenceMu.TryLock() {
		s.maintenance.Store(false)
		shellJSON(w, 409, nil, "storage_busy", "参考素材传输正在进行，请等待完成")
		return
	}
	defer s.referenceMu.Unlock()
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	resume, err := s.runtime.PrepareStorageMigration(ctx)
	if err != nil {
		s.maintenance.Store(false)
		shellJSON(w, 409, nil, "tasks_active", err.Error())
		return
	}
	if folders := s.runtime.ProjectFolders(); folders != nil {
		if err := folders.FlushPending(ctx); err != nil {
			resume()
			s.maintenance.Store(false)
			shellJSON(w, 409, nil, "project_folder_conflict", err.Error())
			return
		}
	}
	shellJSON(w, 200, map[string]bool{"stopping": true}, "", "")
	// Finish the response before canceling the server's lifecycle. Active task
	// workers block maintenance; shutdown then drains the remaining runtime.
	time.AfterFunc(300*time.Millisecond, s.stop)
}
