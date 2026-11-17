package repository

import (
	"errors"
	"fmt"
	"strings"
	"time"

	"infinite-canvas/backend/internal/model"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

func (r *Repository) AllAssets() ([]model.Asset, error) {
	var assets []model.Asset
	return assets, r.db.Find(&assets).Error
}

func (r *Repository) ReserveDailyUpload(userID string, day string, size int64, limit int64) error {
	return r.ReserveIdentifiedDailyUpload(userID, day, "", size, limit)
}

func (r *Repository) ReserveIdentifiedDailyUpload(userID string, day string, identity string, size int64, limit int64) error {
	usage := model.UserDailyUploadUsage{ID: userID + ":" + day, UserID: userID, Day: day}
	identity = strings.TrimSpace(identity)
	return r.db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Clauses(clause.OnConflict{DoNothing: true}).Create(&usage).Error; err != nil {
			return err
		}
		result := tx.Model(&model.UserDailyUploadUsage{}).
			Where("id = ? AND bytes + ? < ?", usage.ID, size, limit).
			Updates(map[string]any{"bytes": gorm.Expr("bytes + ?", size), "updated_at": time.Now()})
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected == 0 {
			return ErrDailyUploadLimitExceeded
		}
		if identity == "" {
			return nil
		}
		now := time.Now()
		err := tx.Create(&model.UserUploadReservation{
			ID:        userID + ":" + identity,
			UserID:    userID,
			Identity:  identity,
			Day:       day,
			Size:      size,
			CreatedAt: now,
			UpdatedAt: now,
		}).Error
		if isUniqueConstraint(err) {
			return ErrUploadReservationConflict
		}
		return err
	})
}

func (r *Repository) ReleaseDailyUpload(userID string, day string, size int64) error {
	return r.ReleaseIdentifiedDailyUpload(userID, day, "", size)
}

func (r *Repository) ReleaseIdentifiedDailyUpload(userID string, day string, identity string, size int64) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		return releaseIdentifiedDailyUploadTx(tx, userID, day, identity, size)
	})
}

func (r *Repository) ClearUploadReservation(userID string, identity string) error {
	return clearUploadReservationTx(r.db, userID, identity)
}

func (r *Repository) ListUploadReservations() ([]model.UserUploadReservation, error) {
	var rows []model.UserUploadReservation
	if err := r.db.Find(&rows).Error; err != nil {
		return nil, err
	}
	return rows, nil
}

func (r *Repository) UploadReservation(userID string, identity string) (*model.UserUploadReservation, error) {
	identity = strings.TrimSpace(identity)
	if strings.TrimSpace(userID) == "" || identity == "" {
		return nil, nil
	}
	var row model.UserUploadReservation
	err := r.db.Where("user_id = ? AND identity = ?", userID, identity).First(&row).Error
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, nil
		}
		return nil, err
	}
	return &row, nil
}

func (r *Repository) UserStoredFileBytes(userID string) (int64, error) {
	var total int64
	err := r.db.Raw(`
		SELECT
			COALESCE((
				SELECT SUM(physical_resources.size)
				FROM (
					SELECT MAX(size) AS size
					FROM resources
					WHERE user_id = ? AND status = ?
					GROUP BY COALESCE(NULLIF(provider, ''), 'local'), endpoint, bucket, object_key
				) AS physical_resources
			), 0)
	`, userID, model.ResourceStatusReady).Scan(&total).Error
	return total, err
}

func (r *Repository) DailyUploadBytes(userID string, day string) (int64, error) {
	var total int64
	err := r.db.Model(&model.UserDailyUploadUsage{}).Select("COALESCE(bytes, 0)").Where("user_id = ? AND day = ?", userID, day).Scan(&total).Error
	return total, err
}

func (r *Repository) CreateResource(resource *model.Resource) error {
	return r.db.Create(resource).Error
}

func (r *Repository) SaveResource(resource *model.Resource) error {
	if resource == nil {
		return errors.New("resource is nil")
	}
	identity := resourceUploadIdentity(resource)
	if identity == "" || (resource.Status != model.ResourceStatusReady && resource.Status != model.ResourceStatusFailed) {
		return r.db.Save(resource).Error
	}
	return r.db.Transaction(func(tx *gorm.DB) error {
		return saveResourceSettlingReservation(tx, resource)
	})
}

func (r *Repository) ResourceByUploadKey(userID string, uploadKey string) (*model.Resource, error) {
	var resource model.Resource
	if err := r.db.First(&resource, "user_id = ? AND upload_key = ?", userID, uploadKey).Error; err != nil {
		return nil, err
	}
	return &resource, nil
}

