package model

import "testing"

func TestUpscaleIdentityComesFromOperationOrFrozenInput(t *testing.T) {
	for _, task := range []Task{{Model: "opaque", Operation: "media.upscale.topaz"}, {Model: "opaque", InputJSON: `{"mode":"image","upscale":{"factor":2}}`}} {
		if !task.IsUpscale() {
			t.Fatalf("upscale intent lost: %+v", task)
		}
	}
	for _, raw := range []string{"", "invalid JSON", `{"upscale":null}`, `{"upscale":[]}`, `{}`} {
		if (Task{Model: "topaz-standard-v2", InputJSON: raw}).IsUpscale() {
			t.Fatalf("model name or invalid input treated as upscale: %s", raw)
		}
	}
}
