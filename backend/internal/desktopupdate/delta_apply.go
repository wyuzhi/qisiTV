package desktopupdate

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// ValidateDeltaArchive checks the structure, limits, and internal payload digests of a .delta.zip file.
func ValidateDeltaArchive(platform, fromVersion, toVersion, deltaZipPath string) (DeltaManifest, error) {
	reader, err := zip.OpenReader(deltaZipPath)
	if err != nil {
		return DeltaManifest{}, ErrInvalidArchive
	}
	defer reader.Close()
	manifest, zipFiles, err := parseAndValidateDeltaReader(&reader.Reader, platform, fromVersion, toVersion, defaultExtractLimits())
	if err != nil {
		return DeltaManifest{}, err
	}
	for _, entry := range manifest.Entries {
		switch entry.Op {
		case "replace":
			zf := zipFiles[deltaFilesPrefix+entry.Path]
			if err := verifyZipFileDigest(zf, entry.Size, entry.SHA256); err != nil {
				return DeltaManifest{}, err
			}
		case "patch":
			zf := zipFiles[deltaPatchesPrefix+entry.Path+deltaPatchSuffix]
			if err := verifyZipFileDigest(zf, entry.PatchSize, entry.PatchSHA256); err != nil {
				return DeltaManifest{}, err
			}
		}
	}
	return manifest, nil
}

func verifyZipFileDigest(zf *zip.File, expectedSize int64, expectedSHA string) error {
	if zf == nil || int64(zf.UncompressedSize64) != expectedSize {
		return ErrInvalidArchive
	}
	rc, err := zf.Open()
	if err != nil {
		return err
	}
	defer rc.Close()
	h := sha256.New()
	n, err := io.Copy(h, io.LimitReader(rc, expectedSize+1))
	if err != nil || n != expectedSize || !strings.EqualFold(hex.EncodeToString(h.Sum(nil)), expectedSHA) {
		return ErrTampered
	}
	return nil
}

