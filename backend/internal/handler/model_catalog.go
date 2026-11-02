package handler

import (
	"errors"
	"net/http"

	"qisitv/backend/internal/modelcatalog"

	"github.com/gin-gonic/gin"
)

// modelCatalogs serves the unified model catalog. Assembly still lives in the
// composition root; the handler only names the two reads it uses.
type modelCatalogs interface {
	workspaceOwners
	ModelCatalog(intent *modelcatalog.ModelRequestIntent) (*modelcatalog.CatalogResponse, error)
}

// RegisterModelCatalogRoutes 注册统一模型目录路由
func RegisterModelCatalogRoutes(r *gin.RouterGroup, catalogs modelCatalogs) {
	r.GET("/model-catalog", func(c *gin.Context) {
		if _, err := currentUser(c, catalogs); err != nil {
			failService(c, err)
			return
		}
		catalog, err := catalogs.ModelCatalog(nil)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, catalog)
	})

	r.POST("/model-catalog/available", func(c *gin.Context) {
		if _, err := currentUser(c, catalogs); err != nil {
			failService(c, err)
			return
		}
		var intent modelcatalog.ModelRequestIntent
		if err := c.ShouldBindJSON(&intent); err != nil {
			fail(c, http.StatusBadRequest, errors.New("模型能力请求格式错误"))
			return
		}
		catalog, err := catalogs.ModelCatalog(&intent)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, catalog)
	})

}
