package skills

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"qisitv/backend/internal/kernel"
	"qisitv/backend/internal/outbound"
	"io"
	"net/http"
	"net/url"
	"os"
	"path"
	"sort"
	"strings"
	"time"
)

const (
	defaultGitHubAPIBaseURL      = "https://api.github.com"
	defaultGitHubCodeloadBaseURL = "https://codeload.github.com"
)

var (
	githubAPIBaseURL      = defaultGitHubAPIBaseURL
	githubCodeloadBaseURL = defaultGitHubCodeloadBaseURL

	allowedGitHubSkillHosts = map[string]bool{
		"api.github.com":                       true,
		"codeload.github.com":                  true,
		"github.com":                           true,
		"raw.githubusercontent.com":            true,
		"objects.githubusercontent.com":        true,
		"release-assets.githubusercontent.com": true,
		"gh-proxy.com":                         true,
		"ghfast.top":                           true,
	}
)

func parseGitHubSkillURL(rawURL string, requestedRef string, requestedSubdir string) (githubSkillSpec, error) {
	target, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil || target.Scheme != "https" || !strings.EqualFold(target.Hostname(), "github.com") || target.User != nil {
		return githubSkillSpec{}, kernel.BadAuthRequest("请输入公开的 https://github.com 仓库地址")
	}
	parts := strings.Split(strings.Trim(target.Path, "/"), "/")
	if len(parts) < 2 {
		return githubSkillSpec{}, kernel.BadAuthRequest("GitHub 地址必须包含 owner/repository")
	}
	spec := githubSkillSpec{Owner: parts[0], Repo: strings.TrimSuffix(parts[1], ".git"), Ref: strings.TrimSpace(requestedRef), Subdir: strings.Trim(strings.ReplaceAll(strings.TrimSpace(requestedSubdir), "\\", "/"), "/")}
	if len(parts) >= 4 && parts[2] == "tree" {
		if spec.Ref == "" {
			spec.Ref = parts[3]
		}
		if spec.Subdir == "" && len(parts) > 4 {
			spec.Subdir = strings.Join(parts[4:], "/")
		}
	}
	if len(parts) > 2 && parts[2] != "tree" {
		return githubSkillSpec{}, kernel.BadAuthRequest("GitHub 地址必须指向仓库根目录或 tree 子目录")
	}
	if spec.Owner == "" || spec.Repo == "" {
		return githubSkillSpec{}, kernel.BadAuthRequest("GitHub 仓库地址无效")
	}
	return spec, nil
}

func newGitHubHTTPClient() *http.Client {
	client := outbound.OutboundHTTPClient(30 * time.Second)
	client.CheckRedirect = func(redirectReq *http.Request, via []*http.Request) error {
		if len(via) >= 5 {
			return errors.New("GitHub 请求重定向次数过多")
		}
		_, err := validateGitHubSkillOutboundURL(redirectReq.Context(), redirectReq.URL.String())
		return err
	}
	return client
}

func isConfiguredGitHubTestBase(parsed *url.URL) bool {
	if parsed == nil {
		return false
	}
	for _, pair := range [][2]string{
		{githubAPIBaseURL, defaultGitHubAPIBaseURL},
		{githubCodeloadBaseURL, defaultGitHubCodeloadBaseURL},
	} {
		current, def := strings.TrimSpace(pair[0]), pair[1]
		if current == "" || current == def {
			continue
		}
		base, err := url.Parse(current)
		if err != nil || base.Host == "" {
			continue
		}
		host := strings.ToLower(base.Hostname())
		if (host == "127.0.0.1" || host == "localhost" || host == "::1") &&
			strings.EqualFold(parsed.Scheme, base.Scheme) &&
			strings.EqualFold(parsed.Host, base.Host) {
			return true
		}
	}
	return false
}

