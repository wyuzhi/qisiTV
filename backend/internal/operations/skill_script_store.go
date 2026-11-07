package operations

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"gorm.io/gorm"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/skills"
)

const (
	skillScriptProposalOpName = "skill.script.proposal"
	skillScriptAllowOpName    = "skill.script.session_allow"
)

type SkillScriptProposal struct {
	ProposalID            string                  `json:"proposalId"`
	TurnID                string                  `json:"turnId"`
	CanvasID              string                  `json:"canvasId"`
	SessionID             string                  `json:"sessionId,omitempty"`
	SkillID               string                  `json:"skillId"`
	SkillName             string                  `json:"skillName"`
	VersionID             string                  `json:"versionId"`
	Version               string                  `json:"version"`
	ContentHash           string                  `json:"contentHash"`
	ScriptPath            string                  `json:"scriptPath"`
	Interpreter           string                  `json:"interpreter"`
	Args                  []string                `json:"args"`
	Stdin                 string                  `json:"stdin,omitempty"`
	StdinPreview          string                  `json:"stdinPreview,omitempty"`
	HasStdin              bool                    `json:"hasStdin,omitempty"`
	TimeoutSec            int                     `json:"timeoutSec"`
	UseWorkspaceOutputDir bool                    `json:"useWorkspaceOutputDir,omitempty"`
	Note                  string                  `json:"note,omitempty"`
	Status                string                  `json:"status"`
	Result                *skills.ScriptRunResult `json:"result,omitempty"`
	CreatedAt             string                  `json:"createdAt,omitempty"`
	UpdatedAt             string                  `json:"updatedAt,omitempty"`
}

func (p SkillScriptProposal) PublicView() SkillScriptProposal {
	out := p
	out.Stdin = ""
	if out.Args == nil {
		out.Args = []string{}
	}
	return out
}

func skillScriptProposalOpID(proposalID string) string {
	return "script-proposal:" + strings.TrimSpace(proposalID)
}

func newSkillScriptProposalID() string {
	var buf [8]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return fmt.Sprintf("sp-%d", time.Now().UnixNano())
	}
	return "sp-" + hex.EncodeToString(buf[:])
}

func skillScriptAllowOpID(canvasID, sessionID string, pin skills.Pin, scriptPath string) string {
	id := pin.Identity()
	raw := strings.Join([]string{
		strings.TrimSpace(canvasID),
		strings.TrimSpace(sessionID),
		strings.TrimSpace(id.SkillID),
		strings.TrimSpace(id.VersionID),
		strings.TrimSpace(id.ContentHash),
		strings.TrimSpace(scriptPath),
	}, "\x00")
	sum := sha256.Sum256([]byte(raw))
	return "script-allow:" + hex.EncodeToString(sum[:])
}

func UpsertSkillScriptProposal(db *gorm.DB, userID string, proposal SkillScriptProposal) error {
	if db == nil || strings.TrimSpace(proposal.ProposalID) == "" {
		return nil
	}
	if proposal.Args == nil {
		proposal.Args = []string{}
	}
	encoded, err := json.Marshal(proposal)
	if err != nil {
		return err
	}
	opID := skillScriptProposalOpID(proposal.ProposalID)
	status := "script:" + strings.TrimSpace(proposal.Status)
	var existing model.AgentOpRecord
	findErr := db.Where("user_id = ? AND op_id = ?", userID, opID).First(&existing).Error
	if errors.Is(findErr, gorm.ErrRecordNotFound) {
		return db.Create(&model.AgentOpRecord{
			OpID:        opID,
			UserID:      userID,
			Op:          skillScriptProposalOpName,
			PayloadHash: strings.TrimSpace(proposal.CanvasID),
			Status:      status,
			ResultJSON:  string(encoded),
			TurnID:      strings.TrimSpace(proposal.TurnID),
			ClientID:    strings.TrimSpace(proposal.SessionID),
		}).Error
	}
	if findErr != nil {
		return findErr
	}
	return db.Model(&model.AgentOpRecord{}).Where("user_id = ? AND op_id = ?", userID, opID).Updates(map[string]any{
		"payload_hash": strings.TrimSpace(proposal.CanvasID),
		"status":       status,
		"result_json":  string(encoded),
		"turn_id":      strings.TrimSpace(proposal.TurnID),
		"client_id":    strings.TrimSpace(proposal.SessionID),
	}).Error
}

