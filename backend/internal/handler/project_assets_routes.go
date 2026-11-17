package handler

import (
	"net/http"
	"strings"

	localproject "infinite-canvas/backend/internal/project"

	"github.com/gin-gonic/gin"
)

func registerProjectAssetRoutes(r *gin.RouterGroup, owners workspaceOwners, projects *localproject.Service) {
	r.GET("/projects/:id/assets", func(c *gin.Context) {
		user, err := currentUser(c, owners)
		if err != nil {
			failService(c, err)
			return
		}
		pageParam, hasPage := c.GetQuery("page")
		pageSizeParam, hasPageSize := c.GetQuery("pageSize")
		if hasPage || hasPageSize {
			page, pageErr := parsePositiveQueryInt(pageParam, 1)
			if pageErr != nil {
				fail(c, http.StatusBadRequest, pageErr)
				return
			}
			pageSize, pageSizeErr := parsePositiveQueryInt(pageSizeParam, 40)
			if pageSizeErr != nil {
				fail(c, http.StatusBadRequest, pageSizeErr)
				return
			}
			var folderID *string
			if value, present := c.GetQuery("folderId"); present {
				folderID = &value
			}
			assets, pageErr := projects.ProjectAssetsPage(user.ID, c.Param("id"), page, pageSize, c.Query("category"), c.Query("mediaType"), c.Query("status"), folderID, c.Query("q"))
			if pageErr != nil {
				failService(c, pageErr)
				return
			}
			ok(c, assets)
			return
		}
		assets, err := projects.FilterProjectAssets(user.ID, c.Param("id"), localproject.ProjectAssetFilter{Category: c.Query("category"), MediaType: c.Query("mediaType"), Status: c.Query("status"), Usage: c.Query("usage")})
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, gin.H{"assets": assets})
	})
	r.GET("/projects/:id/asset-folders", func(c *gin.Context) {
		user, err := currentUser(c, owners)
		if err != nil {
			failService(c, err)
			return
		}
		folders, err := projects.ProjectAssetFolders(user.ID, c.Param("id"))
		if err != nil {
			if localproject.IsNotFound(err) {
				fail(c, http.StatusNotFound, err)
				return
			}
			failService(c, err)
			return
		}
		ok(c, gin.H{"folders": folders})
	})
	r.POST("/projects/:id/asset-folders", func(c *gin.Context) {
		user, err := currentUser(c, owners)
		if err != nil {
			failService(c, err)
			return
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 32<<10)
		var req localproject.CreateProjectAssetFolderRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			fail(c, http.StatusBadRequest, err)
			return
		}
		folder, err := projects.CreateProjectAssetFolder(user.ID, c.Param("id"), req)
		if err != nil {
			if localproject.IsNotFound(err) {
				fail(c, http.StatusNotFound, err)
				return
			}
			failService(c, err)
			return
		}
		ok(c, gin.H{"folder": folder})
	})
	r.PATCH("/projects/:id/asset-folders/:folderId", func(c *gin.Context) {
		user, err := currentUser(c, owners)
		if err != nil {
			failService(c, err)
			return
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 32<<10)
		var req localproject.UpdateProjectAssetFolderRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			fail(c, http.StatusBadRequest, err)
			return
		}
		folder, err := projects.UpdateProjectAssetFolder(user.ID, c.Param("id"), c.Param("folderId"), req)
		if err != nil {
			if localproject.IsNotFound(err) {
				fail(c, http.StatusNotFound, err)
				return
			}
			failService(c, err)
			return
		}
		ok(c, gin.H{"folder": folder})
	})
	r.DELETE("/projects/:id/asset-folders/:folderId", func(c *gin.Context) {
		user, err := currentUser(c, owners)
		if err != nil {
			failService(c, err)
			return
		}
		if err := projects.DeleteProjectAssetFolder(user.ID, c.Param("id"), c.Param("folderId")); err != nil {
			if localproject.IsNotFound(err) {
				fail(c, http.StatusNotFound, err)
				return
			}
			failService(c, err)
			return
		}
		ok(c, gin.H{"id": c.Param("folderId")})
	})
	r.POST("/projects/:id/characters", func(c *gin.Context) {
		user, err := currentUser(c, owners)
		if err != nil {
			failService(c, err)
			return
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 256<<10)
		var req localproject.CreateProjectCharacterRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			fail(c, http.StatusBadRequest, err)
			return
		}
		character, err := projects.CreateProjectCharacter(user.ID, c.Param("id"), req)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, character)
	})
	r.GET("/projects/:id/characters/:assetId", func(c *gin.Context) {
		user, err := currentUser(c, owners)
		if err != nil {
			failService(c, err)
			return
		}
		character, err := projects.ProjectCharacter(user.ID, c.Param("id"), c.Param("assetId"))
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, character)
	})
	r.PATCH("/projects/:id/characters/:assetId", func(c *gin.Context) {
		user, err := currentUser(c, owners)
		if err != nil {
			failService(c, err)
			return
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 256<<10)
		var req localproject.UpdateProjectCharacterRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			fail(c, http.StatusBadRequest, err)
			return
		}
		character, err := projects.UpdateProjectCharacter(user.ID, c.Param("id"), c.Param("assetId"), req)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, character)
	})
	r.PUT("/projects/:id/characters/:assetId/representations", func(c *gin.Context) {
		user, err := currentUser(c, owners)
		if err != nil {
			failService(c, err)
			return
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 128<<10)
		var req localproject.ReplaceCharacterRepresentationsRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			fail(c, http.StatusBadRequest, err)
			return
		}
		character, err := projects.ReplaceProjectCharacterRepresentations(user.ID, c.Param("id"), c.Param("assetId"), req)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, character)
	})
	r.PUT("/projects/:id/characters/:assetId/voice", func(c *gin.Context) {
		user, err := currentUser(c, owners)
		if err != nil {
			failService(c, err)
			return
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 64<<10)
		var req localproject.BindCharacterVoiceRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			fail(c, http.StatusBadRequest, err)
			return
		}
		character, err := projects.BindProjectCharacterVoice(user.ID, c.Param("id"), c.Param("assetId"), req)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, character)
	})
	r.DELETE("/projects/:id/characters/:assetId/voice", func(c *gin.Context) {
		user, err := currentUser(c, owners)
		if err != nil {
			failService(c, err)
			return
		}
		character, err := projects.UnbindProjectCharacterVoice(user.ID, c.Param("id"), c.Param("assetId"))
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, character)
	})
	r.POST("/projects/:id/assets", func(c *gin.Context) {
		user, err := currentUser(c, owners)
		if err != nil {
			failService(c, err)
			return
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 64<<10)
		var req localproject.LinkProjectAssetRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			fail(c, http.StatusBadRequest, err)
			return
		}
		asset, err := projects.LinkProjectAsset(user.ID, c.Param("id"), req)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, gin.H{"asset": asset})
	})
	r.DELETE("/projects/:id/assets/:assetId", func(c *gin.Context) {
		user, err := currentUser(c, owners)
		if err != nil {
			failService(c, err)
			return
		}
		if err := projects.UnlinkProjectAsset(user.ID, c.Param("id"), c.Param("assetId")); err != nil {
			failService(c, err)
			return
		}
		ok(c, gin.H{"id": c.Param("assetId")})
	})
	r.PATCH("/projects/:id/assets/:assetId", func(c *gin.Context) {
		user, err := currentUser(c, owners)
		if err != nil {
			failService(c, err)
			return
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 64<<10)
		var req localproject.UpdateProjectAssetRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			fail(c, http.StatusBadRequest, err)
			return
		}
		asset, err := projects.UpdateProjectAsset(user.ID, c.Param("id"), c.Param("assetId"), req)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, gin.H{"asset": asset})
	})
	r.POST("/projects/:id/assets/:assetId/versions", func(c *gin.Context) {
		user, err := currentUser(c, owners)
		if err != nil {
			failService(c, err)
			return
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 256<<10)
		var req localproject.CreateAssetVersionRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			fail(c, http.StatusBadRequest, err)
			return
		}
		version, err := projects.CreateProjectAssetVersion(user.ID, c.Param("id"), c.Param("assetId"), req)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, gin.H{"version": version})
	})
	r.POST("/projects/:id/asset-candidates", func(c *gin.Context) {
		user, err := currentUser(c, owners)
		if err != nil {
			failService(c, err)
			return
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 512<<10)
		var req localproject.CreateAssetCandidatesRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			fail(c, http.StatusBadRequest, err)
			return
		}
		candidates, err := projects.CreateProjectAssetCandidates(user.ID, c.Param("id"), req)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, gin.H{"candidates": candidates})
	})
	r.GET("/projects/:id/asset-candidates", func(c *gin.Context) {
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
		pageSize, err := parsePositiveQueryInt(c.Query("pageSize"), 100)
		if err != nil {
			fail(c, http.StatusBadRequest, err)
			return
		}
		result, err := projects.ProjectAssetCandidatesPage(user.ID, c.Param("id"), page, pageSize, c.Query("unitId"), c.Query("status"), c.Query("category"), c.Query("q"))
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, result)
	})
	r.POST("/projects/:id/asset-candidates/:candidateId/confirm", func(c *gin.Context) {
		user, err := currentUser(c, owners)
		if err != nil {
			failService(c, err)
			return
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 64<<10)
		var req localproject.ConfirmProjectAssetCandidateRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			fail(c, http.StatusBadRequest, err)
			return
		}
		asset, err := projects.ConfirmProjectAssetCandidate(user.ID, c.Param("id"), c.Param("candidateId"), req)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, gin.H{"asset": asset})
	})
	r.GET("/projects/:id/chapter-apply-receipts", func(c *gin.Context) {
		user, err := currentUser(c, owners)
		if err != nil {
			failService(c, err)
			return
		}
		taskIDs := strings.Split(c.Query("taskIds"), ",")
		receipts, err := projects.ChapterApplyReceipts(user.ID, c.Param("id"), taskIDs)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, gin.H{"receipts": receipts})
	})
}
