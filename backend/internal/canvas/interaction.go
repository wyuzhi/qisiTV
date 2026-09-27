package canvas

import (
	"encoding/json"
	"time"
)

const CanvasInteractionTTL = 30 * time.Second

type CanvasViewport struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
	K float64 `json:"k"`
}
type CanvasInteraction struct {
	CanvasID        string         `json:"canvasId"`
	TabID           string         `json:"tabId"`
	SelectedNodeIDs []string       `json:"selectedNodeIds"`
	Viewport        CanvasViewport `json:"viewport"`
	IsActive        bool           `json:"isActive"`
	UpdatedAt       time.Time      `json:"updatedAt"`
	ExpiresAt       time.Time      `json:"expiresAt"`
	LastActiveAt    time.Time      `json:"lastActiveAt"`
}

// Interaction is ephemeral UI presence, scoped by user and tab. It does not
// mutate the document/revision and disappears on shutdown or heartbeat expiry.
func (s *Service) PutCanvasInteraction(userID, canvasID string, value CanvasInteraction) (*CanvasInteraction, error) {
	if _, err := s.scopedCanvasHistoryProject(userID, canvasID); err != nil {
		return nil, err
	}
	if !validControlID(value.TabID) || len(value.SelectedNodeIDs) > 1000 {
		return nil, controlError("tabId 或选择数量无效")
	}
	if !controlNumber(value.Viewport.X, -1e7, 1e7) || !controlNumber(value.Viewport.Y, -1e7, 1e7) || !controlNumber(value.Viewport.K, 0.01, 100) {
		return nil, controlError("viewport 必须包含有效的 x/y/k")
	}
	raw, err := s.UserCanvasProject(userID, canvasID)
	if err != nil {
		return nil, err
	}
	var document struct {
		Nodes []struct {
			ID string `json:"id"`
		} `json:"nodes"`
	}
	if err = json.Unmarshal(raw, &document); err != nil {
		return nil, err
	}
	ids := map[string]bool{}
	for _, node := range document.Nodes {
		ids[node.ID] = true
	}
	selected := []string{}
	seen := map[string]bool{}
	for _, id := range value.SelectedNodeIDs {
		if !ids[id] {
			return nil, controlError("选择的节点不存在")
		}
		if !seen[id] {
			selected = append(selected, id)
			seen[id] = true
		}
	}
	now := time.Now().UTC()
	value.CanvasID, value.SelectedNodeIDs, value.UpdatedAt, value.ExpiresAt = canvasID, selected, now, now.Add(CanvasInteractionTTL)
	s.interactionMu.Lock()
	defer s.interactionMu.Unlock()
	s.expireInteractions(now)
	previous := s.interactions[userID+"\x00"+value.TabID]
	value.LastActiveAt = previous.LastActiveAt
	if value.IsActive {
		value.LastActiveAt = now
	}
	s.interactions[userID+"\x00"+value.TabID] = value
	result := value
	result.SelectedNodeIDs = append([]string{}, value.SelectedNodeIDs...)
	return &result, nil
}

func (s *Service) GetCanvasInteraction(userID, canvasID, tabID string) (*CanvasInteraction, error) {
	if canvasID != "" {
		if _, err := s.scopedCanvasHistoryProject(userID, canvasID); err != nil {
			return nil, err
		}
	}
	s.interactionMu.Lock()
	defer s.interactionMu.Unlock()
	s.expireInteractions(time.Now())
	var latest *CanvasInteraction
	for key, value := range s.interactions {
		if key != userID+"\x00"+value.TabID || (canvasID != "" && value.CanvasID != canvasID) || (tabID != "" && value.TabID != tabID) {
			continue
		}
		if tabID == "" && value.LastActiveAt.IsZero() {
			continue
		}
		if latest == nil || (value.IsActive && !latest.IsActive) || (value.IsActive == latest.IsActive && value.LastActiveAt.After(latest.LastActiveAt)) {
			copy := value
			copy.SelectedNodeIDs = append([]string{}, value.SelectedNodeIDs...)
			latest = &copy
		}
	}
	if latest != nil {
		raw, err := s.UserCanvasProject(userID, latest.CanvasID)
		if err != nil {
			delete(s.interactions, userID+"\x00"+latest.TabID)
			return nil, nil
		}
		var document struct {
			Nodes []struct {
				ID string `json:"id"`
			} `json:"nodes"`
		}
		if err = json.Unmarshal(raw, &document); err != nil {
			return nil, err
		}
		ids := map[string]bool{}
		for _, node := range document.Nodes {
			ids[node.ID] = true
		}
		kept := []string{}
		for _, id := range latest.SelectedNodeIDs {
			if ids[id] {
				kept = append(kept, id)
			}
		}
		latest.SelectedNodeIDs = kept
	}
	return latest, nil
}

func (s *Service) expireInteractions(now time.Time) {
	for key, value := range s.interactions {
		if !value.ExpiresAt.After(now) {
			delete(s.interactions, key)
		}
	}
}
