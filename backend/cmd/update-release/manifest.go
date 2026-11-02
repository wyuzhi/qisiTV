package main

import (
	"bytes"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	"qisitv/backend/internal/brand"
)

const (
	payloadSchema   = 1
	payloadSchemaV2 = 2
	// A renamed fork must never install the upstream application's releases.
	defaultFeedURL      = ""
	defaultDownloadHost = ""
	defaultDomesticHost = ""
	updaterImportPath   = "qisitv/backend/internal/desktopupdate"
)

type payload struct {
	Schema    int                      `json:"schema"`
	Version   string                   `json:"version"`
	Commit    string                   `json:"commit"`
	Notes     string                   `json:"notes"`
	Platforms map[string]platformAsset `json:"platforms"`
}

type deltaAsset struct {
	URLs   []string `json:"urls"`
	SHA256 string   `json:"sha256"`
	Size   int64    `json:"size"`
}

type platformAsset struct {
	URL    string                `json:"url,omitempty"`
	URLs   []string              `json:"urls,omitempty"`
	SHA256 string                `json:"sha256"`
	Size   int64                 `json:"size"`
	Deltas map[string]deltaAsset `json:"deltas,omitempty"`
}

type envelope struct {
	Payload   string `json:"payload"`
	Signature string `json:"signature"`
}