func validateGitHubSkillOutboundURL(ctx context.Context, rawURL string) (*url.URL, error) {
	parsed, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil || parsed.Hostname() == "" || parsed.User != nil || parsed.Fragment != "" {
		return nil, fmt.Errorf("无效的 GitHub 资源地址")
	}
	publicCtx := outbound.WithPublicHTTPS(ctx)
	if isConfiguredGitHubTestBase(parsed) {
		if _, err := outbound.ValidatePublicHTTPSURLContext(publicCtx, parsed.String()); err != nil {
			return nil, err
		}
		return parsed, nil
	}
	if parsed.Scheme != "https" {
		return nil, fmt.Errorf("GitHub 资源地址必须使用 HTTPS")
	}
	if !allowedGitHubSkillHosts[strings.ToLower(parsed.Hostname())] {
		return nil, fmt.Errorf("不允许访问未授权的 GitHub 资源域名 %q", parsed.Hostname())
	}
	if _, err := outbound.ValidatePublicHTTPSURLContext(publicCtx, parsed.String()); err != nil {
		return nil, err
	}
	return parsed, nil
}

func fetchGitHubSkillArchive(ctx context.Context, spec githubSkillSpec) (skillPackageArchive, string, string, string, error) {
	ctx = outbound.WithPublicHTTPS(ctx)
	client := newGitHubHTTPClient()
	apiBase := strings.TrimRight(githubAPIBaseURL, "/")
	resolvedRef := spec.Ref
	if resolvedRef == "" {
		var repoInfo struct {
			DefaultBranch string `json:"default_branch"`
		}
		if err := githubJSON(ctx, client, fmt.Sprintf("%s/repos/%s/%s", apiBase, url.PathEscape(spec.Owner), url.PathEscape(spec.Repo)), &repoInfo); err != nil {
			return skillPackageArchive{}, "", "", "", err
		}
		resolvedRef = repoInfo.DefaultBranch
	}
	var commitInfo struct {
		SHA    string `json:"sha"`
		Commit struct {
			Tree struct {
				SHA string `json:"sha"`
			} `json:"tree"`
		} `json:"commit"`
	}
	if err := githubJSON(ctx, client, fmt.Sprintf("%s/repos/%s/%s/commits/%s", apiBase, url.PathEscape(spec.Owner), url.PathEscape(spec.Repo), url.PathEscape(resolvedRef)), &commitInfo); err != nil {
		if len(resolvedRef) == 40 && outbound.ValidHexDigest(resolvedRef) {
			commitInfo.SHA = strings.ToLower(resolvedRef)
		} else {
			return skillPackageArchive{}, "", "", "", err
		}
	}
	if commitInfo.SHA == "" {
		return skillPackageArchive{}, "", "", "", errors.New("GitHub 未返回提交版本")
	}
	treeSHA := strings.ToLower(strings.TrimSpace(commitInfo.Commit.Tree.SHA))
	if len(treeSHA) != 40 || !outbound.ValidHexDigest(treeSHA) {
		treeSHA = ""
	}
	downloadURL := fmt.Sprintf("%s/%s/%s/zip/%s", strings.TrimRight(githubCodeloadBaseURL, "/"), url.PathEscape(spec.Owner), url.PathEscape(spec.Repo), url.PathEscape(commitInfo.SHA))
	// Third-party proxies are only used as fallbacks after codeload.github.com
	// and only when the commit's cryptographic Git tree SHA-1 is known.
	candidates := outbound.ExpandGitHubMirrorURLs(downloadURL, "", treeSHA, "")
	var data []byte
	var lastErr error
	for _, candidate := range candidates {
		if ctx.Err() != nil {
			break
		}
		isProxyFallback := candidate != downloadURL
		fetched, sizeExceeded, err := downloadAndVerifyGitHubZip(ctx, client, candidate, commitInfo.SHA, treeSHA, isProxyFallback)
		if sizeExceeded {
			return skillPackageArchive{}, "", "", "", err
		}
		if err != nil {
			lastErr = err
			continue
		}
		data = fetched
		lastErr = nil
		break
	}
	if lastErr != nil {
		return skillPackageArchive{}, "", "", "", lastErr
	}
	archive, err := archiveFromZip(data, spec.Subdir)
	if err != nil {
		return skillPackageArchive{}, "", "", "", err
	}
	canonicalURL := fmt.Sprintf("https://github.com/%s/%s", spec.Owner, spec.Repo)
	return archive, commitInfo.SHA, canonicalURL, resolvedRef, nil
}

