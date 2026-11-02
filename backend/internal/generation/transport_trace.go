package generation

import (
	"qisitv/backend/internal/outbound"
	"net/http"
)

type transportTrace struct{ outbound.TransportTrace }

func (t *transportTrace) attach(req *http.Request) *http.Request { return t.Attach(req) }
func (t *transportTrace) result(err error) (bool, string)        { return t.Result(err) }
