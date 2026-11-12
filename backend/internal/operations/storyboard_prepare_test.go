package operations

import (
	"encoding/json"
	"strings"
	"testing"
)

// 草稿标题由调用方传入模板，{n} 在领域层替换为镜号；模板不能混进生成参数。
func TestOpStoryboardPrepareForwardsTitleTemplates(t *testing.T) {
	probe := &prepareProbe{configureProbe: configureFixture(t, "image")}
	_, err := opStoryboardPrepare(&Context{UserID: "owner", Domain: probe},
		json.RawMessage(`{"canvasId":"c1","nodeId":"n","expectedRevision":4,"rowIds":["shot-1"],
			"image":{"model":"chosen","title":"镜 {n} 首帧"},
			"video":{"model":"chosen","generateAudio":"true","title":"镜 {n} 视频"}}`))
	if err != nil {
		t.Fatal(err)
	}
	if !probe.prepared || probe.input.ImageTitle != "镜 {n} 首帧" || probe.input.VideoTitle != "镜 {n} 视频" {
		t.Fatalf("title templates = %#v", probe.input)
	}
	for kind, patch := range map[string]map[string]any{"image": probe.input.Image, "video": probe.input.Video} {
		if _, exists := patch["title"]; exists {
			t.Fatalf("%s 生成参数不应保留 title: %#v", kind, patch)
		}
	}
}

// 不含 {n}、null、超过 40 字的模板都在入口拒绝，与 schema 一致。
func TestOpStoryboardPrepareRejectsInvalidTitleTemplates(t *testing.T) {
	for _, title := range []string{`"镜 首帧"`, `"镜头 {N} 首帧"`, `null`, `"` + strings.Repeat("镜", 38) + `{n}"`} {
		probe := &prepareProbe{configureProbe: configureFixture(t, "image")}
		_, err := opStoryboardPrepare(&Context{UserID: "owner", Domain: probe},
			json.RawMessage(`{"canvasId":"c1","nodeId":"n","expectedRevision":4,"rowIds":["shot-1"],
				"image":{"model":"chosen","title":`+title+`}}`))
		if err == nil || AsError(err).Reason != "invalid_parameter" {
			t.Fatalf("无效模板应被拒绝: %s -> %v", title, err)
		}
		if probe.prepared {
			t.Fatalf("拒绝后不应创建草稿: %q", title)
		}
	}
}

func TestOpStoryboardPrepareTreatsBlankTitleAsOmitted(t *testing.T) {
	probe := &prepareProbe{configureProbe: configureFixture(t, "image")}
	_, err := opStoryboardPrepare(&Context{UserID: "owner", Domain: probe},
		json.RawMessage(`{"canvasId":"c1","nodeId":"n","expectedRevision":4,"rowIds":["shot-1"],
			"image":{"model":"chosen","title":"   "}}`))
	if err != nil {
		t.Fatal(err)
	}
	if probe.input.ImageTitle != "" {
		t.Fatalf("空白模板应等同省略: %#v", probe.input)
	}
}
