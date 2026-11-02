package generation

import (
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
)

func TestFrozenImageDispatchDoesNotFollowPostRedirect(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	var forwarded atomic.Int32
	destination := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { forwarded.Add(1); w.Write([]byte(`{"data":[]}`)) }))
	defer destination.Close()
	source := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, destination.URL+"/v1/images/generations", http.StatusTemporaryRedirect)
	}))
	defer source.Close()
	req, _ := http.NewRequest(http.MethodPost, source.URL+"/v1/images/generations", nil)
	req.Header.Set("Idempotency-Key", "original-key")
	_, _, err := DoBinaryWithDispatchAdmission(req, func() error { return nil })
	if err == nil || forwarded.Load() != 0 {
		t.Fatalf("冻结 POST 被转发到未经核实的渠道: forwarded=%d err=%v", forwarded.Load(), err)
	}
}