func downloadAndVerifyGitHubZip(ctx context.Context, client *http.Client, targetURL, commitSHA, treeSHA string, requireTree bool) ([]byte, bool, error) {
	if requireTree && (len(treeSHA) != 40 || !outbound.ValidHexDigest(treeSHA)) {
		return nil, false, errors.New("缺少 Git 树哈希，拒绝使用第三方代理下载")
	}
	if _, err := validateGitHubSkillOutboundURL(ctx, targetURL); err != nil {
		return nil, false, fmt.Errorf("下载 GitHub 技能失败: %w", err)
	}
	request, err := http.NewRequestWithContext(outbound.WithPublicHTTPS(ctx), http.MethodGet, targetURL, nil)
	if err != nil {
		return nil, false, fmt.Errorf("下载 GitHub 技能失败: %w", err)
	}
	request.Header.Set("User-Agent", outbound.DefaultOutboundUserAgent)
	response, err := client.Do(request)
	if err != nil {
		return nil, false, fmt.Errorf("下载 GitHub 技能失败: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, false, fmt.Errorf("下载 GitHub 技能失败: HTTP %d", response.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, maxSkillPackageBytes+1))
	if err != nil {
		return nil, false, err
	}
	if len(data) > maxSkillPackageBytes {
		return nil, true, kernel.BadAuthRequest("GitHub 技能包超过 200MB")
	}
	if err := verifyGitHubCommitZip(data, commitSHA, treeSHA); err != nil {
		return nil, false, err
	}
	return data, false, nil
}

func verifyGitHubCommitZip(data []byte, expectedCommitSHA string, expectedTreeSHA ...string) error {
	want := strings.ToLower(strings.TrimSpace(expectedCommitSHA))
	if len(want) != 40 || !outbound.ValidHexDigest(want) {
		return errors.New("GitHub 未返回有效提交版本")
	}
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return fmt.Errorf("下载内容不是有效 ZIP: %w", err)
	}
	if len(zr.File) == 0 {
		return errors.New("GitHub 技能包为空")
	}
	comment := strings.ToLower(strings.TrimSpace(zr.Comment))
	if comment != want {
		return fmt.Errorf("GitHub 技能包提交校验失败（期望 %s，实际 %s）", want, comment)
	}
	rootPrefix := ""
	hasFiles := false
	for _, entry := range zr.File {
		prefix, rest, ok := strings.Cut(entry.Name, "/")
		if !ok || len(prefix) < 41 || prefix[len(prefix)-41] != '-' {
			return fmt.Errorf("GitHub 技能包目录缺少提交后缀: %s", entry.Name)
		}
		suffix := prefix[len(prefix)-40:]
		if !outbound.ValidHexDigest(suffix) || !strings.EqualFold(suffix, want) {
			return fmt.Errorf("GitHub 技能包目录提交校验失败（期望 %s，实际 %s）", want, suffix)
		}
		if rootPrefix == "" {
			rootPrefix = prefix
		} else if prefix != rootPrefix {
			return fmt.Errorf("GitHub 技能包包含不一致的顶层目录: %s 与 %s", rootPrefix, prefix)
		}
		if rest != "" && !entry.FileInfo().IsDir() {
			hasFiles = true
		}
	}
	if !hasFiles {
		return errors.New("GitHub 技能包未包含任何文件")
	}
	wantTree := ""
	if len(expectedTreeSHA) > 0 {
		wantTree = strings.ToLower(strings.TrimSpace(expectedTreeSHA[0]))
	}
	if wantTree != "" {
		if len(wantTree) != 40 || !outbound.ValidHexDigest(wantTree) {
			return errors.New("GitHub 未返回有效目录树版本")
		}
		gotTree, err := computeGitZipTreeSHA(zr, rootPrefix)
		if err != nil {
			return err
		}
		if !strings.EqualFold(gotTree, wantTree) {
			return fmt.Errorf("GitHub 技能包内容树哈希校验失败（期望 %s，实际 %s）", wantTree, gotTree)
		}
	}
	return nil
}

type gitTreeNode struct {
	files map[string]gitTreeLeaf
	dirs  map[string]*gitTreeNode
}

type gitTreeLeaf struct {
	mode string
	sha  [20]byte
}

func newGitTreeNode() *gitTreeNode {
	return &gitTreeNode{
		files: make(map[string]gitTreeLeaf),
		dirs:  make(map[string]*gitTreeNode),
	}
}

func computeGitZipTreeSHA(zr *zip.Reader, rootPrefix string) (string, error) {
	root := newGitTreeNode()
	var total int64
	prefix := rootPrefix + "/"
	for _, entry := range zr.File {
		if entry.FileInfo().IsDir() || strings.HasSuffix(entry.Name, "/") {
			continue
		}
		rel := strings.TrimPrefix(entry.Name, prefix)
		cleanRel := path.Clean(rel)
		if cleanRel == "." || cleanRel == "" || strings.HasPrefix(cleanRel, "../") || strings.HasPrefix(cleanRel, "/") {
			return "", fmt.Errorf("GitHub 技能包文件路径无效: %s", entry.Name)
		}
		rc, err := entry.Open()
		if err != nil {
			return "", err
		}
		content, readErr := io.ReadAll(io.LimitReader(rc, maxSkillPackageBytes-total+1))
		closeErr := rc.Close()
		if readErr != nil {
			return "", readErr
		}
		if closeErr != nil {
			return "", closeErr
		}
		total += int64(len(content))
		if total > maxSkillPackageBytes {
			return "", kernel.BadAuthRequest("GitHub 技能包超过 200MB")
		}
		blobHash := sha1.New()
		_, _ = fmt.Fprintf(blobHash, "blob %d\x00", len(content))
		_, _ = blobHash.Write(content)
		var sha [20]byte
		copy(sha[:], blobHash.Sum(nil))

		mode := "100644"
		if entry.Mode()&os.ModeSymlink != 0 {
			mode = "120000"
		} else if entry.Mode()&0o111 != 0 {
			mode = "100755"
		}

		segments := strings.Split(cleanRel, "/")
		curr := root
		for _, dirName := range segments[:len(segments)-1] {
			next, ok := curr.dirs[dirName]
			if !ok {
				next = newGitTreeNode()
				curr.dirs[dirName] = next
			}
			curr = next
		}
		curr.files[segments[len(segments)-1]] = gitTreeLeaf{mode: mode, sha: sha}
	}
	rootSum := hashGitTreeNode(root)
	return hex.EncodeToString(rootSum[:]), nil
}

func hashGitTreeNode(node *gitTreeNode) [20]byte {
	type treeEntry struct {
		name  string
		mode  string
		sha   [20]byte
		isDir bool
	}
	entries := make([]treeEntry, 0, len(node.files)+len(node.dirs))
	for name, leaf := range node.files {
		entries = append(entries, treeEntry{name: name, mode: leaf.mode, sha: leaf.sha, isDir: false})
	}
	for name, child := range node.dirs {
		entries = append(entries, treeEntry{name: name, mode: "40000", sha: hashGitTreeNode(child), isDir: true})
	}
	sort.Slice(entries, func(i, j int) bool {
		a := entries[i].name
		if entries[i].isDir {
			a += "/"
		}
		b := entries[j].name
		if entries[j].isDir {
			b += "/"
		}
		return a < b
	})
	var buf bytes.Buffer
	for _, e := range entries {
		_, _ = fmt.Fprintf(&buf, "%s %s\x00", e.mode, e.name)
		_, _ = buf.Write(e.sha[:])
	}
	h := sha1.New()
	_, _ = fmt.Fprintf(h, "tree %d\x00", buf.Len())
	_, _ = h.Write(buf.Bytes())
	var out [20]byte
	copy(out[:], h.Sum(nil))
	return out
}

func githubJSON(ctx context.Context, client *http.Client, target string, output any) error {
	if _, err := validateGitHubSkillOutboundURL(ctx, target); err != nil {
		return fmt.Errorf("读取 GitHub 信息失败: %w", err)
	}
	request, err := http.NewRequestWithContext(outbound.WithPublicHTTPS(ctx), http.MethodGet, target, nil)
	if err != nil {
		return fmt.Errorf("读取 GitHub 信息失败: %w", err)
	}
	request.Header.Set("Accept", "application/vnd.github+json")
	request.Header.Set("User-Agent", outbound.DefaultOutboundUserAgent)
	response, err := client.Do(request)
	if err != nil {
		return fmt.Errorf("读取 GitHub 信息失败: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fmt.Errorf("读取 GitHub 信息失败: HTTP %d", response.StatusCode)
	}
	return json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(output)
}
