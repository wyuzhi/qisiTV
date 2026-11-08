package handler

import (
	"net/http"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"

	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/operations"
)

type assistantSettingsService interface {
	Database() *gorm.DB
}

// RegisterAssistantSettingsRoutes exposes the assistant behavior preferences
// kept in the local workspace settings store. 写入会改变助手运行脚本前的确认方式，
// 因此复用 /assistant 路由的身份与只读客户端校验，而不是只认工作区所有者。
func RegisterAssistantSettingsRoutes(r gin.IRouter, svc assistantSettingsService, guard func(*gin.Context, bool) bool) {
	r.GET("/assistant/settings", func(c *gin.Context) {
		if !guard(c, false) {
			return
		}
		ok(c, gin.H{"skillScriptAutoRun": operations.SkillScriptAutoRunEnabled(svc.Database())})
	})
	r.PATCH("/assistant/settings", func(c *gin.Context) {
		if !guard(c, true) {
			return
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 4<<10)
		var req struct {
			SkillScriptAutoRun *bool `json:"skillScriptAutoRun"`
		}
		if err := c.ShouldBindJSON(&req); err != nil || req.SkillScriptAutoRun == nil {
			fail(c, http.StatusBadRequest, kernel.BadAuthRequest("请填写有效的助手设置"))
			return
		}
		if err := operations.SetSkillScriptAutoRun(svc.Database(), *req.SkillScriptAutoRun); err != nil {
			failService(c, err)
			return
		}
		ok(c, gin.H{"skillScriptAutoRun": *req.SkillScriptAutoRun})
	})
}
