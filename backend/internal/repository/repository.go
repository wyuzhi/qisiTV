package repository

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"infinite-canvas/backend/internal/model"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

var ErrDailyUploadLimitExceeded = errors.New("daily upload limit exceeded")

var ErrUploadReservationConflict = errors.New("upload reservation already exists")

var ErrTaskProviderRecoveryConflict = errors.New("task provider recovery is already running")

var ErrTaskProviderCancellationConflict = errors.New("task provider cancellation is already claimed")

var ErrTaskStateConflict = errors.New("task state changed concurrently")

var ErrTextReplayQuotaExceeded = errors.New("text replay quota exceeded")

var ErrTextReplayClosed = errors.New("text replay task is closed")

var ErrProjectAssetFolderNotEmpty = errors.New("project asset folder is not empty")

var ErrAssetOwnedByAnotherUser = errors.New("asset belongs to another user")

var ErrProjectHasActiveTasks = errors.New("project has active tasks")

var ErrProjectUnitShotsChanged = errors.New("project unit shots changed")

var ErrCanvasRevisionConflict = errors.New("canvas revision changed")

var ErrAssetExpectedStatusMismatch = errors.New("asset expected status mismatch")

type Repository struct {
	db *gorm.DB
}

// DB 暴露底层连接，供同一进程内的操作层复用同一个数据库（不新建第二个库）。
func (r *Repository) DB() *gorm.DB {
	if r == nil {
		return nil
	}
	return r.db
}

// WithTx 返回绑定到同一事务的仓储，使领域写入与操作记录一起提交。
// 这是操作层幂等能成立的前提：不做内存去重，也不用第二个数据库假装满足。
func (r *Repository) WithTx(tx *gorm.DB) *Repository {
	if r == nil {
		return &Repository{db: tx}
	}
	return &Repository{db: tx}
}

// HoldsTransaction reports that this repository is already bound to a GORM
// transaction. Callers that would take the process storage mutex must skip it
// so a single SQLite connection cannot deadlock on transaction -> mutex -> DB.
func (r *Repository) HoldsTransaction() bool {
	if r == nil || r.db == nil || r.db.Statement == nil {
		return false
	}
	_, ok := r.db.Statement.ConnPool.(gorm.TxCommitter)
	return ok
}

type UserStorageUsage struct {
	AssetCount   int64 `json:"assetCount"`
	AssetBytes   int64 `json:"assetBytes"`
	CanvasCount  int64 `json:"canvasCount"`
	CanvasBytes  int64 `json:"canvasBytes"`
	TaskCount    int64 `json:"taskCount"`
	TaskBytes    int64 `json:"taskBytes"`
	APICallCount int64 `json:"apiCallCount"`
}

func New(db *gorm.DB) *Repository {
	return &Repository{db: db}
}

func (r *Repository) WithContext(ctx context.Context) *Repository {
	return &Repository{db: r.db.WithContext(ctx)}
}

func (r *Repository) Transaction(fn func(*Repository) error) error {
	if r == nil || r.db == nil {
		return errors.New("repository is not initialized")
	}
	return r.db.Transaction(func(tx *gorm.DB) error {
		return fn(r.WithTx(tx))
	})
}

func (r *Repository) Dialect() string {
	return r.db.Dialector.Name()
}

// NextPrefixedID 在数据库事务中递增序列，避免 UUID/父子字符串拼接导致的不可读和不可排序 ID。
// prefix 只决定展示前缀，关联关系仍由独立外键维护。
func (r *Repository) NextPrefixedID(prefix string) (string, error) {
	return r.nextPrefixedID(r.db, prefix)
}

func (r *Repository) nextPrefixedID(db *gorm.DB, prefix string) (string, error) {
	prefix = strings.ToUpper(strings.TrimSpace(prefix))
	if prefix == "" || len(prefix) > 16 {
		return "", errors.New("invalid id prefix")
	}
	sequence := "id:" + prefix
	var item model.IDSequence
	err := db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Clauses(clause.OnConflict{DoNothing: true}).Create(&model.IDSequence{Name: sequence, UpdatedAt: time.Now()}).Error; err != nil {
			return err
		}
		if err := tx.Model(&model.IDSequence{}).Where("name = ?", sequence).Updates(map[string]any{
			"value":      gorm.Expr("value + ?", 1),
			"updated_at": time.Now(),
		}).Error; err != nil {
			return err
		}
		return tx.First(&item, "name = ?", sequence).Error
	})
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("%s_%06d", prefix, item.Value), nil
}

