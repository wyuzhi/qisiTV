package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	"qisitv/backend/internal/desktopstorage"
	"qisitv/backend/internal/runtimeinfo"
)

func lockEngineLocation(profile string) (*os.File, error) {
	return desktopstorage.LockFile(filepath.Join(filepath.Dir(profile), ".qisitv-storage-location.lock"))
}

func storageCommand(ctx context.Context, args []string) error {
	if len(args) == 0 {
		return errors.New("usage: qisitv-engine storage migrate --to ABSOLUTE_EMPTY_DIRECTORY | storage cleanup --confirm")
	}
	command := args[0]
	profile, err := engineProfileRoot()
	if err != nil {
		return err
	}
	flags := flag.NewFlagSet("storage "+command, flag.ContinueOnError)
	profileDir := flags.String("profile-dir", profile, "Explicit isolated profile root; normally omit")
	target := flags.String("to", "", "Empty destination for the closed engine workspace")
	expectedSource := flags.String("expected-source", "", "Require the active source to match the directory shown by the website")
	confirmed := flags.Bool("confirm", false, "Confirm deletion of the verified previous workspace copy")
	if err := flags.Parse(args[1:]); err != nil {
		return err
	}
	if flags.NArg() != 0 || !filepath.IsAbs(*profileDir) {
		return errors.New("invalid storage command")
	}
	if strings.TrimSpace(os.Getenv("QISITV_ENGINE_DATA_DIR")) != "" {
		return errors.New("remove QISITV_ENGINE_DATA_DIR before switching the stored workspace location")
	}
	lock, err := lockEngineLocation(*profileDir)
	if err != nil {
		return err
	}
	defer lock.Close()
	var usage desktopstorage.Usage
	switch command {
	case "migrate":
		if *target == "" || *confirmed {
			return errors.New("usage: qisitv-engine storage migrate --to ABSOLUTE_EMPTY_DIRECTORY")
		}
		if *expectedSource != "" {
			current, resolveErr := desktopstorage.Resolve(*profileDir)
			currentInfo, currentErr := os.Stat(current)
			expectedInfo, expectedErr := os.Stat(*expectedSource)
			if !filepath.IsAbs(*expectedSource) || resolveErr != nil || currentErr != nil || expectedErr != nil || !os.SameFile(currentInfo, expectedInfo) {
				return errors.New("active engine directory differs from the website command; reopen the standard engine and regenerate the migration command, or explicitly select the correct --profile-dir")
			}
		}
		usage, err = migrateEngineStorage(ctx, *profileDir, *target)
	case "cleanup":
		if !*confirmed || *target != "" || *expectedSource != "" {
			return errors.New("cleanup requires --confirm; the previous copy will be deleted only if its recorded hashes still match")
		}
		current, resolveErr := desktopstorage.Resolve(*profileDir)
		if resolveErr != nil {
			return resolveErr
		}
		workspaceLock, lockErr := runtimeinfo.LockWorkspace(current)
		if lockErr != nil {
			return lockErr
		}
		defer workspaceLock.Close()
		if err = validateClosedEngine(current); err == nil {
			err = desktopstorage.CleanupPrevious(*profileDir, current, runtimeinfo.LockWorkspace)
		}
		if err == nil {
			usage, err = desktopstorage.Inspect(current)
		}
	default:
		return errors.New("unknown storage command")
	}
	if err != nil {
		return err
	}
	return json.NewEncoder(os.Stdout).Encode(map[string]any{"storage": usage, "next": "Open qisiTV again to use this workspace. Migration retains the previous directory until explicit storage cleanup --confirm."})
}

