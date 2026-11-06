package skillhub

import (
	"archive/zip"
	"bytes"
	"os"
	"strings"
	"testing"
)

func buildTestReleaseArchive(t *testing.T, files map[string][]byte, mode os.FileMode) ([]byte, *Release) {
	t.Helper()
	var data bytes.Buffer
	writer := zip.NewWriter(&data)
	release := &Release{ContentHash: ContentDigest(files)}
	for name, content := range files {
		header := &zip.FileHeader{Name: name, Method: zip.Deflate}
		header.SetMode(mode)
		entry, err := writer.CreateHeader(header)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := entry.Write(content); err != nil {
			t.Fatal(err)
		}
		release.Files = append(release.Files, File{Path: name, Size: int64(len(content)), SHA256: Digest(content)})
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	release.ArchiveBytes = int64(data.Len())
	release.ArchiveSHA256 = Digest(data.Bytes())
	return data.Bytes(), release
}

func TestVerifyArchiveRejectsUnlistedPathsAndDigestChanges(t *testing.T) {
	files := map[string][]byte{"SKILL.md": []byte("---\nname: example\ndescription: Example\n---\nInstructions\n")}
	raw, release := buildTestReleaseArchive(t, files, 0600)
	if _, err := VerifyArchive(raw, release); err != nil {
		t.Fatal(err)
	}
	release.Files[0].SHA256 = "wrong"
	if _, err := VerifyArchive(raw, release); err == nil {
		t.Fatal("file digest mismatch accepted")
	}
	release.Files[0].SHA256 = Digest(files["SKILL.md"])
	release.Files = append(release.Files, release.Files[0])
	if _, err := VerifyArchive(raw, release); err == nil {
		t.Fatal("duplicate manifest path accepted")
	}
	for _, name := range []string{"../escape", "x/../escape", "/absolute", "a\\b", "a:b", "x/.git/config", "CON.txt", "a/trailing.", "a/b?c", "__MACOSX/a"} {
		if SafeFilePath(name) {
			t.Errorf("unsafe path accepted: %q", name)
		}
	}
}

func TestVerifyArchiveAcceptsScriptsLargeFilesAndExecutablesWhileRejectingSecretsAndUnsafeEntries(t *testing.T) {
	desc := strings.Repeat("述", MaxDescriptionRunes)
	largeFile := bytes.Repeat([]byte("a"), 3<<20)
	files := map[string][]byte{
		"SKILL.md":           []byte("---\nname: example\ndescription: " + desc + "\n---\nRun the attached file.\n"),
		"scripts/run.py":     []byte("#!/usr/bin/env python3\nprint('ok')\n"),
		"script/helper.sh":   []byte("#!/bin/sh\necho ok\n"),
		"assets/font.woff2":  {0x00, 0x01, 0x77, 0x4f, 0x46, 0x32, 0xff},
		"assets/large.bin":   largeFile,
	}
	raw, release := buildTestReleaseArchive(t, files, 0755)
	if !HasScripts(release.Files) {
		t.Fatal("expected HasScripts to detect scripts/ entry")
	}
	verified, err := VerifyArchive(raw, release)
	if err != nil {
		t.Fatalf("expected scripts, executable bits, binary, and >2 MiB file to be accepted: %v", err)
	}
	if len(verified["assets/large.bin"]) != len(largeFile) {
		t.Fatalf("large file size = %d, want %d", len(verified["assets/large.bin"]), len(largeFile))
	}

	for _, rejectedPath := range []string{
		"../escape.py",
		"node_modules/pkg/index.js",
		".env",
		"config/.env.production",
		"credentials.json",
		"secrets.json",
		"tokens.json",
		"auth.json",
		"keys/private_key.txt",
		"keys/server.pem",
	} {
		if DataFilePath(rejectedPath) {
			t.Fatalf("expected DataFilePath to reject %q", rejectedPath)
		}
		badFiles := map[string][]byte{
			"SKILL.md":   files["SKILL.md"],
			rejectedPath: []byte("content"),
		}
		badRaw, badRelease := buildTestReleaseArchive(t, badFiles, 0600)
		if _, err := VerifyArchive(badRaw, badRelease); err == nil {
			t.Fatalf("expected VerifyArchive to reject %q", rejectedPath)
		}
	}

	symlinkRaw, symlinkRelease := buildTestReleaseArchive(t, map[string][]byte{
		"SKILL.md": files["SKILL.md"],
		"link.py":  []byte("target"),
	}, os.ModeSymlink|0777)
	if _, err := VerifyArchive(symlinkRaw, symlinkRelease); err == nil {
		t.Fatal("symlink entry accepted")
	}

	secretRaw, secretRelease := buildTestReleaseArchive(t, map[string][]byte{
		"SKILL.md":       files["SKILL.md"],
		"scripts/key.py": []byte("-----BEGIN PRIVATE KEY-----\nabc\n"),
	}, 0600)
	if _, err := VerifyArchive(secretRaw, secretRelease); err == nil {
		t.Fatal("private key literal accepted")
	}

	oversizedRelease := *release
	oversizedRelease.Files = append([]File{}, release.Files...)
	oversizedRelease.Files[0].Size = MaxPackageBytes + 1
	if _, err := VerifyArchive(raw, &oversizedRelease); err == nil {
		t.Fatal("oversized total accepted")
	}

	tooLongDesc := strings.Repeat("述", MaxDescriptionRunes+1)
	if _, err := SkillName([]byte("---\nname: example\ndescription: " + tooLongDesc + "\n---\nBody\n")); err == nil {
		t.Fatal("description over 1024 runes accepted")
	}
}
