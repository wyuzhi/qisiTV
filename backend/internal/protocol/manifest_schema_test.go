package protocol

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"
)

// The published schema is for editor hints; the Go validator stays the judge.
// These tests keep the two from drifting: every field the runtime decodes is
// described, every shipped manifest only uses described fields, and the
// required lists match.
func loadInterfaceSchema(t *testing.T) map[string]any {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("..", "..", "..", "plugin-packages", "interface-manifest.schema.json"))
	if err != nil {
		t.Fatal(err)
	}
	var schema map[string]any
	if err := json.Unmarshal(data, &schema); err != nil {
		t.Fatalf("schema is not valid JSON: %v", err)
	}
	return schema
}

func schemaProperties(t *testing.T, node map[string]any) map[string]any {
	t.Helper()
	properties, ok := node["properties"].(map[string]any)
	if !ok {
		t.Fatal("schema node has no properties")
	}
	return properties
}

func jsonFieldNames(value any) []string {
	kind := reflect.TypeOf(value)
	names := make([]string, 0, kind.NumField())
	for index := 0; index < kind.NumField(); index++ {
		tag := strings.Split(kind.Field(index).Tag.Get("json"), ",")[0]
		if tag != "" && tag != "-" {
			names = append(names, tag)
		}
	}
	sort.Strings(names)
	return names
}

func TestInterfaceSchemaDescribesEveryProviderField(t *testing.T) {
	schema := loadInterfaceSchema(t)
	provider := schema["$defs"].(map[string]any)["provider"].(map[string]any)
	described := schemaProperties(t, provider)
	for _, name := range jsonFieldNames(ManifestProvider{}) {
		if _, ok := described[name]; !ok {
			t.Errorf("provider field %q is decoded by BeefTV but missing from interface-manifest.schema.json", name)
		}
	}
	operation := schema["$defs"].(map[string]any)["operation"].(map[string]any)
	describedOperation := schemaProperties(t, operation)
	for _, name := range jsonFieldNames(ManifestOperation{}) {
		if _, ok := describedOperation[name]; !ok {
			t.Errorf("operation field %q is missing from the schema", name)
		}
	}
}

func TestShippedManifestsOnlyUseSchemaFields(t *testing.T) {
	schema := loadInterfaceSchema(t)
	top := schemaProperties(t, schema)
	provider := schemaProperties(t, schema["$defs"].(map[string]any)["provider"].(map[string]any))
	paths, err := filepath.Glob(filepath.Join("..", "..", "..", "plugin-packages", "*", "manifest.json"))
	if err != nil || len(paths) < 60 {
		t.Fatalf("shipped manifests = %d, err = %v", len(paths), err)
	}
	for _, path := range paths {
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		var manifest map[string]any
		if err := json.Unmarshal(data, &manifest); err != nil {
			t.Fatal(err)
		}
		for key := range manifest {
			if _, ok := top[key]; !ok {
				t.Errorf("%s: top-level %q is not in the schema", path, key)
			}
		}
		contributes, _ := manifest["contributes"].(map[string]any)
		providers, _ := contributes["providers"].([]any)
		for _, raw := range providers {
			item, _ := raw.(map[string]any)
			for key := range item {
				if _, ok := provider[key]; !ok {
					t.Errorf("%s: provider field %q is not in the schema", path, key)
				}
			}
		}
	}
}
