package database

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"qisitv/backend/internal/kernel"
	"qisitv/backend/internal/model"

	"gorm.io/gorm"
)

const CurrentSchemaVersion int64 = 2

type localSchemaMigration struct {
	Version   int64 `gorm:"primaryKey;autoIncrement:false"`
	Name      string
	AppliedAt time.Time
}

func (localSchemaMigration) TableName() string { return "local_schema_migrations" }

type localMigration struct {
	version     int64
	name        string
	destructive bool
	apply       func(*gorm.DB) error
}

type SchemaStatus struct {
	Current  int64 `json:"current"`
	Expected int64 `json:"expected"`
	Ready    bool  `json:"ready"`
}

// LocalModels is the complete native-app persistence surface. SaaS identity,
// billing, payments, object-storage settings, announcements, public shares,
// and managed model catalogs are deliberately absent.
func LocalModels() []any {
	return []any{
		&model.Workspace{}, &model.IDSequence{}, &model.SystemSetting{}, &model.UserDailyActivity{},
		&model.ModelChannel{}, &model.ChannelModel{}, &model.ChannelModelVariant{}, &model.ApiCallLog{},
		&model.LogicalModel{}, &model.LogicalModelRevision{}, &model.LogicalModelRoute{}, &model.RouteAttempt{},
		&model.CloudAgentExecution{}, &model.CloudAgentCanvasMutation{}, &model.AgentProfile{}, &model.AgentLesson{}, &model.AgentMemorySetting{},
		&model.PluginPlatformState{}, &model.UserPluginState{},
		&model.Skill{}, &model.SkillVersion{}, &model.SkillFile{}, &model.UserSkillState{},
		&model.Resource{}, &model.ResourceDeletionJob{}, &model.UserDailyUploadUsage{}, &model.ArkPrivateAssetBinding{},
		&model.Asset{}, &model.AssetFolder{}, &model.AssetVersion{}, &model.AssetRepresentation{},
		&model.ProjectAssetLink{}, &model.ProjectAssetFolder{}, &model.ProjectAssetCandidate{},
		&model.VoiceProfile{}, &model.CharacterVoiceBinding{},
		&model.Project{}, &model.ProjectFolder{}, &model.StyleProfile{}, &model.ProjectUnit{}, &model.CanvasUnitLink{},
		&model.Shot{}, &model.ShotRevision{}, &model.ShotArtifact{}, &model.ShotAssetReference{},
		&model.WorkflowTemplateVersion{}, &model.WorkflowInstance{}, &model.WorkflowStepInstance{}, &model.WorkflowStepTask{}, &model.ProductionTaskLink{},
		&model.CanvasProject{}, &model.CanvasSnapshot{}, &model.CanvasSnapshotResource{},
		&model.PromptTemplate{}, &model.UserPromptCustomization{},
		&model.Task{}, &model.CreationRun{}, &model.CreationSubmission{}, &model.TaskTextDelta{}, &model.TaskLog{}, &model.Result{},
	}
}

func MigrateLocalSchema(db *gorm.DB) error {
	return migrateLocalSchema(db, nil)
}

func migrateLocalSchema(db *gorm.DB, beforeApply func(int64) error) error {
	if err := db.AutoMigrate(&localSchemaMigration{}); err != nil {
		return fmt.Errorf("初始化本地结构版本表: %w", err)
	}
	migrations := []localMigration{
		{version: 1, name: "local-core-schema", apply: migrateLocalCoreSchema},
		{version: 2, name: "retire-hosted-schema", destructive: true, apply: migrateRetiredHostedSchema},
	}
	current, err := currentSchemaVersion(db)
	if err != nil {
		return err
	}
	for _, migration := range migrations {
		if migration.version <= current {
			continue
		}
		if migration.destructive {
			if err := backupBeforeDestructiveMigration(db, migration.version); err != nil {
				return err
			}
		}
		if beforeApply != nil {
			if err := beforeApply(migration.version); err != nil {
				return fmt.Errorf("迁移 v%d %s 前置检查: %w", migration.version, migration.name, err)
			}
		}
		if err := db.Transaction(func(tx *gorm.DB) error {
			if err := migration.apply(tx); err != nil {
				return err
			}
			return tx.Create(&localSchemaMigration{Version: migration.version, Name: migration.name, AppliedAt: time.Now().UTC()}).Error
		}); err != nil {
			return fmt.Errorf("执行本地数据库迁移 v%d %s: %w", migration.version, migration.name, err)
		}
		current = migration.version
	}
	return nil
}

func migrateLocalCoreSchema(tx *gorm.DB) error {
	if err := tx.AutoMigrate(LocalModels()...); err != nil {
		return fmt.Errorf("迁移本地工作区结构: %w", err)
	}
	if err := ensureLocalWorkspace(tx); err != nil {
		return err
	}
	return backfillProjectUnitWordCounts(tx)
}

