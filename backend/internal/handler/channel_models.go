package handler

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	"infinite-canvas/backend/internal/app"
	"infinite-canvas/backend/internal/generation"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/modelcatalog"
	"infinite-canvas/backend/internal/platform"

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
	// 设置页展示的请求地址由后端给出，和读取模型目录、文本任务实际请求的是同一个地址。
	r.POST("/ai/request-urls", func(c *gin.Context) {
		if _, err := currentUser(c, catalogs); err != nil {
			failService(c, err)
			return
		}
		var input struct {
			BaseURL   string `json:"baseUrl"`
			APIFormat string `json:"apiFormat"`
			// 模型配置里写的文本接口格式，原样传来；留空表示按渠道格式取默认值。
			Protocols []string `json:"protocols"`
		}
		if err := c.ShouldBindJSON(&input); err != nil || len(input.Protocols) > 32 {
			fail(c, http.StatusBadRequest, errors.New("模型渠道参数格式错误"))
			return
		}
		ok(c, channelRequestURLs(input.BaseURL, input.APIFormat, input.Protocols))
	})
}

func channelRequestURLs(baseURL, apiFormat string, protocols []string) gin.H {
	text := map[string]string{}
	if strings.TrimSpace(baseURL) == "" {
		return gin.H{"catalog": "", "text": text}
	}
	for _, protocol := range protocols {
		// 没写接口格式的 Gemini 渠道不走这三种文本接口，不给地址。
		if strings.TrimSpace(protocol) == "" && strings.EqualFold(strings.TrimSpace(apiFormat), "gemini") {
			continue
		}
		if url := generation.TextRequestURLFor(baseURL, apiFormat, protocol); url != "" {
			text[protocol] = url
		}
	}
	catalog := ""
	// 和真正读取目录一样先整理地址与格式；不支持读取目录的格式不给目录地址。
	if format, err := modelcatalog.NormalizeCatalogAPIFormat(apiFormat); err == nil {
		catalog = generation.ChannelCatalogURL(modelcatalog.CatalogBaseURL(baseURL), format)
	}
	return gin.H{"catalog": catalog, "text": text}
}
