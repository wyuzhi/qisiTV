package workspace

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

const (
	LocalProviderConfigFile = "local-model-config.json"
	RedactedSecret          = "__QISITV_REDACTED__"
)

// IsRedactedSecret accepts snapshots from browser tabs opened before the rename.
func IsRedactedSecret(value any) bool {
	text, ok := value.(string)
	return ok && (text == RedactedSecret || text == "__BEEFTV_REDACTED__")
}

// ProviderConfig owns the local provider snapshot. It has no database or
// hosted-service dependency and can therefore be reused by CLI/desktop shells.
type ProviderConfig struct {
	dataDir    string
	mu         sync.Mutex
	likeAIOnly bool
}

var ErrProviderConfigRevisionConflict = errors.New("本地模型配置已被其他写入更新")

func NewProviderConfig(dataDir string) (*ProviderConfig, error) {
	dataDir = strings.TrimSpace(dataDir)
	if dataDir == "" {
		return nil, errors.New("本地工作区数据目录不能为空")
	}
	return &ProviderConfig{dataDir: dataDir}, nil
}

func (s *ProviderConfig) ReadLocalModelConfig() ([]byte, error) {
	effective, _, err := s.LoadEffectiveModelConfig()
	if err != nil {
		return nil, err
	}
	return json.Marshal(effective.Config)
}

func (s *ProviderConfig) ReadRedactedModelConfig() ([]byte, error) {
	body, err := s.ReadLocalModelConfig()
	if err != nil || len(body) == 0 {
		return body, err
	}
	var value any
	if err := json.Unmarshal(body, &value); err != nil {
		return nil, fmt.Errorf("本地模型配置损坏: %w", err)
	}
	redactSecrets(value)
	return json.Marshal(value)
}

func (s *ProviderConfig) SaveLocalModelConfig(body []byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	existingDocument, _, _ := s.loadDocument()
	return s.saveLocalModelConfig(body, existingDocument)
}

func (s *ProviderConfig) SaveLocalModelConfigRevision(body []byte, expectedRevision int64) (int64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	existingDocument, _, err := s.loadDocument()
	if err != nil {
		return 0, err
	}
	if existingDocument.Revision != expectedRevision {
		return existingDocument.Revision, ErrProviderConfigRevisionConflict
	}
	if err := s.saveLocalModelConfig(body, existingDocument); err != nil {
		return existingDocument.Revision, err
	}
	return existingDocument.Revision + 1, nil
}

func (s *ProviderConfig) saveLocalModelConfig(body []byte, existingDocument ProviderStateDocument) error {
	if len(body) == 0 || len(body) > 2<<20 {
		return errors.New("本地模型配置大小无效")
	}
	incoming, err := decodeIncomingConfig(body)
	if err != nil {
		return errors.New("本地模型配置必须是有效 JSON")
	}
	if existingDocument.Config != nil {
		preserveSecrets(incoming, existingDocument.Config)
	}
	if s.likeAIOnly {
		incoming = preserveInactiveProviderConfig(incoming, existingDocument.Config)
	}
	document := newProviderState(incoming, existingDocument.Revision+1)
	canonical, err := json.Marshal(document)
	if err != nil {
		return fmt.Errorf("编码本地模型配置失败: %w", err)
	}
	if err := os.MkdirAll(s.dataDir, 0o700); err != nil {
		return fmt.Errorf("创建本地配置目录失败: %w", err)
	}
	tmp, err := os.CreateTemp(s.dataDir, ".local-model-config-*")
	if err != nil {
		return fmt.Errorf("创建本地配置临时文件失败: %w", err)
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	if err := tmp.Chmod(0o600); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("设置本地配置权限失败: %w", err)
	}
	if _, err := tmp.Write(canonical); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("写入本地模型配置失败: %w", err)
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("同步本地模型配置失败: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("关闭本地模型配置失败: %w", err)
	}
	if err := s.rotateBackup(); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := os.Rename(tmpName, s.path()); err != nil {
		return fmt.Errorf("替换本地模型配置失败: %w", err)
	}
	if directory, err := os.Open(s.dataDir); err == nil {
		_ = directory.Sync()
		_ = directory.Close()
	}
	return nil
}

func (s *ProviderConfig) path() string { return filepath.Join(s.dataDir, LocalProviderConfigFile) }

func (s *ProviderConfig) backupPath() string { return s.path() + ".bak" }

func (s *ProviderConfig) LoadEffectiveModelConfig() (EffectiveModelConfig, ConfigHealth, error) {
	document, health, err := s.loadDocument()
	if err != nil {
		return EffectiveModelConfig{}, health, err
	}
	effective, err := effectiveProviderState(document)
	if err != nil {
		return EffectiveModelConfig{}, health, fmt.Errorf("合并内置模型配置失败: %w", err)
	}
	if s.likeAIOnly {
		effective.Config = likeAIOnlyConfig(effective.Config)
		effective.PresetVersions = map[string]int{"likeai": 1}
	}
	return effective, health, nil
}

