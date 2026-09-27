package desktopupdate

import (
	"net"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"

	"golang.org/x/net/http/httpproxy"
)

type systemProxySettings struct {
	config        httpproxy.Config
	excludeSimple bool
}

// Desktop launchers do not inherit shell proxy variables. Read system settings
// on each request so retry also works after the user changes their proxy.
func desktopProxy(req *http.Request) (*url.URL, error) {
	config := httpproxy.FromEnvironment()
	for _, name := range []string{"HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy"} {
		if _, explicit := os.LookupEnv(name); explicit {
			return config.ProxyFunc()(req.URL)
		}
	}
	return proxyWithSystem(req.URL, *config, readSystemProxy())
}

func proxyWithSystem(target *url.URL, env httpproxy.Config, system systemProxySettings) (*url.URL, error) {
	if system.excludeSimple && !strings.Contains(target.Hostname(), ".") && net.ParseIP(target.Hostname()) == nil {
		return nil, nil
	}
	env.HTTPProxy = system.config.HTTPProxy
	env.HTTPSProxy = system.config.HTTPSProxy
	env.NoProxy = strings.Trim(env.NoProxy+","+system.config.NoProxy, ",")
	return env.ProxyFunc()(target)
}

func parseWindowsProxy(server, bypass string) systemProxySettings {
	settings := systemProxySettings{excludeSimple: strings.Contains(strings.ToLower(bypass), "<local>")}
	settings.config.NoProxy = strings.ReplaceAll(strings.ReplaceAll(bypass, "<local>", ""), ";", ",")
	if !strings.Contains(server, "=") {
		settings.config.HTTPProxy = strings.TrimSpace(server)
		settings.config.HTTPSProxy = strings.TrimSpace(server)
		return settings
	}
	for _, part := range strings.Split(server, ";") {
		protocol, address, ok := strings.Cut(strings.TrimSpace(part), "=")
		if !ok {
			continue
		}
		switch strings.ToLower(protocol) {
		case "http":
			settings.config.HTTPProxy = strings.TrimSpace(address)
		case "https":
			settings.config.HTTPSProxy = strings.TrimSpace(address)
		}
	}
	return settings
}

func parseMacProxy(output string) systemProxySettings {
	values := map[string]string{}
	var bypass []string
	inExceptions := false
	for _, line := range strings.Split(output, "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "ExceptionsList :") {
			inExceptions = true
			continue
		}
		if line == "}" {
			inExceptions = false
			continue
		}
		key, value, ok := strings.Cut(line, " : ")
		if !ok {
			continue
		}
		if inExceptions {
			bypass = append(bypass, value)
		} else {
			values[key] = value
		}
	}
	address := func(protocol string) string {
		if values[protocol+"Enable"] != "1" {
			return ""
		}
		host, port := values[protocol+"Proxy"], values[protocol+"Port"]
		n, err := strconv.Atoi(port)
		if host == "" || err != nil || n < 1 || n > 65535 {
			return ""
		}
		return "http://" + net.JoinHostPort(host, port)
	}
	return systemProxySettings{
		config:        httpproxy.Config{HTTPProxy: address("HTTP"), HTTPSProxy: address("HTTPS"), NoProxy: strings.Join(bypass, ",")},
		excludeSimple: values["ExcludeSimpleHostnames"] == "1",
	}
}
