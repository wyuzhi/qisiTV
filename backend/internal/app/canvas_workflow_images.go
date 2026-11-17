package app

import (
	"context"

	cw "infinite-canvas/backend/internal/canvasworkflow"
	"infinite-canvas/backend/internal/model"
)

func (s *Service) workflowDescribeRequest(n cw.Node, resource, operation string) (CreateTaskRequest, error) {
	request, err := cw.DescribeRequest(s.compileHost(), n, resource, operation)
	return createTaskRequestFromRecipe(request), err
}

func (s *Service) executeWorkflowUpscale(user, operation string, n cw.Node, resource string) (*model.Task, error) {
	request, err := cw.UpscaleRequest(n)
	if err != nil {
		return nil, err
	}
	request.ResourceID, request.ClientOperationID, request.NodeID = resource, operation, n.ID
	return s.CreateMediaUpscale(context.Background(), user, request)
}
