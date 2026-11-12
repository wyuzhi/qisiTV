package agentconnect

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"qisitv/backend/internal/agentops"
	"qisitv/backend/internal/buildinfo"
)

const (
	skillMarkerName = ".qisitv-managed"
	skillSource     = "qisitv-desktop"
)

var errSkillNotOwned = errors.New("skill directory is not managed by qisiTV")

func markerContent() []byte {
	version := strings.TrimSpace(buildinfo.Version)
	if version == "" {
		version = "dev"
	}
	return []byte("source: " + skillSource + "\nversion: " + version + "\nskill: " + SkillName + "\n")
}

// writeFileAtomic replaces a file without leaving a half-written skill.
// It never follows a symlink at the destination.
func writeFileAtomic(path string, data []byte, defaultPerm os.FileMode) error {
	perm := defaultPerm
	if info, err := os.Lstat(path); err == nil {
		if info.Mode()&os.ModeSymlink != 0 {
			return errSkillNotOwned
		}
		perm = info.Mode().Perm()
	}
	return writeAtomicFile(path, data, perm)
}

func (m *Manager) skillDirs(kind agentops.ClientKind) []string {
	switch kind {
	case agentops.ClientKindClaude:
		return []string{filepath.Join(m.Home, ".claude", "skills")}
	case agentops.ClientKindCodex:
		// Codex uses its own directory; ~/.agents/skills is the shared Agent
		// Skills location used by current Codex builds.
		return []string{
			filepath.Join(m.Home, ".codex", "skills"),
			filepath.Join(m.Home, ".agents", "skills"),
		}
	default:
		return nil
	}
}

func (m *Manager) skillInstalled(kind agentops.ClientKind) bool {
	dirs := m.skillDirs(kind)
	if len(dirs) == 0 {
		return false
	}
	for _, dir := range dirs {
		if !managedSkillReady(filepath.Join(dir, SkillName)) {
			return false
		}
	}
	return true
}

func managedSkillReady(target string) bool {
	info, err := os.Lstat(target)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return false
	}
	if !markerOwned(target) {
		return false
	}
	skill, err := os.Lstat(filepath.Join(target, "SKILL.md"))
	return err == nil && skill.Mode().IsRegular()
}

func markerOwned(dir string) bool {
	marker := filepath.Join(dir, skillMarkerName)
	info, err := os.Lstat(marker)
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return false
	}
	raw, err := os.ReadFile(marker)
	if err != nil {
		return false
	}
	return strings.Contains(string(raw), "source: "+skillSource+"\n")
}

func (m *Manager) installSkill(kind agentops.ClientKind) error {
	dirs := m.skillDirs(kind)
	if len(dirs) == 0 {
		return ErrUnsupported
	}
	if len(canvasSkill) == 0 {
		return errors.New("内置技能为空")
	}
	var lastErr error
	for _, dir := range dirs {
		if err := installManagedSkill(dir); err != nil {
			lastErr = err
		}
	}
	return lastErr
}

func installManagedSkill(skillsDir string) error {
	target := filepath.Join(skillsDir, SkillName)
	info, err := os.Lstat(target)
	switch {
	case err == nil:
		// Never follow or replace a directory the user created themselves.
		if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || !markerOwned(target) {
			return errSkillNotOwned
		}
	case os.IsNotExist(err):
		if err := os.MkdirAll(target, 0o755); err != nil {
			return fmt.Errorf("写入使用说明失败：%w", err)
		}
	default:
		return fmt.Errorf("写入使用说明失败：%w", err)
	}
	if err := writeFileAtomic(filepath.Join(target, skillMarkerName), markerContent(), 0o644); err != nil {
		return fmt.Errorf("写入使用说明失败：%w", err)
	}
	if err := writeFileAtomic(filepath.Join(target, "SKILL.md"), canvasSkill, 0o644); err != nil {
		return fmt.Errorf("写入使用说明失败：%w", err)
	}
	return nil
}

func (m *Manager) removeSkill(kind agentops.ClientKind) error {
	dirs := m.skillDirs(kind)
	if len(dirs) == 0 {
		return ErrUnsupported
	}
	var lastErr error
	for _, dir := range dirs {
		target := filepath.Join(dir, SkillName)
		// Only remove the directory this manager created and marked.
		info, err := os.Lstat(target)
		if err != nil {
			if os.IsNotExist(err) {
				continue
			}
			lastErr = err
			continue
		}
		if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || !markerOwned(target) {
			continue
		}
		if err := os.RemoveAll(target); err != nil {
			lastErr = fmt.Errorf("移除使用说明失败：%w", err)
		}
	}
	return lastErr
}
