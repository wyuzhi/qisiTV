package plugins

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestClientBundleResolvesOnlyInstalledBrowserModules(t *testing.T) {
	dir := t.TempDir()
	client := filepath.Join(dir, "client")
	if err := os.Mkdir(client, 0700); err != nil {
		t.Fatal(err)
	}
	write := func(p, data string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(dir, p), []byte(data), 0600); err != nil {
			t.Fatal(err)
		}
	}
	write("client/ui.mjs", "export const badge = 'qisi-fixture-badge'")
	write("client/provider.js", "export const server = 'private-fixture'")
	write("hidden.js", "export const code = 'private-fixture'")
	rt := &Runtime{plugins: map[string]Record{"test": {
		PackageDir: dir, Status: StatusEnabled,
		Raw: []byte(`{"client":"./client/index.js","contributes":{"providers":[{"module":"./client/provider.js"}]}}`),
	}}}
	svc := New(rt, nil)
	entry := "client/index.js"
	write(entry, "export { badge } from './ui.mjs'")
	body, err := svc.ClientBundle("test")
	if err != nil || !strings.Contains(string(body), "qisi-fixture-badge") || strings.Contains(string(body), "from './ui") {
		t.Fatalf("bundle = %s, err = %v", body, err)
	}
	write(entry, "export const x = () => import('./ui.mjs')")
	if _, err := svc.ClientBundle("test"); err != nil {
		t.Fatalf("local literal dynamic import: %v", err)
	}
	for _, invalid := range []string{
		"export * from '../hidden.js'", "export * from './provider.js'",
		"export * from 'pkg'", "export * from 'https://example.invalid/file.js'",
		"export * from 'node:fs'", "export * from '/etc/passwd'",
		"export default x => import(x)", "export default x => import('./' + x + '.js')",
	} {
		write(entry, invalid)
		if _, err := svc.ClientBundle("test"); err == nil {
			t.Fatalf("accepted %q", invalid)
		}
	}
	if err := os.Symlink(filepath.Join(dir, "hidden.js"), filepath.Join(client, "link.js")); err == nil {
		write(entry, "export * from './link.js'")
		if _, err := svc.ClientBundle("test"); err == nil {
			t.Fatal("bundled a symlink outside the client directory")
		}
	}
	for _, id := range []string{"missing", "test"} {
		record := rt.plugins["test"]
		record.Status = StatusDisabled
		rt.plugins["test"] = record
		if _, err := svc.ClientBundle(id); err == nil {
			t.Fatalf("served missing or disabled bundle %s", id)
		}
	}
}
