package canvas

import (
	"encoding/json"
	"errors"
	"net/http"
	"reflect"
	"strings"
	"testing"

	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/writechange"
)

func TestStoryboardPromptEditClearsOnlyChangedTemplate(t *testing.T) {
	image, video := "new image", "same video"
	row := map[string]any{"imageGenerationPrompt": "old image", "videoMotionPrompt": video,
		"imagePromptTemplateVariables": map[string]any{"old": true}, "videoPromptTemplateVariables": map[string]any{"keep": true}}
	applyStoryboardRowDraft(row, StoryboardRowDraft{ImageGenerationPrompt: &image, VideoMotionPrompt: &video})
	if _, exists := row["imagePromptTemplateVariables"]; exists {
		t.Fatal("new prompt still overridden by old template")
	}
	if row["videoPromptTemplateVariables"] == nil {
		t.Fatal("unchanged prompt lost its template")
	}
}

func storyboardFixture(t *testing.T) (*Service, string, string, int64) {
	t.Helper()
	svc := newCanvasHistoryTestService(t)
	created, err := svc.UpsertUserCanvasProject("owner", json.RawMessage(`{
		"id":"canvas-story","revision":0,"title":"分镜",
		"nodes":[
			{"id":"script","type":"script","title":"剧本","metadata":{"storyboard":{"rows":[],"visibleColumns":["shotNumber","durationSeconds","videoMotionPrompt","dialogue","assets"],"referenceNodeIds":[]}}},
			{"id":"txt","type":"text","title":"文本","metadata":{"content":"正文"}}
		],"connections":[]}`))
	if err != nil {
		t.Fatal(err)
	}
	return svc, "canvas-story", "script", created.Revision
}