func migrateRetiredHostedSchema(tx *gorm.DB) error {
	if tx.Migrator().HasTable("creation_submissions") && tx.Migrator().HasColumn("creation_submissions", "quote_json") {
		if err := migrateLegacyCreationSubmissions(tx); err != nil {
			return err
		}
	}
	if tx.Migrator().HasTable("channel_model_price_tiers") {
		if err := migrateLegacyChannelModelVariants(tx); err != nil {
			return err
		}
	}
	return dropHostedTables(tx)
}

func currentSchemaVersion(db *gorm.DB) (int64, error) {
	var version int64
	if err := db.Model(&localSchemaMigration{}).Select("COALESCE(MAX(version), 0)").Scan(&version).Error; err != nil {
		return 0, fmt.Errorf("读取本地结构版本: %w", err)
	}
	return version, nil
}

func backupBeforeDestructiveMigration(db *gorm.DB, version int64) error {
	needsBackup := false
	for _, table := range hostedTables() {
		if db.Migrator().HasTable(table) {
			needsBackup = true
			break
		}
	}
	if !needsBackup && db.Migrator().HasTable("creation_submissions") {
		needsBackup = db.Migrator().HasColumn("creation_submissions", "quote_json")
	}
	if !needsBackup {
		return nil
	}
	var databases []struct {
		Seq  int
		Name string
		File string
	}
	if err := db.Raw("PRAGMA database_list").Scan(&databases).Error; err != nil {
		return fmt.Errorf("读取 SQLite 数据库路径: %w", err)
	}
	databasePath := ""
	for _, item := range databases {
		if item.Name == "main" {
			databasePath = strings.TrimSpace(item.File)
			break
		}
	}
	// In-memory test and ephemeral databases have no recoverable file to copy.
	if databasePath == "" || databasePath == ":memory:" {
		return nil
	}
	backupDir := filepath.Join(filepath.Dir(databasePath), "backups")
	if err := os.MkdirAll(backupDir, 0o700); err != nil {
		return fmt.Errorf("创建数据库备份目录: %w", err)
	}
	backupPath := filepath.Join(backupDir, fmt.Sprintf("before-schema-v%d-%s.db", version, time.Now().UTC().Format("20060102T150405.000000000Z")))
	quotedPath := strings.ReplaceAll(backupPath, "'", "''")
	if err := db.Exec("VACUUM INTO '" + quotedPath + "'").Error; err != nil {
		return fmt.Errorf("创建破坏性迁移前备份: %w", err)
	}
	return nil
}

func migrateLegacyChannelModelVariants(db *gorm.DB) error {
	type legacyVariant struct {
		ID               string
		ChannelModelID   string
		SelectorKey      string
		SelectorJSON     string
		Resolution       string
		VideoSeconds     int
		ProviderModelKey string
		Enabled          bool
		CreatedAt        time.Time
		UpdatedAt        time.Time
		DeletedAt        gorm.DeletedAt
	}
	var items []legacyVariant
	if err := db.Table("channel_model_price_tiers").Select(
		"id, channel_model_id, selector_key, selector_json, resolution, video_seconds, provider_model_key, enabled, created_at, updated_at, deleted_at",
	).Find(&items).Error; err != nil {
		return fmt.Errorf("读取旧模型规格: %w", err)
	}
	for _, item := range items {
		selectorJSON := strings.TrimSpace(item.SelectorJSON)
		if selectorJSON == "" {
			selectorJSON = "{}"
		}
		selectorKey := strings.TrimSpace(item.SelectorKey)
		if selectorKey == "" {
			selectorKey = selectorJSON
		}
		variant := model.ChannelModelVariant{
			ID: item.ID, ChannelModelID: item.ChannelModelID,
			SelectorKey: selectorKey, SelectorJSON: selectorJSON,
			Resolution: item.Resolution, VideoSeconds: item.VideoSeconds,
			ProviderModelKey: item.ProviderModelKey, Enabled: item.Enabled,
			CreatedAt: item.CreatedAt, UpdatedAt: item.UpdatedAt, DeletedAt: item.DeletedAt,
		}
		if err := db.Where("id = ?", variant.ID).FirstOrCreate(&variant).Error; err != nil {
			return fmt.Errorf("迁移模型规格 %s: %w", item.ID, err)
		}
	}
	return nil
}

func migrateLegacyCreationSubmissions(db *gorm.DB) error {
	type legacySubmission struct {
		ID             string
		QuoteJSON      string
		PriceSignature string
	}
	var items []legacySubmission
	if err := db.Table("creation_submissions").Select("id, quote_json, price_signature").Find(&items).Error; err != nil {
		return fmt.Errorf("读取旧创作执行项: %w", err)
	}
	for _, item := range items {
		legacy := struct {
			Model     string         `json:"model"`
			QuoteHash string         `json:"quoteHash"`
			Options   map[string]any `json:"options"`
		}{}
		_ = json.Unmarshal([]byte(item.QuoteJSON), &legacy)
		execution, _ := json.Marshal(map[string]any{
			"model": legacy.Model, "configHash": legacy.QuoteHash, "options": legacy.Options,
		})
		if err := db.Table("creation_submissions").Where("id = ?", item.ID).Updates(map[string]any{
			"execution_json": string(execution), "config_signature": item.PriceSignature,
		}).Error; err != nil {
			return fmt.Errorf("迁移创作执行项 %s: %w", item.ID, err)
		}
	}
	for _, column := range []string{"quote_json", "price_signature", "expires_at"} {
		if db.Migrator().HasColumn("creation_submissions", column) {
			// The desktop runtime is SQLite-only. Using the native statement here
			// avoids GORM's SQLite table-rebuild path dereferencing a nil schema
			// when the retired column is intentionally absent from the Go model.
			if err := db.Exec("ALTER TABLE creation_submissions DROP COLUMN " + column).Error; err != nil {
				return fmt.Errorf("删除创作执行项旧字段 %s: %w", column, err)
			}
		}
	}
	return nil
}

