package projectfolder

import (
	"context"
	"errors"
	"fmt"
	"os"
)

// Status polling checks the real manifest and media inventory without rereading
// gigabytes of media every four seconds. Explicit recovery also verifies hashes.
func (s *Service) checkFolderFiles(b binding, verifyMediaHashes bool) error {
	directory, err := openProject(s.options.RootDirectory, b.Directory)
	if err != nil {
		return fmt.Errorf("project folder unavailable: %w", err)
	}
	defer directory.Close()
	raw, err := readBounded(directory, ManifestName, MaxManifestBytes)
	if errors.Is(err, os.ErrNotExist) && b.ManifestSHA256 == "" {
		return nil
	}
	if err != nil {
		return fmt.Errorf("project manifest unavailable: %w", err)
	}
	digest := digestBytes(raw)
	if digest != b.ManifestSHA256 && digest != b.PendingManifestSHA256 {
		return ErrConflict
	}
	manifest, err := parseManifest(raw)
	if err != nil {
		return err
	}
	for _, media := range manifest.Media {
		if verifyMediaHashes {
			if err := verifyFile(directory, media.Path, media.Bytes, media.SHA256); err != nil {
				return fmt.Errorf("project media unavailable: %s: %w", media.Path, err)
			}
			continue
		}
		info, err := directory.Stat(media.Path)
		if err != nil {
			return fmt.Errorf("project media unavailable: %s: %w", media.Path, err)
		}
		if !info.Mode().IsRegular() || info.Size() != media.Bytes {
			return fmt.Errorf("project media size changed: %s", media.Path)
		}
	}
	return nil
}

func (s *Service) recordFolderFailure(ctx context.Context, b *binding, failure error) error {
	state := "error"
	if errors.Is(failure, ErrConflict) {
		state = "conflict"
	}
	if b.State == "conflict" {
		return nil
	}
	if b.State == state && b.LastError == failure.Error() {
		return nil
	}
	if err := s.db.WithContext(ctx).Model(&binding{}).Where("canvas_id=? AND user_id=?", b.CanvasID, b.UserID).Updates(map[string]any{"state": state, "last_error": failure.Error()}).Error; err != nil {
		return err
	}
	b.State, b.LastError = state, failure.Error()
	return nil
}
