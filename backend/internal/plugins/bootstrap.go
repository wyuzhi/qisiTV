package plugins

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"qisitv/backend/internal/protocol"
)

// Official packages are immutable inputs shipped with the application. Cache
// their validated envelopes so multiple runtime instances do not repeatedly
// parse the same archives during startup. Uploaded packages are intentionally
// parsed through the uncached path.
var officialPluginPackageCache = struct {
	sync.RWMutex
	items map[string]protocol.PluginPackage
}{items: make(map[string]protocol.PluginPackage)}

func parseOfficialPluginPackage(data []byte) (protocol.PluginPackage, error) {
	key := pluginHash(data)
	officialPluginPackageCache.RLock()
	if pkg, ok := officialPluginPackageCache.items[key]; ok {
		officialPluginPackageCache.RUnlock()
		return pkg, nil
	}
	officialPluginPackageCache.RUnlock()
	pkg, err := protocol.ParsePluginPackage(data)
	if err != nil {
		return protocol.PluginPackage{}, err
	}
	officialPluginPackageCache.Lock()
	officialPluginPackageCache.items[key] = pkg
	officialPluginPackageCache.Unlock()
	return pkg, nil
}

func (c *Runtime) reconcileBuiltIns(stored []RegistryRecord) ([]RegistryRecord, error) {
	byID := make(map[string]RegistryRecord, len(stored))
	for _, record := range stored {
		if _, exists := byID[record.ID]; exists {
			return nil, fmt.Errorf("插件 registry 记录 ID %q 重复", record.ID)
		}
		byID[record.ID] = record
	}
	officialDir, err := officialPluginPackageDir()
	if err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(officialDir)
	if err != nil {
		return nil, fmt.Errorf("读取官方插件目录失败：%w", err)
	}
	builtInIDs := make(map[string]struct{}, len(entries)+2)
	// IDs the shipped packages resolve, aliases included. A removed package
	// whose IDs all resolve here has been merged into a shipped one.
	shippedResolvable := make(map[string]string, len(entries)*2)
	// One inventory read serves every decision below: which shipped plugin may
	// not be overwritten yet, and which removed plugin must be kept.
	snapshot := c.snapshotReferences()
	retained := make(map[string]*RetentionView)
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(strings.ToLower(entry.Name()), protocol.PluginPackageExtension) {
			continue
		}
		packageData, err := os.ReadFile(filepath.Join(officialDir, entry.Name()))
		if err != nil {
			return nil, fmt.Errorf("读取官方插件包 %s：%w", entry.Name(), err)
		}
		pkg, err := parseOfficialPluginPackage(packageData)
		if err != nil {
			return nil, fmt.Errorf("校验官方插件包 %s：%w", entry.Name(), err)
		}
		if _, err := protocol.LoadInstalledProviders(pkg.ManifestRaw); err != nil {
			return nil, fmt.Errorf("加载官方插件 %q：%w", pkg.Manifest.Metadata.ID, err)
		}
		for resolvable := range resolvableProviderIDs(pkg.ManifestRaw) {
			shippedResolvable[resolvable] = pkg.Manifest.Metadata.ID
		}
		id := pkg.Manifest.Metadata.ID
		if _, duplicate := builtInIDs[id]; duplicate {
			return nil, fmt.Errorf("官方插件 ID %q 重复", id)
		}
		builtInIDs[id] = struct{}{}
		manifest := pkg.Manifest
		record := byID[id]
		if len(record.Raw) > 0 {
			var previous protocol.Manifest
			if err := json.Unmarshal(record.Raw, &previous); err == nil {
				manifest.Metadata.Enabled = previous.Metadata.Enabled
			}
		}
		manifestData, err := json.Marshal(manifest)
		if err != nil {
			return nil, fmt.Errorf("编码官方插件 %q：%w", id, err)
		}
		hash := pluginHash(packageData)
		packageName := hash + protocol.PluginPackageExtension
		now := time.Now().UTC()
		next := RegistryRecord{
			ID: id, Raw: manifestData, Source: OriginOfficial, FileName: entry.Name(),
			PackagePath: packageName, PackageSHA256: hash, InstalledAt: now, UpdatedAt: now,
		}
		if !record.InstalledAt.IsZero() {
			next.InstalledAt = record.InstalledAt
		}
		if !registryRecordContentChanged(record, next) {
			next.UpdatedAt = record.UpdatedAt
		}
		// Keep the installed definition if the release removes a referenced ID.
		// Compatible fixes must also reach tasks that still need their results.
		if note := deferralFor(record, next, snapshot); note != nil {
			retained[id] = note
			continue
		}
		if _, err := ensurePluginBlob(filepath.Join(c.packageDir, packageName), packageData); err != nil {
			return nil, fmt.Errorf("缓存官方插件 %q：%w", id, err)
		}
		byID[id] = next
	}
	for _, builtinName := range BundledBuiltinPluginNames {
		pkgRoot, ok := BundledSampleDir(builtinName)
		if !ok {
			continue
		}
		pkg, err := protocol.ParsePluginPackageDir(pkgRoot)
		if err != nil {
			return nil, fmt.Errorf("校验官方插件目录 %s：%w", builtinName, err)
		}
		if _, err := protocol.LoadInstalledProviders(pkg.ManifestRaw); err != nil {
			return nil, fmt.Errorf("加载官方插件 %q：%w", pkg.Manifest.Metadata.ID, err)
		}
		id := pkg.Manifest.Metadata.ID
		if _, duplicate := builtInIDs[id]; duplicate {
			return nil, fmt.Errorf("官方插件 ID %q 重复", id)
		}
		builtInIDs[id] = struct{}{}
		manifest := pkg.Manifest
		record := byID[id]
		if len(record.Raw) > 0 {
			var previous protocol.Manifest
			if err := json.Unmarshal(record.Raw, &previous); err == nil {
				manifest.Metadata.Enabled = previous.Metadata.Enabled
			}
		}
		manifestData, err := json.Marshal(manifest)
		if err != nil {
			return nil, fmt.Errorf("编码官方插件包 %q：%w", id, err)
		}
		now := time.Now().UTC()
		next := RegistryRecord{
			ID:            id,
			Raw:           manifestData,
			Source:        OriginOfficial,
			PackageDir:    pkg.RootDir,
			PackageSpec:   pkg.PackageName,
			PackageSHA256: pkg.SHA256,
			SkillDirs:     pkg.SkillDirs,
			LoadError:     record.LoadError,
			InstalledAt:   now,
			UpdatedAt:     now,
		}
		if !record.InstalledAt.IsZero() {
			next.InstalledAt = record.InstalledAt
		}
		if !registryRecordContentChanged(record, next) {
			next.UpdatedAt = record.UpdatedAt
		}
		byID[id] = next
	}
	missing := make([]RegistryRecord, 0, len(byID))
	for _, record := range byID {
		if !IsBuiltInSource(record.Source) {
			continue
		}
		if _, shipped := builtInIDs[record.ID]; !shipped {
			if targets, merged := mergedIntoShipped(record, shippedResolvable); merged {
				// Every ID it served now resolves to a shipped package through an
				// alias, so keeping the old copy would shadow the merged one. Saved
				// configuration that ran with an enabled copy must keep running.
				if recordEnabled(record) {
					enableMergeTargets(byID, targets)
				}
				continue
			}
			missing = append(missing, record)
		}
	}
	// A release must not silently delete an official plugin that saved
	// configuration or an unfinished task still executes with. Retained records
	// keep their committed manifest, package hash and enabled state; they are
	// marked as retired so no new selection offers them.
	for id, note := range c.retentionDecisions(missing, snapshot) {
		retained[id] = note
	}
	result := make([]RegistryRecord, 0, len(byID))
	for _, record := range byID {
		if IsBuiltInSource(record.Source) {
			if _, shipped := builtInIDs[record.ID]; !shipped {
				// Built-in records are reconciled from repository packages and host
				// manifests on every startup, so an unreferenced removed plugin
				// cannot survive stale.
				if _, keep := retained[record.ID]; !keep {
					continue
				}
			}
		}
		result = append(result, record)
	}
	sort.Slice(result, func(i, j int) bool { return result[i].ID < result[j].ID })
	c.retained = retained
	return result, nil
}

