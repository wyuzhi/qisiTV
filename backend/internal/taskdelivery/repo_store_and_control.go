package taskdelivery

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	localasset "qisitv/backend/internal/asset"
	"qisitv/backend/internal/kernel"
	"qisitv/backend/internal/model"
	"qisitv/backend/internal/playback"
	"qisitv/backend/internal/repository"
	localtask "qisitv/backend/internal/task"

	"gorm.io/gorm"
)

const (
	GenerationDeliveryRecoveryInterval = 5 * time.Second
	GenerationDownloadTimeout          = 15 * time.Minute
)

func DeliveryPaused(stage string) bool {
	return stage == "delivery_paused" || stage == "delivery_timed_out"
}

func ModelTaskOutputs(outputs []localtask.CanonicalOutput) []model.TaskOutput {
	if len(outputs) == 0 {
		return nil
	}
	result := make([]model.TaskOutput, 0, len(outputs))
	for _, output := range outputs {
		item := model.TaskOutput{
			OutputIndex:              output.OutputIndex,
			MediaType:                output.MediaType,
			ProviderArtifactRef:      output.ProviderArtifactRef,
			MaterializedAssetID:      output.MaterializedAssetID,
			MaterializationErrorCode: output.MaterializationErrorCode,
			ResourceID:               output.ResourceID,
			EffectKey:                output.EffectKey,
		}
		if output.TargetBinding != nil && !output.TargetBinding.Empty() {
			item.TargetBinding = &model.TaskOutputTarget{
				NodeID:         output.TargetBinding.NodeID,
				MessageID:      output.TargetBinding.MessageID,
				ConversationID: output.TargetBinding.ConversationID,
				Source:         output.TargetBinding.Source,
			}
		}
		result = append(result, item)
	}
	return result
}

type RepoStore struct {
	Repo        *repository.Repository
	PublicInput func(string) string
}

func NewRepoStore(repo *repository.Repository, publicInput func(string) string) Store {
	return RepoStore{Repo: repo, PublicInput: publicInput}
}

func (s RepoStore) WithTx(fn func(Store) error) error {
	if s.Repo == nil {
		return errors.New("generation delivery store is not initialized")
	}
	return s.Repo.Transaction(func(tx *repository.Repository) error {
		return fn(RepoStore{Repo: tx, PublicInput: s.PublicInput})
	})
}

func (s RepoStore) GenerationOutputResults(taskID string) ([]model.Result, error) {
	return s.Repo.GenerationOutputResults(taskID)
}

func (s RepoStore) GenerationOutputResultsForTasks(taskIDs []string) ([]model.Result, error) {
	return s.Repo.GenerationOutputResultsForTasks(taskIDs)
}

func (s RepoStore) AssetRepresentationsForTask(taskID string) ([]model.AssetRepresentation, error) {
	return s.Repo.AssetRepresentationsForTask(taskID)
}

func (s RepoStore) ResourceForUser(userID, id string) (*model.Resource, error) {
	resource, err := s.Repo.ResourceForUser(userID, id)
	return resource, MapDeliveryStoreErr(err)
}

func (s RepoStore) Resource(id string) (*model.Resource, error) {
	resource, err := s.Repo.Resource(id)
	return resource, MapDeliveryStoreErr(err)
}

func (s RepoStore) Asset(id string) (*model.Asset, error) {
	asset, err := s.Repo.Asset(id)
	return asset, MapDeliveryStoreErr(err)
}

func (s RepoStore) AssetVersion(id string) (*model.AssetVersion, error) {
	version, err := s.Repo.AssetVersion(id)
	return version, MapDeliveryStoreErr(err)
}