func cmdSign(args []string, stdout, stderr io.Writer) error {
	fs := newFlagSet("sign", stderr)
	schema := fs.Int("schema", payloadSchema, "manifest schema version (1 for desktop-update.json, 2 for desktop-update-v2.json)")
	fromEnvelope := fs.String("from-envelope", "", "verified schema-1 desktop-update.json to derive schema-2 metadata from")
	version := fs.String("version", "", "stable version such as v1.6.0")
	commit := fs.String("commit", "", "full Git SHA of the released commit")
	notes := fs.String("notes", "", "release notes text")
	notesFile := fs.String("notes-file", "", "file containing release notes")
	changelog := fs.String("changelog", "", "CHANGELOG.md used when --notes and --notes-file are omitted")
	privatePath := fs.String("private-key", "", "path to the base64 private key file")
	expectPublic := fs.String("expect-public-key", "", "base64 public key that must match the private key")
	output := fs.String("output", "", "output path for desktop-update.json")
	downloadBase := fs.String("download-base", brand.Getenv("QISITV_UPDATER_DOWNLOAD_BASE"), "required HTTPS prefix for this distribution's per-version asset URLs")
	domesticBase := fs.String("domestic-download-base", "", "optional domestic mirror prefix for schema-2 asset URLs")
	requirePlatforms := fs.String("require-platforms", "", "comma-separated platforms that must all be present")
	var assets assetFlags
	fs.Var(&assets, "asset", "platform=path, repeatable (example: darwin-arm64=/tmp/qisiTV-v1.6.0-darwin-arm64.zip)")
	var deltas deltaFlags
	fs.Var(&deltas, "delta", "platform=fromVersion=path, repeatable (schema 2 only)")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *schema != payloadSchema && *schema != payloadSchemaV2 {
		return fmt.Errorf("unsupported --schema %d (must be 1 or 2)", *schema)
	}
	if *schema == payloadSchema && strings.TrimSpace(*domesticBase) != "" {
		return fmt.Errorf("--domestic-download-base requires --schema 2")
	}
	if *schema == payloadSchema && len(deltas.values) > 0 {
		return fmt.Errorf("--delta requires --schema 2")
	}

	private, err := loadPrivateKey(*privatePath)
	if err != nil {
		return err
	}
	derivedPublic := private.Public().(ed25519.PublicKey)
	if strings.TrimSpace(*expectPublic) != "" {
		public, err := parsePublicKey(*expectPublic)
		if err != nil {
			return err
		}
		if !derivedPublicEquals(private, public) {
			return fmt.Errorf("private key does not match --expect-public-key / QISITV_UPDATER_PUBLIC_KEY")
		}
	}

	required, err := parsePlatformList(*requirePlatforms)
	if err != nil {
		return err
	}

	var body payload
	if strings.TrimSpace(*fromEnvelope) != "" {
		if *schema != payloadSchemaV2 {
			return fmt.Errorf("--from-envelope requires --schema 2")
		}
		if len(assets.values) > 0 {
			return fmt.Errorf("--from-envelope cannot be combined with --asset")
		}
		srcBody, err := verifyEnvelopeFile(*fromEnvelope, derivedPublic)
		if err != nil {
			return fmt.Errorf("verify --from-envelope: %w", err)
		}
		if strings.TrimSpace(*version) != "" && strings.TrimSpace(*version) != srcBody.Version {
			return fmt.Errorf("--version %s does not match source envelope version %s", *version, srcBody.Version)
		}
		if strings.TrimSpace(*commit) != "" && !strings.EqualFold(strings.TrimSpace(*commit), srcBody.Commit) {
			return fmt.Errorf("--commit does not match source envelope commit")
		}
		built, err := buildSchema2AssetsFromSource(srcBody.Version, strings.TrimRight(*downloadBase, "/"), strings.TrimRight(strings.TrimSpace(*domesticBase), "/"), srcBody.Platforms)
		if err != nil {
			return err
		}
		body = payload{
			Schema:    payloadSchemaV2,
			Version:   srcBody.Version,
			Commit:    srcBody.Commit,
			Notes:     srcBody.Notes,
			Platforms: built,
		}
	} else {
		parsedVersion, err := parseStableVersion(*version)
		if err != nil {
			return err
		}
		commitSHA, err := parseCommitSHA(*commit)
		if err != nil {
			return err
		}
		noteText, err := resolveNotes(*notes, *notesFile, *changelog, parsedVersion.String())
		if err != nil {
			return err
		}
		built, err := buildPlatformAssets(*schema, parsedVersion.String(), strings.TrimRight(*downloadBase, "/"), strings.TrimRight(strings.TrimSpace(*domesticBase), "/"), assets.values)
		if err != nil {
			return err
		}
		body = payload{
			Schema:    *schema,
			Version:   parsedVersion.String(),
			Commit:    commitSHA,
			Notes:     noteText,
			Platforms: built,
		}
	}

	if err := attachDeltaAssets(body.Version, strings.TrimRight(*downloadBase, "/"), strings.TrimRight(strings.TrimSpace(*domesticBase), "/"), body.Platforms, deltas.values); err != nil {
		return err
	}

	for _, platform := range required {
		if _, ok := body.Platforms[platform]; !ok {
			return fmt.Errorf("signed feed requires platform %s", platform)
		}
	}

	payloadBytes, err := marshalCanonical(body)
	if err != nil {
		return err
	}
	env := envelope{
		Payload:   base64.StdEncoding.EncodeToString(payloadBytes),
		Signature: base64.StdEncoding.EncodeToString(ed25519.Sign(private, payloadBytes)),
	}
	if _, err := verifyEnvelope(mustMarshalCanonical(env), derivedPublic); err != nil {
		return err
	}
	outBytes, err := marshalCanonical(env)
	if err != nil {
		return err
	}
	if strings.TrimSpace(*output) == "" {
		return fmt.Errorf("sign requires --output")
	}
	if err := os.MkdirAll(filepath.Dir(*output), 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(*output, append(outBytes, '\n'), 0o644); err != nil {
		return err
	}
	sum, size, err := fileSHA256AndSize(*output)
	if err != nil {
		return err
	}
	fmt.Fprintf(stdout, "path=%s\nsha256=%s\nsize=%d\nplatforms=%d\n", *output, sum, size, len(body.Platforms))
	return nil
}

func cmdVerify(args []string, stdout, stderr io.Writer) error {
	fs := newFlagSet("verify", stderr)
	envelopePath := fs.String("envelope", "", "path to desktop-update.json")
	publicPath := fs.String("public-key", "", "path to the base64 public key file")
	publicInline := fs.String("public-key-text", "", "base64 public key")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if strings.TrimSpace(*envelopePath) == "" {
		return fmt.Errorf("verify requires --envelope")
	}
	public, err := loadPublicKey(*publicPath, *publicInline)
	if err != nil {
		return err
	}
	body, err := verifyEnvelopeFile(*envelopePath, public)
	if err != nil {
		return err
	}
	fmt.Fprintf(stdout, "version=%s\ncommit=%s\nplatforms=%d\n", body.Version, body.Commit, len(body.Platforms))
	return nil
}

func cmdPrintLdflags(args []string, stdout, stderr io.Writer) error {
	fs := newFlagSet("print-ldflags", stderr)
	publicInline := fs.String("public-key", "", "base64 32-byte public key")
	feedURL := fs.String("feed-url", defaultFeedURL, "HTTPS updater feed URL baked into release binaries")
	if err := fs.Parse(args); err != nil {
		return err
	}
	publicText := strings.TrimSpace(*publicInline)
	if publicText == "" {
		publicText = strings.TrimSpace(brand.Getenv(publicKeyEnv))
	}
	if _, err := parsePublicKey(publicText); err != nil {
		return fmt.Errorf("print-ldflags: %w; unsigned desktop builds cannot publish an updater feed", err)
	}
	feed := strings.TrimSpace(*feedURL)
	if envFeed := strings.TrimSpace(brand.Getenv("QISITV_UPDATER_FEED_URL")); envFeed != "" && feed == defaultFeedURL {
		feed = envFeed
	}
	if !strings.HasPrefix(feed, "https://") {
		return fmt.Errorf("feed URL must be HTTPS")
	}
	fmt.Fprintln(stdout, formatLdflags(feed, publicText))
	return nil
}

func formatLdflags(feedURL, publicKey string) string {
	return fmt.Sprintf("-X %s.FeedURL=%s -X %s.PublicKey=%s", updaterImportPath, feedURL, updaterImportPath, publicKey)
}

func verifyEnvelopeFile(path string, public ed25519.PublicKey) (payload, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return payload{}, err
	}
	return verifyEnvelope(data, public)
}