func parseAndValidateDeltaReader(zr *zip.Reader, platform, fromVersion, toVersion string, limits extractLimits) (DeltaManifest, map[string]*zip.File, error) {
	if len(zr.File) == 0 || len(zr.File) > limits.MaxFiles {
		return DeltaManifest{}, nil, ErrInvalidArchive
	}
	zipFiles := make(map[string]*zip.File, len(zr.File))
	for _, f := range zr.File {
		clean, dirOnly, err := sanitizeZipName(f.Name)
		if err != nil || dirOnly || isZipSymlink(f) {
			return DeltaManifest{}, nil, ErrInvalidArchive
		}
		if _, dup := zipFiles[clean]; dup {
			return DeltaManifest{}, nil, ErrInvalidArchive
		}
		zipFiles[clean] = f
	}
	mf, ok := zipFiles[deltaManifestFileName]
	if !ok || mf.UncompressedSize64 > 16*1024*1024 {
		return DeltaManifest{}, nil, ErrInvalidArchive
	}
	rc, err := mf.Open()
	if err != nil {
		return DeltaManifest{}, nil, ErrInvalidArchive
	}
	manifestBytes, readErr := io.ReadAll(io.LimitReader(rc, int64(mf.UncompressedSize64)+1))
	_ = rc.Close()
	if readErr != nil || uint64(len(manifestBytes)) != mf.UncompressedSize64 {
		return DeltaManifest{}, nil, ErrInvalidArchive
	}
	var manifest DeltaManifest
	if err := decodeJSONStrict(manifestBytes, &manifest); err != nil {
		return DeltaManifest{}, nil, ErrInvalidArchive
	}
	if manifest.Schema != deltaManifestSchema || manifest.Platform != platform || len(manifest.Entries) == 0 || len(manifest.Entries) > limits.MaxFiles {
		return DeltaManifest{}, nil, ErrInvalidArchive
	}
	if manifest.ToSize <= 0 || !sha256Hex.MatchString(manifest.ToSHA256) {
		return DeltaManifest{}, nil, ErrInvalidArchive
	}
	if fromVersion != "" && manifest.FromVersion != fromVersion {
		return DeltaManifest{}, nil, ErrInvalidArchive
	}
	if toVersion != "" && manifest.ToVersion != toVersion {
		return DeltaManifest{}, nil, ErrInvalidArchive
	}
	if cmp, err := compareStable(manifest.FromVersion, manifest.ToVersion); err != nil || cmp >= 0 {
		return DeltaManifest{}, nil, ErrInvalidArchive
	}

	seenPaths := make(map[string]struct{}, len(manifest.Entries))
	var totalBytes uint64
	for _, entry := range manifest.Entries {
		clean, dirOnly, err := sanitizeZipName(entry.Path)
		if err != nil || dirOnly || clean != entry.Path {
			return DeltaManifest{}, nil, ErrInvalidArchive
		}
		key := strings.ToLower(clean)
		if _, dup := seenPaths[key]; dup {
			return DeltaManifest{}, nil, ErrInvalidArchive
		}
		seenPaths[key] = struct{}{}
		if entry.Op == "dir" {
			if entry.Size != 0 || entry.SHA256 != "" || entry.FromSize != 0 || entry.FromSHA256 != "" || entry.PatchSize != 0 || entry.PatchSHA256 != "" {
				return DeltaManifest{}, nil, ErrInvalidArchive
			}
			continue
		}
		if entry.Size < 0 || uint64(entry.Size) > limits.MaxEntryBytes || !sha256Hex.MatchString(entry.SHA256) {
			return DeltaManifest{}, nil, ErrInvalidArchive
		}
		if totalBytes+uint64(entry.Size) < totalBytes || totalBytes+uint64(entry.Size) > limits.MaxTotalBytes {
			return DeltaManifest{}, nil, ErrInvalidArchive
		}
		totalBytes += uint64(entry.Size)
		switch entry.Op {
		case "copy":
			if entry.FromSize != 0 || entry.FromSHA256 != "" || entry.PatchSize != 0 || entry.PatchSHA256 != "" {
				return DeltaManifest{}, nil, ErrInvalidArchive
			}
		case "replace":
			zf := zipFiles[deltaFilesPrefix+entry.Path]
			if zf == nil || int64(zf.UncompressedSize64) != entry.Size {
				return DeltaManifest{}, nil, ErrInvalidArchive
			}
		case "patch":
			if entry.FromSize <= 0 || uint64(entry.FromSize) > limits.MaxEntryBytes || !sha256Hex.MatchString(entry.FromSHA256) {
				return DeltaManifest{}, nil, ErrInvalidArchive
			}
			if entry.PatchSize <= 0 || uint64(entry.PatchSize) > limits.MaxEntryBytes || !sha256Hex.MatchString(entry.PatchSHA256) {
				return DeltaManifest{}, nil, ErrInvalidArchive
			}
			zf := zipFiles[deltaPatchesPrefix+entry.Path+deltaPatchSuffix]
			if zf == nil || int64(zf.UncompressedSize64) != entry.PatchSize {
				return DeltaManifest{}, nil, ErrInvalidArchive
			}
		default:
			return DeltaManifest{}, nil, ErrInvalidArchive
		}
	}
	return manifest, zipFiles, nil
}

func hashAnyRegularFile(path string) (string, int64, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return "", 0, err
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() || info.Size() <= 0 {
		return "", 0, ErrInvalidArchive
	}
	return hashRegularFile(path, info.Size())
}

func hashRegularFile(path string, expectedSize int64) (string, int64, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return "", 0, err
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
		return "", 0, ErrInvalidArchive
	}
	if expectedSize >= 0 && info.Size() != expectedSize {
		return "", info.Size(), ErrTampered
	}
	f, err := os.Open(path)
	if err != nil {
		return "", 0, err
	}
	defer f.Close()
	h := sha256.New()
	n, err := io.Copy(h, io.LimitReader(f, expectedSize+1))
	if err != nil || n != expectedSize {
		return "", n, ErrTampered
	}
	return hex.EncodeToString(h.Sum(nil)), n, nil
}