func (s RepoStore) CommitOwned(item OwnedDelivery) error {
	if err := MapDeliveryStoreErr(s.Repo.CommitOwnedGenerationDelivery(repository.GenerationDeliveryItem{
		Result:         item.Result,
		Asset:          item.Asset,
		Version:        item.Version,
		Representation: item.Representation,
	})); err != nil {
		return err
	}
	task, err := s.Repo.Task(item.Result.TaskID)
	if err != nil || (!DeliveryPaused(task.Stage) && task.Stage != "正在取回结果" && !strings.Contains(task.InputJSON, `"imageDeliveryCipher"`)) {
		return err
	}
	rows, err := s.Repo.GenerationOutputResults(task.ID)
	if err != nil {
		return err
	}
	outputs, err := DecodeStoredOutputs(rows)
	if err != nil {
		return err
	}
	if localtask.DeliveryComplete(task.ResultJSON, outputs, task.Type) {
		pub := ""
		if s.PublicInput != nil {
			pub = s.PublicInput(task.InputJSON)
		}
		return s.Repo.FinishGenerationDelivery(task.UserID, task.ID, task.InputJSON, pub)
	}
	return nil
}

func (s RepoStore) SucceededTasksForDelivery(afterID string, limit int) ([]model.Task, error) {
	return s.Repo.SucceededTasksForDelivery(afterID, limit)
}

func MapDeliveryStoreErr(err error) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return ErrNotFound
	}
	if errors.Is(err, repository.ErrAssetOwnedByAnotherUser) {
		return ErrForeignAsset
	}
	return err
}

func CanvasBindingIntents(deliverer *Deliverer, task model.Task, blocksRetry bool) []localtask.CanvasBindingIntent {
	stored, loadErr := deliverer.LoadedOutputs(task.ID)
	proj := Project(task, stored, loadErr, blocksRetry)
	return localtask.CanvasBindingIntents(task.ID, proj.Outputs)
}

func EnsureSucceededTaskDelivery(deliverer *Deliverer, task *model.Task, deliver func(model.Task) error) error {
	if task == nil || task.Status != model.TaskStatusSucceeded {
		return nil
	}
	stored, err := deliverer.LoadedOutputs(task.ID)
	if err != nil {
		return err
	}
	if localtask.DeliveryComplete(task.ResultJSON, stored, task.Type) {
		return nil
	}
	return deliver(*task)
}

func AttachTaskDelivery(
	deliverer *Deliverer,
	task *model.Task,
	hydrateReqID func(*model.Task),
	outcomeFacts func([]model.Task) map[string]localtask.OutcomeFacts,
	blocksRetry bool,
	deliveryProgress *model.TaskDeliveryProgress,
) {
	if task == nil {
		return
	}
	if task.Status == model.TaskStatusFailed && task.ProviderRequestID == "" && hydrateReqID != nil {
		hydrateReqID(task)
	}
	stored, loadErr := deliverer.LoadedOutputs(task.ID)
	facts := outcomeFacts([]model.Task{*task})
	proj := ProjectWithFacts(*task, stored, loadErr, blocksRetry, facts[task.ID])
	task.Outcome = &proj.Outcome
	task.Outputs = ModelTaskOutputs(proj.Outputs)
	task.ResultState = proj.ResultState
	task.Stage = proj.Stage
	task.Delivery = deliveryProgress
}

func AttachTaskSummaryDeliveries(
	deliverer *Deliverer,
	tasks []model.Task,
	summaries []localtask.Summary,
	outcomeFacts func([]model.Task) map[string]localtask.OutcomeFacts,
	blocksRetry func(string, string) bool,
	deliveryForTask func(string) *model.TaskDeliveryProgress,
	applyExtra func(index int, taskID string),
) {
	if len(tasks) == 0 || len(summaries) == 0 {
		return
	}
	ids := make([]string, 0, len(tasks))
	taskByID := make(map[string]model.Task, len(tasks))
	for _, task := range tasks {
		ids = append(ids, task.ID)
		taskByID[task.ID] = task
	}
	byTask, decodeErrs, loadErr := deliverer.LoadedOutputsForTasks(ids)
	facts := outcomeFacts(tasks)
	for index := range summaries {
		task, ok := taskByID[summaries[index].ID]
		if !ok {
			continue
		}
		taskLoadErr := loadErr
		if taskLoadErr == nil {
			taskLoadErr = decodeErrs[task.ID]
		}
		proj := ProjectWithFacts(task, byTask[task.ID], taskLoadErr, blocksRetry(task.Error, task.Stage), facts[task.ID])
		summaries[index].Outcome = &proj.Outcome
		summaries[index].Outputs = proj.Outputs
		summaries[index].ResultState = proj.ResultState
		summaries[index].Stage = proj.Stage
		if deliveryForTask != nil {
			summaries[index].Delivery = deliveryForTask(task.ID)
		}
		if applyExtra != nil {
			applyExtra(index, task.ID)
		}
	}
}