func (r *Repository) UserStorageUsage(userID string) (UserStorageUsage, error) {
	var usage UserStorageUsage
	canvasBytes := `(SELECT COALESCE(SUM(length(CAST(COALESCE(payload_json, '') AS BLOB))), 0) FROM canvas_projects WHERE user_id = ?)`
	args := []any{userID, userID, userID, userID}
	if r.db.Migrator().HasTable(&model.CanvasDrawing{}) {
		canvasBytes += ` + (SELECT COALESCE(SUM(length(CAST(COALESCE(snapshot_json, '') AS BLOB))), 0) FROM canvas_drawings WHERE user_id = ? AND deleted_at IS NULL)`
		args = append(args, userID)
	}
	query := fmt.Sprintf(`
		SELECT
			(SELECT COUNT(*) FROM assets WHERE user_id = ?) AS asset_count,
			(SELECT COALESCE(SUM(length(CAST(COALESCE(payload_json, '') AS BLOB))), 0) FROM assets WHERE user_id = ?) AS asset_bytes,
			(SELECT COUNT(*) FROM canvas_projects WHERE user_id = ?) AS canvas_count,
			%s AS canvas_bytes,
			(SELECT COUNT(*) FROM tasks WHERE user_id = ?) AS task_count,
			(SELECT COALESCE(SUM(length(CAST(COALESCE(prompt, '') AS BLOB)) + length(CAST(COALESCE(input_json, '') AS BLOB)) + length(CAST(COALESCE(workflow_source_cipher, '') AS BLOB)) + length(CAST(COALESCE(result_json, '') AS BLOB)) + length(CAST(COALESCE(text_draft, '') AS BLOB)) + length(CAST(COALESCE(error, '') AS BLOB))), 0) FROM tasks WHERE user_id = ?)
			+ (SELECT COALESCE(SUM(length(CAST(COALESCE(message, '') AS BLOB)) + length(CAST(COALESCE(payload, '') AS BLOB))), 0) FROM task_logs WHERE user_id = ?)
			+ (SELECT COALESCE(SUM(length(CAST(COALESCE(url, '') AS BLOB)) + length(CAST(COALESCE(payload, '') AS BLOB))), 0) FROM results WHERE user_id = ?)
			+ (SELECT COALESCE(SUM(byte_count), 0) FROM task_text_delta WHERE user_id = ?)
			+ (SELECT COALESCE(SUM(length(CAST(COALESCE(path, '') AS BLOB)) + length(CAST(COALESCE(model, '') AS BLOB)) + length(CAST(COALESCE(provider_request_id, '') AS BLOB)) + length(CAST(COALESCE(error_code, '') AS BLOB)) + length(CAST(COALESCE(error, '') AS BLOB)) + length(CAST(COALESCE(upstream_url, '') AS BLOB)) + length(CAST(COALESCE(request_body, '') AS BLOB)) + length(CAST(COALESCE(response_body, '') AS BLOB))), 0) FROM api_call_logs WHERE user_id = ?) AS task_bytes,
			(SELECT COUNT(*) FROM api_call_logs WHERE user_id = ?) AS api_call_count
	`, canvasBytes)
	args = append(args, userID, userID, userID, userID, userID, userID, userID)
	err := r.db.Raw(query, args...).Scan(&usage).Error
	return usage, err
}

// Create 是低层兼容入口；业务写路径应优先使用带领域约束的显式方法。
func (r *Repository) Create(value any) error {
	return r.db.Create(value).Error
}

// Save 是低层兼容入口；涉及状态机或权限边界的写入不得绕过显式事务方法。
func (r *Repository) Save(value any) error {
	return r.db.Save(value).Error
}

func (r *Repository) BackupSQLite(path string) error {
	if r.Dialect() != "sqlite" {
		return errors.New("当前数据库不是 SQLite，不能执行 SQLite 备份")
	}
	escaped := strings.ReplaceAll(path, "'", "''")
	return r.db.Exec("VACUUM INTO '" + escaped + "'").Error
}