func LookupSkillScriptProposal(db *gorm.DB, userID, proposalID string) (*SkillScriptProposal, error) {
	if db == nil || strings.TrimSpace(proposalID) == "" {
		return nil, nil
	}
	var rec model.AgentOpRecord
	err := db.Where("user_id = ? AND op_id = ?", userID, skillScriptProposalOpID(proposalID)).First(&rec).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var proposal SkillScriptProposal
	if err := json.Unmarshal([]byte(rec.ResultJSON), &proposal); err != nil {
		return nil, err
	}
	return &proposal, nil
}

func ListTurnSkillScriptProposals(db *gorm.DB, userID, canvasID, turnID string) ([]SkillScriptProposal, error) {
	if db == nil || strings.TrimSpace(userID) == "" || strings.TrimSpace(turnID) == "" {
		return []SkillScriptProposal{}, nil
	}
	query := db.Where("user_id = ? AND op = ? AND turn_id = ?", userID, skillScriptProposalOpName, strings.TrimSpace(turnID))
	if trimmedCanvas := strings.TrimSpace(canvasID); trimmedCanvas != "" {
		query = query.Where("payload_hash = ?", trimmedCanvas)
	}
	var rows []model.AgentOpRecord
	if err := query.Order("created_at ASC").Find(&rows).Error; err != nil {
		return nil, err
	}
	out := make([]SkillScriptProposal, 0, len(rows))
	for _, row := range rows {
		var item SkillScriptProposal
		if json.Unmarshal([]byte(row.ResultJSON), &item) != nil {
			continue
		}
		out = append(out, item.PublicView())
	}
	return out, nil
}

func RecordSessionScriptAllow(db *gorm.DB, userID, canvasID, sessionID string, pin skills.Pin, scriptPath string) error {
	if db == nil || strings.TrimSpace(userID) == "" || strings.TrimSpace(canvasID) == "" || strings.TrimSpace(sessionID) == "" || strings.TrimSpace(scriptPath) == "" {
		return nil
	}
	opID := skillScriptAllowOpID(canvasID, sessionID, pin, scriptPath)
	payload, _ := json.Marshal(map[string]any{
		"canvasId":    canvasID,
		"sessionId":   sessionID,
		"skillId":     pin.SkillID,
		"versionId":   pin.VersionID,
		"contentHash": pin.ContentHash,
		"scriptPath":  scriptPath,
	})
	var existing model.AgentOpRecord
	err := db.Where("user_id = ? AND op_id = ?", userID, opID).First(&existing).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return db.Create(&model.AgentOpRecord{
			OpID:        opID,
			UserID:      userID,
			Op:          skillScriptAllowOpName,
			PayloadHash: strings.TrimSpace(canvasID),
			Status:      "allow:active",
			ResultJSON:  string(payload),
			ClientID:    strings.TrimSpace(sessionID),
		}).Error
	}
	if err != nil {
		return err
	}
	return db.Model(&model.AgentOpRecord{}).Where("user_id = ? AND op_id = ?", userID, opID).Update("status", "allow:active").Error
}

func IsSessionScriptAllowed(db *gorm.DB, userID, canvasID, sessionID string, pin skills.Pin, scriptPath string) bool {
	if db == nil || strings.TrimSpace(userID) == "" || strings.TrimSpace(canvasID) == "" || strings.TrimSpace(sessionID) == "" || strings.TrimSpace(scriptPath) == "" {
		return false
	}
	opID := skillScriptAllowOpID(canvasID, sessionID, pin, scriptPath)
	var rec model.AgentOpRecord
	err := db.Where("user_id = ? AND op_id = ? AND status = ?", userID, opID, "allow:active").First(&rec).Error
	return err == nil
}

