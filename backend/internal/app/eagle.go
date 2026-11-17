package app

import "infinite-canvas/backend/internal/eagle"

type EagleFolder = eagle.Folder
type EagleLibrary = eagle.Library
type EagleItem = eagle.Item
type EagleItemQuery = eagle.ItemQuery
type EagleAddItemRequest = eagle.AddItemRequest
type EagleCreatedItem = eagle.CreatedItem
type EagleFile = eagle.File

func (s *Service) eagleClient() *eagle.Client {
	return eagle.New()
}

func (s *Service) EagleLibrary(rawBaseURL string) (*EagleLibrary, error) {
	return s.eagleClient().Library(rawBaseURL)
}
