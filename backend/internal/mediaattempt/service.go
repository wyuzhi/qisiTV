// Package mediaattempt owns persisted media submission identities, send fences,
// original-task queries and bounded failed-image recovery. It never chooses a new route.
package mediaattempt

import (
	"context"
	"github.com/google/uuid"
	"qisitv/backend/internal/beefapi"
	"qisitv/backend/internal/generation"
	"qisitv/backend/internal/localcrypto"
	"qisitv/backend/internal/model"
	"qisitv/backend/internal/repository"
	"sync"
	"sync/atomic"
	"time"
)

type Connections interface {
	SystemChannel(string) (*model.ModelChannel, error)
	ReadLocalModelConfig() ([]byte, error)
	HasManagedCredential() bool
	LookupManagedCredential() (string, string, string, string, error)
	ResolveProviderConfig(generation.Config) (generation.Config, error)
}
type Runtime interface {
	IsDraining() bool
	Go(func()) bool
	ForTask(context.Context, model.Task) context.Context
	Bind(context.Context, generation.CallMeta) context.Context
	Receipts(context.Context) context.Context
	HasAccounting() bool
}
type Completion interface {
	Save(*model.Task, []byte, []byte, bool) error
	Present(*model.Task) *model.Task
}
type Dependencies struct {
	Repository  *repository.Repository
	Secrets     localcrypto.TaskCodec
	Connections Connections
	Runtime     Runtime
	Completion  Completion
	Log         func(string, string, string, string, string) error
}
type Service struct {
	repo                 *repository.Repository
	secrets              localcrypto.TaskCodec
	connections          Connections
	runtime              Runtime
	completion           Completion
	log                  func(string, string, string, string, string) error
	imageRecoveryActive  atomic.Bool
	scanMu               sync.Mutex
	imageRecoveryAfterID string
}

func New(deps Dependencies) *Service {
	return &Service{repo: deps.Repository, secrets: deps.Secrets, connections: deps.Connections, runtime: deps.Runtime, completion: deps.Completion, log: deps.Log}
}
func (s *Service) ManagedPort() beefapi.MediaStatePort { return managedMediaPort{service: s} }
func (s *Service) ImageRecoveryCursor() string {
	s.scanMu.Lock()
	defer s.scanMu.Unlock()
	return s.imageRecoveryAfterID
}

type SubmissionKeyContext struct{}

func WithAttempt(ctx context.Context, attempt *model.RouteAttempt) context.Context {
	if attempt == nil {
		return ctx
	}
	key := uuid.NewSHA1(uuid.NameSpaceOID, []byte(attempt.TaskID+":"+attempt.ID)).String()
	ctx = context.WithValue(ctx, AttemptContext{}, attempt.ID)
	ctx = context.WithValue(ctx, SubmissionKeyContext{}, key)
	return generation.WithSubmissionKey(ctx, key)
}

const providerTaskRecoveryLeaseDuration = 10 * time.Minute

func callMeta(ctx context.Context) generation.CallMeta {
	meta, _ := generation.CallMetaFromContext(ctx)
	return meta
}
func classifyHTTP(err generation.HTTPError) generation.Failure {
	return generation.ClassifyHTTP(err.StatusCode, err.Status, err.Body)
}
