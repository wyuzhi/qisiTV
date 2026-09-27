package mcp

import (
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
)

// Session is an in-process MCP client/server pair. Every public method is a
// real JSON-RPC round trip so Agent media calls cannot skip the protocol.
type Session struct {
	mu          sync.Mutex
	tools       map[string]Tool
	order       []string
	initialized bool
	nextID      atomic.Int64
}

func NewSession() *Session {
	return &Session{tools: map[string]Tool{}}
}

func (s *Session) Register(tool Tool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, exists := s.tools[tool.Name]; !exists {
		s.order = append(s.order, tool.Name)
	}
	s.tools[tool.Name] = tool
}

func (s *Session) Handle(raw []byte) []byte {
	var req Request
	if err := json.Unmarshal(raw, &req); err != nil {
		return marshalResponse(Response{JSONRPC: "2.0", Error: &Error{Code: -32700, Message: "parse error"}})
	}
	resp := s.dispatch(req)
	return marshalResponse(resp)
}

func (s *Session) dispatch(req Request) Response {
	resp := Response{JSONRPC: "2.0", ID: req.ID}
	switch req.Method {
	case "initialize":
		s.mu.Lock()
		s.initialized = true
		s.mu.Unlock()
		resp.Result = map[string]any{
			"protocolVersion": ProtocolVersion,
			"serverInfo":      map[string]any{"name": "qisitv-enterprise", "version": "1"},
			"capabilities":    map[string]any{"tools": map[string]any{}},
		}
	case "notifications/initialized":
		resp.Result = map[string]any{}
	case "tools/list":
		if err := s.requireInitialized(); err != nil {
			resp.Error = &Error{Code: -32000, Message: err.Error()}
			return resp
		}
		s.mu.Lock()
		tools := make([]map[string]any, 0, len(s.order))
		for _, name := range s.order {
			tool := s.tools[name]
			tools = append(tools, map[string]any{"name": tool.Name, "description": tool.Description, "inputSchema": tool.InputSchema})
		}
		s.mu.Unlock()
		resp.Result = map[string]any{"tools": tools}
	case "tools/call":
		if err := s.requireInitialized(); err != nil {
			resp.Error = &Error{Code: -32000, Message: err.Error()}
			return resp
		}
		var params CallParams
		if len(req.Params) > 0 {
			if err := json.Unmarshal(req.Params, &params); err != nil {
				resp.Error = &Error{Code: -32602, Message: "invalid params"}
				return resp
			}
		}
		s.mu.Lock()
		tool, ok := s.tools[params.Name]
		s.mu.Unlock()
		if !ok {
			resp.Result = errorResult("unknown tool")
			return resp
		}
		result, err := tool.Handle(params.Arguments)
		if err != nil {
			resp.Result = errorResult(err.Error())
			return resp
		}
		if typed, ok := result.(ToolResult); ok {
			resp.Result = typed
		} else {
			resp.Result = textResult(result)
		}
	default:
		resp.Error = &Error{Code: -32601, Message: "method not found"}
	}
	return resp
}

func (s *Session) requireInitialized() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.initialized {
		return errors.New("mcp session is not initialized")
	}
	return nil
}

func (s *Session) Initialize() (map[string]any, error) {
	var result map[string]any
	if err := s.call("initialize", map[string]any{"protocolVersion": ProtocolVersion, "capabilities": map[string]any{}, "clientInfo": map[string]any{"name": "qisitv-agent", "version": "1"}}, &result); err != nil {
		return nil, err
	}
	_, _ = s.notify("notifications/initialized", map[string]any{})
	return result, nil
}

func (s *Session) ListTools() ([]map[string]any, error) {
	var payload struct {
		Tools []map[string]any `json:"tools"`
	}
	if err := s.call("tools/list", nil, &payload); err != nil {
		return nil, err
	}
	return payload.Tools, nil
}

func (s *Session) CallTool(name string, arguments any) (ToolResult, error) {
	raw, err := json.Marshal(arguments)
	if err != nil {
		return ToolResult{}, err
	}
	var result ToolResult
	if err := s.call("tools/call", CallParams{Name: name, Arguments: raw}, &result); err != nil {
		return ToolResult{}, err
	}
	return result, nil
}

func (s *Session) call(method string, params any, result any) error {
	var rawParams json.RawMessage
	if params != nil {
		body, err := json.Marshal(params)
		if err != nil {
			return err
		}
		rawParams = body
	}
	req := Request{JSONRPC: "2.0", ID: s.nextID.Add(1), Method: method, Params: rawParams}
	reqBody, err := json.Marshal(req)
	if err != nil {
		return err
	}
	var resp Response
	if err := json.Unmarshal(s.Handle(reqBody), &resp); err != nil {
		return err
	}
	if resp.Error != nil {
		return fmt.Errorf("%s", resp.Error.Message)
	}
	if result == nil {
		return nil
	}
	body, err := json.Marshal(resp.Result)
	if err != nil {
		return err
	}
	return json.Unmarshal(body, result)
}

func (s *Session) notify(method string, params any) (Response, error) {
	raw, _ := json.Marshal(params)
	req := Request{JSONRPC: "2.0", Method: method, Params: raw}
	body, _ := json.Marshal(req)
	var resp Response
	if err := json.Unmarshal(s.Handle(body), &resp); err != nil {
		return Response{}, err
	}
	return resp, nil
}

func marshalResponse(resp Response) []byte {
	if resp.JSONRPC == "" {
		resp.JSONRPC = "2.0"
	}
	body, _ := json.Marshal(resp)
	return body
}
