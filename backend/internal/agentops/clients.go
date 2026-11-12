package agentops

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"qisitv/backend/internal/securefile"
)

// ClientMode 是服务端授予客户端的能力模式。客户端只能出示身份，不能自己声明模式。
type ClientMode string

const (
	ClientReadWrite ClientMode = "read-write"
	ClientReadOnly  ClientMode = "read-only"
)

// ClientApprovalMode 是外部客户端凭据在执行付费生成时的审批档位。
// - ask：每次问我（开单后进入待批准，需在 BeefTV 界面或用 beeftv approve 批准）
// - caller：调用方自己批（外部 Agent 凭据默认；先 propose 拿到生成单再凭单 submit）
// - auto：自动，不设限额（确定性脚本专用；submit 一步开单即批）
type ClientApprovalMode string

const (
	ClientApprovalAsk    ClientApprovalMode = "ask"
	ClientApprovalCaller ClientApprovalMode = "caller"
	ClientApprovalAuto   ClientApprovalMode = "auto"
)

// NormalizeClientApprovalMode 把历史空值收敛为 caller（调用方自己批）；未知非空值报错。
func NormalizeClientApprovalMode(raw string) (ClientApprovalMode, error) {
	switch ClientApprovalMode(strings.TrimSpace(strings.ToLower(raw))) {
	case "", ClientApprovalCaller:
		return ClientApprovalCaller, nil
	case ClientApprovalAsk:
		return ClientApprovalAsk, nil
	case ClientApprovalAuto:
		return ClientApprovalAuto, nil
	default:
		return "", InvalidArg("invalid_approval_mode", "approvalMode 必须是 ask、caller 或 auto")
	}
}

// ClientKind 只是登记来源的展示分类（codex/claude/cursor/other），不参与任何鉴权判断。
type ClientKind string

const (
	ClientKindCodex         ClientKind = "codex"
	ClientKindWorkBuddy     ClientKind = "workbuddy"
	ClientKindClaude        ClientKind = "claude"
	ClientKindClaudeDesktop ClientKind = "claude-desktop"
	ClientKindCursor        ClientKind = "cursor"
	ClientKindOpenClaw      ClientKind = "openclaw"
	ClientKindHermes        ClientKind = "hermes"
	ClientKindCodeBuddy     ClientKind = "codebuddy"
	ClientKindVSCode        ClientKind = "vscode"
	ClientKindOther         ClientKind = "other"
)

// NormalizeClientKind 把未知或历史空值统一收敛成 other：老的登记文件没有 kind 字段。
func NormalizeClientKind(kind string) ClientKind {
	switch ClientKind(strings.TrimSpace(strings.ToLower(kind))) {
	case ClientKindCodex:
		return ClientKindCodex
	case ClientKindClaude:
		return ClientKindClaude
	case ClientKindClaudeDesktop:
		return ClientKindClaudeDesktop
	case ClientKindCursor:
		return ClientKindCursor
	case ClientKindWorkBuddy, ClientKindOpenClaw, ClientKindHermes, ClientKindCodeBuddy, ClientKindVSCode:
		return ClientKind(strings.TrimSpace(strings.ToLower(kind)))
	default:
		return ClientKindOther
	}
}

// ClientRegistration 记录一个被本机用户登记过的非交互客户端。
// Kind/Origin/ApprovalMode/LastUsedAt/RevokedAt 是后加字段：历史文件里缺失时按零值解析，
// 读出后统一补默认；缺失的 Origin 一律视为手动连接。
type ClientRegistration struct {
	ID    string     `json:"id"`
	Label string     `json:"label"`
	Kind  ClientKind `json:"kind,omitempty"`
	// Origin records who created the credential. Empty means a manual
	// connection; one-click integrations use a reserved origin value so their
	// identity never depends on the display label.
	Origin       string             `json:"origin,omitempty"`
	Mode         ClientMode         `json:"mode"`
	ApprovalMode ClientApprovalMode `json:"approvalMode,omitempty"`
	TokenHash    string             `json:"tokenHash"`
	CreatedAt    time.Time          `json:"createdAt"`
	LastUsedAt   *time.Time         `json:"lastUsedAt,omitempty"`
	RevokedAt    *time.Time         `json:"revokedAt,omitempty"`
}

