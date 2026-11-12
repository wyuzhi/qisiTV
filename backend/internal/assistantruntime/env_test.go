package assistantruntime

import (
	"runtime"
	"strings"
)

// envValue 按系统规则读环境变量。Windows 的变量名不分大小写，启动子进程时
// NO_PROXY 和 no_proxy 会合成一条，只留后写的那个写法；按名字精确匹配会读不到。
// 同名多条时取最后一条，和系统一致。
func envValue(env []string, key string) string {
	got := ""
	for _, entry := range env {
		if name, value, ok := strings.Cut(entry, "="); ok && sameEnvName(name, key) {
			got = value
		}
	}
	return got
}

func envHasKey(env []string, key string) bool {
	for _, entry := range env {
		if name, _, ok := strings.Cut(entry, "="); ok && sameEnvName(name, key) {
			return true
		}
	}
	return false
}

func sameEnvName(name, key string) bool {
	if runtime.GOOS == "windows" {
		return strings.EqualFold(name, key)
	}
	return name == key
}
