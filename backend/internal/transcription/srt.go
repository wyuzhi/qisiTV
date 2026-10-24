package transcription

import (
	"fmt"
	"strings"

	"qisitv/backend/internal/editing"
)

func BuildSRT(segments []Segment) string {
	var out strings.Builder
	for i, seg := range segments {
		fmt.Fprintf(&out, "%d\n%s --> %s\n%s\n\n", i+1, editing.FormatSRTTimestamp(seg.StartMs), editing.FormatSRTTimestamp(seg.EndMs), seg.Text)
	}
	return out.String()
}
