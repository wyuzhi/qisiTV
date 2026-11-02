package desktopupdate

import (
	"archive/zip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
)

const (
	deltaManifestSchema   = 1
	deltaManifestFileName = "delta-manifest.json"
	deltaFilesPrefix      = "files/"
	deltaPatchesPrefix    = "patches/"
	deltaPatchSuffix      = ".patch"
	minBinaryPatchInput   = 64 * 1024
)

type DeltaManifest struct {
	Schema      int          `json:"schema"`
	FromVersion string       `json:"fromVersion"`
	ToVersion   string       `json:"toVersion"`
	Platform    string       `json:"platform"`
	ToSHA256    string       `json:"toSha256"`
	ToSize      int64        `json:"toSize"`
	Entries     []DeltaEntry `json:"entries"`
}

type DeltaEntry struct {
	Path        string `json:"path"`
	Mode        uint32 `json:"mode"`
	Op          string `json:"op"`
	Size        int64  `json:"size,omitempty"`
	SHA256      string `json:"sha256,omitempty"`
	FromSize    int64  `json:"fromSize,omitempty"`
	FromSHA256  string `json:"fromSha256,omitempty"`
	PatchSize   int64  `json:"patchSize,omitempty"`
	PatchSHA256 string `json:"patchSha256,omitempty"`
}

func DeltaArtifactFileName(version, platform, fromVersion string) string {
	return fmt.Sprintf("qisiTV-%s-%s-from-%s.delta.zip", version, platform, fromVersion)
}

func targetInstallContainer(targetPath, platform string) (string, string, error) {
	absTarget, err := filepath.Abs(targetPath)
	if err != nil {
		return "", "", err
	}
	switch {
	case strings.HasPrefix(platform, "darwin-"):
		if filepath.Base(absTarget) != appBundleName {
			return "", "", fmt.Errorf("invalid macOS target path")
		}
		return filepath.Dir(absTarget), absTarget, nil
	case platform == "linux-amd64":
		if filepath.Base(absTarget) != linuxBundleName {
			return "", "", fmt.Errorf("invalid Linux target path")
		}
		return filepath.Dir(absTarget), absTarget, nil
	case platform == "windows-amd64":
		if !strings.EqualFold(filepath.Base(absTarget), windowsExeName) {
			return "", "", fmt.Errorf("invalid Windows target path")
		}
		dir := filepath.Dir(absTarget)
		return dir, dir, nil
	default:
		return "", "", ErrUnsupported
	}
}

func extractedTargetPath(extractedRoot, platform string) (string, error) {
	switch {
	case strings.HasPrefix(platform, "darwin-"):
		return filepath.Join(extractedRoot, appBundleName), nil
	case platform == "linux-amd64":
		return filepath.Join(extractedRoot, linuxBundleName), nil
	case platform == "windows-amd64":
		return filepath.Join(extractedRoot, windowsExeName), nil
	default:
		return "", ErrUnsupported
	}
}

type zipEntryMeta struct {
	rel     string
	dirOnly bool
	mode    uint32
	size    int64
	sha256  string
	file    *zip.File
}

func indexArchiveEntries(zipPath string, limits extractLimits) ([]zipEntryMeta, map[string]zipEntryMeta, error) {
	reader, err := zip.OpenReader(zipPath)
	if err != nil {
		return nil, nil, ErrInvalidArchive
	}
	defer reader.Close()
	if len(reader.File) == 0 || len(reader.File) > limits.MaxFiles {
		return nil, nil, ErrInvalidArchive
	}
	seen := make(map[string]struct{}, len(reader.File))
	byPath := make(map[string]zipEntryMeta, len(reader.File))
	list := make([]zipEntryMeta, 0, len(reader.File))
	var total uint64
	for _, f := range reader.File {
		rel, dirOnly, err := sanitizeZipName(f.Name)
		if err != nil {
			return nil, nil, err
		}
		key := strings.ToLower(rel)
		if _, dup := seen[key]; dup {
			return nil, nil, ErrInvalidArchive
		}
		seen[key] = struct{}{}
		if isZipSymlink(f) {
			return nil, nil, ErrInvalidArchive
		}
		isDir := dirOnly || f.FileInfo().IsDir()
		perm := uint32(f.Mode().Perm() &^ (os.ModeSetuid | os.ModeSetgid | os.ModeSticky))
		if isDir {
			if perm == 0 {
				perm = 0o755
			}
			meta := zipEntryMeta{rel: rel, dirOnly: true, mode: perm}
			list = append(list, meta)
			byPath[rel] = meta
			continue
		}
		if perm == 0 {
			perm = 0o644
		}
		if f.UncompressedSize64 > limits.MaxEntryBytes || total+f.UncompressedSize64 < total || total+f.UncompressedSize64 > limits.MaxTotalBytes {
			return nil, nil, ErrInvalidArchive
		}
		total += f.UncompressedSize64
		rc, err := f.Open()
		if err != nil {
			return nil, nil, err
		}
		h := sha256.New()
		n, copyErr := io.Copy(h, io.LimitReader(rc, int64(limits.MaxEntryBytes)+1))
		_ = rc.Close()
		if copyErr != nil || uint64(n) != f.UncompressedSize64 {
			return nil, nil, ErrInvalidArchive
		}
		meta := zipEntryMeta{
			rel:    rel,
			mode:   perm,
			size:   n,
			sha256: hex.EncodeToString(h.Sum(nil)),
		}
		list = append(list, meta)
		byPath[rel] = meta
	}
	return list, byPath, nil
}