func PauseGenerationDownload(
	mu *sync.Mutex,
	repo *repository.Repository,
	deliverer *Deliverer,
	cancels map[string]context.CancelFunc,
	deadlines map[string]time.Time,
	attach func(*model.Task),
	task model.Task,
	stage string,
) (*model.Task, error) {
	mu.Lock()
	defer mu.Unlock()
	stored, err := deliverer.LoadedOutputs(task.ID)
	if err != nil {
		return nil, err
	}
	if localtask.DeliveryComplete(task.ResultJSON, stored, task.Type) {
		return nil, kernel.BadAuthRequest("生成结果已取回")
	}
	if err := repo.Transaction(func(tx *repository.Repository) error {
		if err := tx.SetGenerationDeliveryStage(task.UserID, task.ID, stage); err != nil {
			return err
		}
		rows, err := tx.GenerationOutputResults(task.ID)
		if err != nil {
			return err
		}
		outputs, err := DecodeStoredOutputs(rows)
		if err != nil {
			return err
		}
		if localtask.DeliveryComplete(task.ResultJSON, outputs, task.Type) {
			stage = "生成完成"
			return tx.SetGenerationDeliveryStage(task.UserID, task.ID, stage)
		}
		return nil
	}); err != nil {
		return nil, err
	}
	for identity, cancel := range cancels {
		if strings.HasPrefix(identity, task.ID+":") {
			cancel()
		}
	}
	for identity := range deadlines {
		if strings.HasPrefix(identity, task.ID+":") {
			delete(deadlines, identity)
		}
	}
	task.Stage = stage
	if attach != nil {
		attach(&task)
	}
	return &task, nil
}

func ResumeGenerationDownload(
	mu *sync.Mutex,
	closed *bool,
	isDraining func() bool,
	repo *repository.Repository,
	cancels map[string]context.CancelFunc,
	attach func(*model.Task),
	task model.Task,
) (*model.Task, error) {
	mu.Lock()
	defer mu.Unlock()
	if (closed != nil && *closed) || (isDraining != nil && isDraining()) {
		return nil, &kernel.AppError{Status: kernel.CodeUnavailable, Code: kernel.CodeUnavailable, Message: localtask.DrainRetryMessage, Retryable: true}
	}
	for identity := range cancels {
		if strings.HasPrefix(identity, task.ID+":") {
			return nil, errors.New("正在停止取回，请稍后再试")
		}
	}
	if err := repo.SetGenerationDeliveryStage(task.UserID, task.ID, "正在取回结果"); err != nil {
		return nil, err
	}
	task.Stage = "正在取回结果"
	if attach != nil {
		attach(&task)
	}
	return &task, nil
}

