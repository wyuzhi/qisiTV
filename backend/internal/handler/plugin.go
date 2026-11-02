package handler

import (
	"io"
	"net/http"
	"strconv"
	"strings"

	"infinite-canvas/backend/internal/eagle"
	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/platform"
	"infinite-canvas/backend/internal/plugins"
	"infinite-canvas/backend/internal/protocol"

	"github.com/gin-gonic/gin"
)

// pluginCenter is the handler-facing slice of plugin administration. Permission
// checks, audit rows, and feature gates stay in the composition root.
type pluginCenter interface {
	workspaceOwners
	PluginDomain() *plugins.Service
	PluginsForUser(actor *model.User) ([]plugins.View, error)
	RequireAdmin(user *model.User) error
	InstallPluginForAdmin(actor *model.User, data []byte, fileName string) (plugins.View, error)
	SetUserPluginEnabled(actor *model.User, pluginID string, enabled bool) (plugins.StateView, error)
	UninstallPluginForAdmin(actor *model.User, id string) error
	RequireFeature(feature string) error
	SetPluginPlatformAvailability(actor *model.User, pluginID string, available bool) (plugins.AdminStateView, error)
	RequirePluginForUser(userID string, pluginID string) error
}

func RegisterPluginRoutes(r *gin.RouterGroup, center pluginCenter, hosted ...bool) {
	// Protocol metadata is required by the local desktop model editor. It is
	// read-only and must remain available even when the full plugin center is
	// disabled in the desktop profile.
	catalogRoutes := r.Group("/plugins")
	catalogRoutes.GET("/catalog", func(c *gin.Context) {
		if _, err := currentUser(c, center); err != nil {
			failService(c, err)
			return
		}
		scope := strings.TrimSpace(c.DefaultQuery("scope", "user.custom-channel"))
		capability := strings.TrimSpace(c.Query("capability"))
		ok(c, gin.H{"providers": center.PluginDomain().ProviderCatalog(scope, capability, false)})
	})
	catalogRoutes.GET("/packages/enabled", func(c *gin.Context) {
		ok(c, gin.H{"packages": center.PluginDomain().EnabledPackages()})
	})
	catalogRoutes.GET("/:id/files/*filepath", func(c *gin.Context) {
		targetPath, contentType, err := center.PluginDomain().ResolvePackageFile(c.Param("id"), c.Param("filepath"))
		if err != nil {
			failService(c, err)
			return
		}
		c.Header("Cache-Control", "no-store")
		c.Header("X-Content-Type-Options", "nosniff")
		if contentType != "" {
			c.Header("Content-Type", contentType)
		}
		c.File(targetPath)
	})
	catalogRoutes.POST("/:id/load-error", func(c *gin.Context) {
		var request struct {
			Error string `json:"error"`
		}
		if err := c.ShouldBindJSON(&request); err != nil {
			fail(c, http.StatusBadRequest, err)
			return
		}
		plugin, err := center.PluginDomain().SetLoadError(c.Param("id"), strings.TrimSpace(request.Error))
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, gin.H{"plugin": plugin})
	})
	statusRoutes := r.Group("/plugins")
	statusRoutes.GET("/status", func(c *gin.Context) {
		user, err := currentUser(c, center)
		if err != nil {
			failService(c, err)
			return
		}
		states, err := center.PluginDomain().StatesForUser(user)
		if err != nil {
			failService(c, err)
			return
		}
		statuses, err := center.PluginDomain().WorkflowStatusesForUser(user.ID)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, gin.H{"statuses": statuses, "states": states})
	})
	pluginRoutes := r.Group("/plugins")
	pluginRoutes.Use(requirePluginCenterAccess(center))
	// The frontend plugin center is the single management surface. Protocol
	// plugins are returned as kind=protocol records alongside UI plugins.
	pluginRoutes.GET("", func(c *gin.Context) {
		user, err := currentUser(c, center)
		if err != nil {
			failService(c, err)
			return
		}
		listed, err := center.PluginsForUser(user)
		if err != nil {
			failService(c, err)
			return
		}
		states, err := center.PluginDomain().StatesForUser(user)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, gin.H{"plugins": listed, "states": states})
	})
	pluginRoutes.GET("/market/search", func(c *gin.Context) {
		items, err := center.PluginDomain().SearchMarket(c.Request.Context(), c.Query("q"))
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, gin.H{"items": items})
	})
	pluginRoutes.POST("/install", func(c *gin.Context) {
		if _, ok := requirePluginAdmin(c, center); !ok {
			return
		}
		var request struct {
			Source   string `json:"source"`
			Registry string `json:"registry"`
		}
		if err := c.ShouldBindJSON(&request); err != nil {
			fail(c, http.StatusBadRequest, err)
			return
		}
		plugin, err := center.PluginDomain().InstallPackage(request.Source, request.Registry)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, gin.H{"plugin": plugin})
	})
	pluginRoutes.POST("/:id/update", func(c *gin.Context) {
		if _, ok := requirePluginAdmin(c, center); !ok {
			return
		}
		var request struct {
			Registry string `json:"registry"`
		}
		if err := c.ShouldBindJSON(&request); err != nil {
			fail(c, http.StatusBadRequest, err)
			return
		}
		plugin, err := center.PluginDomain().UpdatePackage(c.Param("id"), request.Registry)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, gin.H{"plugin": plugin})
	})
	pluginRoutes.POST("", func(c *gin.Context) {
		user, err := currentUser(c, center)
		if err != nil {
			failService(c, err)
			return
		}
		if err := center.RequireAdmin(user); err != nil {
			failService(c, err)
			return
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, protocol.PluginPackageMaxBytes)
		var data []byte
		fileName := ""
		if strings.HasPrefix(strings.ToLower(c.GetHeader("Content-Type")), "multipart/form-data") {
			file, header, fileErr := c.Request.FormFile("file")
			if fileErr != nil {
				fail(c, http.StatusBadRequest, fileErr)
				return
			}
			defer file.Close()
			fileName = header.Filename
			data, err = io.ReadAll(io.LimitReader(file, protocol.PluginPackageMaxBytes+1))
		} else {
			data, err = io.ReadAll(io.LimitReader(c.Request.Body, protocol.PluginPackageMaxBytes+1))
		}
		if err != nil {
			fail(c, http.StatusBadRequest, err)
			return
		}
		lowerName := strings.ToLower(strings.TrimSpace(fileName))
		if strings.HasSuffix(lowerName, ".tgz") {
			plugin, err := center.PluginDomain().InstallPackageArchive(data, c.PostForm("registry"))
			if err != nil {
				failService(c, err)
				return
			}
			ok(c, gin.H{"plugin": plugin})
			return
		}
		plugin, err := center.InstallPluginForAdmin(user, data, fileName)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, gin.H{"plugin": plugin})
	})
	pluginRoutes.GET("/:id/package", func(c *gin.Context) {
		user, err := currentUser(c, center)
		if err != nil {
			failService(c, err)
			return
		}
		visiblePlugins, err := center.PluginsForUser(user)
		if err != nil {
			failService(c, err)
			return
		}
		visible := false
		for _, plugin := range visiblePlugins {
			if plugin.Manifest.ID == c.Param("id") {
				visible = true
				break
			}
		}
		if !visible {
			failService(c, kernel.Forbidden("无权访问该插件包"))
			return
		}
		data, fileName, err := center.PluginDomain().Package(c.Param("id"))
		if err != nil {
			failService(c, err)
			return
		}
		if fileName == "" {
			fileName = c.Param("id") + protocol.PluginPackageExtension
		}
		c.Header("Cache-Control", "private, no-store")
		c.Header("Content-Disposition", "attachment; filename=\""+strings.ReplaceAll(fileName, "\"", "")+"\"")
		c.Data(http.StatusOK, "application/zip", data)
	})
	pluginRoutes.POST("/:id/enable", pluginToggle(center, true))
	pluginRoutes.POST("/:id/disable", pluginToggle(center, false))
	pluginRoutes.PUT("/:id/activation", func(c *gin.Context) {
		user, err := currentUser(c, center)
		if err != nil {
			failService(c, err)
			return
		}
		var request struct {
			Enabled bool `json:"enabled"`
		}
		if err := c.ShouldBindJSON(&request); err != nil {
			fail(c, http.StatusBadRequest, err)
			return
		}
		state, err := center.SetUserPluginEnabled(user, c.Param("id"), request.Enabled)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, gin.H{"state": state})
	})
	pluginRoutes.DELETE("/:id", func(c *gin.Context) {
		user, err := currentUser(c, center)
		if err != nil {
			failService(c, err)
			return
		}
		if err := center.RequireAdmin(user); err != nil {
			failService(c, err)
			return
		}
		if err := center.UninstallPluginForAdmin(user, c.Param("id")); err != nil {
			failService(c, err)
			return
		}
		ok(c, gin.H{"deleted": true})
	})

	pluginRoutes.GET("/eagle/library", func(c *gin.Context) {
		if _, allowed := requireEnabledPlugin(c, center, plugins.EagleAssetConnector); !allowed {
			return
		}
		library, err := requestEagle(c).Library(c.Query("baseUrl"))
		if err != nil {
			failService(c, err)
			return
		}
		library.LibraryPath = ""
		ok(c, gin.H{"library": library})
	})
	pluginRoutes.GET("/eagle/items", func(c *gin.Context) {
		if _, allowed := requireEnabledPlugin(c, center, plugins.EagleAssetConnector); !allowed {
			return
		}
		limit, _ := strconv.Atoi(c.DefaultQuery("limit", "60"))
		offset, _ := strconv.Atoi(c.DefaultQuery("offset", "0"))
		items, err := requestEagle(c).Items(c.Query("baseUrl"), eagle.ItemQuery{FolderID: c.Query("folderId"), Keyword: c.Query("keyword"), Limit: limit, Offset: offset})
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, gin.H{"items": items})
	})
	pluginRoutes.GET("/eagle/items/:itemId/file", func(c *gin.Context) {
		if _, allowed := requireEnabledPlugin(c, center, plugins.EagleAssetConnector); !allowed {
			return
		}
		file, err := requestEagle(c).OpenFile(c.Query("baseUrl"), c.Param("itemId"))
		if err != nil {
			failService(c, err)
			return
		}
		defer file.Body.Close()
		c.Header("Cache-Control", "private, no-store")
		c.Header("X-Content-Type-Options", "nosniff")
		c.Header("Content-Disposition", "attachment; filename=\""+file.Name+"\"")
		c.DataFromReader(http.StatusOK, file.Size, file.MimeType, file.Body, nil)
	})
	pluginRoutes.GET("/eagle/items/:itemId/thumbnail", func(c *gin.Context) {
		if _, allowed := requireEnabledPlugin(c, center, plugins.EagleAssetConnector); !allowed {
			return
		}
		file, err := requestEagle(c).OpenThumbnail(c.Query("baseUrl"), c.Param("itemId"))
		if err != nil {
			failService(c, err)
			return
		}
		defer file.Body.Close()
		c.Header("Cache-Control", "private, max-age=60")
		c.Header("X-Content-Type-Options", "nosniff")
		c.DataFromReader(http.StatusOK, file.Size, file.MimeType, file.Body, nil)
	})
	pluginRoutes.POST("/eagle/items", func(c *gin.Context) {
		if _, allowed := requireEnabledPlugin(c, center, plugins.EagleAssetConnector); !allowed {
			return
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 160<<20)
		var request eagle.AddItemRequest
		if err := c.ShouldBindJSON(&request); err != nil {
			fail(c, http.StatusBadRequest, err)
			return
		}
		item, err := requestEagle(c).AddItem(c.Query("baseUrl"), request)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, gin.H{"item": item})
	})
	pluginRoutes.POST("/eagle/folders", func(c *gin.Context) {
		if _, allowed := requireEnabledPlugin(c, center, plugins.EagleAssetConnector); !allowed {
			return
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 16<<10)
		var request struct {
			Name     string `json:"name"`
			ParentID string `json:"parentId"`
		}
		if err := c.ShouldBindJSON(&request); err != nil {
			fail(c, http.StatusBadRequest, err)
			return
		}
		if err := requestEagle(c).CreateFolder(c.Query("baseUrl"), request.Name, request.ParentID); err != nil {
			failService(c, err)
			return
		}
		ok(c, gin.H{"created": true})
	})
}

