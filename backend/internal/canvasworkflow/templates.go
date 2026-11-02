package canvasworkflow

import (
	"encoding/json"
	"errors"
	"strings"
	"sync"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
	"qisitv/backend/internal/kernel"
	"qisitv/backend/internal/model"
	"qisitv/backend/internal/repository"
)

// Compiled is a private recipe built from a public definition. Cipher is the
// encrypted recipe, empty unless sealing was requested; Presented is the
// definition as the editor shows it.
type Compiled struct {
	Cipher     string
	Presented  Definition
	References map[string]bool
}

// Recipes compiles and presents private recipes. Model selection, credentials
// and the media encoder belong to the host until they move into this package.
type Recipes interface {
	Compile(user string, d Definition, existing *model.CanvasWorkflow, seal bool) (Compiled, error)
	Present(d Definition, recipeCipher string) (Definition, error)
	Operations() []Operation
}

// Templates owns workflow templates, their immutable revisions and the
// resource references that keep template inputs alive.
type Templates struct {
	repo    *repository.Repository
	recipes Recipes
	// mu is shared with run admission so a run never reads a half-written template.
	mu *sync.Mutex
}

func NewTemplates(repo *repository.Repository, recipes Recipes, mu *sync.Mutex) *Templates {
	return &Templates{repo: repo, recipes: recipes, mu: mu}
}

func BadRequest(message string) error { return kernel.BadAuthRequest(message) }

func NotFound() error {
	return kernel.NewAppError(kernel.CodeNotFound, "工作流或运行记录不存在")
}

func NormalizeRevision(n int) int {
	if n < 1 {
		return 1
	}
	return n
}

func TemplateFromRow(row model.CanvasWorkflow) (Template, error) {
	v := Template{ID: row.ID, Name: row.Name, Description: row.Description, CreatedAt: row.CreatedAt, UpdatedAt: row.UpdatedAt}
	v.Revision = NormalizeRevision(row.Revision)
	err := json.Unmarshal([]byte(row.DefinitionJSON), &v.Definition)
	return v, err
}

func snapshot(row model.CanvasWorkflow) *model.CanvasWorkflowRevision {
	return &model.CanvasWorkflowRevision{TemplateID: row.ID, Revision: NormalizeRevision(row.Revision), UserID: row.UserID, Name: row.Name, Description: row.Description, DefinitionJSON: row.DefinitionJSON, RecipeCipher: row.RecipeCipher}
}

// PersistReferences records that owner (a template or a run) uses each ready resource.
func PersistReferences(tx *gorm.DB, owner, user string, refs map[string]bool) error {
	if len(refs) == 0 {
		return nil
	}
	rows := []model.CanvasWorkflowResource{}
	for id := range refs {
		rows = append(rows, model.CanvasWorkflowResource{OwnerID: owner, UserID: user, ResourceID: id})
	}
	for _, row := range rows {
		var count int64
		if e := tx.Model(&model.Resource{}).Where("id = ? AND user_id = ? AND status = ?", row.ResourceID, row.UserID, model.ResourceStatusReady).Count(&count).Error; e != nil {
			return e
		}
		if count != 1 {
			return BadRequest("工作流素材已被移除，请重新保存素材")
		}
	}
	return tx.Clauses(clause.OnConflict{DoNothing: true}).Create(&rows).Error
}

func (t *Templates) List(user string) ([]Template, error) {
	var rows []model.CanvasWorkflow
	if err := t.repo.DB().Where("user_id = ?", user).Order("created_at DESC").Find(&rows).Error; err != nil {
		return nil, err
	}
	out := []Template{}
	for _, r := range rows {
		v, e := TemplateFromRow(r)
		if e != nil {
			return nil, e
		}
		out = append(out, v)
	}
	return out, nil
}

func (t *Templates) Get(user, id string) (Template, error) {
	var row model.CanvasWorkflow
	if err := t.repo.DB().Where("user_id = ? AND id = ?", user, id).First(&row).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return Template{}, NotFound()
		}
		return Template{}, err
	}
	return TemplateFromRow(row)
}

// RevisionRow returns the template as it was at revision.
func (t *Templates) RevisionRow(user, id string, revision int) (model.CanvasWorkflow, error) {
	var row model.CanvasWorkflow
	if e := t.repo.DB().Where("id = ? AND user_id = ?", id, user).First(&row).Error; e != nil {
		return row, NotFound()
	}
	revision = NormalizeRevision(revision)
	if NormalizeRevision(row.Revision) == revision {
		return row, nil
	}
	var old model.CanvasWorkflowRevision
	if e := t.repo.DB().Where("template_id = ? AND user_id = ? AND revision = ?", id, user, revision).First(&old).Error; e != nil {
		return row, NotFound()
	}
	row.Revision = old.Revision
	row.Name = old.Name
	row.Description = old.Description
	row.DefinitionJSON = old.DefinitionJSON
	row.RecipeCipher = old.RecipeCipher
	return row, nil
}

func (t *Templates) Editor(user, id string, revision int) (Editor, error) {
	if revision == 0 {
		current, e := t.Get(user, id)
		if e != nil {
			return Editor{}, e
		}
		revision = current.Revision
	}
	row, e := t.RevisionRow(user, id, revision)
	if e != nil {
		return Editor{}, e
	}
	public, e := TemplateFromRow(row)
	if e != nil {
		return Editor{}, e
	}
	if public.Definition, e = t.recipes.Present(public.Definition, row.RecipeCipher); e != nil {
		return Editor{}, e
	}
	return Editor{Workflow: public, Operations: t.recipes.Operations()}, nil
}

