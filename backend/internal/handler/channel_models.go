package handler

import (
	"context"
	"errors"
	"net/http"
	"time"

	"qisitv/backend/internal/app"
	"qisitv/backend/internal/model"
	"qisitv/backend/internal/modelcatalog"
	"qisitv/backend/internal/platform"

	"github.com/gin-gonic/gin"
)

// channelModelCatalogs lists models for one custom channel. Fetching still
// lives in the composition root; the handler only names the calls it makes.
type channelModelCatalogs interface {
	workspaceOwners
	RequireFeature(feature string) error
	FetchChannelModelCatalog(ctx context.Context, actor *model.User, input app.ChannelModelsRequest) ([]modelcatalog.ChannelModelCatalogItem, error)
}

func RegisterChannelModelRoutes(r *gin.RouterGroup, catalogs channelModelCatalogs) {
	r.POST("/ai/models", func(c *gin.Context) {
		user, err := currentUser(c, catalogs)
		if err != nil {
			failService(c, err)
			return
		}
		if err := catalogs.RequireFeature(platform.FeatureCustomChannels); err != nil {
			failService(c, err)
			return
		}
		if !enforceRateLimit(c, "channel-models:"+user.ID, 30, time.Minute) {
			return
		}
		var input app.ChannelModelsRequest
		if err := c.ShouldBindJSON(&input); err != nil {
			fail(c, http.StatusBadRequest, errors.New("模型渠道参数格式错误"))
			return
		}
		// handler 不接触上游响应细节，密钥校验和模型目录解析统一收敛到 service。
		models, err := catalogs.FetchChannelModelCatalog(c.Request.Context(), user, input)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, gin.H{"models": models})
	})
}