func readZipEntryBytes(zr *zip.ReadCloser, rel string, expectedSize int64) ([]byte, error) {
	for _, f := range zr.File {
		clean, dirOnly, err := sanitizeZipName(f.Name)
		if err != nil || dirOnly || clean != rel {
			continue
		}
		rc, err := f.Open()
		if err != nil {
			return nil, err
		}
		defer rc.Close()
		data, err := io.ReadAll(io.LimitReader(rc, expectedSize+1))
		if err != nil {
			return nil, err
		}
		if int64(len(data)) != expectedSize {
			return nil, ErrInvalidArchive
		}
		return data, nil
	}
	return nil, ErrInvalidArchive
}

// BuildDeltaZip creates a signed-ready incremental archive transforming fromZipPath into toZipPath,
// and self-verifies that applying the generated delta to fromZipPath reproduces toZipPath bit-for-bit.
func BuildDeltaZip(platform, fromVersion, toVersion, fromZipPath, toZipPath, outputZipPath string) error {
	if !knownPlatform(platform) {
		return ErrUnsupported
	}
	cmp, err := compareStable(fromVersion, toVersion)
	if err != nil || cmp >= 0 {
		return fmt.Errorf("fromVersion %q must be an older stable version than toVersion %q", fromVersion, toVersion)
	}
	limits := defaultExtractLimits()
	_, fromMap, err := indexArchiveEntries(fromZipPath, limits)
	if err != nil {
		return fmt.Errorf("index from-zip: %w", err)
	}
	toList, _, err := indexArchiveEntries(toZipPath, limits)
	if err != nil {
		return fmt.Errorf("index to-zip: %w", err)
	}

	fromReader, err := zip.OpenReader(fromZipPath)
	if err != nil {
		return err
	}
	defer fromReader.Close()
	toReader, err := zip.OpenReader(toZipPath)
	if err != nil {
		return err
	}
	defer toReader.Close()

	// Determine which directories have child entries so we only emit explicit dir entries for empty dirs.
	nonEmptyDirs := make(map[string]struct{}, 512)
	for _, item := range toList {
		for dir := path.Dir(item.rel); dir != "." && dir != "/"; dir = path.Dir(dir) {
			nonEmptyDirs[dir] = struct{}{}
		}
	}

	if err := os.MkdirAll(filepath.Dir(outputZipPath), 0o755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(outputZipPath), ".qisitv-delta-*.zip")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer func() {
		_ = tmp.Close()
		_ = os.Remove(tmpName)
	}()

	zw := zip.NewWriter(tmp)
	entries := make([]DeltaEntry, 0, len(toList))
	for _, item := range toList {
		if item.dirOnly {
			if _, hasChildren := nonEmptyDirs[item.rel]; !hasChildren {
				entries = append(entries, DeltaEntry{
					Path: item.rel,
					Mode: item.mode,
					Op:   "dir",
				})
			}
			continue
		}
		if prev, ok := fromMap[item.rel]; ok && !prev.dirOnly {
			if prev.size == item.size && strings.EqualFold(prev.sha256, item.sha256) {
				entries = append(entries, DeltaEntry{
					Path:   item.rel,
					Mode:   item.mode,
					Op:     "copy",
					Size:   item.size,
					SHA256: item.sha256,
				})
				continue
			}
			if prev.size >= minBinaryPatchInput && item.size >= minBinaryPatchInput {
				oldBytes, oldErr := readZipEntryBytes(fromReader, item.rel, prev.size)
				newBytes, newErr := readZipEntryBytes(toReader, item.rel, item.size)
				if oldErr == nil && newErr == nil {
					if patchBytes, patchErr := BuildBinaryPatch(oldBytes, newBytes); patchErr == nil && int64(len(patchBytes)) < item.size*4/5 {
						patchSum := sha256.Sum256(patchBytes)
						patchHex := hex.EncodeToString(patchSum[:])
						hdr := &zip.FileHeader{
							Name:   deltaPatchesPrefix + item.rel + deltaPatchSuffix,
							Method: zip.Store,
						}
						hdr.SetMode(0o644)
						w, createErr := zw.CreateHeader(hdr)
						if createErr != nil {
							_ = zw.Close()
							return createErr
						}
						if _, writeErr := w.Write(patchBytes); writeErr != nil {
							_ = zw.Close()
							return writeErr
						}
						entries = append(entries, DeltaEntry{
							Path:        item.rel,
							Mode:        item.mode,
							Op:          "patch",
							Size:        item.size,
							SHA256:      item.sha256,
							FromSize:    prev.size,
							FromSHA256:  prev.sha256,
							PatchSize:   int64(len(patchBytes)),
							PatchSHA256: patchHex,
						})
						continue
					}
				}
			}
		}
		newBytes, err := readZipEntryBytes(toReader, item.rel, item.size)
		if err != nil {
			_ = zw.Close()
			return err
		}
		hdr := &zip.FileHeader{
			Name:   deltaFilesPrefix + item.rel,
			Method: zip.Deflate,
		}
		hdr.SetMode(os.FileMode(item.mode))
		w, err := zw.CreateHeader(hdr)
		if err != nil {
			_ = zw.Close()
			return err
		}
		if _, err := w.Write(newBytes); err != nil {
			_ = zw.Close()
			return err
		}
		entries = append(entries, DeltaEntry{
			Path:   item.rel,
			Mode:   item.mode,
			Op:     "replace",
			Size:   item.size,
			SHA256: item.sha256,
		})
	}

	sort.Slice(entries, func(i, j int) bool { return entries[i].Path < entries[j].Path })
	toZipSHA, toZipSize, err := hashAnyRegularFile(toZipPath)
	if err != nil {
		_ = zw.Close()
		return err
	}
	manifest := DeltaManifest{
		Schema:      deltaManifestSchema,
		FromVersion: fromVersion,
		ToVersion:   toVersion,
		Platform:    platform,
		ToSHA256:    toZipSHA,
		ToSize:      toZipSize,
		Entries:     entries,
	}
	manifestBytes, err := json.Marshal(manifest)
	if err != nil {
		_ = zw.Close()
		return err
	}
	hdr := &zip.FileHeader{
		Name:   deltaManifestFileName,
		Method: zip.Deflate,
	}
	hdr.SetMode(0o644)
	mw, err := zw.CreateHeader(hdr)
	if err != nil {
		_ = zw.Close()
		return err
	}
	if _, err := mw.Write(manifestBytes); err != nil {
		_ = zw.Close()
		return err
	}
	if err := zw.Close(); err != nil {
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}

	// Self-verify by reconstructing toZip from fromZip + tmpName in an isolated temp directory.
	verifyRoot, err := os.MkdirTemp("", "qisitv-delta-verify-*")
	if err != nil {
		return err
	}
	defer os.RemoveAll(verifyRoot)
	fromExtracted := filepath.Join(verifyRoot, "from")
	if err := extractSecureZip(fromZipPath, fromExtracted, limits); err != nil {
		return fmt.Errorf("extract from-zip for delta verification: %w", err)
	}
	targetInFrom, err := extractedTargetPath(fromExtracted, platform)
	if err != nil {
		return err
	}
	if err := verifyDeltaAgainstTarget(context.Background(), tmpName, targetInFrom, platform, fromVersion, toVersion); err != nil {
		return fmt.Errorf("verify generated delta against from-zip: %w", err)
	}
	reconstructed := filepath.Join(verifyRoot, "reconstructed")
	if err := applyDeltaZipWithProgress(context.Background(), tmpName, targetInFrom, platform, reconstructed, limits, nil); err != nil {
		return fmt.Errorf("apply generated delta to from-zip: %w", err)
	}
	if err := validateExtractedLayout(reconstructed, platform); err != nil {
		return fmt.Errorf("reconstructed layout invalid: %w", err)
	}
	if err := verifyReconstructedMatchesArchive(reconstructed, toList); err != nil {
		return err
	}
	return os.Rename(tmpName, outputZipPath)
}

func verifyReconstructedMatchesArchive(reconstructed string, expected []zipEntryMeta) error {
	expectedFiles := make(map[string]zipEntryMeta, len(expected))
	for _, item := range expected {
		if !item.dirOnly {
			expectedFiles[item.rel] = item
		}
	}
	var actualCount int
	err := filepath.WalkDir(reconstructed, func(p string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if d.IsDir() {
			return nil
		}
		rel, err := filepath.Rel(reconstructed, p)
		if err != nil {
			return err
		}
		slashRel := filepath.ToSlash(rel)
		exp, ok := expectedFiles[slashRel]
		if !ok {
			return fmt.Errorf("reconstructed unexpected file %s", slashRel)
		}
		sum, size, err := hashRegularFile(p, exp.size)
		if err != nil || size != exp.size || !strings.EqualFold(sum, exp.sha256) {
			return fmt.Errorf("reconstructed file mismatch for %s", slashRel)
		}
		actualCount++
		return nil
	})
	if err != nil {
		return err
	}
	if actualCount != len(expectedFiles) {
		return fmt.Errorf("reconstructed file count %d does not match expected %d", actualCount, len(expectedFiles))
	}
	return nil
}
