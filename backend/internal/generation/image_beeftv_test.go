package generation

import (
	"encoding/json"
	"infinite-canvas/backend/internal/providerpreset"
	"net/http"
	"testing"
)

type captureImagePort struct {
	calls             int
	path, contentType string
	body              map[string]interface{}
}

func (p *captureImagePort) Intercept(req *http.Request) (bool, []byte, string, error) {
	p.calls++
	p.path, p.contentType = req.URL.Path, req.Header.Get("Content-Type")
	if err := json.NewDecoder(req.Body).Decode(&p.body); err != nil {
		return true, nil, "", err
	}
	return true, []byte(`{"data":[{"b64_json":"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR1sAAAAASUVORK5CYII="}]}`), "application/json", nil
}

func TestBeefAPIHyImageRatioSizesMeetGatewayLimits(t *testing.T) {
	contract, _ := providerpreset.BeefAPIImageContract("hy-image-v3")
	for ratio, want := range contract.Sizes {
		if size, err := contract.PixelSize(ratio); err != nil || size != want {
			t.Fatalf("%s: size=%s err=%v", ratio, size, err)
		}
	}
}
