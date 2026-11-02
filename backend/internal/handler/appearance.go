package handler

import (
	"io"
	"net/http"

	"qisitv/backend/internal/appearance"
	"qisitv/backend/internal/assets"

	"github.com/gin-gonic/gin"
)

// appearanceAssets opens the bytes for a configured slot. The domain service
// only knows which resource is configured; streaming stays at the composition root.
type appearanceAssets interface {
	OpenAppearanceAsset(slot string, rangeHeader string) (*assets.ResourceStream, error)
}

func RegisterDesktopAppearanceRoutes(r *gin.RouterGroup, assets appearanceAssets) {
	r.GET("/public/appearance", func(c *gin.Context) {
		setting, err := requestAppearance(c).Public()
		if err != nil {
			failService(c, err)
			return
		}
		c.Header("Cache-Control", "no-store")
		ok(c, gin.H{"appearance": setting})
	})

	r.GET("/public/appearance/assets/:slot", func(c *gin.Context) {
		stream, err := assets.OpenAppearanceAsset(c.Param("slot"), c.GetHeader("Range"))
		if err != nil {
			failService(c, err)
			return
		}
		defer stream.Body.Close()
		resource := stream.Resource
		mimeType := resource.MimeType
		if mimeType == "" {
			mimeType = "application/octet-stream"
		}
		if c.Query("v") != "" {
			c.Header("Cache-Control", "public, max-age=31536000, immutable")
		} else {
			c.Header("Cache-Control", "public, no-cache")
		}
		c.Header("Accept-Ranges", "bytes")
		c.Header("Referrer-Policy", "no-referrer")
		c.Header("X-Content-Type-Options", "nosniff")
		if stream.ContentRange != "" {
			c.Header("Content-Range", stream.ContentRange)
		}
		if seeker, available := stream.Body.(io.ReadSeeker); available {
			c.Header("Content-Type", mimeType)
			http.ServeContent(c.Writer, c.Request, resource.ID, resource.UpdatedAt, seeker)
			return
		}
		c.DataFromReader(stream.StatusCode, stream.ContentLength, mimeType, stream.Body, nil)
	})

}

func requestAppearance(c *gin.Context) *appearance.Service {
	if dependencies, ok := runtimeDependencies(c); ok && dependencies.Appearance != nil {
		return dependencies.Appearance
	}
	return appearance.New(appearance.Dependencies{})
}
