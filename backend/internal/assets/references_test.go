package assets

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestReferenceCollectorsPreserveScalarAndNestedLocators(t *testing.T) {
	for _, tc := range []struct{ raw, want string }{
		{`"/api/resources/media/file"`, "media"},
		{`"resource:media"`, "media"},
		{`{"prompt":"resource:ignored","nested":{"resourceIds":["first","second"],"content":"/api/resources/first/file"}}`, "first,second"},
		{`{"nodes":[{"metadata":{"storageKey":"resource:ab1e3cd"}}],"prompt":"escaped \\\" 1e1000"}`, "ab1e3cd"},
		{`{"resourceId":"media","custom":1e2}`, "media"},
	} {
		t.Run(tc.raw, func(t *testing.T) {
			var decoded any
			decoder := json.NewDecoder(strings.NewReader(tc.raw))
			decoder.UseNumber()
			if err := decoder.Decode(&decoded); err != nil {
				t.Fatal(err)
			}
			for _, collect := range []func(map[string]struct{}) error{
				func(refs map[string]struct{}) error { return CollectOwnedDocumentReferences(tc.raw, refs) },
				func(refs map[string]struct{}) error {
					return CollectOwnedDocumentReferencesFromDecoded(tc.raw, decoded, refs)
				},
			} {
				refs := map[string]struct{}{}
				if err := collect(refs); err != nil {
					t.Fatal(err)
				}
				if got := strings.Join(SortedIDs(refs), ","); got != tc.want {
					t.Fatalf("references = %s, want %s", got, tc.want)
				}
			}
		})
	}
}

func TestReferenceNumberValidationSkipsQuotedText(t *testing.T) {
	for _, tc := range []struct {
		raw  string
		want bool
	}{
		{`{"resourceId":"ab1e3cd","value":1.25}`, false},
		{`{"prompt":"` + strings.Repeat("9", 400) + ` 1e1000"}`, false},
		{`{"prompt":"escaped \\\" 1e1000","value":1}`, false},
		{`{"prompt":"escaped \\\" 1e1000","value":1e1000}`, true},
		{`{"value":-1E+309}`, true},
		{`{"value":` + strings.Repeat("9", 309) + `}`, true},
		{`{"value":` + strings.Repeat("9", 250) + `e99}`, true},
	} {
		if !json.Valid([]byte(tc.raw)) {
			t.Fatalf("invalid fixture: %s", tc.raw)
		}
		if got := referenceNumbersNeedValidation(tc.raw); got != tc.want {
			t.Errorf("range check = %v, want %v: %s", got, tc.want, tc.raw)
		}
	}
}
