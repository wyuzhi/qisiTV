package handler

import (
	"fmt"
	"net/http"
	"strconv"

	"infinite-canvas/backend/internal/app"
	localproject "infinite-canvas/backend/internal/project"

	"github.com/gin-gonic/gin"
)

// projectReads are the two project views that also include task summaries;
// app keeps that cross-domain assembly.
type projectReads interface {
	ProjectDetail(string, string) (app.ProjectDetail, error)
	ProjectUnitWorkspace(string, string, string) (app.ProjectUnitWorkspace, error)
}

// RegisterProjectRoutes serves short-drama projects from the project domain.
func RegisterProjectRoutes(r *gin.RouterGroup, owners workspaceOwners, projects *localproject.Service, reads projectReads) {
	r.GET("/project-folders", func(c *gin.Context) {
		user, err := currentUser(c, owners)
		if err != nil {
			failService(c, err)
			return
		}
		folders, err := projects.ListProjectFolders(user.ID)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, gin.H{"folders": folders})
	})
	r.POST("/project-folders", func(c *gin.Context) {
		user, err := currentUser(c, owners)
		if err != nil {
			failService(c, err)
			return
		}
		var req localproject.CreateProjectFolderRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			fail(c, http.StatusBadRequest, err)
			return
		}
		folder, err := projects.CreateProjectFolder(user.ID, req)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, gin.H{"folder": folder})
	})
	r.GET("/voice-profiles", func(c *gin.Context) {
		user, err := currentUser(c, owners)
		if err != nil {
			failService(c, err)
			return
		}
		profiles, err := projects.ListVoiceProfiles(user.ID)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, gin.H{"profiles": profiles})
	})
	r.GET("/projects", func(c *gin.Context) {
		user, err := currentUser(c, owners)
		if err != nil {
			failService(c, err)
			return
		}
		pageParam, hasPage := c.GetQuery("page")
		pageSizeParam, hasPageSize := c.GetQuery("pageSize")
		if !hasPage && !hasPageSize {
			summaries, err := projects.ListProjects(user.ID)
			if err != nil {
				failService(c, err)
				return
			}
			ok(c, gin.H{"projects": summaries})
			return
		}
		page, err := parsePositiveQueryInt(pageParam, 1)
		if err != nil {
			fail(c, http.StatusBadRequest, err)
			return
		}
		pageSize, err := parsePositiveQueryInt(pageSizeParam, 50)
		if err != nil {
			fail(c, http.StatusBadRequest, err)
			return
		}
		projects, err := projects.ListProjectsPage(user.ID, page, pageSize)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, projects)
	})
	r.POST("/projects", func(c *gin.Context) {
		user, err := currentUser(c, owners)
		if err != nil {
			failService(c, err)
			return
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 64<<10)
		var req localproject.CreateProjectRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			fail(c, http.StatusBadRequest, err)
			return
		}
		project, err := projects.CreateProject(user.ID, req)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, gin.H{"project": project})
	})
	r.POST("/projects/:id/duplicate", func(c *gin.Context) {
		user, err := currentUser(c, owners)
		if err != nil {
			failService(c, err)
			return
		}
		project, err := projects.DuplicateProject(user.ID, c.Param("id"))
		if err != nil {
			if localproject.IsNotFound(err) {
				fail(c, http.StatusNotFound, err)
				return
			}
			failService(c, err)
			return
		}
		ok(c, gin.H{"project": project})
	})
	r.PATCH("/projects/:id/folder", func(c *gin.Context) {
		user, err := currentUser(c, owners)
		if err != nil {
			failService(c, err)
			return
		}
		var req struct {
			FolderID string `json:"folderId"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			fail(c, http.StatusBadRequest, err)
			return
		}
		if err := projects.MoveProjectToFolder(user.ID, c.Param("id"), req.FolderID); err != nil {
			if localproject.IsNotFound(err) {
				fail(c, http.StatusNotFound, err)
				return
			}
			failService(c, err)
			return
		}
		ok(c, gin.H{"id": c.Param("id"), "folderId": req.FolderID})
	})
	r.GET("/projects/:id", func(c *gin.Context) {
		user, err := currentUser(c, owners)
		if err != nil {
			failService(c, err)
			return
		}
		detail, err := reads.ProjectDetail(user.ID, c.Param("id"))
		if err != nil {
			if localproject.IsNotFound(err) {
				fail(c, http.StatusNotFound, err)
				return
			}
			failService(c, err)
			return
		}
		ok(c, detail)
	})
	r.GET("/projects/:id/core", func(c *gin.Context) {
		user, err := currentUser(c, owners)
		if err != nil {
			failService(c, err)
			return
		}
		core, err := projects.ProjectCore(user.ID, c.Param("id"))
		if err != nil {
			if localproject.IsNotFound(err) {
				fail(c, http.StatusNotFound, err)
				return
			}
			failService(c, err)
			return
		}
		ok(c, core)
	})
	r.GET("/projects/:id/overview", func(c *gin.Context) {
		user, err := currentUser(c, owners)
		if err != nil {
			failService(c, err)
			return
		}
		overview, err := projects.ProjectOverview(user.ID, c.Param("id"))
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, overview)
	})
	r.PATCH("/projects/:id", func(c *gin.Context) {
		user, err := currentUser(c, owners)
		if err != nil {
			failService(c, err)
			return
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 64<<10)
		var req localproject.UpdateProjectRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			fail(c, http.StatusBadRequest, err)
			return
		}
		project, err := projects.UpdateProject(user.ID, c.Param("id"), req)
		if err != nil {
			if localproject.IsNotFound(err) {
				fail(c, http.StatusNotFound, err)
				return
			}
			failService(c, err)
			return
		}
		ok(c, gin.H{"project": project})
	})
	r.DELETE("/projects/:id", func(c *gin.Context) {
		user, err := currentUser(c, owners)
		if err != nil {
			failService(c, err)
			return
		}
		if err := projects.DeleteProject(user.ID, c.Param("id")); err != nil {
			if localproject.IsNotFound(err) {
				fail(c, http.StatusNotFound, err)
				return
			}
			failService(c, err)
			return
		}
		ok(c, gin.H{"id": c.Param("id")})
	})
	r.POST("/projects/:id/units", func(c *gin.Context) {
		user, err := currentUser(c, owners)
		if err != nil {
			failService(c, err)
			return
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 2<<20)
		var req localproject.CreateProjectUnitRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			fail(c, http.StatusBadRequest, err)
			return
		}
		unit, err := projects.CreateProjectUnit(user.ID, c.Param("id"), req)
		if err != nil {
			if localproject.IsNotFound(err) {
				fail(c, http.StatusNotFound, err)
				return
			}
			failService(c, err)
			return
		}
		ok(c, gin.H{"unit": unit})
	})
	r.GET("/projects/:id/units", func(c *gin.Context) {
		user, err := currentUser(c, owners)
		if err != nil {
			failService(c, err)
			return
		}
		units, err := projects.ProjectUnitSummaries(user.ID, c.Param("id"))
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, units)
	})
	r.GET("/projects/:id/units/:unitId", func(c *gin.Context) {
		user, err := currentUser(c, owners)
		if err != nil {
			failService(c, err)
			return
		}
		unit, err := projects.GetProjectUnit(user.ID, c.Param("id"), c.Param("unitId"))
		if err != nil {
			if localproject.IsNotFound(err) {
				fail(c, http.StatusNotFound, err)
				return
			}
			failService(c, err)
			return
		}
		ok(c, gin.H{"unit": unit})
	})
	r.GET("/projects/:id/units/:unitId/workspace", func(c *gin.Context) {
		user, err := currentUser(c, owners)
		if err != nil {
			failService(c, err)
			return
		}
		workspace, err := reads.ProjectUnitWorkspace(user.ID, c.Param("id"), c.Param("unitId"))
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, workspace)
	})
	r.POST("/projects/:id/units/import", func(c *gin.Context) {
		user, err := currentUser(c, owners)
		if err != nil {
			failService(c, err)
			return
		}
		// 长篇小说可能包含两千章以上，限制请求体防止滥用的同时为整本原子导入留足空间。
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 32<<20)
		var req localproject.ImportProjectUnitsRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			fail(c, http.StatusBadRequest, err)
			return
		}
		units, err := projects.ImportProjectUnits(user.ID, c.Param("id"), req)
		if err != nil {
			if localproject.IsNotFound(err) {
				fail(c, http.StatusNotFound, err)
				return
			}
			failService(c, err)
			return
		}
		// 导入响应只需返回新章节标识与摘要，正文不再原样回传一次。
		for index := range units {
			units[index].SourceText = ""
		}
		ok(c, gin.H{"units": units})
	})
	r.PATCH("/projects/:id/units/reorder", func(c *gin.Context) {
		user, err := currentUser(c, owners)
		if err != nil {
			failService(c, err)
			return
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 256<<10)
		var req localproject.ReorderProjectUnitsRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			fail(c, http.StatusBadRequest, err)
			return
		}
		if err := projects.ReorderProjectUnits(user.ID, c.Param("id"), req); err != nil {
			if localproject.IsNotFound(err) {
				fail(c, http.StatusNotFound, err)
				return
			}
			failService(c, err)
			return
		}
		ok(c, gin.H{"unitIds": req.UnitIDs})
	})
	r.PATCH("/projects/:id/units/:unitId", func(c *gin.Context) {
		user, err := currentUser(c, owners)
		if err != nil {
			failService(c, err)
			return
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 2<<20)
		var req localproject.UpdateProjectUnitRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			fail(c, http.StatusBadRequest, err)
			return
		}
		unit, err := projects.UpdateProjectUnit(user.ID, c.Param("id"), c.Param("unitId"), req)
		if err != nil {
			if localproject.IsNotFound(err) {
				fail(c, http.StatusNotFound, err)
				return
			}
			failService(c, err)
			return
		}
		ok(c, gin.H{"unit": unit})
	})
	r.DELETE("/projects/:id/units/:unitId", func(c *gin.Context) {
		user, err := currentUser(c, owners)
		if err != nil {
			failService(c, err)
			return
		}
		if err := projects.DeleteProjectUnit(user.ID, c.Param("id"), c.Param("unitId")); err != nil {
			if localproject.IsNotFound(err) {
				fail(c, http.StatusNotFound, err)
				return
			}
			failService(c, err)
			return
		}
		ok(c, gin.H{"id": c.Param("unitId")})
	})
	r.POST("/projects/:id/canvas-links", func(c *gin.Context) {
		user, err := currentUser(c, owners)
		if err != nil {
			failService(c, err)
			return
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 64<<10)
		var req localproject.LinkCanvasUnitRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			fail(c, http.StatusBadRequest, err)
			return
		}
		link, err := projects.LinkCanvasUnit(user.ID, c.Param("id"), req)
		if err != nil {
			if localproject.IsNotFound(err) {
				fail(c, http.StatusNotFound, err)
				return
			}
			failService(c, err)
			return
		}
		ok(c, gin.H{"link": link})
	})
	r.DELETE("/projects/:id/canvas-links/:canvasId/units/:unitId", func(c *gin.Context) {
		user, err := currentUser(c, owners)
		if err != nil {
			failService(c, err)
			return
		}
		if err := projects.UnlinkCanvasUnit(user.ID, c.Param("id"), c.Param("canvasId"), c.Param("unitId")); err != nil {
			if localproject.IsNotFound(err) {
				fail(c, http.StatusNotFound, err)
				return
			}
			failService(c, err)
			return
		}
		ok(c, gin.H{"canvasId": c.Param("canvasId"), "unitId": c.Param("unitId")})
	})
	r.DELETE("/projects/:id/canvases/:canvasId", func(c *gin.Context) {
		user, err := currentUser(c, owners)
		if err != nil {
			failService(c, err)
			return
		}
		if err := projects.UnlinkCanvasProject(user.ID, c.Param("id"), c.Param("canvasId")); err != nil {
			if localproject.IsNotFound(err) {
				fail(c, http.StatusNotFound, err)
				return
			}
			failService(c, err)
			return
		}
		ok(c, gin.H{"canvasId": c.Param("canvasId")})
	})
	r.GET("/projects/:id/canvases", func(c *gin.Context) {
		user, err := currentUser(c, owners)
		if err != nil {
			failService(c, err)
			return
		}
		page, err := parsePositiveQueryInt(c.Query("page"), 1)
		if err != nil {
			fail(c, http.StatusBadRequest, err)
			return
		}
		pageSize, err := parsePositiveQueryInt(c.Query("pageSize"), 40)
		if err != nil {
			fail(c, http.StatusBadRequest, err)
			return
		}
		result, err := projects.ProjectCanvasesPage(user.ID, c.Param("id"), page, pageSize)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, result)
	})
	registerProjectAssetRoutes(r, owners, projects)
	registerProjectShotAndWorkflowRoutes(r, owners, projects)
}

// parsePositiveQueryInt 解析列表查询里的正整数。分页和筛选查询名统一用 camelCase：page、pageSize、projectId、folderId、mediaType、unitId。
func parsePositiveQueryInt(value string, fallback int) (int, error) {
	if value == "" {
		return fallback, nil
	}
	parsed, err := strconv.Atoi(value)
	if err != nil || parsed < 1 {
		return 0, fmt.Errorf("query parameter must be a positive integer")
	}
	return parsed, nil
}

// parsePaginationQuery 统一解析列表分页参数。
// 缺省值由具体接口声明；显式传入非正整数属于请求错误，不能悄悄变成服务层默认值，
// 否则客户端的协议问题会被掩盖，分页行为也会随服务层实现变化。
func parsePaginationQuery(c *gin.Context, fallbackPageSize int) (int, int, error) {
	page, err := parsePositiveQueryInt(c.Query("page"), 1)
	if err != nil {
		return 0, 0, fmt.Errorf("page: %w", err)
	}
	pageSize, err := parsePositiveQueryInt(c.Query("pageSize"), fallbackPageSize)
	if err != nil {
		return 0, 0, fmt.Errorf("pageSize: %w", err)
	}
	return page, pageSize, nil
}