func verifyDeltaAgainstTarget(ctx context.Context, deltaZipPath, targetPath, platform, fromVersion, toVersion string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	containerDir, allowedRoot, err := targetInstallContainer(targetPath, platform)
	if err != nil {
		return err
	}
	reader, err := zip.OpenReader(deltaZipPath)
	if err != nil {
		return ErrInvalidArchive
	}
	defer reader.Close()
	manifest, _, err := parseAndValidateDeltaReader(&reader.Reader, platform, fromVersion, toVersion, defaultExtractLimits())
	if err != nil {
		return err
	}
	for _, entry := range manifest.Entries {
		if err := ctx.Err(); err != nil {
			return err
		}
		if entry.Op != "copy" && entry.Op != "patch" {
			continue
		}
		srcPath := filepath.Join(containerDir, filepath.FromSlash(entry.Path))
		if !withinRoot(allowedRoot, srcPath) {
			return ErrInvalidArchive
		}
		wantSize := entry.Size
		wantSHA := entry.SHA256
		if entry.Op == "patch" {
			wantSize = entry.FromSize
			wantSHA = entry.FromSHA256
		}
		gotSHA, gotSize, err := hashRegularFile(srcPath, wantSize)
		if err != nil || gotSize != wantSize || !strings.EqualFold(gotSHA, wantSHA) {
			return fmt.Errorf("local base file mismatch for %s", entry.Path)
		}
	}
	return nil
}

func applyDeltaZipWithProgress(ctx context.Context, deltaZipPath, targetPath, platform, dest string, limits extractLimits, progress func(int, int)) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if limits.MaxFiles <= 0 {
		limits = defaultExtractLimits()
	}
	containerDir, allowedRoot, err := targetInstallContainer(targetPath, platform)
	if err != nil {
		return err
	}
	reader, err := zip.OpenReader(deltaZipPath)
	if err != nil {
		return ErrInvalidArchive
	}
	defer reader.Close()
	manifest, zipFiles, err := parseAndValidateDeltaReader(&reader.Reader, platform, "", "", limits)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(dest, 0o700); err != nil {
		return err
	}
	root, err := filepath.Abs(dest)
	if err != nil {
		return err
	}
	totalFiles := 0
	for _, entry := range manifest.Entries {
		if entry.Op != "dir" {
			totalFiles++
		}
	}
	completed := 0
	if progress != nil {
		progress(0, totalFiles)
	}
	createdDirs := make(map[string]struct{}, 512)
	ensureDir := func(dir string) error {
		if _, ok := createdDirs[dir]; ok {
			return nil
		}
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return err
		}
		createdDirs[dir] = struct{}{}
		return nil
	}
	copyBuf := make([]byte, 64*1024)
	for _, entry := range manifest.Entries {
		if err := ctx.Err(); err != nil {
			return err
		}
		dstPath := filepath.Join(root, filepath.FromSlash(entry.Path))
		if !withinRoot(root, dstPath) {
			return ErrInvalidArchive
		}
		if entry.Op == "dir" {
			if err := ensureDir(dstPath); err != nil {
				return err
			}
			continue
		}
		if err := ensureDir(filepath.Dir(dstPath)); err != nil {
			return err
		}
		perm := os.FileMode(entry.Mode).Perm()
		if perm == 0 {
			perm = 0o644
		}
		perm &^= os.ModeSetuid | os.ModeSetgid | os.ModeSticky

		switch entry.Op {
		case "copy":
			srcPath := filepath.Join(containerDir, filepath.FromSlash(entry.Path))
			if !withinRoot(allowedRoot, srcPath) {
				return ErrInvalidArchive
			}
			if err := copyAndVerifyStreamFile(ctx, srcPath, dstPath, perm, entry.Size, entry.SHA256, copyBuf); err != nil {
				return err
			}
		case "replace":
			zf := zipFiles[deltaFilesPrefix+entry.Path]
			if err := writeAndVerifyZipFile(ctx, zf, dstPath, perm, entry.Size, entry.SHA256, copyBuf); err != nil {
				return err
			}
		case "patch":
			srcPath := filepath.Join(containerDir, filepath.FromSlash(entry.Path))
			if !withinRoot(allowedRoot, srcPath) {
				return ErrInvalidArchive
			}
			zf := zipFiles[deltaPatchesPrefix+entry.Path+deltaPatchSuffix]
			if err := applyAndVerifyPatchedFile(ctx, srcPath, zf, dstPath, perm, entry); err != nil {
				return err
			}
		default:
			return ErrInvalidArchive
		}
		completed++
		if progress != nil {
			progress(completed, totalFiles)
		}
	}
	return rejectExtractedSymlinks(root)
}

