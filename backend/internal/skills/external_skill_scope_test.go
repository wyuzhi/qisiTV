package skills

import (
	"os"
	"path/filepath"
	"testing"

	"infinite-canvas/backend/internal/model"
)

func TestStartupDoesNotImportExternalSkillDirectories(t *testing.T) {
	for _, savedEnabled := range []bool{false, true} {
		t.Run(map[bool]string{false: "unconfigured", true: "previously-enabled"}[savedEnabled], func(t *testing.T) {
			home := t.TempDir()
			t.Setenv("HOME", home)
			file := filepath.Join(home, ".agents", "skills", "lark-wiki", "SKILL.md")
			writeLocalSkill(t, filepath.Dir(file), map[string]string{"SKILL.md": "---\nname: lark-wiki\ndescription: External workflow\n---\nExternal content"})
			s := localSkillFixture(t)
			if savedEnabled {
				if err := s.repo.SaveSystemSetting(&model.SystemSetting{Key: "local_skills_directory", ValueJSON: "true"}); err != nil {
					t.Fatal(err)
				}
			}
			if err := s.RetireExternalSkills(); err != nil {
				t.Fatal(err)
			}
			if ids := localSkillIDs(t, s); len(ids) != 0 {
				t.Fatalf("external skills entered the library: %v", ids)
			}
			if _, err := os.Stat(file); err != nil {
				t.Fatal("original external skill changed", err)
			}
		})
	}
}

func TestRetireExternalSkillsKeepsBeefTVInstallationsAndBlocksLegacyUsage(t *testing.T) {
	s, db := agentSkillFixture(t)
	files := map[string]string{"SKILL.md": "---\nname: workflow\ndescription: Workflow\n---\nBody", "scripts/helper.py": "print('ok')"}
	external := installAgentSkill(t, s, files)
	if err := db.Model(&model.Skill{}).Where("id = ?", external.SkillID).Updates(map[string]any{"source_type": "local", "source_url": "local://agents-skills"}).Error; err != nil {
		t.Fatal(err)
	}
	if err := s.repo.SaveSystemSetting(&model.SystemSetting{Key: "local_skills_directory", ValueJSON: "true"}); err != nil {
		t.Fatal(err)
	}
	var kept []Pin
	for _, source := range []string{"builtin", "markdown", "zip", "github", "market", "plugin"} {
		pin := installAgentSkill(t, s, files)
		if err := db.Model(&model.Skill{}).Where("id = ?", pin.SkillID).Update("source_type", source).Error; err != nil {
			t.Fatal(err)
		}
		kept = append(kept, pin)
	}
	for attempt := 0; attempt < 2; attempt++ {
		if err := s.RetireExternalSkills(); err != nil {
			t.Fatal(err)
		}
	}
	for _, scope := range []string{"mine", "created", "public", "favorites"} {
		list, err := s.Skills("owner", SkillListRequest{Scope: scope, PageSize: 80})
		if err != nil {
			t.Fatal(err)
		}
		for _, item := range list.Skills {
			if item.SourceType == "local" {
				t.Fatalf("external skill remained in %s", scope)
			}
		}
	}
	active, err := s.AddedSkills("owner")
	if err != nil || len(active) != len(kept) {
		t.Fatalf("enabled BeefTV skills changed: %d, %v", len(active), err)
	}
	if _, err := s.SetSkillAdded("owner", external.SkillID, true); err == nil {
		t.Fatal("retired external skill could be enabled")
	}
	if _, err := s.AgentVersion("owner", external); err == nil {
		t.Fatal("retired external skill remained readable by the assistant")
	}
	state, err := s.repo.UserSkillState("owner", external.SkillID)
	if err != nil || state == nil || state.Added {
		t.Fatalf("external enabled state was retained: %+v, %v", state, err)
	}
	version, err := s.repo.SkillVersion(external.VersionID)
	if err != nil {
		t.Fatal("historical version metadata was lost", err)
	}
	if _, err := os.Stat(filepath.Join(s.dataDir, "skill-packages", filepath.FromSlash(version.PackageKey))); err != nil {
		t.Fatal("historical package was lost", err)
	}
	for _, pin := range kept {
		if _, err := s.AgentVersion("owner", pin); err != nil {
			t.Fatal("BeefTV installation stopped working", err)
		}
	}
	if setting, err := s.repo.LookupSystemSetting("local_skills_directory"); err != nil || setting != nil {
		t.Fatalf("obsolete external source setting remained: %+v, %v", setting, err)
	}
}

func TestRetireExternalSkillsRollsBackOnFailure(t *testing.T) {
	s, db := agentSkillFixture(t)
	pin := installAgentSkill(t, s, map[string]string{"SKILL.md": "---\nname: external\ndescription: External workflow\n---\nBody"})
	if err := db.Model(&model.Skill{}).Where("id = ?", pin.SkillID).Update("source_type", "local").Error; err != nil {
		t.Fatal(err)
	}
	if err := s.repo.SaveSystemSetting(&model.SystemSetting{Key: "local_skills_directory", ValueJSON: "true"}); err != nil {
		t.Fatal(err)
	}
	if err := db.Exec("CREATE TRIGGER fail_external_retirement BEFORE UPDATE OF status ON skills BEGIN SELECT RAISE(ABORT, 'retirement failed'); END").Error; err != nil {
		t.Fatal(err)
	}
	if err := s.RetireExternalSkills(); err == nil {
		t.Fatal("retirement failure was ignored")
	}
	state, err := s.repo.UserSkillState("owner", pin.SkillID)
	if err != nil || state == nil || !state.Added {
		t.Fatalf("failed retirement changed enabled state: %+v, %v", state, err)
	}
	if _, err := s.repo.Skill(pin.SkillID); err != nil {
		t.Fatal("failed retirement hid the skill", err)
	}
	if setting, err := s.repo.LookupSystemSetting("local_skills_directory"); err != nil || setting == nil || setting.ValueJSON != "true" {
		t.Fatalf("failed retirement changed settings: %+v, %v", setting, err)
	}
	if err := db.Exec("DROP TRIGGER fail_external_retirement").Error; err != nil {
		t.Fatal(err)
	}
	if err := s.RetireExternalSkills(); err != nil {
		t.Fatal("retirement could not be retried", err)
	}
}