func decodeJSONStrict(data []byte, dest any) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(dest); err != nil {
		return err
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return fmt.Errorf("trailing JSON")
	}
	return nil
}

func verifyEnvelope(data []byte, public ed25519.PublicKey) (payload, error) {
	var env envelope
	if err := decodeJSONStrict(data, &env); err != nil {
		return payload{}, fmt.Errorf("envelope JSON: %w", err)
	}
	payloadBytes, err := base64.StdEncoding.DecodeString(strings.TrimSpace(env.Payload))
	if err != nil {
		return payload{}, fmt.Errorf("envelope payload is not base64")
	}
	signature, err := base64.StdEncoding.DecodeString(strings.TrimSpace(env.Signature))
	if err != nil {
		return payload{}, fmt.Errorf("envelope signature is not base64")
	}
	if !ed25519.Verify(public, payloadBytes, signature) {
		return payload{}, fmt.Errorf("updater signature verification failed")
	}
	var body payload
	if err := decodeJSONStrict(payloadBytes, &body); err != nil {
		return payload{}, fmt.Errorf("payload JSON: %w", err)
	}
	if body.Schema != payloadSchema && body.Schema != payloadSchemaV2 {
		return payload{}, fmt.Errorf("unsupported updater payload schema %d", body.Schema)
	}
	targetVer, err := parseStableVersion(body.Version)
	if err != nil {
		return payload{}, err
	}
	if _, err := parseCommitSHA(body.Commit); err != nil {
		return payload{}, err
	}
	if strings.TrimSpace(body.Notes) == "" {
		return payload{}, fmt.Errorf("payload notes are empty")
	}
	if len(body.Platforms) == 0 {
		return payload{}, fmt.Errorf("payload has no platforms")
	}
	for platform, asset := range body.Platforms {
		if err := validatePlatform(platform); err != nil {
			return payload{}, err
		}
		switch body.Schema {
		case payloadSchema:
			if len(asset.URLs) > 0 || len(asset.Deltas) > 0 || !strings.HasPrefix(asset.URL, "https://") {
				return payload{}, fmt.Errorf("platform %s schema-1 url must be HTTPS without urls or deltas", platform)
			}
		case payloadSchemaV2:
			if strings.TrimSpace(asset.URL) != "" || len(asset.URLs) == 0 {
				return payload{}, fmt.Errorf("platform %s schema-2 requires urls without legacy url", platform)
			}
			if err := validateSchema2URLList(platform, asset.URLs); err != nil {
				return payload{}, err
			}
			for fromVer, delta := range asset.Deltas {
				parsedFrom, err := parseStableVersion(fromVer)
				if err != nil || targetVer.compare(parsedFrom) <= 0 {
					return payload{}, fmt.Errorf("platform %s has invalid delta fromVersion %s", platform, fromVer)
				}
				if len(delta.URLs) == 0 {
					return payload{}, fmt.Errorf("platform %s delta %s requires urls", platform, fromVer)
				}
				if err := validateSchema2URLList(platform+" delta "+fromVer, delta.URLs); err != nil {
					return payload{}, err
				}
				if len(delta.SHA256) != 64 || delta.Size <= 0 {
					return payload{}, fmt.Errorf("platform %s delta %s has invalid digest or size", platform, fromVer)
				}
			}
		}
		if len(asset.SHA256) != 64 {
			return payload{}, fmt.Errorf("platform %s sha256 must be 64 hex characters", platform)
		}
		if asset.Size <= 0 {
			return payload{}, fmt.Errorf("platform %s size must be positive", platform)
		}
	}
	return body, nil
}

