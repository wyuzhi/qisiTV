package asset

import (
	"mime/multipart"
	"testing"

	"qisitv/backend/internal/model"
)

type fakeBackend struct{ resources []model.Resource }

func (f fakeBackend) Resources(string, int) ([]model.Resource, error) { return f.resources, nil }
func (f fakeBackend) UploadLocalResource(string, *multipart.FileHeader, string, int, int, int64, ...string) (*model.Resource, error) {
	return nil, nil
}

func TestServiceRejectsCloudAndMissingReadyAssets(t *testing.T) {
	root := t.TempDir()
	tests := []model.Resource{
		{ID: "cloud", Provider: "s3", Status: model.ResourceStatusReady, ObjectKey: "cloud.png"},
		{ID: "missing", Provider: "local", Status: model.ResourceStatusReady, ObjectKey: "missing.png"},
	}
	for _, resource := range tests {
		service := New(fakeBackend{resources: []model.Resource{resource}}, root)
		if _, err := service.Resources("local", 10); err == nil {
			t.Fatalf("resource %s was accepted by the local asset boundary", resource.ID)
		}
	}
}
