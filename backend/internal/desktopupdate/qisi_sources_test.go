package desktopupdate

import "testing"

func TestQisiUpdateSourcesAreExplicitAndExcludeUpstream(t *testing.T) {
	for _, allowed := range []string{
		"https://cheeser.link/qisitv/releases/v2.1.2/qisiTV.zip",
		"https://github.com/wyuzhi/qisiTV/releases/download/v2.1.2/qisiTV.zip",
	} {
		if err := validateArtifactURL(allowed, true); err != nil {
			t.Fatalf("owned release URL was rejected: %s: %v", allowed, err)
		}
	}
	for _, rejected := range []string{
		"https://updates.beefapi.com/beeftv/v2.1.2/BeefTV.zip",
		"https://github.com/glanderness/BeefTV/releases/download/v2.1.2/BeefTV.zip",
		"https://github.com/wyuzhi/another-project/releases/download/v2.1.2/app.zip",
		"https://cheeser.link/other-app/app.zip",
		"https://cheeser.link.evil.example/qisitv/app.zip",
	} {
		if err := validateArtifactURL(rejected, true); err == nil {
			t.Fatalf("unrelated release URL was accepted: %s", rejected)
		}
	}
	if DefaultFeedURL != "" || LegacyFeedURL != "" {
		t.Fatal("updater must remain opt-in until this distribution supplies its own signed feed")
	}
	if !isKnownRedirectHost("release-assets.githubusercontent.com") || isKnownRedirectHost("asset.cnb.cool") {
		t.Fatal("release CDN trust did not follow the qisi repository")
	}
}
