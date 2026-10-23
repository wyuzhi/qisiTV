package projectfolder

import (
	"encoding/json"
	"errors"
)

const ManifestName = "project.qisitv.json"
const MaxManifestBytes = 64 << 20
const MaxReceiptBytes = 32 << 20

var ErrConflict = errors.New("project folder differs from the last confirmed revision")
var ErrUnbound = errors.New("project is not bound to this engine workspace")

type Options struct {
	DataDir       string
	RootDirectory string
	WorkspaceID   string
}
type Authority struct {
	Kind        string `json:"kind"`
	WorkspaceID string `json:"workspaceId"`
	CanvasID    string `json:"canvasId"`
	Generation  int64  `json:"generation"`
}
type MediaEntry struct {
	Path     string `json:"path"`
	MimeType string `json:"mimeType"`
	Bytes    int64  `json:"bytes"`
	SHA256   string `json:"sha256"`
	Kind     string `json:"kind"`
}
type Manifest struct {
	Format          string                     `json:"format"`
	FormatVersion   int                        `json:"formatVersion"`
	Revision        int64                      `json:"revision"`
	Project         map[string]any             `json:"project"`
	Media           map[string]MediaEntry      `json:"media"`
	Drawings        map[string]json.RawMessage `json:"drawings,omitempty"`
	DeletedAt       string                     `json:"deletedAt,omitempty"`
	EngineAuthority *Authority                 `json:"engineAuthority,omitempty"`
	// Receipts are exported separately to keep the manifest readable and bounded.
	ReceiptsPath string `json:"receiptsPath,omitempty"`
}
type ImportRequest struct {
	// Relative to the root selected when starting the local engine. Arbitrary
	// absolute paths from a website are never accepted.
	Directory              string            `json:"directory"`
	ExpectedManifestSHA256 string            `json:"expectedManifestSha256"`
	ExpectedWorkspaceID    string            `json:"expectedWorkspaceId"`
	ReceiptsComplete       bool              `json:"receiptsComplete"`
	Receipts               []json.RawMessage `json:"receipts"`
}
type Status struct {
	CanvasID         string `json:"canvasId"`
	WorkspaceID      string `json:"workspaceId"`
	Directory        string `json:"directory"`
	State            string `json:"state"`
	Revision         int64  `json:"revision"`
	ExportedRevision int64  `json:"exportedRevision"`
	Pending          bool   `json:"pending"`
	Error            string `json:"error,omitempty"`
	LegacyReceipts   int64  `json:"legacyReceipts"`
}
