package canvas

import (
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"testing"
	"time"

	"qisitv/backend/internal/model"
	"qisitv/backend/internal/repository"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

// Generate a fixed document in memory; the benchmark never opens a workspace.
func canvasHistoryBenchmarkProject(b testing.TB, count int) model.CanvasProject {
	b.Helper()
	nodes := make([]any, count)
	connections := make([]any, 0, count)
	for i := range nodes {
		resourceID := fmt.Sprintf("%032x", i+1)
		nodes[i] = map[string]any{
			"id": fmt.Sprintf("node-%04d", i), "type": "image", "title": "素材节点",
			"x": i % 20 * 300, "y": i / 20 * 240, "width": 256, "height": 192,
			"metadata": map[string]any{
				"content":    fmt.Sprintf("/api/resources/%s/file", resourceID),
				"storageKey": "resource:" + resourceID,
				"assetId":    fmt.Sprintf("asset-%04d", i), "prompt": strings.Repeat("素材描述 ", 32),
				"naturalWidth": 3840, "naturalHeight": 2160,
			},
		}
		if i > 0 {
			connections = append(connections, map[string]any{"id": fmt.Sprintf("edge-%04d", i), "source": fmt.Sprintf("node-%04d", i-1), "target": fmt.Sprintf("node-%04d", i)})
		}
	}
	raw, err := json.Marshal(map[string]any{"id": "canvas", "title": "素材画布", "nodes": nodes, "connections": connections, "viewport": map[string]any{"x": 0, "y": 0, "k": 1}})
	if err != nil {
		b.Fatal(err)
	}
	at := time.Date(2026, 10, 22, 0, 0, 0, 0, time.UTC)
	return model.CanvasProject{ID: "canvas", UserID: "owner", Title: "素材画布", PayloadJSON: string(raw), Revision: 1, CreatedAt: at, UpdatedAt: at}
}

func BenchmarkBuildCanvasSnapshot(b *testing.B) {
	for _, count := range []int{100, 500, 1000} {
		for _, scenario := range []string{"changed", "unchanged", "restore"} {
			b.Run(fmt.Sprintf("nodes_%d/%s", count, scenario), func(b *testing.B) {
				before := canvasHistoryBenchmarkProject(b, count)
				after := before
				after.Revision++
				after.UpdatedAt = after.UpdatedAt.Add(time.Minute)
				reason := "automatic"
				if scenario == "changed" {
					after.PayloadJSON = strings.Replace(before.PayloadJSON, `"x":0`, `"x":1`, 1)
				}
				if scenario == "restore" {
					reason = "before_restore"
				}
				b.ReportAllocs()
				b.ResetTimer()
				for i := 0; i < b.N; i++ {
					snapshot, refs, err := buildCanvasSnapshot(&before, after, reason)
					if err != nil {
						b.Fatal(err)
					}
					if scenario == "unchanged" {
						if snapshot != nil || len(refs) != 0 {
							b.Fatal("unchanged content created history")
						}
					} else if snapshot == nil || snapshot.NodeCount != count || len(refs) != count {
						b.Fatalf("incomplete history: snapshot=%v refs=%d", snapshot != nil, len(refs))
					}
				}
				b.StopTimer()
				b.ReportMetric(float64(len(before.PayloadJSON)), "document_bytes")
			})
		}
	}
}

type canvasSaveBenchmarkHost struct {
	nopHost
	locked time.Duration
}

func (h *canvasSaveBenchmarkHost) WithStorageLock(fn func() error) error {
	start := time.Now()
	defer func() { h.locked += time.Since(start) }()
	return fn()
}

// This covers service validation, revision CAS, history, and SQLite writes.
// SQLite stays in memory to avoid test directories and user workspace writes;
// this measures backend CPU/allocation cost, not filesystem durability latency.
func BenchmarkCanvasSave(b *testing.B) {
	for _, count := range []int{100, 500, 1000} {
		for _, scenario := range []string{"changed", "unchanged"} {
			b.Run(fmt.Sprintf("nodes_%d/%s", count, scenario), func(b *testing.B) {
				before := canvasHistoryBenchmarkProject(b, count)
				db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
				if err != nil {
					b.Fatal(err)
				}
				pool, err := db.DB()
				if err != nil {
					b.Fatal(err)
				}
				defer pool.Close()
				pool.SetMaxOpenConns(1)
				pool.SetMaxIdleConns(1)
				if err := db.AutoMigrate(&model.CanvasProject{}, &model.CanvasSnapshot{}, &model.CanvasSnapshotResource{}, &model.CanvasLibraryFolder{}, &model.Asset{}, &model.Resource{}); err != nil {
					b.Fatal(err)
				}
				resources := make([]model.Resource, count)
				assetRows := make([]model.Asset, count)
				for i := range resources {
					id := fmt.Sprintf("%032x", i+1)
					resources[i] = model.Resource{ID: id, UserID: "owner", Kind: "image", Status: model.ResourceStatusReady, Provider: "local"}
					assetRows[i] = model.Asset{ID: fmt.Sprintf("asset-%04d", i), UserID: "owner", Kind: "image", PayloadJSON: fmt.Sprintf(`{"content":"/api/resources/%s/file"}`, id)}
				}
				if err := db.CreateInBatches(resources, 200).Error; err != nil {
					b.Fatal(err)
				}
				if err := db.CreateInBatches(assetRows, 200).Error; err != nil {
					b.Fatal(err)
				}
				host := &canvasSaveBenchmarkHost{}
				svc := New(repository.New(db), host)
				body := before.PayloadJSON[1:]
				changed := strings.Replace(body, `"x":0`, `"x":1`, 1)
				if _, err := svc.UpsertUserCanvasProject("owner", json.RawMessage(`{"revision":0,`+body)); err != nil {
					b.Fatal(err)
				}
				// Warm history before timing so every measured changed save uses
				// the same interval-throttled path, independent of benchmark b.N.
				warmBody := body
				if scenario == "changed" {
					warmBody = changed
				}
				if _, err := svc.UpsertUserCanvasProject("owner", json.RawMessage(`{"revision":1,`+warmBody)); err != nil {
					b.Fatal(err)
				}
				host.locked = 0
				b.ReportAllocs()
				b.ResetTimer()
				for i := 0; i < b.N; i++ {
					content := body
					if scenario == "changed" && i%2 != 0 {
						content = changed
					}
					raw := json.RawMessage(`{"revision":` + strconv.Itoa(i+2) + `,` + content)
					result, err := svc.UpsertUserCanvasProject("owner", raw)
					if err != nil || result.Revision != int64(i+3) {
						b.Fatalf("save failed: %+v %v", result, err)
					}
				}
				b.StopTimer()
				b.ReportMetric(float64(host.locked.Nanoseconds())/float64(b.N), "ns/storage_lock")
				b.ReportMetric(float64(len(before.PayloadJSON)), "document_bytes")
			})
		}
	}
}
