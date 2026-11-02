package operations

import (
	"encoding/json"
	"strings"

	"qisitv/backend/internal/assistantturns"
	"qisitv/backend/internal/canvas"
	"qisitv/backend/internal/kernel"
	"qisitv/backend/internal/model"
	"qisitv/backend/internal/repository"
)

type ProjectSearch interface {
	SearchAgentProject(userID, canvasID, target, query, kind string, page, pageSize int) (any, error)
}

func CurrentAgentProject(repo *repository.Repository, activeProject func(userID, projectID string) (*model.Project, error), userID, canvasID string) (*model.CanvasProject, error) {
	current, err := repo.CanvasProjectForUser(userID, canvasID)
	if err != nil {
		return nil, kernel.Forbidden("当前画布不存在或不属于当前工作区")
	}
	if current.ProjectID != "" && activeProject != nil {
		if _, err := activeProject(userID, current.ProjectID); err != nil {
			return nil, err
		}
	}
	return current, nil
}

func ValidateProjectReference(repo *repository.Repository, activeProject func(userID, projectID string) (*model.Project, error), userID, canvasID, kind, id string) error {
	current, err := CurrentAgentProject(repo, activeProject, userID, canvasID)
	if err != nil {
		return err
	}
	if current.ProjectID == "" {
		return kernel.Forbidden("当前画布未关联项目，只能使用已引用的资源")
	}
	switch kind {
	case "asset":
		if _, err := repo.AssetForUser(userID, id); err != nil {
			return kernel.Forbidden("素材不属于当前项目")
		}
		linked, err := repo.ProjectAssetLinked(current.ProjectID, id)
		if err != nil {
			return err
		}
		if linked {
			return nil
		}
	case "canvas":
		other, err := repo.CanvasProjectForUser(userID, id)
		if err == nil && other.ProjectID == current.ProjectID {
			return nil
		}
	}
	return kernel.Forbidden("资源不属于当前画布的项目")
}