func (r *Repository) ClaimFailedResourceUpload(userID string, id string) (bool, error) {
	result := r.db.Model(&model.Resource{}).
		Where("id = ? AND user_id = ? AND status = ?", id, userID, model.ResourceStatusFailed).
		Updates(map[string]any{"status": model.ResourceStatusPending, "error": "", "updated_at": time.Now()})
	return result.RowsAffected == 1, result.Error
}

func (r *Repository) DeleteResource(userID string, id string) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		if tx.Migrator().HasTable(&model.CanvasWorkflowResource{}) {
			var count int64
			if err := tx.Model(&model.CanvasWorkflowResource{}).Where("user_id = ? AND resource_id = ?", userID, id).Count(&count).Error; err != nil {
				return err
			}
			if count > 0 {
				return fmt.Errorf("资源仍被工作流模板或运行记录引用")
			}
		}
		var resource model.Resource
		err := tx.Where("id = ? AND user_id = ?", id, userID).First(&resource).Error
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil
		}
		if err != nil {
			return err
		}
		if err := settleDeletedResourceReservation(tx, &resource); err != nil {
			return err
		}
		return tx.Delete(&model.Resource{}, "id = ? AND user_id = ?", id, userID).Error
	})
}

func (r *Repository) Resource(id string) (*model.Resource, error) {
	var resource model.Resource
	if err := r.db.First(&resource, "id = ?", id).Error; err != nil {
		return nil, err
	}
	return &resource, nil
}

func (r *Repository) ResourceForUser(userID string, id string) (*model.Resource, error) {
	var resource model.Resource
	if err := r.db.First(&resource, "id = ? AND user_id = ?", id, userID).Error; err != nil {
		return nil, err
	}
	return &resource, nil
}

func (r *Repository) Resources(userID string, limit int) ([]model.Resource, error) {
	var resources []model.Resource
	if limit <= 0 || limit > 500 {
		limit = 200
	}
	err := r.db.Order("created_at desc").Limit(limit).Find(&resources, "user_id = ?", userID).Error
	return resources, err
}

// ClaimPlaybackTranscode 原子地把仍为 READY 且待判定（空/none）的视频置为 processing。
// 多实例或多 goroutine 并发转同一资源时仅一个能成功置位，其余返回 false 直接放弃，
// 避免重复转码同一份文件，也不抢占已删除/非就绪行。
func (r *Repository) ClaimPlaybackTranscode(id string) (bool, error) {
	res := r.db.Model(&model.Resource{}).
		Where("id = ? AND status = ? AND (playback_status = ? OR playback_status IS NULL OR playback_status = ?)",
			id, model.ResourceStatusReady, "", model.PlaybackStatusNone).
		Updates(map[string]any{"playback_status": model.PlaybackStatusProcessing, "playback_error": ""})
	if res.Error != nil {
		return false, res.Error
	}
	return res.RowsAffected > 0, nil
}

// ResetStuckPlaybackTranscodes 服务重启时把卡在 processing 的转码记录重置回待判定
// （进程崩溃后转码 goroutine 随进程消亡，状态永远停在 processing）。
func (r *Repository) ResetStuckPlaybackTranscodes() error {
	return r.db.Model(&model.Resource{}).
		Where("playback_status = ?", model.PlaybackStatusProcessing).
		Updates(map[string]any{"playback_status": "", "playback_error": "", "updated_at": time.Now()}).Error
}

// ReleasePlaybackTranscodeClaim 把仍处于 processing 且资源仍 READY 的 claim 放回待判定，
// 供 Runner 拒绝或 Stop 取消后由下次启动回填恢复。
func (r *Repository) ReleasePlaybackTranscodeClaim(id string) error {
	return r.db.Model(&model.Resource{}).
		Where("id = ? AND playback_status = ? AND status = ?", id, model.PlaybackStatusProcessing, model.ResourceStatusReady).
		Updates(map[string]any{"playback_status": "", "playback_error": "", "updated_at": time.Now()}).Error
}

