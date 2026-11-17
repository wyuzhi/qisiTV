package app

import (
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/outbound"
	localtask "infinite-canvas/backend/internal/task"
)

type deliveryProgressRegistry struct {
	localtask.DeliveryProgressRegistry
}

func (s *Service) deliveryProgressRegistry() *deliveryProgressRegistry {
	s.deliveryProgressOnce.Do(func() {
		s.deliveryProgress = &deliveryProgressRegistry{}
	})
	return s.deliveryProgress
}

func (r *deliveryProgressRegistry) record(identity string, progress model.TaskDeliveryOutputProgress) {
	if r != nil {
		r.Record(identity, progress)
	}
}

func (r *deliveryProgressRegistry) clear(identity string) {
	if r != nil {
		r.Clear(identity)
	}
}

func (r *deliveryProgressRegistry) forTask(taskID string) *model.TaskDeliveryProgress {
	if r == nil {
		return nil
	}
	return r.ForTask(taskID)
}

func deliveryProgressFromOutbound(identity string, progress outbound.ResumableProgress) model.TaskDeliveryOutputProgress {
	return localtask.DeliveryProgressFromOutbound(identity, progress)
}
