package bootstrap

import (
	"errors"
	"qisitv/backend/internal/projectfolder"
)

// SetupProjectFolders is called only after a native directory selection or an
// explicit --projects-dir. The caller owns the Service.Run context.
func (r *Runtime) SetupProjectFolders(rootDirectory, workspaceID string) error {
	if r == nil || r.db == nil {
		return errors.New("本地引擎尚未就绪")
	}
	r.projectFoldersMu.Lock()
	defer r.projectFoldersMu.Unlock()
	if r.projectFolders != nil {
		if r.projectFolders.Matches(rootDirectory, workspaceID) {
			return nil
		}
		return errors.New("项目根目录已配置；切换目录需要重启本地引擎")
	}
	service, err := projectfolder.Open(r.db, projectfolder.Options{DataDir: r.cfg.DataDir, RootDirectory: rootDirectory, WorkspaceID: workspaceID})
	if err != nil {
		return err
	}
	r.projectFolders = service
	return nil
}
func (r *Runtime) ProjectFolders() *projectfolder.Service {
	if r == nil {
		return nil
	}
	r.projectFoldersMu.RLock()
	defer r.projectFoldersMu.RUnlock()
	return r.projectFolders
}
func (r *Runtime) ProjectFolderOwnerID() (string, error) {
	if r == nil || r.service == nil {
		return "", errors.New("本地引擎尚未就绪")
	}
	owner, err := r.service.LocalWorkspaceOwner()
	if err != nil {
		return "", err
	}
	return owner.ID, nil
}
