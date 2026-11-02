package main

import (
	"fmt"
	"io"
	"path/filepath"
	"strings"

	"qisitv/backend/internal/desktopupdate"
)

func cmdBuildDelta(args []string, stdout, stderr io.Writer) error {
	fs := newFlagSet("build-delta", stderr)
	platform := fs.String("platform", "", "darwin-arm64, darwin-amd64, windows-amd64, or linux-amd64")
	fromVersion := fs.String("from-version", "", "source stable version such as v2.0.6")
	toVersion := fs.String("to-version", "", "target stable version such as v2.1.0")
	fromZip := fs.String("from-zip", "", "path to source platform update zip")
	toZip := fs.String("to-zip", "", "path to target platform update zip")
	output := fs.String("output", "", "output .delta.zip path")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if err := validatePlatform(*platform); err != nil {
		return err
	}
	parsedFrom, err := parseStableVersion(*fromVersion)
	if err != nil {
		return fmt.Errorf("--from-version: %w", err)
	}
	parsedTo, err := parseStableVersion(*toVersion)
	if err != nil {
		return fmt.Errorf("--to-version: %w", err)
	}
	if parsedTo.compare(parsedFrom) <= 0 {
		return fmt.Errorf("--to-version %s must be newer than --from-version %s", parsedTo, parsedFrom)
	}
	if strings.TrimSpace(*fromZip) == "" || strings.TrimSpace(*toZip) == "" || strings.TrimSpace(*output) == "" {
		return fmt.Errorf("build-delta requires --from-zip, --to-zip, and --output")
	}
	if err := validateArchive(*platform, *toZip); err != nil {
		return fmt.Errorf("--to-zip: %w", err)
	}
	expectedName := deltaArtifactFileName(parsedTo.String(), *platform, parsedFrom.String())
	if filepath.Base(*output) != expectedName {
		return fmt.Errorf("delta output must be named %s", expectedName)
	}
	if err := desktopupdate.BuildDeltaZip(*platform, parsedFrom.String(), parsedTo.String(), *fromZip, *toZip, *output); err != nil {
		return err
	}
	sum, size, err := fileSHA256AndSize(*output)
	if err != nil {
		return err
	}
	fmt.Fprintf(stdout, "path=%s\nsha256=%s\nsize=%d\n", *output, sum, size)
	return nil
}

func cmdVerifyDelta(args []string, stdout, stderr io.Writer) error {
	fs := newFlagSet("verify-delta", stderr)
	platform := fs.String("platform", "", "darwin-arm64, darwin-amd64, windows-amd64, or linux-amd64")
	fromVersion := fs.String("from-version", "", "expected source version")
	toVersion := fs.String("to-version", "", "expected target version")
	input := fs.String("input", "", "path to .delta.zip")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if err := validatePlatform(*platform); err != nil {
		return err
	}
	if strings.TrimSpace(*input) == "" {
		return fmt.Errorf("verify-delta requires --input")
	}
	manifest, err := desktopupdate.ValidateDeltaArchive(*platform, strings.TrimSpace(*fromVersion), strings.TrimSpace(*toVersion), *input)
	if err != nil {
		return err
	}
	fmt.Fprintf(stdout, "from=%s\nto=%s\nplatform=%s\nentries=%d\n", manifest.FromVersion, manifest.ToVersion, manifest.Platform, len(manifest.Entries))
	return nil
}

func deltaArtifactFileName(version, platform, fromVersion string) string {
	return desktopupdate.DeltaArtifactFileName(version, platform, fromVersion)
}

type deltaFlags struct {
	// platform -> fromVersion -> path
	values map[string]map[string]string
}

func (d *deltaFlags) String() string {
	if d == nil || len(d.values) == 0 {
		return ""
	}
	var parts []string
	for platform, byFrom := range d.values {
		for fromVer, path := range byFrom {
			parts = append(parts, platform+"="+fromVer+"="+path)
		}
	}
	return strings.Join(parts, ",")
}

func (d *deltaFlags) Set(value string) error {
	firstEq := strings.IndexByte(value, '=')
	if firstEq <= 0 {
		return fmt.Errorf("--delta must be platform=fromVersion=path")
	}
	rest := value[firstEq+1:]
	secondEq := strings.IndexByte(rest, '=')
	if secondEq <= 0 {
		return fmt.Errorf("--delta must be platform=fromVersion=path")
	}
	platform := strings.TrimSpace(value[:firstEq])
	fromVer := strings.TrimSpace(rest[:secondEq])
	path := strings.TrimSpace(rest[secondEq+1:])
	if platform == "" || fromVer == "" || path == "" {
		return fmt.Errorf("--delta must be platform=fromVersion=path")
	}
	if d.values == nil {
		d.values = map[string]map[string]string{}
	}
	if d.values[platform] == nil {
		d.values[platform] = map[string]string{}
	}
	if _, exists := d.values[platform][fromVer]; exists {
		return fmt.Errorf("duplicate --delta for %s %s", platform, fromVer)
	}
	d.values[platform][fromVer] = path
	return nil
}

func attachDeltaAssets(
	version, downloadBase, domesticBase string,
	built map[string]platformAsset,
	deltas map[string]map[string]string,
) error {
	if len(deltas) == 0 {
		return nil
	}
	targetVer, err := parseStableVersion(version)
	if err != nil {
		return err
	}
	for platform, byFrom := range deltas {
		asset, ok := built[platform]
		if !ok {
			return fmt.Errorf("--delta specified for unknown or missing platform %s", platform)
		}
		if asset.Deltas == nil {
			asset.Deltas = make(map[string]deltaAsset, len(byFrom))
		}
		for fromVer, path := range byFrom {
			parsedFrom, err := parseStableVersion(fromVer)
			if err != nil || targetVer.compare(parsedFrom) <= 0 {
				return fmt.Errorf("%s: invalid delta fromVersion %s for release %s", platform, fromVer, version)
			}
			expectedName := deltaArtifactFileName(version, platform, parsedFrom.String())
			if filepath.Base(path) != expectedName {
				return fmt.Errorf("%s delta artifact must be named %s", platform, expectedName)
			}
			manifest, err := desktopupdate.ValidateDeltaArchive(platform, parsedFrom.String(), version, path)
			if err != nil {
				return fmt.Errorf("%s delta (%s -> %s): %w", platform, parsedFrom.String(), version, err)
			}
			if manifest.ToSize != asset.Size || !strings.EqualFold(manifest.ToSHA256, asset.SHA256) {
				return fmt.Errorf("%s delta (%s -> %s): target zip digest/size in delta manifest does not match full platform zip", platform, parsedFrom.String(), version)
			}
			sum, size, err := fileSHA256AndSize(path)
			if err != nil {
				return err
			}
			urls, err := buildSchema2URLs(version, expectedName, downloadBase, domesticBase)
			if err != nil {
				return fmt.Errorf("%s delta: %w", platform, err)
			}
			asset.Deltas[parsedFrom.String()] = deltaAsset{
				URLs:   urls,
				SHA256: sum,
				Size:   size,
			}
		}
		built[platform] = asset
	}
	return nil
}