func requestEagle(c *gin.Context) *eagle.Client {
	if dependencies, ok := runtimeDependencies(c); ok && dependencies.Eagle != nil {
		return dependencies.Eagle
	}
	return eagle.New()
}

func requirePluginCenterAccess(center pluginCenter) gin.HandlerFunc {
	return func(c *gin.Context) {
		user, err := currentUser(c, center)
		if err != nil {
			failService(c, err)
			c.Abort()
			return
		}
		if user.Role == model.UserRoleAdmin {
			c.Next()
			return
		}
		if err := center.RequireFeature(platform.FeaturePluginCenter); err != nil {
			failService(c, err)
			c.Abort()
			return
		}
		c.Next()
	}
}

func pluginToggle(center pluginCenter, enabled bool) gin.HandlerFunc {
	return func(c *gin.Context) {
		user, err := currentUser(c, center)
		if err != nil {
			failService(c, err)
			return
		}
		if err := center.RequireAdmin(user); err != nil {
			failService(c, err)
			return
		}
		state, err := center.SetPluginPlatformAvailability(user, c.Param("id"), enabled)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, gin.H{"state": state})
	}
}

func requireEnabledPlugin(c *gin.Context, center pluginCenter, pluginID string) (*model.User, bool) {
	user, err := currentUser(c, center)
	if err == nil {
		err = center.RequirePluginForUser(user.ID, pluginID)
	}
	if err != nil {
		failService(c, err)
		return nil, false
	}
	return user, true
}

func requirePluginAdmin(c *gin.Context, center pluginCenter) (*model.User, bool) {
	user, err := currentUser(c, center)
	if err == nil {
		err = center.RequireAdmin(user)
	}
	if err != nil {
		failService(c, err)
		return nil, false
	}
	return user, true
}