// Revoked 判断该登记是否已被本机用户吊销：吊销后凭据立即失效，且不再出现在列表里。
func (c ClientRegistration) Revoked() bool { return c.RevokedAt != nil }

// lastUsedThrottle 控制 lastUsedAt 的落盘频率：每次读操作都写文件会让登记表成为热点。
const lastUsedThrottle = time.Minute

// ClientRegistry 把登记信息持久化在数据目录里（0600），由本机用户维护。
type ClientRegistry struct {
	mu   sync.Mutex
	path string
}

func NewClientRegistry(dataDir string) *ClientRegistry {
	return &ClientRegistry{path: ClientRegistryPath(dataDir)}
}

// ClientRegistryPath 存客户端登记（含凭据摘要），和凭据文件一样只许当前用户读写。
func ClientRegistryPath(dataDir string) string {
	return filepath.Join(dataDir, "agent_clients.json")
}

func hashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

func (r *ClientRegistry) load() ([]ClientRegistration, error) {
	raw, err := os.ReadFile(r.path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	var items []ClientRegistration
	if err := json.Unmarshal(raw, &items); err != nil {
		return nil, err
	}
	// 老版本文件没有 kind 或 approvalMode：统一补默认，后续读写都按同一形状处理。
	for index := range items {
		items[index].Kind = NormalizeClientKind(string(items[index].Kind))
		mode, err := NormalizeClientApprovalMode(string(items[index].ApprovalMode))
		if err != nil {
			mode = ClientApprovalCaller
		}
		items[index].ApprovalMode = mode
	}
	return items, nil
}

// Register 生成一次性展示的 token，并在服务端保存其哈希与模式。
func (r *ClientRegistry) Register(label string, mode ClientMode) (ClientRegistration, string, error) {
	return r.RegisterClient("", label, mode, ClientApprovalCaller)
}

// RegisterKind 与 Register 相同，额外记录来源分类（仅用于展示与生成接入说明）。
func (r *ClientRegistry) RegisterKind(kind, label string, mode ClientMode) (ClientRegistration, string, error) {
	return r.RegisterClient(kind, label, mode, ClientApprovalCaller)
}

// RegisterClient 登记一个客户端凭据，记录来源分类、读写模式与付费生成审批档位。
func (r *ClientRegistry) RegisterClient(kind, label string, mode ClientMode, approvalMode ClientApprovalMode) (ClientRegistration, string, error) {
	return r.RegisterClientOrigin(kind, label, "", mode, approvalMode)
}

// RegisterClientOrigin 额外记录凭据来源；空 origin 表示手动连接。
// 一键接入只凭这个字段识别自己签发的凭据，显示名称不参与判断。
func (r *ClientRegistry) RegisterClientOrigin(kind, label, origin string, mode ClientMode, approvalMode ClientApprovalMode) (ClientRegistration, string, error) {
	if mode == "" {
		mode = ClientReadWrite
	}
	if mode != ClientReadOnly && mode != ClientReadWrite {
		return ClientRegistration{}, "", InvalidArg("invalid_mode", "mode 必须是 read-only 或 read-write")
	}
	normalizedApproval, err := NormalizeClientApprovalMode(string(approvalMode))
	if err != nil {
		return ClientRegistration{}, "", err
	}
	normalizedKind := NormalizeClientKind(kind)
	if strings.TrimSpace(label) == "" {
		label = string(normalizedKind)
	}
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		return ClientRegistration{}, "", AsError(err)
	}
	idBuf := make([]byte, 8)
	if _, err := rand.Read(idBuf); err != nil {
		return ClientRegistration{}, "", AsError(err)
	}
	token := hex.EncodeToString(buf)
	reg := ClientRegistration{
		ID:           "client-" + hex.EncodeToString(idBuf),
		Label:        label,
		Kind:         normalizedKind,
		Origin:       strings.TrimSpace(origin),
		Mode:         mode,
		ApprovalMode: normalizedApproval,
		TokenHash:    hashToken(token),
		CreatedAt:    time.Now().UTC(),
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	items, err := r.load()
	if err != nil {
		return ClientRegistration{}, "", AsError(err)
	}
	items = append(items, reg)
	if err := r.save(items); err != nil {
		return ClientRegistration{}, "", AsError(err)
	}
	return reg, token, nil
}

// save 必须在持有锁时调用。
func (r *ClientRegistry) save(items []ClientRegistration) error {
	encoded, err := json.MarshalIndent(items, "", "  ")
	if err != nil {
		return err
	}
	return atomicWriteFile(r.path, encoded)
}

// Lookup 按 (clientID, token) 解析身份；返回的是服务端登记的模式。
// 已吊销的登记一律解析失败——吊销后凭据立即失效，不留宽限期。
// 命中时顺带记录最近使用时间，但按节流写盘：读操作不该每次都改文件。
func (r *ClientRegistry) Lookup(clientID, token string) (ClientRegistration, bool) {
	if strings.TrimSpace(clientID) == "" || strings.TrimSpace(token) == "" {
		return ClientRegistration{}, false
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	items, err := r.load()
	if err != nil {
		return ClientRegistration{}, false
	}
	want := hashToken(token)
	for index, item := range items {
		if item.ID != clientID || item.Revoked() {
			continue
		}
		// 哈希比较用常量时间，避免按前缀逐字节试探已登记客户端的 token。
		if subtle.ConstantTimeCompare([]byte(item.TokenHash), []byte(want)) != 1 {
			continue
		}
		now := time.Now().UTC()
		if item.LastUsedAt == nil || now.Sub(*item.LastUsedAt) >= lastUsedThrottle {
			items[index].LastUsedAt = &now
			// 写失败不影响本次鉴权：lastUsedAt 只是展示信息。
			_ = r.save(items)
		}
		return items[index], true
	}
	return ClientRegistration{}, false
}

// List 返回未吊销的登记信息（不含 token 本身）。
func (r *ClientRegistry) List() []ClientRegistration {
	live, _ := r.ListLive()
	return live
}

// ListLive 与 List 相同，但登记文件读不出或解析失败时返回错误。
// 需要据此做安全决定的调用方（例如断开前枚举要吊销的凭据）必须用它，
// 不能把「读不出」当成「没有凭据」。
func (r *ClientRegistry) ListLive() ([]ClientRegistration, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	items, err := r.load()
	if err != nil {
		return nil, err
	}
	live := make([]ClientRegistration, 0, len(items))
	for _, item := range items {
		if !item.Revoked() {
			live = append(live, item)
		}
	}
	return live, nil
}

// Revoke 吊销一个登记：保留记录（带吊销时间）而不是删行，这样凭据不会被后续登记复用，
// 也留下可审计的痕迹。未找到或已吊销都按未找到处理，避免把存在性变成探测手段。
func (r *ClientRegistry) Revoke(clientID string) error {
	clientID = strings.TrimSpace(clientID)
	if clientID == "" {
		return InvalidArg("missing_client_id", "缺少客户端 ID")
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	items, err := r.load()
	if err != nil {
		return AsError(err)
	}
	for index, item := range items {
		if item.ID != clientID || item.Revoked() {
			continue
		}
		now := time.Now().UTC()
		items[index].RevokedAt = &now
		if err := r.save(items); err != nil {
			return AsError(err)
		}
		return nil
	}
	return NotFound("client_not_found", "没有这个客户端登记")
}

// atomicWriteFile 先写临时文件再改名，避免并发登记时留下半截文件丢记录。
// 写入前先把空文件收紧到只有当前用户可读（Windows 上不再继承数据目录的权限）。
// 数据目录在不支持访问控制的磁盘上（如 exFAT）时照常写入并记一条日志：
// 凭据写不出来会让本机鉴权整体失效，比权限没收紧更糟。
func atomicWriteFile(path string, data []byte) error {
	tmp, err := os.CreateTemp(filepath.Dir(path), ".agent-clients-*")
	if err != nil {
		return err
	}
	name := tmp.Name()
	defer os.Remove(name)
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return err
	}
	if err := restrictFile(name); err != nil {
		log.Printf("凭据文件 %s 未能收紧为仅当前用户可读：%v", filepath.Base(path), err)
	}
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(name, path)
}

// OwnerTokenPath 是后端与可信本机前端共享的 owner 凭据；只有它能执行写操作与登记客户端。
func OwnerTokenPath(dataDir string) string { return filepath.Join(dataDir, "agent_owner_token") }

// EnsureOwnerToken 读取已有 owner token，不存在则生成（0600）。
func EnsureOwnerToken(dataDir string) (string, error) {
	path := OwnerTokenPath(dataDir)
	if raw, err := os.ReadFile(path); err == nil {
		if token := strings.TrimSpace(string(raw)); token != "" {
			return token, nil
		}
	}
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	token := hex.EncodeToString(buf)
	if err := atomicWriteFile(path, []byte(token)); err != nil {
		return "", err
	}
	return token, nil
}

// OwnerTokenMatches 用常量时间比较 owner 凭据。
func OwnerTokenMatches(dataDir, presented string) bool {
	expected, err := EnsureOwnerToken(dataDir)
	if err != nil || presented == "" {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(expected), []byte(presented)) == 1
}

// HostTokenPath 是内置助手宿主的专属凭据：只由后端注入宿主进程，页面与普通客户端拿不到。
func HostTokenPath(dataDir string) string { return filepath.Join(dataDir, "agent_host_token") }

// HostTokenMatches 判断请求是否来自已鉴权的内置助手宿主。
// 回合归属只认这个身份：owner/已登记客户端即使拿到 turnId，也不能自报归属。
// 取值顺序与 handler.readAgentHostToken 完全一致（显式环境变量优先，其次数据目录文件），
// 否则宿主拿到的是环境变量、这里读的是文件，两边会悄悄对不上。
func HostTokenMatches(dataDir, presented string) bool {
	presented = strings.TrimSpace(presented)
	if presented == "" {
		return false
	}
	expected := strings.TrimSpace(os.Getenv("BEEFTV_AGENT_HOST_TOKEN"))
	if expected == "" {
		if strings.TrimSpace(dataDir) == "" {
			return false
		}
		raw, err := os.ReadFile(HostTokenPath(dataDir))
		if err != nil {
			return false
		}
		expected = strings.TrimSpace(string(raw))
	}
	if expected == "" || len(expected) != len(presented) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(expected), []byte(presented)) == 1
}

func restrictFile(path string) error {
	if err := securefile.Protect(path); err != nil {
		return err
	}
	return securefile.Verify(path)
}

// restrictExisting 收紧旧版本已经写好的凭据文件；文件不存在时什么都不做。
func restrictExisting(path string) {
	if _, err := os.Stat(path); err != nil {
		return
	}
	_ = os.Chmod(path, 0o600)
	if err := restrictFile(path); err != nil {
		log.Printf("凭据文件 %s 未能收紧为仅当前用户可读：%v", filepath.Base(path), err)
	}
}

// EnsureAgentCredentials 在组合根生成 owner 凭据与宿主凭据；DataDir 为空时明确报错，不写 CWD。
// 已有的凭据文件和客户端登记也在这里收紧一次，旧版本在 Windows 上写的文件会继承数据目录权限。
func EnsureAgentCredentials(dataDir string) {
	if strings.TrimSpace(dataDir) == "" {
		return
	}
	hostPath := HostTokenPath(dataDir)
	for _, path := range []string{OwnerTokenPath(dataDir), hostPath, ClientRegistryPath(dataDir)} {
		restrictExisting(path)
	}
	if _, err := EnsureOwnerToken(dataDir); err != nil {
		return
	}
	if _, err := os.Stat(hostPath); err == nil {
		return
	}
	buf := make([]byte, 24)
	if _, err := rand.Read(buf); err != nil {
		return
	}
	_ = atomicWriteFile(hostPath, []byte(hex.EncodeToString(buf)))
}
