package skills

import (
	"context"

	"qisitv/backend/internal/kernel"
	"qisitv/backend/internal/skillhub"
)

func (s *Service) MarketSearch(ctx context.Context, query string, page, pageSize int) (*skillhub.SearchResult, error) {
	if page < 1 {
		page = 1
	}
	if pageSize < 1 {
		pageSize = 20
	}
	builtins := s.matchingBuiltinMarketReleases(query)
	client, err := marketClient()
	if err != nil {
		return nil, err
	}
	result, err := client.Search(ctx, query, "beeftv", []string{"beeftv.canvas"}, page, pageSize)
	if len(builtins) == 0 {
		return result, err
	}
	builtinBySkillID := make(map[string]bool, len(builtins))
	builtinItems := make([]skillhub.SearchItem, 0, len(builtins))
	for _, rel := range builtins {
		builtinBySkillID[rel.SkillID] = true
		builtinItems = append(builtinItems, builtinReleaseToSearchItem(rel))
	}
	if err != nil {
		if page == 1 {
			return &skillhub.SearchResult{Items: builtinItems, Total: len(builtinItems), Page: page, PageSize: pageSize, Target: "beeftv"}, nil
		}
		return nil, err
	}
	filteredRemote := make([]skillhub.SearchItem, 0, len(result.Items))
	removedCount := 0
	for _, item := range result.Items {
		if builtinBySkillID[item.SkillID] {
			removedCount++
			continue
		}
		filteredRemote = append(filteredRemote, item)
	}
	if page == 1 {
		combined := make([]skillhub.SearchItem, 0, len(builtinItems)+len(filteredRemote))
		combined = append(combined, builtinItems...)
		combined = append(combined, filteredRemote...)
		if len(combined) > pageSize {
			combined = combined[:pageSize]
		}
		result.Items = combined
	} else {
		result.Items = filteredRemote
	}
	result.Total = result.Total - removedCount + len(builtinItems)
	return result, nil
}

func (s *Service) MarketFile(ctx context.Context, id, release, name string, offset, limit int) (*skillhub.FileChunk, error) {
	if rel, ver, ok := s.findBuiltinMarketRelease(id, release); ok {
		return s.readBuiltinMarketFile(rel, ver, name, offset, limit)
	}
	client, err := marketClient()
	if err != nil {
		return nil, err
	}
	return client.File(ctx, id, release, name, offset, limit)
}

func checkMarketRequirements(requirements []string) error {
	for _, required := range requirements {
		if required != "beeftv.canvas" && required != "model.image" && required != "model.video" && required != "model.audio" {
			return kernel.BadAuthRequest("当前工作区尚未验证技能要求的能力：" + required)
		}
	}
	return nil
}
