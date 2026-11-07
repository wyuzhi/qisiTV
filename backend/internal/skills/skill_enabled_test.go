package skills

import (
	"testing"

	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/model"
)

func TestOwnerCanDisableWithoutDeletingPinnedPackage(t *testing.T) {
	s, _ := agentSkillFixture(t)
	pin := installAgentSkill(t, s, map[string]string{"SKILL.md": "---\nname: Test\ndescription: Test flow\n---\nUse the input."})
	item, err := s.SetSkillAdded("owner", pin.SkillID, false)
	if err != nil || item.IsAdded {
		t.Fatalf("disable: %+v %v", item, err)
	}
	available, err := s.AddedSkills("owner")
	if err != nil || len(available) != 0 {
		t.Fatalf("disabled selectable: %+v %v", available, err)
	}
	if _, err := s.AgentVersion("owner", pin); err == nil {
		t.Fatal("disabled skill still executable")
	}
	if _, err := s.SkillPackageFile("owner", pin.SkillID, "SKILL.md"); err != nil {
		t.Fatal("disable deleted package", err)
	}
	if _, err := s.SetSkillAdded("owner", pin.SkillID, true); err != nil {
		t.Fatal(err)
	}
	if _, err := s.AgentVersion("owner", pin); err != nil {
		t.Fatal("re-enable lost pin", err)
	}
}

func TestNonOwnerCanDisableAndReenableInstalledSkillsAndKeepInMineScope(t *testing.T) {
	s, db := agentSkillFixture(t)
	pin := installAgentSkill(t, s, map[string]string{"SKILL.md": "---\nname: SystemBuiltin\ndescription: Official builtin skill\n---\nBody"})
	if err := db.Model(&model.Skill{}).Where("id = ?", pin.SkillID).Updates(map[string]any{
		"owner_id":    "system",
		"source_type": "builtin",
		"is_private":  false,
	}).Error; err != nil {
		t.Fatal(err)
	}

	disabled, err := s.SetSkillAdded("owner", pin.SkillID, false)
	if err != nil || disabled.IsAdded {
		t.Fatalf("disable builtin skill failed: item=%+v err=%v", disabled, err)
	}
	mineList, err := s.Skills("owner", SkillListRequest{Scope: "mine", PageSize: 20})
	if err != nil || len(mineList.Skills) != 1 || mineList.Skills[0].SkillID != pin.SkillID || mineList.Skills[0].IsAdded {
		t.Fatalf("expected disabled builtin skill to remain in mine scope as disabled, got %+v err=%v", mineList, err)
	}
	addedList, err := s.AddedSkills("owner")
	if err != nil || len(addedList) != 0 {
		t.Fatalf("expected disabled builtin skill excluded from AddedSkills, got %+v err=%v", addedList, err)
	}
	reenabled, err := s.SetSkillAdded("owner", pin.SkillID, true)
	if err != nil || !reenabled.IsAdded {
		t.Fatalf("re-enable builtin skill failed: item=%+v err=%v", reenabled, err)
	}

	privateSkillID := kernel.NewID()
	if err := db.Create(&model.Skill{
		ID:        privateSkillID,
		OwnerID:   "plugin:demo",
		Name:      "PrivateNonOwned",
		Status:    skillStatusEnabled,
		IsPrivate: true,
	}).Error; err != nil {
		t.Fatal(err)
	}
	if err := s.repo.SetUserSkillAdded(&model.UserSkillState{
		ID:      kernel.NewID(),
		UserID:  "consumer",
		SkillID: privateSkillID,
		Added:   true,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.SkillDetail("stranger", privateSkillID); err == nil {
		t.Fatal("expected stranger to be forbidden from private skill")
	}
	offItem, err := s.SetSkillAdded("consumer", privateSkillID, false)
	if err != nil || offItem.IsAdded {
		t.Fatalf("disable private non-owned skill failed: item=%+v err=%v", offItem, err)
	}
	onItem, err := s.SetSkillAdded("consumer", privateSkillID, true)
	if err != nil || !onItem.IsAdded {
		t.Fatalf("re-enable private non-owned skill failed: item=%+v err=%v", onItem, err)
	}
}
