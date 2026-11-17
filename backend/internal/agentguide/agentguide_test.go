package agentguide

import (
	"crypto/sha256"
	"encoding/hex"
	"strings"
	"testing"
)

func TestCurrentDescribesItsOwnText(t *testing.T) {
	guide := Current()
	if guide.Name != Name || guide.Name == "" {
		t.Fatalf("guide name = %q", guide.Name)
	}
	if strings.TrimSpace(guide.Text) == "" {
		t.Fatal("guide text is empty")
	}
	sum := sha256.Sum256([]byte(guide.Text))
	if want := hex.EncodeToString(sum[:]); guide.ContentHash != want {
		t.Fatalf("content hash does not match text: %q != %q", guide.ContentHash, want)
	}
	if len(guide.Version) != 12 || !strings.HasPrefix(guide.ContentHash, guide.Version) {
		t.Fatalf("version %q must be the short content hash of %q", guide.Version, guide.ContentHash)
	}
}
