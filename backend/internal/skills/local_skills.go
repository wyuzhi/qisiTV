package skills

import (
	"encoding/json"
	"errors"
	"log"
	"os"
	"path/filepath"
	"strings"

	"infinite-canvas/backend/internal/model"
)

const (
	localSkillsSettingKey = "local_skills_directory"
	localSkillsSourceURL  = "local://agents-skills"
	localSkillsDirectory  = "~/.agents/skills"
)

// LocalSkillSource 是技能库读取本机技能目录的开关。其他 AI 工具把技能装在这个目录里，默认一起用。
type LocalSkillSource struct {
	Enabled   bool   `json:"enabled"`
	Directory string `json:"directory"`
}

func (s *Service) LocalSkillSource() (*LocalSkillSource, error) {
	enabled, err := s.localSkillsEnabled()
	if err != nil {
		return nil, err
	}
	return &LocalSkillSource{Enabled: enabled, Directory: localSkillsDirectory}, nil
}

// SetLocalSkillSource 保存开关并立刻同步：打开时读进来，关闭时把读进来的技能从技能库拿掉。
// 只动技能库里的记录，不碰用户电脑上的目录。
func (s *Service) SetLocalSkillSource(enabled bool) (*LocalSkillSource, error) {
	value, err := json.Marshal(enabled)
	if err != nil {
		return nil, err
	}
	if err := s.repo.SaveSystemSetting(&model.SystemSetting{Key: localSkillsSettingKey, ValueJSON: string(value)}); err != nil {
		return nil, err
	}
	if err := s.SyncLocalSkills(); err != nil {
		return nil, err
	}
	return s.LocalSkillSource()
}

func (s *Service) localSkillsEnabled() (bool, error) {
	setting, err := s.repo.LookupSystemSetting(localSkillsSettingKey)
	if err != nil || setting == nil {
		return setting == nil, err
	}
	var enabled bool
	if err := json.Unmarshal([]byte(setting.ValueJSON), &enabled); err != nil {
		return false, err
	}
	return enabled, nil
}

// SyncLocalSkills 让技能库和本机技能目录保持一致。启动时和打开技能库时各跑一次。
func (s *Service) SyncLocalSkills() error {
	if s == nil || s.repo == nil || s.repo.DB() == nil {
		return nil
	}
	enabled, err := s.localSkillsEnabled()
	if err != nil {
		return err
	}
	var dirs []string
	if enabled {
		home, err := os.UserHomeDir()
		if err != nil {
			return errors.New("找不到本机用户目录")
		}
		dirs = localSkillDirs(filepath.Join(home, ".agents", "skills"))
	}
	return s.syncDirectorySkills(skillDirSource{
		sourceType: skillSourceTypeLocal, sourceURL: localSkillsSourceURL, idPrefix: "local-", ownerFallback: "local",
		authorName: "本机", fallbackDescription: "本机技能", private: true, skipBroken: true,
	}, dirs)
}

// SyncLocalSkillsAtStartup 不让本机目录的问题挡住应用启动。
func (s *Service) SyncLocalSkillsAtStartup() error {
	if err := s.SyncLocalSkills(); err != nil {
		log.Printf("读取本机技能失败：%v", err)
	}
	return nil
}

// localSkillDirs 列出目录下的每个技能。技能管理工具常用软链接把技能放进来，这里跟着链接读真实目录。
func localSkillDirs(root string) []string {
	entries, err := os.ReadDir(root)
	if err != nil {
		return nil
	}
	dirs := make([]string, 0, len(entries))
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".") {
			continue
		}
		if dir, err := filepath.EvalSymlinks(filepath.Join(root, entry.Name())); err == nil {
			dirs = append(dirs, dir)
		}
	}
	return dirs
}