func (t *Templates) Validate(user string, d Definition) error {
	_, e := t.recipes.Compile(user, d, nil, false)
	return e
}

// Prepare compiles a draft without saving it. Editing an existing template
// compiles against the given revision so its private recipe is reused.
func (t *Templates) Prepare(user string, d Definition, id string, revision int) (Definition, error) {
	var existing *model.CanvasWorkflow
	if id != "" {
		if revision < 1 {
			return d, BadRequest("编辑校验需要有效的模板版本")
		}
		row, e := t.RevisionRow(user, id, revision)
		if e != nil {
			return d, e
		}
		existing = &row
	}
	compiled, e := t.recipes.Compile(user, d, existing, false)
	if e != nil {
		return d, e
	}
	return compiled.Presented, nil
}

func storedDefinition(d Definition, compiled Compiled) (string, error) {
	if d.PresentationVersion > 0 {
		d = compiled.Presented
	}
	raw, e := json.Marshal(d)
	return string(raw), e
}

func (t *Templates) Create(user string, req CreateRequest) (Template, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	req.Name = strings.TrimSpace(req.Name)
	if req.Name == "" || len([]rune(req.Name)) > 100 || len(req.Description) > 4000 {
		return Template{}, BadRequest("请输入 1–100 字的工作流名称，说明不超过 4000 字节")
	}
	compiled, e := t.recipes.Compile(user, req.Definition, nil, true)
	if e != nil {
		return Template{}, e
	}
	definition, e := storedDefinition(req.Definition, compiled)
	if e != nil {
		return Template{}, e
	}
	row := model.CanvasWorkflow{ID: kernel.NewID(), Revision: 1, UserID: user, Name: req.Name, Description: req.Description, DefinitionJSON: definition, RecipeCipher: compiled.Cipher}
	e = t.repo.DB().Transaction(func(tx *gorm.DB) error {
		if e := tx.Create(&row).Error; e != nil {
			return e
		}
		if e := tx.Create(snapshot(row)).Error; e != nil {
			return e
		}
		return PersistReferences(tx, row.ID, user, compiled.References)
	})
	if e != nil {
		return Template{}, e
	}
	return TemplateFromRow(row)
}

func (t *Templates) Update(user, id string, req UpdateRequest) (Template, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	req.Name = strings.TrimSpace(req.Name)
	if req.Name == "" || len([]rune(req.Name)) > 100 || len(req.Description) > 4000 {
		return Template{}, BadRequest("工作流名称或说明无效")
	}
	var row model.CanvasWorkflow
	if e := t.repo.DB().Where("id = ? AND user_id = ?", id, user).First(&row).Error; e != nil {
		return Template{}, NotFound()
	}
	if req.ExpectedRevision != NormalizeRevision(row.Revision) {
		return Template{}, kernel.NewAppError(kernel.CodeConflict, "工作流已更新，请保留草稿并重新载入比较")
	}
	compiled, e := t.recipes.Compile(user, req.Definition, &row, true)
	if e != nil {
		return Template{}, e
	}
	definition, e := storedDefinition(req.Definition, compiled)
	if e != nil {
		return Template{}, e
	}
	old := row
	row.Revision = NormalizeRevision(row.Revision) + 1
	row.Name = req.Name
	row.Description = req.Description
	row.DefinitionJSON = definition
	row.RecipeCipher = compiled.Cipher
	e = t.repo.DB().Transaction(func(tx *gorm.DB) error {
		if e := tx.Clauses(clause.OnConflict{DoNothing: true}).Create(snapshot(old)).Error; e != nil {
			return e
		}
		result := tx.Model(&model.CanvasWorkflow{}).Where("id = ? AND user_id = ? AND revision = ?", id, user, req.ExpectedRevision).Updates(map[string]any{"revision": row.Revision, "name": row.Name, "description": row.Description, "definition_json": row.DefinitionJSON, "recipe_cipher": row.RecipeCipher})
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected != 1 {
			return kernel.NewAppError(kernel.CodeConflict, "工作流版本冲突")
		}
		if e := tx.Create(snapshot(row)).Error; e != nil {
			return e
		}
		// References are a union across immutable revisions; never release old inputs on edit.
		return PersistReferences(tx, id, user, compiled.References)
	})
	if e != nil {
		return Template{}, e
	}
	return t.Get(user, id)
}

func (t *Templates) Delete(user, id string) error {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.repo.DB().Transaction(func(tx *gorm.DB) error {
		var row model.CanvasWorkflow
		if e := tx.Where("id = ? AND user_id = ?", id, user).First(&row).Error; e != nil {
			return NotFound()
		}
		if e := tx.Where("owner_id = ? AND user_id = ?", id, user).Delete(&model.CanvasWorkflowResource{}).Error; e != nil {
			return e
		}
		if e := tx.Where("template_id = ? AND user_id = ?", id, user).Delete(&model.CanvasWorkflowRevision{}).Error; e != nil {
			return e
		}
		return tx.Delete(&row).Error
	})
}
