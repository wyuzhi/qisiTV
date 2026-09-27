package handler

import (
	"qisitv/backend/internal/app"
	"qisitv/backend/internal/model"

	"github.com/gin-gonic/gin"
)

// currentUser resolves the stable workspace owner. Local routes never inspect
// cookies and never create a session record.
func currentUser(c *gin.Context, svc *app.Service) (*model.User, error) {
	if _, exists := c.Get(workspaceContextKey); exists {
		scope, err := CurrentWorkspace(c)
		if err != nil {
			return nil, err
		}
		return svc.WorkspaceOwner(scope.ID)
	}
	return svc.LocalWorkspaceOwner()
}