func (r *Repository) Vacuum() error {
	if r.Dialect() != "sqlite" {
		return nil
	}
	return r.db.Exec("VACUUM").Error
}

// Delete 是低层兼容入口；删除业务数据应使用带用户/项目作用域和关联清理的显式方法。
func (r *Repository) Delete(value any, query any, args ...any) error {
	conds := append([]any{query}, args...)
	return r.db.Delete(value, conds...).Error
}

func (r *Repository) SystemChannels(includeDisabled bool) ([]model.ModelChannel, error) {
	var channels []model.ModelChannel
	query := r.db.Order("sort_order asc, created_at asc, id asc").Where("scope = ?", model.ChannelScopeSystem)
	if !includeDisabled {
		query = query.Where("enabled = ?", true)
	}
	err := query.Find(&channels).Error
	return channels, err
}

func (r *Repository) HistoricalSystemChannelReferences() ([]model.ModelChannel, error) {
	var channels []model.ModelChannel
	err := r.db.Unscoped().Select("id", "name").Where("scope = ?", model.ChannelScopeSystem).Order("created_at asc").Find(&channels).Error
	return channels, err
}

func (r *Repository) AdminSystemChannels(keyword string, status string, limit int, offset int) ([]model.ModelChannel, int64, error) {
	var channels []model.ModelChannel
	var total int64
	query := r.db.Model(&model.ModelChannel{}).Where("scope = ?", model.ChannelScopeSystem)
	if value := strings.TrimSpace(keyword); value != "" {
		pattern := "%" + strings.ToLower(value) + "%"
		query = query.Where("lower(name) LIKE ? OR lower(public_alias) LIKE ? OR lower(base_url) LIKE ?", pattern, pattern, pattern)
	}
	if status == "enabled" {
		query = query.Where("enabled = ?", true)
	} else if status == "disabled" {
		query = query.Where("enabled = ?", false)
	}
	if err := query.Count(&total).Error; err != nil {
		return nil, 0, err
	}
	if err := query.Order("sort_order asc, created_at asc, id asc").Limit(limit).Offset(offset).Find(&channels).Error; err != nil {
		return nil, 0, err
	}
	return channels, total, nil
}

func (r *Repository) AdminSystemChannelReferences() ([]model.ModelChannel, error) {
	var channels []model.ModelChannel
	err := r.db.Select("id", "name", "enabled").Where("scope = ?", model.ChannelScopeSystem).Order("created_at asc").Find(&channels).Error
	return channels, err
}

func (r *Repository) SystemChannel(id string) (*model.ModelChannel, error) {
	var channel model.ModelChannel
	if err := r.db.First(&channel, "id = ? AND scope = ? AND enabled = ?", id, model.ChannelScopeSystem, true).Error; err != nil {
		return nil, err
	}
	return &channel, nil
}

func (r *Repository) AdminSystemChannel(id string) (*model.ModelChannel, error) {
	var channel model.ModelChannel
	if err := r.db.First(&channel, "id = ? AND scope = ?", id, model.ChannelScopeSystem).Error; err != nil {
		return nil, err
	}
	return &channel, nil
}

func (r *Repository) DeleteSystemChannel(id string) error {
	now := time.Now()
	return r.db.Transaction(func(tx *gorm.DB) error {
		channelResult := tx.Model(&model.ModelChannel{}).
			Where("id = ? AND scope = ?", id, model.ChannelScopeSystem).
			Updates(map[string]any{"api_key": "", "secret_key": "", "enabled": false, "updated_at": now})
		if channelResult.Error != nil {
			return channelResult.Error
		}
		if channelResult.RowsAffected != 1 {
			return gorm.ErrRecordNotFound
		}
		if err := tx.Model(&model.ChannelModel{}).Where("channel_id = ?", id).Updates(map[string]any{"enabled": false, "updated_at": now}).Error; err != nil {
			return err
		}
		if err := tx.Where("channel_id = ?", id).Delete(&model.ChannelModel{}).Error; err != nil {
			return err
		}
		return tx.Where("id = ? AND scope = ?", id, model.ChannelScopeSystem).Delete(&model.ModelChannel{}).Error
	})
}

