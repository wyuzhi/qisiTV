package app

import cw "qisitv/backend/internal/canvasworkflow"

func (s *Service) selectWorkflowModel(n cw.Node, recipe *workflowRecipe) (bool, error) {
	return cw.SelectModel(s.compileHost(), n, recipe)
}