func RequireLocalSchema(db *gorm.DB) error {
	for _, table := range []any{&model.Workspace{}, &model.Resource{}, &model.Project{}, &model.CanvasProject{}, &model.Task{}} {
		if !db.Migrator().HasTable(table) {
			return fmt.Errorf("本地工作区数据库结构缺失，请启用自动迁移")
		}
	}
	version, err := currentSchemaVersion(db)
	if err != nil {
		return err
	}
	if version != CurrentSchemaVersion {
		return fmt.Errorf("本地工作区数据库版本为 %d，期望 %d，请启用自动迁移", version, CurrentSchemaVersion)
	}
	return nil
}

func ReadSchemaStatus(db *gorm.DB) (SchemaStatus, error) {
	status := SchemaStatus{Expected: CurrentSchemaVersion}
	if err := RequireLocalSchema(db); err != nil {
		return status, nil
	}
	status.Current, _ = currentSchemaVersion(db)
	status.Ready = status.Current == CurrentSchemaVersion
	return status, nil
}

func backfillProjectUnitWordCounts(db *gorm.DB) error {
	var units []model.ProjectUnit
	if err := db.Select("id", "source_text").Where("word_count = 0 AND source_text <> ''").Find(&units).Error; err != nil {
		return fmt.Errorf("读取待回填章节字数：%w", err)
	}
	for _, unit := range units {
		wordCount := model.ProjectUnitWordCount(unit.SourceText)
		if err := db.Model(&model.ProjectUnit{}).Where("id = ?", unit.ID).Update("word_count", wordCount).Error; err != nil {
			return fmt.Errorf("回填章节 %s 字数：%w", unit.ID, err)
		}
	}
	return nil
}

func ensureLocalWorkspace(db *gorm.DB) error {
	var existing model.Workspace
	if err := db.Order("created_at ASC").First(&existing).Error; err == nil {
		return nil
	} else if !errors.Is(err, gorm.ErrRecordNotFound) {
		return fmt.Errorf("读取本地工作区: %w", err)
	}

	id := legacyWorkspaceOwnerID(db)
	if id == "" {
		id = kernel.NewID()
	}
	now := time.Now().UTC()
	if err := db.Create(&model.Workspace{ID: id, Name: "本地工作区", CreatedAt: now, UpdatedAt: now}).Error; err != nil {
		return fmt.Errorf("创建本地工作区: %w", err)
	}
	return nil
}

func legacyWorkspaceOwnerID(db *gorm.DB) string {
	if db.Migrator().HasTable("users") {
		var id string
		if err := db.Table("users").Select("id").Where("username = ?", "local").Limit(1).Scan(&id).Error; err == nil && id != "" {
			return id
		}
	}
	for _, table := range []string{"projects", "resources", "tasks", "canvas_projects", "assets"} {
		if !db.Migrator().HasTable(table) {
			continue
		}
		var id string
		if err := db.Table(table).Select("user_id").Where("user_id <> ''").Limit(1).Scan(&id).Error; err == nil && id != "" {
			return id
		}
	}
	return ""
}

func dropHostedTables(db *gorm.DB) error {
	for _, table := range hostedTables() {
		if db.Migrator().HasTable(table) {
			if err := db.Migrator().DropTable(table); err != nil {
				return fmt.Errorf("删除托管版遗留表 %s: %w", table, err)
			}
		}
	}
	return nil
}

func hostedTables() []string {
	return []string{
		// Hosted identity and authentication.
		"auth_sessions", "user_identities", "oauth_states", "email_verification_codes", "users",
		// Hosted content distribution and object-storage control planes.
		"announcements", "announcement_image_drafts", "user_announcement_reads", "banner_announcements", "canvas_shares",
		"user_oss_settings", "storage_locations",
		// Commerce, wallet, payment, redemption, and reconciliation.
		"model_pricings", "credit_accounts", "credit_ledger_entries", "billing_orders", "billing_reviews",
		"topup_products", "payment_provider_configs", "payment_orders", "payment_notifications",
		"payment_reconciliation_runs", "payment_reconciliation_items", "redeem_batches", "redeem_codes",
		"channel_model_price_tiers", "logical_model_price_skus",
	}
}