func RevokeSessionScriptAllows(db *gorm.DB, userID, canvasID, sessionID string) error {
	if db == nil || strings.TrimSpace(userID) == "" || strings.TrimSpace(canvasID) == "" {
		return nil
	}
	query := db.Where("user_id = ? AND op = ? AND payload_hash = ?", userID, skillScriptAllowOpName, strings.TrimSpace(canvasID))
	if trimmedSession := strings.TrimSpace(sessionID); trimmedSession != "" {
		query = query.Where("client_id = ?", trimmedSession)
	}
	return query.Delete(&model.AgentOpRecord{}).Error
}

func lookupTurnSessionID(db *gorm.DB, userID, turnID string) string {
	if db == nil || strings.TrimSpace(turnID) == "" {
		return ""
	}
	var row model.AssistantTurn
	if err := db.Select("durable_session_id").Where("turn_id = ? AND user_id = ?", strings.TrimSpace(turnID), userID).First(&row).Error; err != nil {
		return ""
	}
	return strings.TrimSpace(row.DurableSessionID)
}

func scriptStatusFromResult(res *skills.ScriptRunResult) string {
	if res == nil {
		return "failed"
	}
	if res.Cancelled {
		return "cancelled"
	}
	if res.TimedOut || res.ExitCode != 0 {
		return "failed"
	}
	return "completed"
}

func ProposeOrRunSkillScript(ctx context.Context, db *gorm.DB, skillSvc *skills.Service, userID, turnID string, req skills.ScriptRunRequest) (any, error) {
	if skillSvc == nil {
		return nil, Unsupported("skill_unavailable", "当前工作区无法运行技能脚本")
	}
	if strings.TrimSpace(turnID) == "" {
		return nil, PermissionDenied("scope_denied", "技能脚本只能在内置助手对话轮次中发起运行")
	}
	validated, err := skillSvc.ValidateScriptRun(userID, req, "")
	if err != nil {
		return nil, mapDomainError(err)
	}
	sessionID := strings.TrimSpace(req.SessionID)
	if sessionID == "" {
		sessionID = lookupTurnSessionID(db, userID, turnID)
	}
	now := time.Now().UTC().Format(time.RFC3339)
	proposalID := newSkillScriptProposalID()
	proposal := SkillScriptProposal{
		ProposalID:            proposalID,
		TurnID:                strings.TrimSpace(turnID),
		CanvasID:              strings.TrimSpace(req.CanvasID),
		SessionID:             sessionID,
		SkillID:               validated.Pin.SkillID,
		SkillName:             validated.SkillName,
		VersionID:             validated.Pin.VersionID,
		Version:               validated.VersionLabel,
		ContentHash:           validated.Pin.ContentHash,
		ScriptPath:            validated.ScriptPath,
		Interpreter:           validated.Interpreter,
		Args:                  validated.Args,
		Stdin:                 validated.Stdin,
		StdinPreview:          validated.StdinPreview,
		HasStdin:              validated.HasStdin,
		TimeoutSec:            validated.TimeoutSec,
		UseWorkspaceOutputDir: validated.UseOutputDir,
		Note:                  validated.Note,
		Status:                "pending",
		CreatedAt:             now,
		UpdatedAt:             now,
	}
	if sessionID != "" && IsSessionScriptAllowed(db, userID, req.CanvasID, sessionID, validated.Pin, validated.ScriptPath) {
		proposal.Status = "running"
		if err := UpsertSkillScriptProposal(db, userID, proposal); err != nil {
			return nil, AsError(err)
		}
		req.ProposalID = proposalID
		req.SessionID = sessionID
		req.TurnID = strings.TrimSpace(turnID)
		res, runErr := skillSvc.ExecuteSkillScript(ctx, userID, req, "")
		if runErr != nil {
			proposal.Status = "failed"
			proposal.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
			_ = UpsertSkillScriptProposal(db, userID, proposal)
			return nil, mapDomainError(runErr)
		}
		proposal.Status = scriptStatusFromResult(res)
		proposal.Result = res
		proposal.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
		if err := UpsertSkillScriptProposal(db, userID, proposal); err != nil {
			return nil, AsError(err)
		}
		return map[string]any{
			"canvasId": proposal.CanvasID,
			"status":   proposal.Status,
			"proposal": proposal.PublicView(),
			"result":   res,
		}, nil
	}
	if err := UpsertSkillScriptProposal(db, userID, proposal); err != nil {
		return nil, AsError(err)
	}
	return map[string]any{
		"canvasId": proposal.CanvasID,
		"status":   "requires_confirmation",
		"proposal": proposal.PublicView(),
		"message":  "脚本运行提议已提交，等待用户在界面确认后运行。",
	}, nil
}