func validateSchema2URLList(label string, urls []string) error {
	seen := make(map[string]struct{}, len(urls))
	for _, u := range urls {
		if _, dup := seen[u]; dup {
			return fmt.Errorf("%s has duplicate url %s", label, u)
		}
		seen[u] = struct{}{}
		if err := validateSchema2URL(u); err != nil {
			return fmt.Errorf("%s: %w", label, err)
		}
	}
	return nil
}

func validateSchema2URL(raw string) error {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return fmt.Errorf("url %q must be clean HTTPS", raw)
	}
	switch strings.ToLower(parsed.Hostname()) {
	case "cheeser.link":
		if !strings.HasPrefix(parsed.Path, "/qisitv/") {
			return fmt.Errorf("untrusted path on cheeser.link: %s", parsed.Path)
		}
	case "github.com":
		if !strings.HasPrefix(parsed.Path, "/wyuzhi/qisiTV/releases/download/") {
			return fmt.Errorf("untrusted release repository on github.com: %s", parsed.Path)
		}
	default:
		return fmt.Errorf("untrusted download domain %s", parsed.Hostname())
	}
	return nil
}

func resolveNotes(inline, notesFile, changelog, version string) (string, error) {
	switch {
	case strings.TrimSpace(inline) != "":
		return strings.TrimSpace(inline), nil
	case strings.TrimSpace(notesFile) != "":
		data, err := os.ReadFile(notesFile)
		if err != nil {
			return "", fmt.Errorf("read notes file: %w", err)
		}
		notes := strings.TrimSpace(string(data))
		if notes == "" {
			return "", fmt.Errorf("notes file is empty")
		}
		return notes, nil
	case strings.TrimSpace(changelog) != "":
		return extractChangelogNotes(changelog, version)
	default:
		return "", fmt.Errorf("sign requires --notes, --notes-file, or --changelog")
	}
}

func buildSchema2URLs(version, name, downloadBase, domesticBase string) ([]string, error) {
	if !strings.HasPrefix(downloadBase, "https://") {
		return nil, fmt.Errorf("download base must be HTTPS")
	}
	r2URL := downloadBase + "/" + version + "/" + name
	var urls []string
	if domesticBase != "" {
		if !strings.HasPrefix(domesticBase, "https://") {
			return nil, fmt.Errorf("domestic download base must be HTTPS")
		}
		urls = append(urls, domesticBase+"/"+version+"/"+name)
	}
	urls = append(urls, r2URL)
	for _, u := range urls {
		if err := validateSchema2URL(u); err != nil {
			return nil, err
		}
	}
	return urls, nil
}

