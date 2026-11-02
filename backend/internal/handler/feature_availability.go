package handler

import (
	"qisitv/backend/internal/platform"

	"github.com/gin-gonic/gin"
)

// featureGates resolves the caller and the workspace feature switches.
type featureGates interface {
	workspaceOwners
	FeatureAvailability() (*platform.PublicFeatureAvailability, error)
	RequireFeature(feature string) error
}

func RegisterDesktopFeatureAvailabilityRoutes(r *gin.RouterGroup, gates featureGates) {
	r.GET("/features", func(c *gin.Context) {
		if _, err := currentUser(c, gates); err != nil {
			failService(c, err)
			return
		}
		setting, err := gates.FeatureAvailability()
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, gin.H{"features": setting})
	})

}

// 功能守卫先解析本地工作区身份，再判断功能开放状态。
func RequireFeature(gates featureGates, feature string) gin.HandlerFunc {
	return func(c *gin.Context) {
		if _, err := currentUser(c, gates); err != nil {
			failService(c, err)
			c.Abort()
			return
		}
		if err := gates.RequireFeature(feature); err != nil {
			failService(c, err)
			c.Abort()
			return
		}
		c.Next()
	}
}