func agentAssetSearchItem(raw json.RawMessage) (map[string]any, error) {
	var payload struct {
		ID    string `json:"id"`
		Title string `json:"title"`
		Kind  string `json:"kind"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return nil, err
	}
	return map[string]any{"assetId": payload.ID, "title": payload.Title, "kind": payload.Kind}, nil
}

func SearchProject(
	repo *repository.Repository,
	canvasSvc *canvas.Service,
	activeProject func(userID, projectID string) (*model.Project, error),
	ownedReadyResource func(userID, resourceID string) (*model.Resource, error),
	userID, canvasID, target, query, kind string,
	page, size int,
) (any, error) {
	current, err := CurrentAgentProject(repo, activeProject, userID, canvasID)
	if err != nil {
		return nil, err
	}
	result := map[string]any{"canvasId": canvasID, "projectId": current.ProjectID, "page": page, "pageSize": size, "items": []any{}, "total": int64(0), "hasMore": false}
	items := []any{}
	if target == "canvas" {
		if current.ProjectID == "" {
			if strings.Contains(strings.ToLower(current.Title), strings.ToLower(query)) {
				result["total"] = int64(1)
				if page == 1 {
					items = append(items, map[string]any{"canvasId": current.ID, "title": current.Title, "revision": current.Revision})
				}
			}
		} else {
			found, err := canvasSvc.UserCanvasProjectsPage(userID, page, size, current.ProjectID, query, "")
			if err != nil {
				return nil, err
			}
			for _, item := range found.Projects {
				items = append(items, map[string]any{"canvasId": item.ID, "title": item.Title, "revision": item.Revision, "nodeCount": item.NodeCount})
			}
			result["total"], result["hasMore"] = found.Total, found.HasMore
		}
	} else if current.ProjectID != "" {
		found, err := canvasSvc.UserAssetsPage(userID, page, size, canvas.UserAssetPageFilter{ProjectID: current.ProjectID, Query: query, Kind: kind})
		if err != nil {
			return nil, err
		}
		for _, raw := range found.Assets {
			item, err := agentAssetSearchItem(raw)
			if err != nil {
				return nil, err
			}
			items = append(items, item)
		}
		result["total"], result["hasMore"] = found.Total, found.HasMore
	} else {
		ids, _ := assistantturns.AssociatedReferences(json.RawMessage(current.PayloadJSON))
		if len(ids) > 1000 {
			return nil, kernel.BadAuthRequest("当前画布关联素材过多，请缩小范围")
		}
		for _, id := range ids {
			asset, err := repo.AssetForUser(userID, id)
			if err != nil {
				return nil, err
			}
			if (kind == "" || asset.Kind == kind) && strings.Contains(strings.ToLower(asset.Title), strings.ToLower(query)) {
				items = append(items, map[string]any{"assetId": asset.ID, "title": asset.Title, "kind": asset.Kind})
			}
		}
		var document struct {
			Nodes []map[string]any `json:"nodes"`
		}
		if err := json.Unmarshal([]byte(current.PayloadJSON), &document); err != nil {
			return nil, err
		}
		if len(document.Nodes) > 1000 {
			return nil, kernel.BadAuthRequest("当前画布节点过多，请缩小范围")
		}
		for _, node := range document.Nodes {
			nodeKind, _ := node["type"].(string)
			title, _ := node["title"].(string)
			nodeID, _ := node["id"].(string)
			if (nodeKind != "image" && nodeKind != "video" && nodeKind != "audio") || (kind != "" && nodeKind != kind) || !strings.Contains(strings.ToLower(title), strings.ToLower(query)) {
				continue
			}
			raw, _ := json.Marshal(node)
			resources, err := ReferencedMediaResourceIDs(raw)
			if err != nil {
				return nil, err
			}
			if len(resources) == 0 || nodeID == "" {
				continue
			}
			for _, id := range resources {
				if _, err := ownedReadyResource(userID, id); err != nil {
					return nil, err
				}
			}
			items = append(items, map[string]any{"nodeId": nodeID, "title": title, "kind": nodeKind, "resourceIds": resources})
		}
		result["total"], result["hasMore"] = int64(len(items)), page*size < len(items)
		start := (page - 1) * size
		if start >= len(items) {
			items = []any{}
		} else {
			end := start + size
			if end > len(items) {
				end = len(items)
			}
			items = items[start:end]
		}
	}
	result["items"] = items
	return result, nil
}

func registerProjectSearchOps(r *Registry) {
	for _, target := range []string{"media", "canvas"} {
		kind := target
		r.Register(Op{AssistantCanvas: true, ID: "project." + kind + ".search", Summary: "在当前项目查找媒体或画布", ReadOnly: true, Scope: ScopeCanvas,
			Params: json.RawMessage(`{"type":"object","properties":{"canvasId":{"type":"string"},"query":{"type":"string"},"kind":{"type":"string","enum":["image","video","audio"]},"page":{"type":"integer"},"pageSize":{"type":"integer"}},"required":["canvasId"]}`),
			Handler: func(ctx *Context, raw json.RawMessage) (any, error) {
				var args struct {
					CanvasID string `json:"canvasId"`
					Query    string `json:"query"`
					Kind     string `json:"kind"`
					Page     int    `json:"page"`
					PageSize int    `json:"pageSize"`
				}
				if err := decodeParams(raw, &args); err != nil {
					return nil, err
				}
				if args.CanvasID == "" || len(args.Query) > 256 || args.Page < 0 || args.Page > 10000 || args.PageSize < 0 || args.PageSize > 20 {
					return nil, InvalidArg("invalid_project_search", "搜索需要当前画布、有效页码，每页最多20条")
				}
				if args.Kind != "" && args.Kind != "image" && args.Kind != "video" && args.Kind != "audio" {
					return nil, InvalidArg("invalid_media_kind", "媒体类型无效")
				}
				if kind == "canvas" && args.Kind != "" {
					return nil, InvalidArg("unexpected_media_kind", "画布搜索不接收媒体类型")
				}
				port, ok := ctx.Domain.(ProjectSearch)
				if !ok {
					return nil, Unsupported("project_search_unavailable", "当前工作区无法搜索项目")
				}
				page, size := args.Page, args.PageSize
				if page == 0 {
					page = 1
				}
				if size == 0 {
					size = 20
				}
				result, err := port.SearchAgentProject(ctx.UserID, args.CanvasID, kind, args.Query, args.Kind, page, size)
				return sanitizeForClient(result), mapDomainError(err)
			}})
	}
}
