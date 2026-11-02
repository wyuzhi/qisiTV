package app

import (
	"encoding/json"

	cw "qisitv/backend/internal/canvasworkflow"
	"qisitv/backend/internal/model"
)

func workflowRevision(n int) int { return cw.NormalizeRevision(n) }

func (s *Service) CanvasWorkflowOperations() []cw.Operation {
	return cw.PresentOperations(s.compileHost())
}

func (s *Service) workflowRevisionRow(user, id string, revision int) (model.CanvasWorkflow, error) {
	return s.workflowTemplates().RevisionRow(user, id, revision)
}

// CanvasWorkflowTemplates is the template domain service used by the HTTP layer.
func (s *Service) CanvasWorkflowTemplates() *cw.Templates { return s.workflowTemplates() }

func (s *Service) workflowTemplates() *cw.Templates {
	return cw.NewTemplates(s.repo, workflowRecipeHost{s}, &s.canvasWorkflowMu)
}

// workflowRecipeHost compiles private recipes with the host's model selection,
// credentials and encryption.
type workflowRecipeHost struct{ s *Service }

func (h workflowRecipeHost) Compile(user string, d cw.Definition, existing *model.CanvasWorkflow, seal bool) (cw.Compiled, error) {
	compiled, e := cw.Compile(h.s.compileHost(), user, d, existing)
	if e != nil {
		return cw.Compiled{}, e
	}
	// Presenting rewrites nodes in place; keep the caller's definition intact.
	presented := d
	presented.Nodes = append([]cw.Node(nil), d.Nodes...)
	presented.Edges = append([]cw.Edge(nil), d.Edges...)
	out := cw.Compiled{Presented: cw.EditorDefinition(presented, compiled.Recipes), References: compiled.References}
	if seal {
		raw, err := json.Marshal(compiled.Recipes)
		if err != nil {
			return cw.Compiled{}, err
		}
		if out.Cipher, e = h.s.encryptSettingSecret(string(raw)); e != nil {
			return cw.Compiled{}, e
		}
	}
	return out, nil
}

func (h workflowRecipeHost) Present(d cw.Definition, recipeCipher string) (cw.Definition, error) {
	plain, e := h.s.decryptSettingSecret(recipeCipher)
	if e != nil {
		return d, e
	}
	var recipes workflowRecipes
	if e = json.Unmarshal([]byte(plain), &recipes); e != nil {
		return d, e
	}
	return cw.EditorDefinition(d, recipes), nil
}

func (h workflowRecipeHost) Operations() []cw.Operation { return h.s.CanvasWorkflowOperations() }
