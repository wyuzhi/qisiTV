package agentconnect

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"infinite-canvas/backend/internal/agentops"
)

// stateMu serializes the read-modify-write of the shared integrations file.
// The handler also locks per kind, but Claude and Codex may save concurrently.
var stateMu sync.Mutex

const integrationStateFile = "integrations.json"

// IntegrationRecord is auxiliary metadata only. Whether a connection exists is
// determined by the live credential registry, not by this file.
type IntegrationRecord struct {
	Kind        string    `json:"kind"`
	ClientID    string    `json:"clientId"`
	TokenFile   string    `json:"tokenFile"`
	ConnectedAt time.Time `json:"connectedAt"`
}

type integrationState struct {
	Integrations map[string]IntegrationRecord `json:"integrations"`
}

func (m *Manager) stateDir() string {
	return filepath.Join(m.DataDir, "agent-clients")
}

func (m *Manager) statePath() string {
	return filepath.Join(m.stateDir(), integrationStateFile)
}

func (m *Manager) ensureStateDir() error {
	if err := os.MkdirAll(m.stateDir(), 0o700); err != nil {
		return err
	}
	// MkdirAll does not tighten an existing directory.
	_ = os.Chmod(m.stateDir(), 0o700)
	return nil
}

// TokenPath is where a one-click credential token is stored.
func (m *Manager) TokenPath(kind agentops.ClientKind) string {
	return filepath.Join(m.stateDir(), string(kind)+".token")
}

// TokenFilePresent reports whether the token file is a regular file.
func (m *Manager) TokenFilePresent(path string) bool {
	if strings.TrimSpace(path) == "" {
		return false
	}
	info, err := os.Lstat(path)
	return err == nil && info.Mode().IsRegular()
}

// tokenWriteStage is a test hook for asserting ordering: permissions are set
// before any token byte is written, and the final file is verified after the
// rename. It is a no-op in production.
var tokenWriteStage = func(stage, path string) {}

// WriteToken persists the raw token and returns its path. Permissions are set
// on the empty temporary file before the secret is written, so a crash cannot
// leave a readable token file behind.
func (m *Manager) WriteToken(kind agentops.ClientKind, token string) (string, error) {
	if !m.Available() || displayName(kind) == "" || strings.TrimSpace(token) == "" {
		return "", ErrUnsupported
	}
	if err := m.ensureStateDir(); err != nil {
		return "", fmt.Errorf("保存连接凭据失败：%w", err)
	}
	path := m.TokenPath(kind)
	if err := writeTokenFile(path, strings.TrimSpace(token)); err != nil {
		return "", fmt.Errorf("保存连接凭据失败：%w", err)
	}
	return path, nil
}

func writeTokenFile(path, token string) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, ".beeftv-token-*")
	if err != nil {
		return err
	}
	name := tmp.Name()
	defer os.Remove(name)

	fail := func(closeFile bool, cause error) error {
		if closeFile {
			_ = tmp.Close()
		}
		_ = os.Remove(name)
		return cause
	}
	// CreateTemp already uses 0600, but set it explicitly and protect the file
	// before writing any secret bytes.
	if err := tmp.Chmod(0o600); err != nil {
		return fail(true, err)
	}
	if err := secureTokenFile(name); err != nil {
		return fail(true, err)
	}
	if err := verifyTokenPermissions(name); err != nil {
		return fail(true, err)
	}
	tokenWriteStage("secure", name)
	if _, err := tmp.WriteString(token); err != nil {
		return fail(true, err)
	}
	if err := tmp.Sync(); err != nil {
		return fail(true, err)
	}
	tokenWriteStage("write", name)
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Rename(name, path); err != nil {
		return err
	}
	if err := verifyTokenPermissions(path); err != nil {
		_ = os.Remove(path)
		return err
	}
	tokenWriteStage("rename", path)
	return nil
}

// DeleteToken removes the token file. A missing file is success.
func (m *Manager) DeleteToken(kind agentops.ClientKind) error {
	if !m.Available() || displayName(kind) == "" {
		return ErrUnsupported
	}
	if err := os.Remove(m.TokenPath(kind)); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("删除连接凭据失败：%w", err)
	}
	return nil
}

func (m *Manager) readState() (integrationState, error) {
	state := integrationState{Integrations: map[string]IntegrationRecord{}}
	raw, err := os.ReadFile(m.statePath())
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return state, nil
		}
		return state, err
	}
	if len(raw) == 0 {
		return state, nil
	}
	if err := json.Unmarshal(raw, &state); err != nil {
		return integrationState{Integrations: map[string]IntegrationRecord{}}, err
	}
	if state.Integrations == nil {
		state.Integrations = map[string]IntegrationRecord{}
	}
	return state, nil
}

func (m *Manager) saveState(state integrationState) error {
	if err := m.ensureStateDir(); err != nil {
		return err
	}
	encoded, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return err
	}
	encoded = append(encoded, '\n')
	return writeAtomicFile(m.statePath(), encoded, 0o600)
}

// Record returns the auxiliary record. A read or parse error is reported to
// the caller so the UI can show "needs retry".
func (m *Manager) Record(kind agentops.ClientKind) (IntegrationRecord, bool, error) {
	if !m.Available() {
		return IntegrationRecord{}, false, nil
	}
	stateMu.Lock()
	defer stateMu.Unlock()
	state, err := m.readState()
	if err != nil {
		return IntegrationRecord{}, false, err
	}
	record, ok := state.Integrations[string(kind)]
	return record, ok, nil
}

// SaveRecord persists auxiliary metadata. A corrupt state file is replaced
// instead of blocking reconnects.
func (m *Manager) SaveRecord(record IntegrationRecord) error {
	if !m.Available() {
		return ErrUnsupported
	}
	stateMu.Lock()
	defer stateMu.Unlock()
	state, err := m.readState()
	if err != nil {
		state = integrationState{Integrations: map[string]IntegrationRecord{}}
	}
	state.Integrations[record.Kind] = record
	return m.saveState(state)
}

// DeleteRecord removes BeefTV's auxiliary record. A corrupt file is reset so
// disconnect can finish.
func (m *Manager) DeleteRecord(kind agentops.ClientKind) error {
	if !m.Available() {
		return ErrUnsupported
	}
	stateMu.Lock()
	defer stateMu.Unlock()
	state, err := m.readState()
	if err != nil {
		if removeErr := os.Remove(m.statePath()); removeErr != nil && !errors.Is(removeErr, os.ErrNotExist) {
			return removeErr
		}
		return nil
	}
	if _, ok := state.Integrations[string(kind)]; !ok {
		return nil
	}
	delete(state.Integrations, string(kind))
	return m.saveState(state)
}

func writeAtomicFile(path string, data []byte, perm os.FileMode) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, ".beeftv-state-*")
	if err != nil {
		return err
	}
	name := tmp.Name()
	defer os.Remove(name)
	if err := tmp.Chmod(perm); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(name, path)
}
