package projectfolder

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strings"
)

var digestPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)
var secretField = regexp.MustCompile(`(?i)^(api[-_]?key|x[-_]?api[-_]?key|authorization|credentials?|credentialRef|headers|token|access[-_]?token|refresh[-_]?token|pairingToken|connectionToken|client[-_]?secret|secret|password)$`)
var safeID = regexp.MustCompile(`^[A-Za-z0-9_-]{1,160}$`)

func digestBytes(value []byte) string { sum := sha256.Sum256(value); return hex.EncodeToString(sum[:]) }
func validateRelative(value string) error {
	if value == "" || strings.ContainsAny(value, "\\\x00") || !filepath.IsLocal(value) || path.Clean(value) != value || value == "." {
		return fmt.Errorf("unsafe project path")
	}
	return nil
}
func openProject(root, directory string) (*os.Root, error) {
	if err := validateRelative(directory); err != nil {
		return nil, err
	}
	parent, err := os.OpenRoot(root)
	if err != nil {
		return nil, err
	}
	defer parent.Close()
	return parent.OpenRoot(directory)
}
func readBounded(root *os.Root, name string, limit int64) ([]byte, error) {
	if err := validateRelative(name); err != nil {
		return nil, err
	}
	f, err := root.Open(name)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || info.Size() > limit {
		return nil, fmt.Errorf("project file is not a regular file or exceeds limit")
	}
	b, err := io.ReadAll(io.LimitReader(f, limit+1))
	if int64(len(b)) > limit {
		return nil, fmt.Errorf("project file exceeds limit")
	}
	return b, err
}
func atomicWrite(root *os.Root, name string, data []byte) error {
	return atomicCopy(root, name, strings.NewReader(string(data)), int64(len(data)), digestBytes(data))
}
func atomicCopy(root *os.Root, name string, source io.Reader, size int64, expected string) error {
	if err := validateRelative(name); err != nil {
		return err
	}
	if err := root.MkdirAll(path.Dir(name), 0700); err != nil {
		return err
	}
	var nonce [12]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		return err
	}
	tmp := path.Join(path.Dir(name), ".qisitv-write-"+hex.EncodeToString(nonce[:]))
	f, err := root.OpenFile(tmp, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	defer root.Remove(tmp)
	hash := sha256.New()
	count, err := io.Copy(io.MultiWriter(f, hash), io.LimitReader(source, size+1))
	if err == nil && (count != size || hex.EncodeToString(hash.Sum(nil)) != expected) {
		err = fmt.Errorf("project media size or SHA256 mismatch")
	}
	if err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	if err = root.Rename(tmp, name); err != nil {
		return err
	}
	// Directory sync is supported on Unix; Windows refuses directory fsync.
	if dir, openErr := root.Open(path.Dir(name)); openErr == nil {
		_ = dir.Sync()
		_ = dir.Close()
	}
	return nil
}
func verifyFile(root *os.Root, name string, size int64, digest string) error {
	if err := validateRelative(name); err != nil {
		return err
	}
	f, err := root.Open(name)
	if err != nil {
		return err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() || info.Size() != size {
		return fmt.Errorf("project media size mismatch: %s", name)
	}
	h := sha256.New()
	n, err := io.Copy(h, io.LimitReader(f, size+1))
	if err != nil {
		return err
	}
	if n != size || hex.EncodeToString(h.Sum(nil)) != digest {
		return fmt.Errorf("project media SHA256 mismatch: %s", name)
	}
	return nil
}
func hashRegularFile(f *os.File) (string, int64, error) {
	info, err := f.Stat()
	if err != nil {
		return "", 0, err
	}
	if !info.Mode().IsRegular() {
		return "", 0, fmt.Errorf("media is not a regular file")
	}
	h := sha256.New()
	n, err := io.Copy(h, f)
	if err != nil {
		return "", 0, err
	}
	if n != info.Size() {
		return "", 0, fmt.Errorf("media changed while reading")
	}
	return hex.EncodeToString(h.Sum(nil)), n, nil
}
func parseManifest(raw []byte) (Manifest, error) {
	var result Manifest
	decoder := json.NewDecoder(strings.NewReader(string(raw)))
	decoder.UseNumber()
	if err := decoder.Decode(&result); err != nil {
		return result, err
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		return result, fmt.Errorf("project manifest contains trailing data")
	}
	if result.Format != "qisitv-project" || (result.FormatVersion != 1 && result.FormatVersion != 2) || result.Revision < 1 || result.Revision >= 9007199254740991 || result.Project == nil || result.Media == nil {
		return result, fmt.Errorf("invalid qisiTV project manifest")
	}
	id, _ := result.Project["id"].(string)
	if !safeID.MatchString(id) || len(id) > 80 {
		return result, fmt.Errorf("invalid canvas identity")
	}
	if _, ok := result.Project["nodes"].([]any); !ok {
		return result, fmt.Errorf("missing canvas nodes")
	}
	if _, ok := result.Project["connections"].([]any); !ok {
		return result, fmt.Errorf("missing canvas connections")
	}
	for key, media := range result.Media {
		if key == "" || len(key) > 2048 || media.MimeType == "" || len(media.MimeType) > 120 {
			return result, fmt.Errorf("invalid media identity or MIME type")
		}
		if err := validateRelative(media.Path); err != nil {
			return result, err
		}
		parts := strings.Split(media.Path, "/")
		if len(parts) != 2 || !strings.Contains("|references|images|videos|audio|exports|.qisitv|", "|"+parts[0]+"|") || !digestPattern.MatchString(media.SHA256) || media.Bytes < 0 {
			return result, fmt.Errorf("invalid media manifest")
		}
		if !strings.Contains("|image|video|audio|file|", "|"+media.Kind+"|") {
			return result, fmt.Errorf("invalid media kind")
		}
	}
	return result, nil
}
func clean(value any) any {
	switch v := value.(type) {
	case map[string]any:
		out := map[string]any{}
		for key, item := range v {
			if !secretField.MatchString(key) {
				out[key] = clean(item)
			}
		}
		return out
	case []any:
		out := make([]any, len(v))
		for i, item := range v {
			out[i] = clean(item)
		}
		return out
	default:
		return value
	}
}
func remap(value any, replacements map[string]string) any {
	switch v := value.(type) {
	case string:
		if next, ok := replacements[v]; ok {
			return next
		}
		return v
	case map[string]any:
		out := map[string]any{}
		for key, item := range v {
			out[key] = remap(item, replacements)
		}
		return out
	case []any:
		out := make([]any, len(v))
		for i, item := range v {
			out[i] = remap(item, replacements)
		}
		return out
	default:
		return value
	}
}
func stableID(values ...string) string {
	hash := digestBytes([]byte(strings.Join(values, "\x00")))
	return hash[:8] + "-" + hash[8:12] + "-5" + hash[13:16] + "-a" + hash[17:20] + "-" + hash[20:32]
}
func stringValue(m map[string]any, key string) string { v, _ := m[key].(string); return v }