func ConfirmSkillScriptProposal(ctx context.Context, db *gorm.DB, skillSvc *skills.Service, userID, turnID, proposalID, canvasID string, alwaysAllowSession bool) (*SkillScriptProposal, *skills.ScriptRunResult, error) {
	if db == nil || skillSvc == nil {
		return nil, nil, Unsupported("skill_unavailable", "当前工作区无法运行技能脚本")
	}
	proposal, err := LookupSkillScriptProposal(db, userID, proposalID)
	if err != nil {
		return nil, nil, AsError(err)
	}
	if proposal == nil {
		return nil, nil, NotFound("script_proposal_not_found", "未找到对应的脚本运行提议")
	}
	if strings.TrimSpace(turnID) == "" || proposal.CanvasID != strings.TrimSpace(canvasID) || proposal.TurnID == "" || proposal.TurnID != strings.TrimSpace(turnID) {
		return nil, nil, PermissionDenied("script_proposal_mismatch", "脚本运行提议不属于当前画布或对话轮次")
	}
	if (proposal.Status == "completed" || proposal.Status == "failed") && proposal.Result != nil {
		pub := proposal.PublicView()
		return &pub, proposal.Result, nil
	}
	if proposal.Status == "running" {
		return nil, nil, Conflict("script_already_running", "该脚本正在运行中", nil)
	}
	if proposal.SessionID == "" {
		proposal.SessionID = lookupTurnSessionID(db, userID, turnID)
	}
	pin := skills.Pin{SkillID: proposal.SkillID, VersionID: proposal.VersionID, ContentHash: proposal.ContentHash}
	if alwaysAllowSession && proposal.SessionID != "" {
		if err := RecordSessionScriptAllow(db, userID, proposal.CanvasID, proposal.SessionID, pin, proposal.ScriptPath); err != nil {
			return nil, nil, AsError(err)
		}
	}
	proposal.Status = "running"
	proposal.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
	if err := UpsertSkillScriptProposal(db, userID, *proposal); err != nil {
		return nil, nil, AsError(err)
	}
	res, runErr := skillSvc.ExecuteSkillScript(ctx, userID, skills.ScriptRunRequest{
		CanvasID:              proposal.CanvasID,
		SessionID:             proposal.SessionID,
		TurnID:                proposal.TurnID,
		ProposalID:            proposal.ProposalID,
		Pin:                   pin,
		ScriptPath:            proposal.ScriptPath,
		Args:                  proposal.Args,
		Stdin:                 proposal.Stdin,
		TimeoutSec:            proposal.TimeoutSec,
		UseWorkspaceOutputDir: proposal.UseWorkspaceOutputDir,
		Note:                  proposal.Note,
	}, "")
	if runErr != nil {
		proposal.Status = "failed"
		proposal.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
		_ = UpsertSkillScriptProposal(db, userID, *proposal)
		return nil, nil, mapDomainError(runErr)
	}
	proposal.Status = scriptStatusFromResult(res)
	proposal.Result = res
	proposal.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
	if err := UpsertSkillScriptProposal(db, userID, *proposal); err != nil {
		return nil, nil, AsError(err)
	}
	pub := proposal.PublicView()
	return &pub, res, nil
}
