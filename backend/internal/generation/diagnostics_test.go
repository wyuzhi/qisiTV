package generation

import (
	"strings"
	"testing"
)

func TestDiagnosticSummaryHidesMountedAndNetworkPaths(t *testing.T) {
	for _, path := range []string{`/Volumes/PrivateDrive/customer-A/image.png`, `/Volumes/External Work/customer-A/image.png`, `C:\Private User\customer-A\image.png`, `\\Private Server\Private Share\customer-A\image.png`, `/mnt/PrivateDrive/customer-A/image.png`, `/media/PrivateDrive/customer-A/image.png`, `/app/uploads/Private-customer-A/image.png`, `/data/uploads/Private-customer-A/image.png`, `/workspace/Private-customer-A/image.png`, `\\PrivateServer\PrivateShare\customer-A\image.png`} {
		got := DiagnosticSummary("open " + path + ": permission denied")
		if strings.Contains(got, "Private") || strings.Contains(got, "customer-A") || !strings.Contains(got, "permission denied") {
			t.Fatalf("unsafe summary %q", got)
		}
	}
}

func TestDiagnosticSummaryDoesNotMangleHTTPURLsAsLocalPaths(t *testing.T) {
	for _, msg := range []string{
		`本次请求准备失败：Get "https://beeftv.app/v1/models": EOF`,
		`Post "https://beeftv.app/v1/media/tasks": connection reset by peer`,
		`Put "https://storage.example.com/media/uploads/part1?X-Amz-Signature=secret": unexpected EOF`,
	} {
		got := DiagnosticSummary(msg)
		if strings.Contains(got, "[路径已隐藏]") || strings.Contains(got, "http[") || strings.Contains(got, "beeftv.app") || strings.Contains(got, "secret") {
			t.Fatalf("HTTP URL mangled as local path or leaked: %q -> %q", msg, got)
		}
		if !strings.Contains(got, "EOF") && !strings.Contains(got, "connection reset by peer") {
			t.Fatalf("transport cause lost: %q -> %q", msg, got)
		}
	}
	combined := DiagnosticSummary(`cannot read C:\Users\PRIVATE\image.png https://host/file?token=PRIVATE Authorization: Bearer PRIVATE multi word`)
	if strings.Contains(combined, "PRIVATE") || !strings.Contains(combined, "[路径已隐藏]") {
		t.Fatalf("combined path+url+credential summary leaked: %q", combined)
	}
}
