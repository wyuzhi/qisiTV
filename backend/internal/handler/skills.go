package handler

import (
	"mime"
	"net/http"
	"path/filepath"
	"strconv"
	"strings"

	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/skills"

	"github.com/gin-gonic/gin"
)

// skillSyncs is the one skill action that still checks the workspace profile
// before reaching the domain service.
type skillSyncs interface {
	SyncGitHubSkill(userID string, skillID string) (*skills.SkillItem, error)
}

func RegisterSkillRoutes(r *gin.RouterGroup, owners workspaceOwners, domain *skills.Service, syncs skillSyncs) {
	registerSkillRoutes(r, owners, domain, syncs, true)
}

// RegisterDesktopSkillRoutes keeps local skill files available while removing
// GitHub-backed installation and synchronization from the desktop API.
func RegisterDesktopSkillRoutes(r *gin.RouterGroup, owners workspaceOwners, domain *skills.Service) {
	registerSkillMarketRoutes(r, owners, domain)
	registerSkillRoutes(r, owners, domain, nil, false)
}

func registerSkillRoutes(r *gin.RouterGroup, owners workspaceOwners, skillsDomain *skills.Service, syncs skillSyncs, includeRemote bool) {
	r.POST("/skills/install", func(c *gin.Context) {
		user, err := currentUser(c, owners)
		if err != nil {
			failService(c, err)
			return
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, skills.SkillPackageUploadMaxBytes)
		file, err := c.FormFile("file")
		if err != nil {
			failService(c, kernel.BadAuthRequest("请选择 Markdown 或 ZIP 技能文件"))
			return
		}
		isPrivate, err := parseOptionalBool(c.PostForm("isPrivate"))
		if err != nil {
			failService(c, kernel.BadAuthRequest("isPrivate 必须是布尔值"))
			return
		}
		sourceType := strings.ToLower(strings.TrimSpace(c.PostForm("sourceType")))
		if sourceType == "" {
			switch strings.ToLower(filepath.Ext(file.Filename)) {
			case ".md", ".markdown":
				sourceType = "markdown"
			case ".zip":
				sourceType = "zip"
			}
		}
		skill, err := skillsDomain.InstallSkillUpload(user.ID, sourceType, file, skills.SkillInstallRequest{
			Name: c.PostForm("name"), Description: c.PostForm("description"), Tag: c.PostForm("tag"), IsPrivate: isPrivate,
		})
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, gin.H{"skill": skill})
	})

	if includeRemote {
		r.POST("/skills/install/github", func(c *gin.Context) {
			user, err := currentUser(c, owners)
			if err != nil {
				failService(c, err)
				return
			}
			c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 32<<10)
			var req skills.SkillGitHubInstallRequest
			if err := c.ShouldBindJSON(&req); err != nil {
				failService(c, kernel.BadAuthRequest("GitHub 技能数据格式无效"))
				return
			}
			skill, err := skillsDomain.InstallGitHubSkill(user.ID, req)
			if err != nil {
				failService(c, err)
				return
			}
			ok(c, gin.H{"skill": skill})
		})
	}

	r.GET("/skills", func(c *gin.Context) {
		user, err := currentUser(c, owners)
		if err != nil {
			failService(c, err)
			return
		}
		page, pageSize, err := parsePaginationQuery(c, 20)
		if err != nil {
			fail(c, http.StatusBadRequest, err)
			return
		}
		result, err := skillsDomain.Skills(user.ID, skills.SkillListRequest{
			Page: page, PageSize: pageSize, Scope: c.DefaultQuery("scope", "public"),
			Search: c.Query("search"), Tag: c.Query("tag"), Sort: c.DefaultQuery("sort", "popular"),
		})
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, result)
	})

	r.GET("/skills/added", func(c *gin.Context) {
		user, err := currentUser(c, owners)
		if err != nil {
			failService(c, err)
			return
		}
		skills, err := skillsDomain.AddedSkills(user.ID)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, gin.H{"skills": skills})
	})

	r.GET("/skills/:id", func(c *gin.Context) {
		user, err := currentUser(c, owners)
		if err != nil {
			failService(c, err)
			return
		}
		skill, err := skillsDomain.SkillDetail(user.ID, c.Param("id"))
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, gin.H{"skill": skill})
	})

	r.GET("/skills/:id/files", func(c *gin.Context) {
		user, err := currentUser(c, owners)
		if err != nil {
			failService(c, err)
			return
		}
		files, err := skillsDomain.SkillPackageFiles(user.ID, c.Param("id"))
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, gin.H{"files": files})
	})

	r.GET("/skills/:id/file", func(c *gin.Context) {
		user, err := currentUser(c, owners)
		if err != nil {
			failService(c, err)
			return
		}
		file, err := skillsDomain.SkillPackageFile(user.ID, c.Param("id"), c.Query("path"))
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, gin.H{"file": file})
	})

	r.GET("/skills/:id/file/raw", func(c *gin.Context) {
		user, err := currentUser(c, owners)
		if err != nil {
			failService(c, err)
			return
		}
		data, mimeType, fileName, err := skillsDomain.SkillPackageRawFile(user.ID, c.Param("id"), c.Query("path"))
		if err != nil {
			failService(c, err)
			return
		}
		c.Header("Cache-Control", "private, no-store")
		c.Header("X-Content-Type-Options", "nosniff")
		c.Header("Content-Security-Policy", "default-src 'none'; sandbox")
		c.Header("Content-Disposition", mime.FormatMediaType("inline", map[string]string{"filename": fileName}))
		c.Data(http.StatusOK, mimeType, data)
	})

	r.GET("/skills/:id/bundle", func(c *gin.Context) {
		user, err := currentUser(c, owners)
		if err != nil {
			failService(c, err)
			return
		}
		bundle, err := skillsDomain.SkillPackageBundle(user.ID, c.Param("id"))
		if err != nil {
			failService(c, err)
			return
		}
		c.Header("Cache-Control", "private, no-store")
		ok(c, gin.H{"bundle": bundle})
	})

	r.GET("/skills/:id/search", func(c *gin.Context) {
		user, err := currentUser(c, owners)
		if err != nil {
			failService(c, err)
			return
		}
		results, err := skillsDomain.SearchSkillPackage(user.ID, c.Param("id"), c.Query("q"))
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, gin.H{"results": results})
	})

	if includeRemote {
		r.POST("/skills/:id/sync", func(c *gin.Context) {
			user, err := currentUser(c, owners)
			if err != nil {
				failService(c, err)
				return
			}
			skill, err := syncs.SyncGitHubSkill(user.ID, c.Param("id"))
			if err != nil {
				failService(c, err)
				return
			}
			ok(c, gin.H{"skill": skill})
		})
	}

	r.POST("/skills", func(c *gin.Context) {
		user, err := currentUser(c, owners)
		if err != nil {
			failService(c, err)
			return
		}
		var req skills.SkillMutationRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			failService(c, kernel.BadAuthRequest("技能数据格式无效"))
			return
		}
		skill, err := skillsDomain.CreateSkill(user.ID, req)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, gin.H{"skill": skill})
	})

	r.PUT("/skills/:id", func(c *gin.Context) {
		user, err := currentUser(c, owners)
		if err != nil {
			failService(c, err)
			return
		}
		var req skills.SkillMutationRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			failService(c, kernel.BadAuthRequest("技能数据格式无效"))
			return
		}
		skill, err := skillsDomain.UpdateSkill(user.ID, c.Param("id"), req)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, gin.H{"skill": skill})
	})

	r.DELETE("/skills/:id", func(c *gin.Context) {
		user, err := currentUser(c, owners)
		if err != nil {
			failService(c, err)
			return
		}
		if err := skillsDomain.DeleteSkill(user.ID, c.Param("id")); err != nil {
			failService(c, err)
			return
		}
		ok(c, gin.H{"deleted": true})
	})

	r.POST("/skills/:id/add", setSkillAdded(owners, skillsDomain, true))
	r.DELETE("/skills/:id/add", setSkillAdded(owners, skillsDomain, false))
	r.POST("/skills/:id/like", setSkillLiked(owners, skillsDomain, true))
	r.DELETE("/skills/:id/like", setSkillLiked(owners, skillsDomain, false))
}

func parseOptionalBool(value string) (bool, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return false, nil
	}
	return strconv.ParseBool(value)
}

func setSkillAdded(owners workspaceOwners, skillsDomain *skills.Service, added bool) gin.HandlerFunc {
	return func(c *gin.Context) {
		user, err := currentUser(c, owners)
		if err != nil {
			failService(c, err)
			return
		}
		skill, err := skillsDomain.SetSkillAdded(user.ID, c.Param("id"), added)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, gin.H{"skill": skill})
	}
}

func setSkillLiked(owners workspaceOwners, skillsDomain *skills.Service, liked bool) gin.HandlerFunc {
	return func(c *gin.Context) {
		user, err := currentUser(c, owners)
		if err != nil {
			failService(c, err)
			return
		}
		skill, err := skillsDomain.SetSkillLiked(user.ID, c.Param("id"), liked)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, gin.H{"skill": skill})
	}
}
