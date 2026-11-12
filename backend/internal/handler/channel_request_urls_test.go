package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"qisitv/backend/internal/app"
	"qisitv/backend/internal/model"
	"qisitv/backend/internal/modelcatalog"

	"github.com/gin-gonic/gin"
)

type requestURLCatalogs struct{}

func (requestURLCatalogs) WorkspaceOwner(string) (*model.User, error) {
	return &model.User{ID: "owner"}, nil
}
func (requestURLCatalogs) LocalWorkspaceOwner() (*model.User, error) {
	return &model.User{ID: "owner"}, nil
}
func (requestURLCatalogs) RequireFeature(string) error { return nil }
func (requestURLCatalogs) FetchChannelModelCatalog(context.Context, *model.User, app.ChannelModelsRequest) ([]modelcatalog.ChannelModelCatalogItem, error) {
	return nil, nil
}

func postRequestURLs(t *testing.T, body string) (catalog string, text map[string]string) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	router := gin.New()
	RegisterChannelModelRoutes(router.Group("/api"), requestURLCatalogs{})
	response := httptest.NewRecorder()
	router.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/api/ai/request-urls", strings.NewReader(body)))
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	var envelope struct {
		Code int `json:"code"`
		Data struct {
			Catalog string            `json:"catalog"`
			Text    map[string]string `json:"text"`
		} `json:"data"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &envelope); err != nil || envelope.Code != 0 {
		t.Fatalf("envelope = %s, err = %v", response.Body.String(), err)
	}
	return envelope.Data.Catalog, envelope.Data.Text
}

// 设置页显示的地址必须就是后端读取目录和发文本任务时请求的地址，版本前缀不能被改写。
func TestChannelRequestURLsMatchBackendRequests(t *testing.T) {
	for _, base := range []string{"https://cheeser.link/api-service/likeai", "https://task.likeai.pro/task-api"} {
		catalog, _ := postRequestURLs(t, `{"baseUrl":"`+base+`","apiFormat":"likeai"}`)
		if catalog != base+"/task/models" {
			t.Fatalf("LikeAI catalog = %s", catalog)
		}
	}
	catalog, text := postRequestURLs(t, `{"baseUrl":"https://gateway.example.com/api/v3/","apiFormat":"openai","protocols":["chat-completion","openai-response","anthropic-messages","","not-installed"]}`)
	if catalog != "https://gateway.example.com/api/v3/models" {
		t.Fatalf("catalog = %q", catalog)
	}
	// 旧 ID、别名和留空按文本任务同一套规则落到宿主的接口格式；认不出的不给地址。
	want := map[string]string{
		"chat-completion":    "https://gateway.example.com/api/v3/chat/completions",
		"openai-response":    "https://gateway.example.com/api/v3/responses",
		"anthropic-messages": "https://gateway.example.com/api/v3/messages",
		"":                   "https://gateway.example.com/api/v3/chat/completions",
	}
	if len(text) != len(want) {
		t.Fatalf("text = %v, want %v", text, want)
	}
	for protocol, url := range want {
		if text[protocol] != url {
			t.Fatalf("%q = %q, want %q", protocol, text[protocol], url)
		}
	}

	_, bare := postRequestURLs(t, `{"baseUrl":"https://gateway.example.com","apiFormat":"openai","protocols":["chat-completion"]}`)
	if bare["chat-completion"] != "https://gateway.example.com/v1/chat/completions" {
		t.Fatalf("bare host chat = %q", bare["chat-completion"])
	}

	// 目录地址和真正读取目录一样先去掉结尾斜杠；Gemini 渠道里显式写了接口格式的文本模型照常给地址。
	geminiCatalog, geminiText := postRequestURLs(t, `{"baseUrl":"https://gateway.example.com/v1beta/","apiFormat":"gemini","protocols":["","chat-completion"]}`)
	if geminiCatalog != "https://gateway.example.com/v1beta/models" {
		t.Fatalf("gemini catalog = %q", geminiCatalog)
	}
	if len(geminiText) != 1 || geminiText["chat-completion"] != "https://gateway.example.com/v1beta/chat/completions" {
		t.Fatalf("gemini text = %v", geminiText)
	}

	emptyCatalog, emptyText := postRequestURLs(t, `{"baseUrl":"  ","apiFormat":"openai","protocols":["chat-completion"]}`)
	if emptyCatalog != "" || len(emptyText) != 0 {
		t.Fatalf("empty base catalog = %q, text = %v", emptyCatalog, emptyText)
	}
}