func buildSchema2AssetsFromSource(version, downloadBase, domesticBase string, src map[string]platformAsset) (map[string]platformAsset, error) {
	built := make(map[string]platformAsset, len(src))
	for platform, asset := range src {
		if err := validatePlatform(platform); err != nil {
			return nil, err
		}
		name := artifactFileName(version, platform)
		urls, err := buildSchema2URLs(version, name, downloadBase, domesticBase)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", platform, err)
		}
		var deltas map[string]deltaAsset
		if len(asset.Deltas) > 0 {
			deltas = make(map[string]deltaAsset, len(asset.Deltas))
			for fromVer, d := range asset.Deltas {
				dName := deltaArtifactFileName(version, platform, fromVer)
				dURLs, err := buildSchema2URLs(version, dName, downloadBase, domesticBase)
				if err != nil {
					return nil, fmt.Errorf("%s delta %s: %w", platform, fromVer, err)
				}
				deltas[fromVer] = deltaAsset{
					URLs:   dURLs,
					SHA256: d.SHA256,
					Size:   d.Size,
				}
			}
		}
		built[platform] = platformAsset{
			URLs:   urls,
			SHA256: asset.SHA256,
			Size:   asset.Size,
			Deltas: deltas,
		}
	}
	return built, nil
}

func buildPlatformAssets(schema int, version, downloadBase, domesticBase string, assets map[string]string) (map[string]platformAsset, error) {
	if len(assets) == 0 {
		return nil, fmt.Errorf("sign requires at least one --asset platform=path")
	}
	if !strings.HasPrefix(downloadBase, "https://") {
		return nil, fmt.Errorf("download base must be HTTPS")
	}
	built := make(map[string]platformAsset, len(assets))
	for platform, path := range assets {
		if err := validatePlatform(platform); err != nil {
			return nil, err
		}
		if _, exists := built[platform]; exists {
			return nil, fmt.Errorf("duplicate --asset for %s", platform)
		}
		if err := validateArchive(platform, path); err != nil {
			return nil, fmt.Errorf("%s: %w", platform, err)
		}
		sum, size, err := fileSHA256AndSize(path)
		if err != nil {
			return nil, err
		}
		name := artifactFileName(version, platform)
		if filepath.Base(path) != name {
			return nil, fmt.Errorf("%s artifact must be named %s", platform, name)
		}
		if schema == payloadSchemaV2 {
			urls, err := buildSchema2URLs(version, name, downloadBase, domesticBase)
			if err != nil {
				return nil, fmt.Errorf("%s: %w", platform, err)
			}
			built[platform] = platformAsset{
				URLs:   urls,
				SHA256: sum,
				Size:   size,
			}
		} else {
			built[platform] = platformAsset{
				URL:    downloadBase + "/" + version + "/" + name,
				SHA256: sum,
				Size:   size,
			}
		}
	}
	return built, nil
}

func mustMarshalCanonical(value any) []byte {
	b, _ := marshalCanonical(value)
	return b
}

func parsePlatformList(text string) ([]string, error) {
	text = strings.TrimSpace(text)
	if text == "" {
		return nil, nil
	}
	parts := strings.Split(text, ",")
	out := make([]string, 0, len(parts))
	seen := map[string]struct{}{}
	for _, part := range parts {
		platform := strings.TrimSpace(part)
		if platform == "" {
			continue
		}
		if err := validatePlatform(platform); err != nil {
			return nil, err
		}
		if _, ok := seen[platform]; ok {
			return nil, fmt.Errorf("duplicate required platform %s", platform)
		}
		seen[platform] = struct{}{}
		out = append(out, platform)
	}
	return out, nil
}

func marshalCanonical(value any) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(value); err != nil {
		return nil, err
	}
	return bytes.TrimSuffix(buf.Bytes(), []byte("\n")), nil
}

type assetFlags struct {
	values map[string]string
}

func (a *assetFlags) String() string {
	if a == nil || len(a.values) == 0 {
		return ""
	}
	parts := make([]string, 0, len(a.values))
	for platform, path := range a.values {
		parts = append(parts, platform+"="+path)
	}
	return strings.Join(parts, ",")
}

func (a *assetFlags) Set(value string) error {
	platform, path, ok := strings.Cut(value, "=")
	if !ok || strings.TrimSpace(platform) == "" || strings.TrimSpace(path) == "" {
		return fmt.Errorf("--asset must be platform=path")
	}
	if a.values == nil {
		a.values = map[string]string{}
	}
	platform = strings.TrimSpace(platform)
	if _, exists := a.values[platform]; exists {
		return fmt.Errorf("duplicate --asset for %s", platform)
	}
	a.values[platform] = strings.TrimSpace(path)
	return nil
}
