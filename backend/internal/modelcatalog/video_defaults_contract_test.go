package modelcatalog

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"testing"
)

// 视频能力默认值同时写在 Go 和前端，靠 fixtures/video-capability-defaults.json 对齐：
// 任何一侧改了默认值，这里和前端的同名测试都会红，避免设置页和任务创建各说一套。
func TestVideoCapabilityDefaultsMatchSharedFixture(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "fixtures", "video-capability-defaults.json"))
	if err != nil {
		t.Fatalf("读取共享契约夹具失败：%v", err)
	}
	var cases []struct {
		Protocol string         `json:"protocol"`
		Model    string         `json:"model"`
		Config   map[string]any `json:"config"`
	}
	if err := json.Unmarshal(raw, &cases); err != nil {
		t.Fatalf("解析共享契约夹具失败：%v", err)
	}
	for _, item := range cases {
		actual, err := json.Marshal(defaultVideoCapabilityConfig(item.Protocol, item.Model))
		if err != nil {
			t.Fatalf("%s/%s 序列化失败：%v", item.Protocol, item.Model, err)
		}
		var actualMap map[string]any
		if err := json.Unmarshal(actual, &actualMap); err != nil {
			t.Fatalf("%s/%s 解析失败：%v", item.Protocol, item.Model, err)
		}
		assertFixtureSubset(t, item.Protocol+"/"+item.Model, item.Config, actualMap)
	}
}

// assertFixtureSubset 只比对夹具里写出来的字段：Go 侧多出来的字段（如 promptMaxUtf16Units）不参与比较，
// 但夹具里的每个值都必须一致。
func assertFixtureSubset(t *testing.T, label string, expected any, actual any) {
	t.Helper()
	switch want := expected.(type) {
	case map[string]any:
		got, ok := actual.(map[string]any)
		if !ok {
			t.Fatalf("%s: 期望对象，实际 %T", label, actual)
		}
		for key, value := range want {
			actualValue, exists := got[key]
			if !exists {
				t.Fatalf("%s: 缺少字段 %s", label, key)
			}
			assertFixtureSubset(t, label+"."+key, value, actualValue)
		}
	case []any:
		got, ok := actual.([]any)
		if !ok || len(got) != len(want) {
			t.Fatalf("%s: 期望 %v，实际 %v", label, want, actual)
		}
		for index := range want {
			assertFixtureSubset(t, label+"["+strconv.Itoa(index)+"]", want[index], got[index])
		}
	default:
		if want != actual {
			t.Fatalf("%s: 期望 %v，实际 %v", label, want, actual)
		}
	}
}
