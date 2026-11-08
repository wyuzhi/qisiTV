package agentconnect

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// Windows batch shims (.cmd/.bat) cannot be executed directly and must go
// through cmd.exe. cmd re-parses the command line, so unsupported metacharacters
// are rejected instead of guessed at.

func windowsComspec() string {
	if value := strings.TrimSpace(os.Getenv("ComSpec")); value != "" {
		return value
	}
	if root := strings.TrimSpace(os.Getenv("SystemRoot")); root != "" {
		return filepath.Join(root, "System32", "cmd.exe")
	}
	return "cmd.exe"
}

func isBatchScript(path string) bool {
	switch strings.ToLower(filepath.Ext(path)) {
	case ".cmd", ".bat":
		return true
	default:
		return false
	}
}

// windowsBatchCommandLine builds the full command line passed to cmd.exe.
// Every token is quoted. Characters cmd would expand or treat as operators are
// refused, because there is no safe escape for them in this context.
func windowsBatchCommandLine(comspec, script string, args []string) (string, error) {
	if strings.TrimSpace(comspec) == "" {
		comspec = "cmd.exe"
	}
	tokens := make([]string, 0, len(args)+2)
	tokens = append(tokens, comspec, script)
	tokens = append(tokens, args...)
	quoted := make([]string, 0, len(tokens))
	for _, token := range tokens {
		if err := validateWindowsToken(token); err != nil {
			return "", err
		}
		quoted = append(quoted, quoteWindowsToken(token))
	}
	return quoted[0] + " /d /s /c \"" + strings.Join(quoted[1:], " ") + "\"", nil
}

func validateWindowsToken(token string) error {
	for _, char := range token {
		switch char {
		case '%', '^', '&', '|', '<', '>', '!', '"', '\r', '\n', 0:
			return fmt.Errorf("%w: 命令行包含无法安全传递的字符 %q", ErrUnsafeCommand, char)
		}
	}
	return nil
}

// quoteWindowsToken wraps a token in quotes and doubles trailing backslashes so
// the closing quote is not escaped by the C runtime argument parser.
func quoteWindowsToken(token string) string {
	trailing := 0
	for index := len(token) - 1; index >= 0 && token[index] == '\\'; index-- {
		trailing++
	}
	return `"` + token + strings.Repeat(`\`, trailing) + `"`
}
