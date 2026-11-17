package app

import (
	"errors"

	"infinite-canvas/backend/internal/model"
)

// ResourceForUser 是 Provider worker 读取资源时必须经过的 service 层归属校验。
func (s *Service) ResourceForUser(actor *model.User, id string) (*model.Resource, error) {
	if actor == nil || actor.ID == "" {
		return nil, errors.New("用户身份无效")
	}
	return s.repo.ResourceForUser(actor.ID, id)
}
