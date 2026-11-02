package app

import "qisitv/backend/internal/model"

type resourceLifecycle struct{ svc *Service }

func (l resourceLifecycle) RecordActivity(u, k string, n int)                        { if l.svc != nil { l.svc.recordActivity(u, k, n) } }
func (l resourceLifecycle) AfterResourceReady(*model.Resource)                       {}
func (l resourceLifecycle) AppearanceReferencedIDs(ids []string) map[string]struct{} { if l.svc == nil { return nil }; return l.svc.appearanceReferencedResourceIDs(ids) }
func (l resourceLifecycle) RecycleRetentionDays() (int, error)                       { if l.svc == nil { return 0, nil }; p, err := l.svc.RuntimePolicy(); return p.Resource.RecycleBinRetentionDays, err }
func (l resourceLifecycle) WorkerID() string                                         { if l.svc == nil { return "" }; return l.svc.workerID }
func (l resourceLifecycle) RunBackground(fn func())                                  { if l.svc != nil { l.svc.runWorkerTask(fn) } }
func (l resourceLifecycle) DeleteUserAsset(u, id string) error                       { if l.svc == nil { return nil }; return l.svc.DeleteUserAsset(u, id) }
func (l resourceLifecycle) WithStorageLock(fn func() error) error                    { if fn == nil { return nil }; if l.svc == nil { return fn() }; l.svc.storageMu.Lock(); defer l.svc.storageMu.Unlock(); return fn() }