func (r *Repository) ApiCallLogs(userID string, admin bool, limit int) ([]model.ApiCallLog, error) {
	var logs []model.ApiCallLog
	if limit <= 0 || limit > 200 {
		limit = 100
	}
	query := r.db.Order("created_at desc").Limit(limit)
	if !admin {
		query = query.Where("user_id = ?", userID)
	}
	err := query.Omit("RequestBody", "ResponseBody").Find(&logs).Error
	return logs, err
}

func (r *Repository) SystemSetting(key string) (*model.SystemSetting, error) {
	var setting model.SystemSetting
	if err := r.db.First(&setting, "key = ?", key).Error; err != nil {
		return nil, err
	}
	return &setting, nil
}

func (r *Repository) SaveSystemSetting(setting *model.SystemSetting) error {
	return r.db.Save(setting).Error
}

func (r *Repository) SaveSystemSettings(settings ...*model.SystemSetting) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		for _, setting := range settings {
			if err := tx.Save(setting).Error; err != nil {
				return err
			}
		}
		return nil
	})
}

func (r *Repository) ArkPrivateAssetBinding(resourceID string, projectName string) (*model.ArkPrivateAssetBinding, error) {
	var binding model.ArkPrivateAssetBinding
	if err := r.db.Where("resource_id = ? AND project_name = ?", resourceID, projectName).First(&binding).Error; err != nil {
		return nil, err
	}
	return &binding, nil
}

// CreateArkPrivateAssetBinding establishes a single uploader for a resource
// and Ark Project. Other workers can wait for that binding instead of
// importing the same image repeatedly.
func (r *Repository) CreateArkPrivateAssetBinding(binding *model.ArkPrivateAssetBinding) (bool, error) {
	result := r.db.Clauses(clause.OnConflict{
		Columns:   []clause.Column{{Name: "resource_id"}, {Name: "project_name"}},
		DoNothing: true,
	}).Create(binding)
	if result.Error != nil {
		return false, result.Error
	}
	return result.RowsAffected == 1, nil
}

func (r *Repository) SaveArkPrivateAssetBinding(binding *model.ArkPrivateAssetBinding) error {
	return r.db.Save(binding).Error
}

func (r *Repository) DeleteSystemSetting(key string) error {
	return r.db.Delete(&model.SystemSetting{}, "key = ?", key).Error
}

func (r *Repository) ActivePromptTemplate(operation string) (*model.PromptTemplate, error) {
	var template model.PromptTemplate
	if err := r.db.Order("version desc").First(&template, "operation = ? AND enabled = ?", operation, true).Error; err != nil {
		return nil, err
	}
	return &template, nil
}

func (r *Repository) PromptTemplateCount(operation string) (int64, error) {
	var count int64
	err := r.db.Model(&model.PromptTemplate{}).Where("operation = ?", operation).Count(&count).Error
	return count, err
}

func (r *Repository) SavePromptTemplate(template *model.PromptTemplate) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		if template.Enabled {
			if err := tx.Model(&model.PromptTemplate{}).Where("operation = ? AND id <> ?", template.Operation, template.ID).Update("enabled", false).Error; err != nil {
				return err
			}
		}
		return tx.Save(template).Error
	})
}

func (r *Repository) UserPromptCustomizations(userID string) ([]model.UserPromptCustomization, error) {
	var customizations []model.UserPromptCustomization
	err := r.db.Where("user_id = ?", userID).Order("operation asc").Find(&customizations).Error
	return customizations, err
}

func (r *Repository) UserPromptCustomization(userID string, operation string) (*model.UserPromptCustomization, error) {
	var customization model.UserPromptCustomization
	if err := r.db.First(&customization, "user_id = ? AND operation = ?", userID, operation).Error; err != nil {
		return nil, err
	}
	return &customization, nil
}

func (r *Repository) SaveUserPromptCustomization(customization *model.UserPromptCustomization) error {
	return r.db.Save(customization).Error
}

func (r *Repository) DeleteUserPromptCustomization(userID string, operation string) error {
	return r.db.Delete(&model.UserPromptCustomization{}, "user_id = ? AND operation = ?", userID, operation).Error
}