// mergedIntoShipped reports whether every provider ID a removed record served
// is resolvable by a package this release ships, and which packages those are.
func mergedIntoShipped(record RegistryRecord, shipped map[string]string) ([]string, bool) {
	var manifest protocol.Manifest
	if err := json.Unmarshal(record.Raw, &manifest); err != nil || len(manifest.Contributes.Providers) == 0 {
		return nil, false
	}
	targets := make([]string, 0, 1)
	for _, provider := range manifest.Contributes.Providers {
		target, ok := shipped[strings.TrimSpace(provider.ID)]
		if !ok {
			return nil, false
		}
		targets = append(targets, target)
	}
	return targets, true
}

func recordEnabled(record RegistryRecord) bool {
	var manifest protocol.Manifest
	return json.Unmarshal(record.Raw, &manifest) == nil && manifest.Metadata.Enabled
}

func enableMergeTargets(byID map[string]RegistryRecord, targets []string) {
	for _, id := range targets {
		record, ok := byID[id]
		if !ok || recordEnabled(record) {
			continue
		}
		var manifest protocol.Manifest
		if json.Unmarshal(record.Raw, &manifest) != nil {
			continue
		}
		manifest.Metadata.Enabled = true
		if raw, err := json.Marshal(manifest); err == nil {
			record.Raw = raw
			byID[id] = record
		}
	}
}