func (s *ProviderConfig) loadDocument() (ProviderStateDocument, ConfigHealth, error) {
	body, err := os.ReadFile(s.path())
	if errors.Is(err, os.ErrNotExist) {
		return newProviderState(map[string]any{}, 0), ConfigHealthDefault, nil
	}
	if err != nil {
		return ProviderStateDocument{}, ConfigHealthReady, fmt.Errorf("读取本地模型配置失败: %w", err)
	}
	document, migrated, decodeErr := decodeProviderDocument(body)
	if decodeErr == nil {
		if migrated {
			return document, ConfigHealthMigrated, nil
		}
		return document, ConfigHealthReady, nil
	}
	backup, backupErr := os.ReadFile(s.backupPath())
	if backupErr != nil {
		return ProviderStateDocument{}, ConfigHealthReady, fmt.Errorf("本地模型配置损坏且无可用备份: %w", decodeErr)
	}
	document, _, backupDecodeErr := decodeProviderDocument(backup)
	if backupDecodeErr != nil {
		return ProviderStateDocument{}, ConfigHealthReady, fmt.Errorf("本地模型配置及备份均损坏: %w", decodeErr)
	}
	return document, ConfigHealthRecovered, nil
}

func decodeProviderDocument(body []byte) (ProviderStateDocument, bool, error) {
	var probe map[string]json.RawMessage
	if err := json.Unmarshal(body, &probe); err != nil {
		return ProviderStateDocument{}, false, err
	}
	if _, versioned := probe["schemaVersion"]; versioned {
		var document ProviderStateDocument
		if err := json.Unmarshal(body, &document); err != nil || document.SchemaVersion != providerStateSchemaVersion || document.Config == nil {
			return ProviderStateDocument{}, false, errors.New("不支持或损坏的本地模型配置版本")
		}
		return document, false, nil
	}
	var config map[string]any
	if err := json.Unmarshal(body, &config); err != nil {
		return ProviderStateDocument{}, false, err
	}
	return newProviderState(config, 0), true, nil
}

func decodeIncomingConfig(body []byte) (map[string]any, error) {
	document, _, err := decodeProviderDocument(body)
	if err != nil {
		return nil, err
	}
	return document.Config, nil
}

func (s *ProviderConfig) rotateBackup() error {
	source, err := os.Open(s.path())
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("读取旧模型配置失败: %w", err)
	}
	defer source.Close()
	var value any
	if err := json.NewDecoder(source).Decode(&value); err != nil {
		return nil
	}
	if _, err := source.Seek(0, 0); err != nil {
		return fmt.Errorf("重读旧模型配置失败: %w", err)
	}
	tmp, err := os.CreateTemp(s.dataDir, ".local-model-config-backup-*")
	if err != nil {
		return fmt.Errorf("创建模型配置备份失败: %w", err)
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	if err := tmp.Chmod(0o600); err != nil {
		_ = tmp.Close()
		return err
	}
	if _, err := io.Copy(tmp, source); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("写入模型配置备份失败: %w", err)
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmpName, s.backupPath()); err != nil {
		return fmt.Errorf("替换模型配置备份失败: %w", err)
	}
	return nil
}

func redactSecrets(value any) {
	switch typed := value.(type) {
	case map[string]any:
		for key, child := range typed {
			if isSecretKey(key) && child != nil && fmt.Sprint(child) != "" {
				typed[key] = RedactedSecret
				continue
			}
			redactSecrets(child)
		}
	case []any:
		for _, child := range typed {
			redactSecrets(child)
		}
	}
}

func preserveSecrets(incoming, existing any) {
	switch next := incoming.(type) {
	case map[string]any:
		previous, _ := existing.(map[string]any)
		for key, value := range next {
			if isSecretKey(key) && IsRedactedSecret(value) {
				if old, ok := previous[key]; ok {
					next[key] = old
				}
				continue
			}
			preserveSecrets(value, previous[key])
		}
	case []any:
		previous, _ := existing.([]any)
		for index, value := range next {
			var old any
			if candidate, ok := value.(map[string]any); ok {
				if id, ok := candidate["id"]; ok {
					for _, item := range previous {
						if oldMap, ok := item.(map[string]any); ok && oldMap["id"] == id {
							old = oldMap
							break
						}
					}
				}
			}
			if old == nil && index < len(previous) {
				old = previous[index]
			}
			preserveSecrets(value, old)
		}
	}
}

func isSecretKey(key string) bool {
	key = strings.ToLower(strings.ReplaceAll(strings.TrimSpace(key), "_", ""))
	return key == "apikey" || key == "token" || key == "secret" || strings.HasSuffix(key, "token") || strings.HasSuffix(key, "secret")
}
