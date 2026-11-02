package handler

import (
	"errors"
	"net/http"

	"qisitv/backend/internal/prompts"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

func RegisterStyleProfileRoutes(r *gin.RouterGroup, owners workspaceOwners, profiles *prompts.Service) {
	r.GET("/style-profiles", func(c *gin.Context) {
		user, err := currentUser(c, owners)
		if err != nil {
			failService(c, err)
			return
		}
		profiles, err := profiles.ListStyleProfiles(user.ID)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, gin.H{"profiles": profiles})
	})
	r.POST("/style-profiles", func(c *gin.Context) {
		user, err := currentUser(c, owners)
		if err != nil {
			failService(c, err)
			return
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 320<<10)
		var req prompts.StyleProfileRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			fail(c, http.StatusBadRequest, err)
			return
		}
		profile, err := profiles.CreateStyleProfile(user.ID, req)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, gin.H{"profile": profile})
	})
	r.PATCH("/style-profiles/:id", func(c *gin.Context) {
		user, err := currentUser(c, owners)
		if err != nil {
			failService(c, err)
			return
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 320<<10)
		var req prompts.StyleProfileRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			fail(c, http.StatusBadRequest, err)
			return
		}
		profile, err := profiles.UpdateStyleProfile(user.ID, c.Param("id"), req)
		if errors.Is(err, gorm.ErrRecordNotFound) {
			fail(c, http.StatusNotFound, err)
			return
		}
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, gin.H{"profile": profile})
	})
	r.PATCH("/style-profiles/:id/favorite", func(c *gin.Context) {
		user, err := currentUser(c, owners)
		if err != nil {
			failService(c, err)
			return
		}
		var req prompts.StyleProfileFavoriteRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			fail(c, http.StatusBadRequest, err)
			return
		}
		if err := profiles.SetStyleProfileFavorite(user.ID, c.Param("id"), req.Favorite); errors.Is(err, gorm.ErrRecordNotFound) {
			fail(c, http.StatusNotFound, err)
			return
		} else if err != nil {
			failService(c, err)
			return
		}
		ok(c, gin.H{"id": c.Param("id"), "favorite": req.Favorite})
	})
	r.POST("/style-profiles/:id/use", func(c *gin.Context) {
		user, err := currentUser(c, owners)
		if err != nil {
			failService(c, err)
			return
		}
		if err := profiles.TouchStyleProfile(user.ID, c.Param("id")); errors.Is(err, gorm.ErrRecordNotFound) {
			fail(c, http.StatusNotFound, err)
			return
		} else if err != nil {
			failService(c, err)
			return
		}
		ok(c, gin.H{"id": c.Param("id")})
	})
	r.DELETE("/style-profiles/:id", func(c *gin.Context) {
		user, err := currentUser(c, owners)
		if err != nil {
			failService(c, err)
			return
		}
		if err := profiles.DeleteStyleProfile(user.ID, c.Param("id")); errors.Is(err, gorm.ErrRecordNotFound) {
			fail(c, http.StatusNotFound, err)
			return
		} else if err != nil {
			failService(c, err)
			return
		}
		ok(c, gin.H{"id": c.Param("id")})
	})
}