func copyAndVerifyStreamFile(ctx context.Context, srcPath, dstPath string, perm os.FileMode, wantSize int64, wantSHA string, buf []byte) error {
	info, err := os.Lstat(srcPath)
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() || info.Size() != wantSize {
		return ErrTampered
	}
	in, err := os.Open(srcPath)
	if err != nil {
		return err
	}
	defer in.Close()
	return writeVerifiedReader(ctx, in, dstPath, perm, wantSize, wantSHA, buf)
}

func writeAndVerifyZipFile(ctx context.Context, zf *zip.File, dstPath string, perm os.FileMode, wantSize int64, wantSHA string, buf []byte) error {
	if zf == nil || int64(zf.UncompressedSize64) != wantSize {
		return ErrInvalidArchive
	}
	rc, err := zf.Open()
	if err != nil {
		return err
	}
	defer rc.Close()
	return writeVerifiedReader(ctx, rc, dstPath, perm, wantSize, wantSHA, buf)
}

func writeVerifiedReader(ctx context.Context, r io.Reader, dstPath string, perm os.FileMode, wantSize int64, wantSHA string, buf []byte) error {
	out, err := os.OpenFile(dstPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, perm)
	if err != nil {
		return err
	}
	h := sha256.New()
	mw := io.MultiWriter(out, h)
	n, copyErr := io.CopyBuffer(mw, io.LimitReader(contextReader{ctx, r}, wantSize+1), buf)
	closeErr := out.Close()
	if copyErr != nil {
		return copyErr
	}
	if closeErr != nil {
		return closeErr
	}
	if n != wantSize || !strings.EqualFold(hex.EncodeToString(h.Sum(nil)), wantSHA) {
		return ErrTampered
	}
	return nil
}

func applyAndVerifyPatchedFile(ctx context.Context, srcPath string, patchZf *zip.File, dstPath string, perm os.FileMode, entry DeltaEntry) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	info, err := os.Lstat(srcPath)
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() || info.Size() != entry.FromSize {
		return ErrTampered
	}
	oldBytes, err := os.ReadFile(srcPath)
	if err != nil || int64(len(oldBytes)) != entry.FromSize {
		return ErrTampered
	}
	oldSum := sha256.Sum256(oldBytes)
	if !strings.EqualFold(hex.EncodeToString(oldSum[:]), entry.FromSHA256) {
		return ErrTampered
	}
	if patchZf == nil || int64(patchZf.UncompressedSize64) != entry.PatchSize {
		return ErrInvalidArchive
	}
	rc, err := patchZf.Open()
	if err != nil {
		return err
	}
	patchBytes, readErr := io.ReadAll(io.LimitReader(contextReader{ctx, rc}, entry.PatchSize+1))
	_ = rc.Close()
	if readErr != nil || int64(len(patchBytes)) != entry.PatchSize {
		return ErrInvalidArchive
	}
	patchSum := sha256.Sum256(patchBytes)
	if !strings.EqualFold(hex.EncodeToString(patchSum[:]), entry.PatchSHA256) {
		return ErrTampered
	}
	newBytes, err := ApplyBinaryPatch(oldBytes, patchBytes)
	if err != nil {
		return err
	}
	if int64(len(newBytes)) != entry.Size {
		return ErrTampered
	}
	newSum := sha256.Sum256(newBytes)
	if !strings.EqualFold(hex.EncodeToString(newSum[:]), entry.SHA256) {
		return ErrTampered
	}
	return writeVerifiedReader(ctx, bytes.NewReader(newBytes), dstPath, perm, entry.Size, entry.SHA256, make([]byte, 64*1024))
}
