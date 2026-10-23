package main

import (
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
)

// Native MCP and the bundled assistant also reach the private API directly.
// Enforce folder authority there, not only on the paired browser gateway.
func engineFolderGuard(current func() *engineShell) gin.HandlerFunc {
	return func(c *gin.Context) {
		path := strings.TrimPrefix(c.Request.URL.Path, "/api")
		if c.Request.Method == http.MethodGet || c.Request.Method == http.MethodHead || c.Request.Method == http.MethodOptions || path == "/workspace/model-config" || path == "/assistant/ui-session" || strings.HasPrefix(path, "/assistant/runtime/") {
			c.Next()
			return
		}
		shell := current()
		if shell == nil || !shell.configured() {
			c.AbortWithStatusJSON(409, gin.H{"code": 409, "reason": "folder_required", "msg": "请在 qisiTV 网页选择并确认本机项目文件夹"})
			return
		}
		if err := shell.checkWritable(c.Request.Context()); err != nil {
			c.AbortWithStatusJSON(409, gin.H{"code": 409, "reason": "project_folder_conflict", "msg": "项目文件夹已改变或不可写；请检查项目存储状态"})
			return
		}
		c.Next()
	}
}