// FinishPlaybackTranscode 仅在 claim 仍为 processing 且资源仍为 READY 时写入终态，
// 避免整行 Save 把并发删除或其他更新复活/覆盖。
func (r *Repository) FinishPlaybackTranscode(id, status, objectKey, errText string) (bool, error) {
	res := r.db.Model(&model.Resource{}).
		Where("id = ? AND playback_status = ? AND status = ?", id, model.PlaybackStatusProcessing, model.ResourceStatusReady).
		Updates(map[string]any{
			"playback_status":     status,
			"playback_object_key": objectKey,
			"playback_error":      errText,
			"updated_at":          time.Now(),
		})
	if res.Error != nil {
		return false, res.Error
	}
	return res.RowsAffected == 1, nil
}

// MarkPlaybackNone 只把 READY 且尚未进入 processing/ready/failed 的行标为 none。
func (r *Repository) MarkPlaybackNone(id string) (bool, error) {
	res := r.db.Model(&model.Resource{}).
		Where("id = ? AND status = ? AND (playback_status = ? OR playback_status IS NULL OR playback_status = ?)",
			id, model.ResourceStatusReady, "", model.PlaybackStatusNone).
		Updates(map[string]any{"playback_status": model.PlaybackStatusNone, "playback_error": "", "updated_at": time.Now()})
	if res.Error != nil {
		return false, res.Error
	}
	return res.RowsAffected == 1, nil
}

func (r *Repository) ResourceCleanupCandidates(incompleteBefore time.Time, readyBefore time.Time, limit int) ([]model.Resource, error) {
	var resources []model.Resource
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	err := r.db.Where(
		"(status IN ? AND updated_at <= ?) OR (status = ? AND created_at <= ?)",
		[]model.ResourceStatus{model.ResourceStatusPending, model.ResourceStatusFailed}, incompleteBefore,
		model.ResourceStatusReady, readyBefore,
	).Order("created_at asc, id asc").Limit(limit).Find(&resources).Error
	return resources, err
}
func (r *Repository) Assets(userID string) ([]model.Asset, error) {
	var assets []model.Asset
	err := r.db.Order("updated_at desc").Find(&assets, "user_id = ?", userID).Error
	return assets, err
}

func (r *Repository) AssetSummaries(userID string) ([]model.Asset, error) {
	var assets []model.Asset
	err := r.db.Select("id", "folder_id", "kind", "category", "status", "primary_version_id", "title", "created_at", "updated_at").Order("updated_at desc").Find(&assets, "user_id = ?", userID).Error
	return assets, err
}

func (r *Repository) Asset(id string) (*model.Asset, error) {
	var asset model.Asset
	if err := r.db.First(&asset, "id = ?", id).Error; err != nil {
		return nil, err
	}
	return &asset, nil
}

func (r *Repository) AssetForUser(userID string, id string) (*model.Asset, error) {
	var asset model.Asset
	if err := r.db.First(&asset, "id = ? AND user_id = ?", id, userID).Error; err != nil {
		return nil, err
	}
	return &asset, nil
}

func (r *Repository) AssetsForUserIDs(userID string, ids []string) ([]model.Asset, error) {
	if len(ids) == 0 {
		return nil, nil
	}
	var assets []model.Asset
	err := r.db.Find(&assets, "user_id = ? AND id IN ?", userID, ids).Error
	return assets, err
}

func (r *Repository) UpsertAsset(asset *model.Asset) error {
	result := r.db.Model(&model.Asset{}).
		Where("id = ? AND user_id = ?", asset.ID, asset.UserID).
		Updates(map[string]any{"folder_id": asset.FolderID, "kind": asset.Kind, "category": asset.Category, "status": asset.Status, "primary_version_id": asset.PrimaryVersionID, "title": asset.Title, "payload_json": asset.PayloadJSON, "updated_at": asset.UpdatedAt})
	if result.Error != nil || result.RowsAffected > 0 {
		return result.Error
	}
	return r.db.Create(asset).Error
}

func (r *Repository) DeleteAsset(userID string, id string) error {
	return r.DeleteAssetAndResources(userID, id, nil, nil)
}

func (r *Repository) FindExpiredArchivedAssets(cutoff time.Time, limit int) ([]model.Asset, error) {
	var assets []model.Asset
	if limit <= 0 {
		limit = 100
	}
	err := r.db.Where("status = ? AND updated_at <= ?", model.AssetVersionStatusArchived, cutoff).
		Order("updated_at asc, id asc").
		Limit(limit).
		Find(&assets).Error
	return assets, err
}

func (r *Repository) ReplaceAssets(userID string, assets []model.Asset) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Delete(&model.Asset{}, "user_id = ?", userID).Error; err != nil {
			return err
		}
		if len(assets) == 0 {
			return nil
		}
		return tx.Create(&assets).Error
	})
}