func storyboardRowsOf(t *testing.T, svc *Service, canvasID, nodeID string) []map[string]any {
	t.Helper()
	raw, err := svc.UserCanvasProject("owner", canvasID)
	if err != nil {
		t.Fatal(err)
	}
	var doc struct {
		Nodes []struct {
			ID       string `json:"id"`
			Metadata struct {
				Storyboard struct {
					Rows []map[string]any `json:"rows"`
				} `json:"storyboard"`
			} `json:"metadata"`
		} `json:"nodes"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	for _, node := range doc.Nodes {
		if node.ID == nodeID {
			return node.Metadata.Storyboard.Rows
		}
	}
	t.Fatalf("节点不存在: %s", nodeID)
	return nil
}

func strPtr(value string) *string { return &value }
func floatPtr(v float64) *float64 { return &v }

// 追加必须生成与界面 createStoryboardRow 同构的完整行：缺字段的行会让界面表格读到 undefined。
func TestAppendUserCanvasStoryboardRowsBuildsCompleteRow(t *testing.T) {
	svc, canvasID, nodeID, revision := storyboardFixture(t)

	summary, created, err := svc.AppendUserCanvasStoryboardRows("owner", canvasID, nodeID, []StoryboardRowDraft{{
		PlotDescription:   strPtr("夜巷，主角回头"),
		VideoMotionPrompt: strPtr("缓慢推进"),
		MustHave:          &[]string{"霓虹灯", "雨伞"},
	}}, revision)
	if err != nil {
		t.Fatal(err)
	}
	if summary.Revision != revision+1 {
		t.Fatalf("追加后 revision = %d", summary.Revision)
	}
	if len(created) != 1 || created[0].ShotNumber != 1 || created[0].ID == "" {
		t.Fatalf("created = %#v", created)
	}
	rows := storyboardRowsOf(t, svc, canvasID, nodeID)
	if len(rows) != 1 {
		t.Fatalf("行数 = %d", len(rows))
	}
	row := rows[0]
	// 覆盖给出的字段。
	if row["plotDescription"] != "夜巷，主角回头" || row["videoMotionPrompt"] != "缓慢推进" {
		t.Fatalf("写入字段 = %#v", row)
	}
	if mustHave, ok := row["mustHave"].([]any); !ok || len(mustHave) != 2 {
		t.Fatalf("mustHave = %#v", row["mustHave"])
	}
	// 未给出的字段必须是完整默认值，而不是缺失。
	for field, want := range map[string]any{
		"durationSeconds": float64(6), "dialogue": "", "characters": []any{},
		"narrativeIntent": "", "viewerPOV": "", "performanceBlocking": "", "shotSize": "",
		"emotion": "", "lightingAndAtmosphere": "", "audioEffects": "", "camera": "", "motion": "",
		"timeBeats": "", "imageGenerationPrompt": "", "optionalDetails": []any{},
		"continuityOut": "", "negativePrompt": "", "assetBindings": []any{}, "status": "idle",
	} {
		got, exists := row[field]
		if !exists {
			t.Fatalf("行缺少字段 %s: %#v", field, row)
		}
		if wantList, ok := want.([]any); ok {
			gotList, ok := got.([]any)
			if !ok || len(gotList) != len(wantList) {
				t.Fatalf("字段 %s = %#v", field, got)
			}
			continue
		}
		if got != want {
			t.Fatalf("字段 %s = %#v，期望 %#v", field, got, want)
		}
	}
	if id, _ := row["id"].(string); id == "" || id == created[0].ID {
		if id == "" {
			t.Fatalf("行缺少 id: %#v", row)
		}
	}
}

// 第二批追加必须接着现有行数编号，而不是从 1 重来。
func TestAppendUserCanvasStoryboardRowsContinuesShotNumbers(t *testing.T) {
	svc, canvasID, nodeID, revision := storyboardFixture(t)
	first, _, err := svc.AppendUserCanvasStoryboardRows("owner", canvasID, nodeID,
		[]StoryboardRowDraft{{}, {}}, revision)
	if err != nil {
		t.Fatal(err)
	}
	second, created, err := svc.AppendUserCanvasStoryboardRows("owner", canvasID, nodeID,
		[]StoryboardRowDraft{{}}, first.Revision)
	if err != nil {
		t.Fatal(err)
	}
	if len(created) != 1 || created[0].ShotNumber != 3 {
		t.Fatalf("第二批 created = %#v（首批 %#v）", created, second)
	}
}

// 非 script 节点必须整体拒绝：分镜行语义只对分镜脚本节点成立。
func TestAppendUserCanvasStoryboardRowsRejectsNonScriptNode(t *testing.T) {
	svc, canvasID, _, revision := storyboardFixture(t)
	_, _, err := svc.AppendUserCanvasStoryboardRows("owner", canvasID, "txt", []StoryboardRowDraft{{}}, revision)
	var appError *kernel.AppError
	if !errors.As(err, &appError) || appError.Status != http.StatusBadRequest {
		t.Fatalf("非 script 节点应被拒绝，实际 %v", err)
	}
}

// 更新只覆盖给出的字段，其余逐字保留；未知行整批拒绝。
func TestUpdateUserCanvasStoryboardRowsPartialPatch(t *testing.T) {
	svc, canvasID, nodeID, revision := storyboardFixture(t)
	summary, created, err := svc.AppendUserCanvasStoryboardRows("owner", canvasID, nodeID, []StoryboardRowDraft{{
		VideoMotionPrompt: strPtr("缓慢推进"),
		Dialogue:          strPtr("旧台词"),
	}}, revision)
	if err != nil {
		t.Fatal(err)
	}

	updated, _, err := svc.UpdateUserCanvasStoryboardRows("owner", canvasID, nodeID, []StoryboardRowPatch{{
		RowID:              created[0].ID,
		StoryboardRowDraft: StoryboardRowDraft{Dialogue: strPtr("新台词")},
	}}, summary.Revision)
	if err != nil {
		t.Fatal(err)
	}
	if updated.Revision != summary.Revision+1 {
		t.Fatalf("更新后 revision = %d", updated.Revision)
	}
	rows := storyboardRowsOf(t, svc, canvasID, nodeID)
	if rows[0]["dialogue"] != "新台词" {
		t.Fatalf("dialogue = %#v", rows[0]["dialogue"])
	}
	if rows[0]["videoMotionPrompt"] != "缓慢推进" {
		t.Fatalf("未给出的字段被改写: %#v", rows[0])
	}

	// 未知行 ID：整批拒绝且不推进 revision。
	_, _, err = svc.UpdateUserCanvasStoryboardRows("owner", canvasID, nodeID, []StoryboardRowPatch{{
		RowID:              "shot-missing",
		StoryboardRowDraft: StoryboardRowDraft{Dialogue: strPtr("x")},
	}}, updated.Revision)
	var appError *kernel.AppError
	if !errors.As(err, &appError) || appError.Status != http.StatusNotFound {
		t.Fatalf("未知行应整批拒绝，实际 %v", err)
	}
}

// 绑定后本行同类产出只剩一条指向绑定节点的连线；另一类产出、其他行、素材引用和
// 指向已删除节点的连线保持原样；回执列出的连线增删与文档实际变化一致。
func TestUpdateUserCanvasStoryboardRowsBindKeepsOneOutputPerKind(t *testing.T) {
	svc := newCanvasHistoryTestService(t)
	created, err := svc.UpsertUserCanvasProject("owner", json.RawMessage(`{
		"id":"canvas-bind","revision":0,"title":"分镜",
		"nodes":[
			{"id":"script","type":"script","metadata":{"storyboard":{"rows":[{"id":"r1","shotNumber":1,"imageNodeId":"img-a"},{"id":"r2","shotNumber":2,"imageNodeId":"img-a"}]}}},
			{"id":"img-a","type":"image"},{"id":"img-b","type":"image"},{"id":"vid","type":"video"},{"id":"txt","type":"text"},
			{"id":"board","type":"image","metadata":{"workflowKind":"action_board"}}
		],"connections":[
			{"id":"drag","fromNodeId":"script","toNodeId":"img-a","fromHandleId":"row:r1"},
			{"id":"gen","fromNodeId":"script","toNodeId":"img-b","fromHandleId":"row:r1","relation":"storyboard-output","storyboardRowId":"r1"},
			{"id":"dup","fromNodeId":"script","toNodeId":"img-b","fromHandleId":"row:r1"},
			{"id":"video-out","fromNodeId":"script","toNodeId":"vid","fromHandleId":"row:r1"},
			{"id":"orphan","fromNodeId":"script","toNodeId":"gone","fromHandleId":"row:r1"},
			{"id":"text-out","fromNodeId":"script","toNodeId":"txt","fromHandleId":"row:r1"},
			{"id":"other-row","fromNodeId":"script","toNodeId":"img-a","fromHandleId":"row:r2"},
			{"id":"ref","fromNodeId":"txt","toNodeId":"img-a","relation":"storyboard-asset-reference","storyboardRowId":"r1"},
			{"id":"action-board","fromNodeId":"script","toNodeId":"board","fromHandleId":"row:r1"}
		]}`))
	if err != nil {
		t.Fatal(err)
	}
	summary, update, err := svc.UpdateUserCanvasStoryboardRows("owner", "canvas-bind", "script", []StoryboardRowPatch{{RowID: "r1", ImageNodeID: strPtr("img-b")}}, created.Revision)
	if err != nil {
		t.Fatal(err)
	}
	if len(update.CreatedEdgeIDs) != 0 || strings.Join(update.DeletedEdgeIDs, ",") != "drag,dup" {
		t.Fatalf("edge receipt = %#v", update)
	}
	ids := func() string {
		raw, err := svc.UserCanvasProject("owner", "canvas-bind")
		if err != nil {
			t.Fatal(err)
		}
		var doc struct {
			Connections []struct {
				ID string `json:"id"`
			} `json:"connections"`
		}
		if err := json.Unmarshal(raw, &doc); err != nil {
			t.Fatal(err)
		}
		out := make([]string, 0, len(doc.Connections))
		for _, edge := range doc.Connections {
			out = append(out, edge.ID)
		}
		return strings.Join(out, ",")
	}
	if got := ids(); got != "gen,video-out,orphan,text-out,other-row,ref,action-board" {
		t.Fatalf("connections = %s", got)
	}
	rows := storyboardRowsOf(t, svc, "canvas-bind", "script")
	if rows[0]["imageNodeId"] != "img-b" || rows[1]["imageNodeId"] != "img-a" {
		t.Fatalf("rows = %#v", rows)
	}

	_, update, err = svc.UpdateUserCanvasStoryboardRows("owner", "canvas-bind", "script", []StoryboardRowPatch{{RowID: "r1", ImageNodeID: strPtr("")}}, summary.Revision)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(update.DeletedEdgeIDs, ",") != "gen" || len(update.CreatedEdgeIDs) != 0 {
		t.Fatalf("unbind receipt = %#v", update)
	}
	if got := ids(); got != "video-out,orphan,text-out,other-row,ref,action-board" {
		t.Fatalf("connections after unbind = %s", got)
	}
	if _, exists := storyboardRowsOf(t, svc, "canvas-bind", "script")[0]["imageNodeId"]; exists {
		t.Fatal("unbind left imageNodeId")
	}
}

// 绑定目标无效或 revision 过期时整批拒绝，画布和 revision 都不变。
func TestUpdateUserCanvasStoryboardRowsRejectsInvalidBindingWithoutWrite(t *testing.T) {
	svc, canvasID, nodeID, revision := storyboardFixture(t)
	summary, created, err := svc.AppendUserCanvasStoryboardRows("owner", canvasID, nodeID, []StoryboardRowDraft{{}, {}}, revision)
	if err != nil {
		t.Fatal(err)
	}
	before, err := svc.UserCanvasProject("owner", canvasID)
	if err != nil {
		t.Fatal(err)
	}
	for name, test := range map[string]struct {
		patches  []StoryboardRowPatch
		revision int64
		status   int
	}{
		"wrong type": {[]StoryboardRowPatch{{RowID: created[0].ID, VideoNodeID: strPtr("txt")}}, summary.Revision, http.StatusBadRequest},
		"missing":    {[]StoryboardRowPatch{{RowID: created[0].ID, ImageNodeID: strPtr("ghost")}}, summary.Revision, http.StatusNotFound},
		"batch":      {[]StoryboardRowPatch{{RowID: created[1].ID, StoryboardRowDraft: StoryboardRowDraft{Dialogue: strPtr("x")}}, {RowID: created[0].ID, ImageNodeID: strPtr("script")}}, summary.Revision, http.StatusBadRequest},
		"stale":      {[]StoryboardRowPatch{{RowID: created[0].ID, ImageNodeID: strPtr("")}}, revision, http.StatusConflict},
	} {
		_, _, err := svc.UpdateUserCanvasStoryboardRows("owner", canvasID, nodeID, test.patches, test.revision)
		var appError *kernel.AppError
		if !errors.As(err, &appError) || appError.Status != test.status {
			t.Fatalf("%s: err = %v", name, err)
		}
		after, err := svc.UserCanvasProject("owner", canvasID)
		if err != nil {
			t.Fatal(err)
		}
		if string(after) != string(before) {
			t.Fatalf("%s wrote canvas", name)
		}
	}
}

// 空 patch（一个字段都没给）必须拒绝，避免静默推进 revision。
func TestUpdateUserCanvasStoryboardRowsRejectsEmptyPatch(t *testing.T) {
	svc, canvasID, nodeID, revision := storyboardFixture(t)
	summary, created, _ := svc.AppendUserCanvasStoryboardRows("owner", canvasID, nodeID, []StoryboardRowDraft{{}}, revision)
	_, _, err := svc.UpdateUserCanvasStoryboardRows("owner", canvasID, nodeID, []StoryboardRowPatch{{RowID: created[0].ID}}, summary.Revision)
	if err == nil {
		t.Fatal("空 patch 应被拒绝")
	}
}

// 删除后剩余行镜号必须重排为 1..n，与界面 removeScriptRow 语义一致。
func TestRemoveUserCanvasStoryboardRowsRenumbers(t *testing.T) {
	svc, canvasID, nodeID, revision := storyboardFixture(t)
	summary, created, err := svc.AppendUserCanvasStoryboardRows("owner", canvasID, nodeID,
		[]StoryboardRowDraft{{}, {}, {}}, revision)
	if err != nil {
		t.Fatal(err)
	}
	after, remaining, err := svc.RemoveUserCanvasStoryboardRows("owner", canvasID, nodeID,
		[]string{created[0].ID}, summary.Revision)
	if err != nil {
		t.Fatal(err)
	}
	if remaining != 2 || after.Revision != summary.Revision+1 {
		t.Fatalf("remaining = %d revision = %d", remaining, after.Revision)
	}
	rows := storyboardRowsOf(t, svc, canvasID, nodeID)
	if len(rows) != 2 {
		t.Fatalf("行数 = %d", len(rows))
	}
	if rows[0]["shotNumber"] != float64(1) || rows[1]["shotNumber"] != float64(2) {
		t.Fatalf("镜号未重排: %#v", rows)
	}

	// 未知行：整批拒绝。
	if _, _, err := svc.RemoveUserCanvasStoryboardRows("owner", canvasID, nodeID, []string{"shot-missing"}, after.Revision); err == nil {
		t.Fatal("未知行应整批拒绝")
	}
}

// 过期 revision 必须被 CAS 拒绝，不能覆盖界面并发修改。
func TestStoryboardRowsRejectStaleRevision(t *testing.T) {
	svc, canvasID, nodeID, revision := storyboardFixture(t)
	first, _, err := svc.AppendUserCanvasStoryboardRows("owner", canvasID, nodeID, []StoryboardRowDraft{{}}, revision)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := svc.AppendUserCanvasStoryboardRows("owner", canvasID, nodeID, []StoryboardRowDraft{{}}, revision); err == nil {
		t.Fatal("过期 revision 应被拒绝")
	}
	if first.Revision <= revision {
		t.Fatalf("revision 未推进: %d", first.Revision)
	}
}

// 超过批次上限必须拒绝，防止一次调用混入多集内容。
func TestStoryboardRowsRejectOversizedBatch(t *testing.T) {
	svc, canvasID, nodeID, revision := storyboardFixture(t)
	drafts := make([]StoryboardRowDraft, maxStoryboardRowsPerCall+1)
	if _, _, err := svc.AppendUserCanvasStoryboardRows("owner", canvasID, nodeID, drafts, revision); err == nil {
		t.Fatal("超上限批次应被拒绝")
	}
}

func TestUpdateUserCanvasStoryboardRowsWithoutSyncedPromptReportsNoAlsoChanged(t *testing.T) {
	svc, canvasID, nodeID, revision := storyboardFixture(t)
	appended, created, err := svc.AppendUserCanvasStoryboardRows("owner", canvasID, nodeID, []StoryboardRowDraft{{}}, revision)
	if err != nil {
		t.Fatal(err)
	}
	_, update, err := svc.UpdateUserCanvasStoryboardRows("owner", canvasID, nodeID, []StoryboardRowPatch{{
		RowID: created[0].ID, StoryboardRowDraft: StoryboardRowDraft{Dialogue: strPtr("新台词")},
	}}, appended.Revision)
	if err != nil {
		t.Fatal(err)
	}
	if len(update.SyncedNodeIDs) != 0 || len(update.AlsoChanged) != 0 {
		t.Fatalf("没有绑定节点时不应有连带改动: %#v", update)
	}
}

func TestUpdateUserCanvasStoryboardRowsAutoSyncsBoundNodeDrafts(t *testing.T) {
	svc := newCanvasHistoryTestService(t)
	created, err := svc.UpsertUserCanvasProject("owner", json.RawMessage(`{
		"id":"canvas-sync","revision":0,"title":"分镜同步",
		"nodes":[
			{"id":"script","type":"script","metadata":{"storyboard":{"rows":[
				{"id":"r1","shotNumber":1,"imageGenerationPrompt":"旧首帧1","videoMotionPrompt":"旧视频1","imageNodeId":"img-1","videoNodeId":"vid-1"},
				{"id":"r2","shotNumber":2,"plotDescription":"旧剧情2","imageGenerationPrompt":"","videoMotionPrompt":"旧视频2","imageNodeId":"img-2","videoNodeId":"vid-2"}
			]}}},
			{"id":"img-1","type":"image","title":"镜1首帧","metadata":{"content":"","taskId":"task-1","prompt":"已提交首帧1","composerContent":"参考资产：@角色1\n旧首帧1","status":"success"}},
			{"id":"vid-1","type":"video","title":"镜1视频","metadata":{"content":"","prompt":"旧视频1","composerContent":"用户单独手改过的视频草稿","status":"idle"}},
			{"id":"img-2","type":"image","title":"镜2首帧","metadata":{"content":"","storageKey":"canvas/image/r2.png","prompt":"已提交首帧2","composerContent":"旧剧情2","status":"success"}},
			{"id":"vid-2","type":"video","title":"镜2视频","metadata":{"content":"","prompt":"旧视频2","composerContent":"旧视频2","status":"idle"}}
		],"connections":[]}`))
	if err != nil {
		t.Fatal(err)
	}
	_, update, err := svc.UpdateUserCanvasStoryboardRows("owner", "canvas-sync", "script", []StoryboardRowPatch{
		{
			RowID: "r1",
			StoryboardRowDraft: StoryboardRowDraft{
				ImageGenerationPrompt: strPtr("新首帧1：雨夜特写"),
				VideoMotionPrompt:     strPtr("新视频1：缓慢拉远"),
			},
		},
		{
			RowID: "r2",
			StoryboardRowDraft: StoryboardRowDraft{
				ImageGenerationPrompt: strPtr("新首帧2：剧情回退同步"),
				VideoMotionPrompt:     strPtr("新视频2：推镜"),
			},
		},
	}, created.Revision)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(update.SyncedNodeIDs, ",") != "img-1,img-2,vid-2" || strings.Join(update.SkippedNodeIDs, ",") != "vid-1" {
		t.Fatalf("synced/skipped receipt = %#v", update)
	}
	wantChanged := []writechange.Node{
		{NodeID: "img-1", Title: "镜1首帧", Fields: []string{"composerContent"}},
		{NodeID: "img-2", Title: "镜2首帧", Fields: []string{"composerContent"}},
		{NodeID: "vid-2", Title: "镜2视频", Fields: []string{"composerContent", "prompt"}},
	}
	if !reflect.DeepEqual(update.AlsoChanged, wantChanged) {
		t.Fatalf("alsoChanged = %#v, want %#v", update.AlsoChanged, wantChanged)
	}
	doc, err := svc.loadCanvasDoc("owner", "canvas-sync")
	if err != nil {
		t.Fatal(err)
	}
	imgMeta := findCanvasNode(doc, "img-1")["metadata"].(map[string]any)
	if imgMeta["composerContent"] != "参考资产：@角色1\n新首帧1：雨夜特写" || imgMeta["prompt"] != "已提交首帧1" {
		t.Fatalf("带参考资产前缀的首帧草稿应保留前缀并保留历史提示词: %#v", imgMeta)
	}
	img2Meta := findCanvasNode(doc, "img-2")["metadata"].(map[string]any)
	if img2Meta["composerContent"] != "新首帧2：剧情回退同步" || img2Meta["prompt"] != "已提交首帧2" {
		t.Fatalf("plotDescription 回退与仅含 storageKey 的节点应同步草稿并保留历史提示词: %#v", img2Meta)
	}
	vidMeta := findCanvasNode(doc, "vid-1")["metadata"].(map[string]any)
	if vidMeta["composerContent"] != "用户单独手改过的视频草稿" {
		t.Fatalf("单独手改过的视频草稿不应被覆盖: %#v", vidMeta)
	}
}
