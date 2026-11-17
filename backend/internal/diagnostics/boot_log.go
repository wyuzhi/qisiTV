package diagnostics

import (
	"bufio"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const (
	bootLogLimit      = 256 * 1024
	maxBootLogEntries = 200
)

type BootLogEntry struct {
	ID         string `json:"id"`
	LaunchID   string `json:"launchId,omitempty"`
	Timestamp  string `json:"timestamp"`
	State      string `json:"state"`
	Phase      string `json:"phase"`
	Reason     string `json:"reason,omitempty"`
	ErrorKind  string `json:"errorKind,omitempty"`
	DurationMs int64  `json:"durationMs,omitempty"`
}

func AppendBootLogEntry(dataDir string, entry BootLogEntry) error {
	cleanDir := strings.TrimSpace(dataDir)
	if cleanDir == "" {
		return nil
	}
	sanitized, ok := sanitizeBootLogEntry(entry)
	if !ok {
		return nil
	}
	logsDir := filepath.Join(cleanDir, "logs")
	if err := os.MkdirAll(logsDir, 0o700); err != nil {
		return err
	}
	path := filepath.Join(logsDir, "boot.jsonl")
	if info, err := os.Stat(path); err == nil && info.Size() >= bootLogLimit {
		_ = os.Rename(path, filepath.Join(logsDir, "boot.jsonl.1"))
	}
	encoded, err := json.Marshal(sanitized)
	if err != nil {
		return err
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return err
	}
	_, writeErr := file.Write(append(encoded, '\n'))
	closeErr := file.Close()
	if writeErr != nil {
		return writeErr
	}
	return closeErr
}

func SummarizeBootErrorKind(err error) string {
	if err == nil {
		return ""
	}
	lower := strings.ToLower(err.Error())
	for _, item := range []struct {
		marker string
		code   string
	}{
		{"另一实例使用", "locked"},
		{"database is locked", "locked"},
		{"sqlite_busy", "locked"},
		{"permission denied", "permission-denied"},
		{"access is denied", "permission-denied"},
		{"拒绝访问", "permission-denied"},
		{"no space left", "disk-full"},
		{"not enough space", "disk-full"},
		{"磁盘空间不足", "disk-full"},
		{"malformed", "corrupt-database"},
		{"not a database", "corrupt-database"},
		{"address already in use", "address-in-use"},
		{"only one usage of each socket address", "address-in-use"},
		{"timeout", "timeout"},
		{"deadline exceeded", "timeout"},
		{"i/o error", "io-error"},
	} {
		if strings.Contains(lower, item.marker) {
			return item.code
		}
	}
	return "details-redacted"
}

func collectBootLog(dataDir string, window timeWindow) ([]BootLogEntry, string, bool) {
	cleanDir := strings.TrimSpace(dataDir)
	if cleanDir == "" {
		return nil, "not_configured", false
	}
	logsDir := filepath.Join(cleanDir, "logs")
	status := "missing"
	truncated := false
	var entries []BootLogEntry

	for _, name := range []string{"boot.jsonl.1", "boot.jsonl"} {
		path := filepath.Join(logsDir, name)
		info, err := os.Lstat(path)
		if os.IsNotExist(err) {
			continue
		}
		if err != nil || !info.Mode().IsRegular() {
			status = "unreadable"
			continue
		}
		file, err := os.Open(path)
		if err != nil {
			status = "unreadable"
			continue
		}
		if status != "unreadable" {
			status = "available"
		}
		start := max(int64(0), info.Size()-bootLogLimit)
		if _, err := file.Seek(start, io.SeekStart); err != nil {
			_ = file.Close()
			status = "unreadable"
			continue
		}
		scanner := bufio.NewScanner(io.LimitReader(file, bootLogLimit))
		scanner.Buffer(make([]byte, 4096), bootLogLimit)
		if start > 0 {
			truncated = true
			scanner.Scan()
		}
		for scanner.Scan() {
			line := strings.TrimSpace(scanner.Text())
			if line == "" {
				continue
			}
			var raw BootLogEntry
			if json.Unmarshal([]byte(line), &raw) != nil {
				continue
			}
			sanitized, ok := sanitizeBootLogEntry(raw)
			if !ok {
				continue
			}
			stamp, err := time.Parse(time.RFC3339Nano, sanitized.Timestamp)
			if err != nil || stamp.Before(window.From) || stamp.After(window.To) {
				continue
			}
			entries = append(entries, sanitized)
		}
		if scanner.Err() != nil {
			truncated = true
		}
		_ = file.Close()
	}
	if len(entries) > maxBootLogEntries {
		entries = entries[len(entries)-maxBootLogEntries:]
		truncated = true
	}
	return entries, status, truncated
}

func sanitizeBootLogEntry(entry BootLogEntry) (BootLogEntry, bool) {
	id := sanitizeIdentifier(entry.ID)
	if id == "" {
		return BootLogEntry{}, false
	}
	stamp, err := time.Parse(time.RFC3339Nano, strings.TrimSpace(entry.Timestamp))
	if err != nil {
		return BootLogEntry{}, false
	}
	state := strings.TrimSpace(entry.State)
	switch state {
	case "starting", "ready", "failed":
	default:
		return BootLogEntry{}, false
	}
	phase := strings.TrimSpace(entry.Phase)
	switch phase {
	case "storage", "lock", "database", "migrate", "services", "listen", "ready":
	default:
		return BootLogEntry{}, false
	}
	return BootLogEntry{
		ID:         id,
		LaunchID:   sanitizeIdentifier(entry.LaunchID),
		Timestamp:  stamp.UTC().Format(time.RFC3339Nano),
		State:      state,
		Phase:      phase,
		Reason:     sanitizeIdentifier(entry.Reason),
		ErrorKind:  sanitizeIdentifier(entry.ErrorKind),
		DurationMs: boundedInt64(entry.DurationMs, 0, 86_400_000),
	}, true
}
