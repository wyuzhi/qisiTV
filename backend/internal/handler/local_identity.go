package handler

import (
	"qisitv/backend/internal/model"

	"github.com/gin-gonic/gin"
)

// workspaceOwners is the only capability handlers need to resolve the caller.
type workspaceOwners interface {
	WorkspaceOwner(string) (*model.User, error)
	LocalWorkspaceOwner() (*model.User, error)
}

// currentUser resolves the stable workspace owner. Local routes never inspect
// cookies and never create a session record.
func currentUser(c *gin.Context, svc workspaceOwners) (*model.User, error) {
	if _, exists := c.Get(workspaceContextKey); exists {
		scope, err := CurrentWorkspace(c)
		if err != nil {
			return nil, err
		}
		return svc.WorkspaceOwner(scope.ID)
	}
	return svc.LocalWorkspaceOwner()
}
