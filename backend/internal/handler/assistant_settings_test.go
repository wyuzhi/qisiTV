package handler

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"infinite-canvas/backend/internal/agentops"
)

func readAssistantSkillScriptAutoRun(t *testing.T, env *assistantTestEnv) bool {
	t.Helper()
	res := env.call(t, http.MethodGet, "/assistant/settings", "")
	if res.Code != http.StatusOK {
		t.Fatalf("GET /assistant/settings returned %d: %s", res.Code, res.Body.String())
	}
	var envelope struct {
		Code int `json:"code"`
		Data struct {
			SkillScriptAutoRun bool `json:"skillScriptAutoRun"`
		} `json:"data"`
	}
	if err := json.Unmarshal(res.Body.Bytes(), &envelope); err != nil || envelope.Code != 0 {
		t.Fatalf("invalid settings response: %s err=%v", res.Body.String(), err)
	}
	return envelope.Data.SkillScriptAutoRun
}

func TestAssistantSkillScriptAutoRunSettingRoundTrip(t *testing.T) {
	env := newAssistantTestEnv(t, nil)

	if readAssistantSkillScriptAutoRun(t, env) {
		t.Fatal("expected auto-run setting to default to off")
	}
	res := env.call(t, http.MethodPatch, "/assistant/settings", `{"skillScriptAutoRun":true}`)
	if res.Code != http.StatusOK {
		t.Fatalf("PATCH /assistant/settings returned %d: %s", res.Code, res.Body.String())
	}
	if !readAssistantSkillScriptAutoRun(t, env) {
		t.Fatal("expected auto-run setting to stay on after update")
	}

	bad := env.call(t, http.MethodPatch, "/assistant/settings", `{}`)
	if bad.Code != http.StatusBadRequest {
		t.Fatalf("expected missing field to be rejected, got %d: %s", bad.Code, bad.Body.String())
	}
}

// 自动运行设置跳过脚本确认，写入必须和助手入口一样要求可信界面身份，
// 不能让无凭据请求或只读客户端直接打开。
func TestAssistantSettingsWriteRejectsUntrustedCallers(t *testing.T) {
	env := newAssistantTestEnv(t, nil)

	unauthenticated := env.callWithHeaders(t, http.MethodPatch, "/assistant/settings", `{"skillScriptAutoRun":true}`, map[string]string{})
	if unauthenticated.Code != http.StatusForbidden || !strings.Contains(unauthenticated.Body.String(), "unauthenticated") {
		t.Fatalf("unauthenticated write should be rejected, got %d: %s", unauthenticated.Code, unauthenticated.Body.String())
	}

	registration, token, err := env.clients.Register("只读测试客户端", agentops.ClientReadOnly)
	if err != nil {
		t.Fatal(err)
	}
	readOnly := env.callWithHeaders(t, http.MethodPatch, "/assistant/settings", `{"skillScriptAutoRun":true}`, map[string]string{
		"X-Beeftv-Client": registration.ID,
		"Authorization":   "Bearer " + token,
	})
	if readOnly.Code != http.StatusForbidden || !strings.Contains(readOnly.Body.String(), "read_only_client") {
		t.Fatalf("read-only client write should be rejected, got %d: %s", readOnly.Code, readOnly.Body.String())
	}

	if readAssistantSkillScriptAutoRun(t, env) {
		t.Fatal("rejected writes must not persist the auto-run setting")
	}
}