func BeginGenerationDownload(
	mu *sync.Mutex,
	closed *bool,
	isDraining func() bool,
	repo *repository.Repository,
	parentCtx context.Context,
	startTrace func(context.Context, model.Task) (context.Context, func(string)),
	traceReason func(error) string,
	pauseOnTimeout func(model.Task),
	deadlines *map[string]time.Time,
	cancels *map[string]context.CancelFunc,
	userID, identity string,
	timeout time.Duration,
) (context.Context, func(error), error) {
	mu.Lock()
	if *closed || (isDraining != nil && isDraining()) {
		mu.Unlock()
		return nil, nil, context.Canceled
	}
	mu.Unlock()
	taskID, _, ok := strings.Cut(identity, ":")
	if !ok {
		return nil, nil, errors.New("generation delivery identity is invalid")
	}
	task, err := repo.TaskForUser(userID, taskID)
	if err != nil {
		return nil, nil, err
	}
	if task.Status != model.TaskStatusSucceeded || DeliveryPaused(task.Stage) {
		return nil, nil, context.Canceled
	}
	if parentCtx == nil {
		parentCtx = context.Background()
	}
	parent, finishTrace := startTrace(parentCtx, *task)
	mu.Lock()
	current, readErr := repo.TaskForUser(userID, taskID)
	if readErr != nil || *closed || (isDraining != nil && isDraining()) || current.Status != model.TaskStatusSucceeded || DeliveryPaused(current.Stage) {
		mu.Unlock()
		if readErr == nil {
			readErr = context.Canceled
		}
		finishTrace("download_not_started")
		return nil, nil, readErr
	}
	if *deadlines == nil {
		*deadlines = map[string]time.Time{}
	}
	deadline, exists := (*deadlines)[identity]
	if !exists {
		deadline = time.Now().Add(timeout)
		(*deadlines)[identity] = deadline
	}
	ctx, cancel := context.WithDeadline(parent, deadline)
	if *cancels == nil {
		*cancels = map[string]context.CancelFunc{}
	}
	(*cancels)[identity] = cancel
	mu.Unlock()
	return ctx, func(downloadErr error) {
		reason := traceReason(downloadErr)
		if downloadErr != nil && ctx.Err() != nil {
			reason = traceReason(ctx.Err())
		}
		defer finishTrace(reason)
		if errors.Is(ctx.Err(), context.DeadlineExceeded) && pauseOnTimeout != nil {
			pauseOnTimeout(*task)
		}
		cancel()
		mu.Lock()
		delete(*cancels, identity)
		if downloadErr == nil {
			delete(*deadlines, identity)
		}
		mu.Unlock()
	}, nil
}

func StopGenerationDownloads(mu *sync.Mutex, closed *bool, cancels map[string]context.CancelFunc) {
	mu.Lock()
	defer mu.Unlock()
	*closed = true
	for _, cancel := range cancels {
		cancel()
	}
}

func NewServiceIngestor(resources *localasset.Service, maxBytes func() (int64, error)) *Ingestor {
	return NewIngestor(IngestDeps{
		Store:      NewAssetInlineStore(resources),
		MaxBytes:   maxBytes,
		ProbeVideo: playback.ProbeGeneratedVideoMedia,
	})
}

func PersistTaskGeneratedMediaResult(
	ingestor *Ingestor,
	task model.Task,
	result map[string]interface{},
	startTrace func(model.Task) func(string),
	traceReason func(error) string,
) (persisted map[string]interface{}, err error) {
	finishTrace := startTrace(task)
	defer func() { finishTrace(traceReason(err)) }()
	if strings.TrimSpace(task.ID) == "" || strings.TrimSpace(task.UserID) == "" {
		return nil, fmt.Errorf("生成结果缺少任务身份")
	}
	persisted, err = ingestor.IngestResult(task.UserID, result, IngestOptions{
		EnforceQuota: true, IdentityPrefix: task.ID + ":inline",
	})
	if full := kernel.DiskFullError(err); full != nil {
		return nil, full
	}
	return persisted, err
}

func DecodeDataURLWithLimit(value string, maxBytes func() (int64, error)) (string, []byte, error) {
	mimeType, data, err := DecodeInlineDataURL(value)
	if err != nil {
		return "", nil, err
	}
	limit, err := maxBytes()
	if err != nil {
		return "", nil, err
	}
	if limit > 0 && int64(len(data)) > limit {
		return "", nil, fmt.Errorf("单个生成资源超过 %dMB", limit>>20)
	}
	return mimeType, data, nil
}

func GenerationLocalArtifactPresent(dataDir string, resource *model.Resource) bool {
	if resource == nil || strings.TrimSpace(resource.ObjectKey) == "" {
		return false
	}
	body, err := localasset.NewFileStore(dataDir).Open(resource.ObjectKey)
	if err != nil {
		return false
	}
	_ = body.Close()
	return true
}