func validateClosedEngine(directory string) error {
	settings, err := os.ReadFile(filepath.Join(directory, "qisitv-engine.json"))
	if err != nil {
		return errors.New("source is not an initialized qisiTV engine workspace")
	}
	var parsed engineSettings
	if json.Unmarshal(settings, &parsed) != nil || parsed.WorkspaceID == "" {
		return errors.New("source engine identity is invalid")
	}
	for _, suffix := range []string{"-wal", "-journal"} {
		info, err := os.Stat(filepath.Join(directory, "open_ai_canvas.db"+suffix))
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		if err == nil && info.Size() > 0 {
			return errors.New("workspace has an uncheckpointed SQLite journal; open and cleanly stop the engine before migrating")
		}
	}
	// The workspace lock guarantees an offline snapshot. Immutable read mode
	// prevents validation itself from creating journal/shared-memory files.
	dsn := (&url.URL{Scheme: "file", Path: filepath.Join(directory, "open_ai_canvas.db"), RawQuery: "mode=ro&immutable=1&_query_only=1"}).String()
	db, err := sql.Open("sqlite3", dsn)
	if err != nil {
		return err
	}
	defer db.Close()
	var integrity string
	if err = db.QueryRow("PRAGMA integrity_check").Scan(&integrity); err != nil || integrity != "ok" {
		return errors.New("workspace SQLite integrity check failed; the original data has been retained")
	}
	var name string
	if err = db.QueryRow("SELECT name FROM sqlite_master WHERE type='table' AND name='canvas_projects'").Scan(&name); err != nil {
		return errors.New("source does not contain the qisiTV canvas schema")
	}
	return nil
}

// No running database is renamed or copied. Both pointer mutation and runtime
// startup serialize on the profile lock; each workspace also holds its own lock.
func migrateEngineStorage(ctx context.Context, profile, target string) (desktopstorage.Usage, error) {
	var empty desktopstorage.Usage
	source, err := desktopstorage.Resolve(profile)
	if err != nil {
		return empty, err
	}
	lock, err := runtimeinfo.LockWorkspace(source)
	if err != nil {
		return empty, fmt.Errorf("stop the qisiTV engine before migrating: %w", err)
	}
	defer lock.Close()
	if err = validateClosedEngine(source); err != nil {
		return empty, err
	}
	if overlap, err := desktopstorage.Overlaps(profile, target); err != nil || overlap {
		return empty, errors.New("destination must not overlap the fixed engine profile")
	}
	executable, err := os.Executable()
	if err != nil {
		return empty, err
	}
	if overlap, err := desktopstorage.Overlaps(filepath.Dir(executable), target); err != nil || overlap {
		return empty, errors.New("destination must not overlap the installed application")
	}
	settingsData, _ := os.ReadFile(filepath.Join(source, "qisitv-engine.json"))
	var settings engineSettings
	_ = json.Unmarshal(settingsData, &settings)
	if settings.ProjectDirectory != "" {
		if overlap, err := desktopstorage.Overlaps(settings.ProjectDirectory, target); err != nil || overlap {
			return empty, errors.New("engine cache destination must not overlap the independent project folders")
		}
	}
	if location, err := desktopstorage.MigrationLocation(profile, source); err != nil {
		return empty, err
	} else if location.PreviousDir != "" {
		return empty, errors.New("a previous migration copy is still retained; review and explicitly clean it before another migration")
	}
	files, err := desktopstorage.Snapshot(source)
	if err != nil {
		return empty, err
	}
	if err = desktopstorage.CopyClosedWorkspace(ctx, source, target); err != nil {
		return empty, err
	}
	if err = desktopstorage.VerifySnapshot(source, files, false); err != nil {
		return empty, err
	}
	if err = desktopstorage.VerifySnapshot(target, files, false); err != nil {
		return empty, err
	}
	if err = validateClosedEngine(target); err != nil {
		return empty, err
	}
	if err = ctx.Err(); err != nil {
		return empty, err
	}
	usage, err := desktopstorage.Inspect(target)
	if err != nil {
		return empty, err
	}
	if err = desktopstorage.SaveMigration(profile, target, source, files); err != nil {
		return empty, err
	}
	usage.PreviousDir = source
	return usage, nil
}
