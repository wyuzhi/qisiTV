package beeftv

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	"qisitv/backend/internal/kernel"
)

var validCNYBalancePattern = regexp.MustCompile(`^\d+(?:\.\d{2})?$`)

const topUpLaunchPath = "/api/payments/enterprise/topup-launch"

type TopUpMethod struct {
	Type     string `json:"type"`
	Name     string `json:"name"`
	MinTopUp int    `json:"minTopup,omitempty"`
}

type TopUpBonusTier struct {
	Threshold float64 `json:"threshold"`
	Bonus     float64 `json:"bonus"`
}

type TopUpCardInfo struct {
	PaymentCurrency string `json:"paymentCurrency"`
	CreditCurrency  string `json:"creditCurrency"`
	MinAmount       int    `json:"minAmount"`
	MaxAmount       int    `json:"maxAmount"`
	USDCNYRate      string `json:"usdCnyRate"`
}

type TopUpInfoView struct {
	Currency          string           `json:"currency"`
	EnableOnlineTopUp bool             `json:"enableOnlineTopup"`
	PayMethods        []TopUpMethod    `json:"payMethods"`
	MinTopUp          int              `json:"minTopup"`
	MaxTopUp          int64            `json:"maxTopup"`
	AmountOptions     []int            `json:"amountOptions"`
	BonusEnabled      bool             `json:"bonusEnabled"`
	BonusTiers        []TopUpBonusTier `json:"bonusTiers,omitempty"`
	EnableCardTopUp   bool             `json:"enableCardTopup"`
	Card              *TopUpCardInfo   `json:"card,omitempty"`
	BalanceCNY        string           `json:"balanceCny,omitempty"`
}

type TopUpCheckoutInput struct {
	PaymentMethod string `json:"paymentMethod"`
	Amount        int64  `json:"amount,omitempty"`
	AmountUSD     string `json:"amountUsd,omitempty"`
	TradeNo       string `json:"tradeNo,omitempty"`
}

type TopUpMoney struct {
	Currency string `json:"currency"`
	Value    string `json:"value"`
}

type TopUpCheckoutResult struct {
	TradeNo       string     `json:"tradeNo"`
	PaymentMethod string     `json:"paymentMethod"`
	FXRate        string     `json:"fxRate,omitempty"`
	Amount        TopUpMoney `json:"amount"`
	Credit        TopUpMoney `json:"credit"`
	Opened        bool       `json:"opened"`
	OpenError     string     `json:"openError,omitempty"`
}

type TopUpReconcileResult struct {
	Status     string  `json:"status"`
	Credited   bool    `json:"credited"`
	Settled    bool    `json:"settled"`
	RetryAfter int     `json:"retryAfter,omitempty"`
	Message    string  `json:"message,omitempty"`
	BalanceCNY string  `json:"balanceCny,omitempty"`
	Connection Summary `json:"connection"`
}

func normalizeRemoteBalance(rawCNY string, quota *int64, fallbackBalance, fallbackCNY string) (string, string) {
	trimmed := strings.TrimSpace(rawCNY)
	validCNY := validCNYBalancePattern.MatchString(trimmed)
	if quota != nil {
		if *quota <= 0 {
			return BalanceZero, "0.00"
		}
		if validCNY {
			return BalanceAvailable, trimmed
		}
		return BalanceAvailable, fallbackCNY
	}
	if validCNY {
		if trimmed == "0.00" || trimmed == "0" {
			return BalanceZero, "0.00"
		}
		return BalanceAvailable, trimmed
	}
	if fallbackBalance == "" {
		fallbackBalance = BalanceUnknown
	}
	return fallbackBalance, fallbackCNY
}

// ValidateCheckoutURL restricts desktop browser launch strictly to the
// connected service origin's dedicated top-up launch path.
func ValidateCheckoutURL(origin, raw string) (*url.URL, error) {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || parsed.Scheme == "" || parsed.Host == "" || parsed.User != nil || parsed.Fragment != "" {
		return nil, kernel.BadAuthRequest("支付地址无效")
	}
	normalizedOrigin := ProviderBaseURL(origin)
	if !strings.EqualFold(parsed.Scheme+"://"+parsed.Host, normalizedOrigin) {
		return nil, kernel.BadAuthRequest("支付地址不属于当前服务地址")
	}
	path := parsed.EscapedPath()
	if path == topUpLaunchPath {
		return parsed, nil
	}
	if isSafeTestHost(parsed.Hostname()) && path == "/api/preview/checkout" {
		return parsed, nil
	}
	return nil, kernel.BadAuthRequest("支付地址不在允许的收银台路径")
}

func (s *Service) currentBalanceSeq() uint64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.balanceSeq
}

func (s *Service) applyRemoteBalanceIfCurrent(seq uint64, balanceCNY string, quota *int64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.state.hasCredential() || s.balanceSeq != seq {
		return
	}
	s.balanceSeq++
	nextBalance, nextCNY := normalizeRemoteBalance(balanceCNY, quota, s.state.Balance, s.state.BalanceCNY)
	if nextBalance == s.state.Balance && nextCNY == s.state.BalanceCNY {
		return
	}
	s.state.Balance = nextBalance
	s.state.BalanceCNY = nextCNY
	_ = s.persistState(s.state)
}

func (s *Service) applyAuthoritativeBalance(balanceCNY string, quota *int64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.state.hasCredential() {
		return
	}
	s.balanceSeq++
	nextBalance, nextCNY := normalizeRemoteBalance(balanceCNY, quota, s.state.Balance, s.state.BalanceCNY)
	if nextBalance == s.state.Balance && nextCNY == s.state.BalanceCNY {
		return
	}
	s.state.Balance = nextBalance
	s.state.BalanceCNY = nextCNY
	_ = s.persistState(s.state)
}

func (s *Service) applyRemoteConnectionViewIfCurrent(seq uint64, view connectionView) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.state.hasCredential() || s.balanceSeq != seq {
		return
	}
	s.balanceSeq++
	if strings.TrimSpace(view.Account.ID.String()) != "" {
		account := view.Account
		s.state.Account = &account
	}
	if strings.TrimSpace(view.KeyName) != "" {
		s.state.KeyName = strings.TrimSpace(view.KeyName)
	}
	if strings.TrimSpace(view.Market) != "" {
		s.state.Market = strings.TrimSpace(view.Market)
	}
	s.state.Balance, s.state.BalanceCNY = normalizeRemoteBalance(view.BalanceCNY, view.Quota, s.state.Balance, s.state.BalanceCNY)
	_ = s.persistState(s.state)
}

func mapResolveError(err error) error {
	var appErr *kernel.AppError
	if errors.As(err, &appErr) {
		return appErr
	}
	if errors.Is(err, errNotConnected) || errors.Is(err, errRevoked) {
		return kernel.Unauthorized(err.Error())
	}
	return kernel.WrapAppError(http.StatusInternalServerError, "读取账户连接状态失败", err)
}

func mapTransportError(err error, fallback string) error {
	if errors.Is(err, context.DeadlineExceeded) {
		return kernel.WrapAppError(http.StatusGatewayTimeout, "连接充值服务超时，请稍后重试", err)
	}
	if errors.Is(err, context.Canceled) {
		return kernel.WrapAppError(http.StatusBadRequest, "请求已取消", err)
	}
	return kernel.WrapAppError(http.StatusBadGateway, fallback, err)
}

func (s *Service) mapUpstreamStatusError(status int, raw []byte, fallback string) error {
	msg, code := parseUpstreamErrorDetail(raw, fallback)
	switch status {
	case http.StatusBadRequest:
		return kernel.BadAuthRequest(msg)
	case http.StatusUnauthorized:
		s.MarkRevoked()
		return kernel.Unauthorized(errRevoked.Error())
	case http.StatusForbidden:
		if code == "desktop_token_required" {
			s.MarkRevoked()
			return kernel.Unauthorized(msg)
		}
		return kernel.Forbidden(msg)
	case http.StatusNotFound:
		return kernel.NotFound(msg)
	case http.StatusConflict:
		return kernel.NewAppError(http.StatusConflict, msg)
	case http.StatusTooManyRequests:
		return kernel.RateLimited(msg)
	case http.StatusServiceUnavailable:
		return kernel.NewAppError(http.StatusServiceUnavailable, msg)
	case http.StatusGatewayTimeout:
		return kernel.NewAppError(http.StatusGatewayTimeout, msg)
	default:
		if status >= 500 {
			return kernel.NewAppError(http.StatusBadGateway, msg)
		}
		return kernel.BadAuthRequest(msg)
	}
}

func (s *Service) RefreshBalance(ctx context.Context) (Summary, error) {
	seq := s.currentBalanceSeq()
	cred, err := s.Resolve()
	if err != nil {
		return s.Status(), mapResolveError(err)
	}
	reqCtx := ctx
	if reqCtx == nil {
		reqCtx = s.lifecycle
	}
	boundedCtx, cancel := context.WithTimeout(reqCtx, 15*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(boundedCtx, http.MethodGet, TokenBaseURL(s.Origin())+"/beeftv/connection", nil)
	if err != nil {
		return s.Status(), kernel.WrapAppError(http.StatusInternalServerError, "构建余额刷新请求失败", err)
	}
	request.Header.Set("Authorization", "Bearer "+cred.APIKey)
	request.Header.Set("Accept", "application/json")
	response, err := s.httpClient.Do(request)
	if err != nil {
		return s.Status(), mapTransportError(err, "刷新账户余额失败，请稍后重试")
	}
	defer response.Body.Close()
	raw, readErr := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if readErr != nil {
		return s.Status(), kernel.WrapAppError(http.StatusBadGateway, "读取账户余额响应失败", readErr)
	}
	if response.StatusCode >= 300 {
		return s.Status(), s.mapUpstreamStatusError(response.StatusCode, raw, "刷新账户余额失败，请稍后重试")
	}
	var view connectionView
	if err := json.Unmarshal(raw, &view); err != nil {
		return s.Status(), kernel.WrapAppError(http.StatusBadGateway, "账户连接信息格式无效", err)
	}
	s.applyRemoteConnectionViewIfCurrent(seq, view)
	return s.Status(), nil
}

func (s *Service) authedJSONRequest(ctx context.Context, timeout time.Duration, method, path string, body any) (int, []byte, error) {
	cred, err := s.Resolve()
	if err != nil {
		return 0, nil, mapResolveError(err)
	}
	reqCtx := ctx
	if reqCtx == nil {
		reqCtx = s.lifecycle
	}
	boundedCtx, cancel := context.WithTimeout(reqCtx, timeout)
	defer cancel()
	var reader io.Reader
	if body != nil {
		encoded, marshalErr := json.Marshal(body)
		if marshalErr != nil {
			return 0, nil, kernel.WrapAppError(http.StatusInternalServerError, "编码请求参数失败", marshalErr)
		}
		reader = bytes.NewReader(encoded)
	}
	request, err := http.NewRequestWithContext(boundedCtx, method, TokenBaseURL(s.Origin())+path, reader)
	if err != nil {
		return 0, nil, kernel.WrapAppError(http.StatusInternalServerError, "构建请求失败", err)
	}
	request.Header.Set("Authorization", "Bearer "+cred.APIKey)
	request.Header.Set("Accept", "application/json")
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := s.httpClient.Do(request)
	if err != nil {
		return 0, nil, mapTransportError(err, "无法连接充值服务，请检查网络后重试")
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil {
		return response.StatusCode, nil, kernel.WrapAppError(http.StatusBadGateway, "读取充值服务响应失败", err)
	}
	return response.StatusCode, raw, nil
}

func parseUpstreamErrorDetail(raw []byte, fallback string) (string, string) {
	var envelope struct {
		Message string `json:"message"`
		Error   any    `json:"error"`
	}
	if json.Unmarshal(raw, &envelope) == nil {
		code := ""
		switch typed := envelope.Error.(type) {
		case string:
			code = strings.TrimSpace(typed)
		case map[string]any:
			if c, ok := typed["code"].(string); ok {
				code = strings.TrimSpace(c)
			}
			if envelope.Message == "" {
				if m, ok := typed["message"].(string); ok {
					envelope.Message = strings.TrimSpace(m)
				}
			}
		}
		if code == "desktop_token_required" {
			return "当前登录凭据不支持桌面充值，请重新登录 BeefTV", code
		}
		if msg := strings.TrimSpace(envelope.Message); msg != "" {
			return msg, code
		}
		if code != "" {
			return code, code
		}
	}
	return fallback, ""
}

func (s *Service) mapUpstreamEnvelopeError(raw []byte, fallback string) error {
	msg, code := parseUpstreamErrorDetail(raw, fallback)
	switch code {
	case "desktop_token_required", "unauthorized", "invalid_token", "invalid_api_key":
		s.MarkRevoked()
		return kernel.Unauthorized(msg)
	case "forbidden":
		return kernel.Forbidden(msg)
	case "not_found":
		return kernel.NotFound(msg)
	case "rate_limited", "too_many_requests":
		return kernel.RateLimited(msg)
	default:
		return kernel.BadAuthRequest(msg)
	}
}

func (s *Service) TopUpInfo(ctx context.Context) (TopUpInfoView, error) {
	seq := s.currentBalanceSeq()
	status, raw, err := s.authedJSONRequest(ctx, 15*time.Second, http.MethodGet, "/beeftv/topup/info", nil)
	if err != nil {
		return TopUpInfoView{}, err
	}
	if status >= 300 {
		return TopUpInfoView{}, s.mapUpstreamStatusError(status, raw, "充值配置暂时不可用，请稍后重试")
	}
	var envelope struct {
		Success bool   `json:"success"`
		Message string `json:"message"`
		Data    struct {
			Currency          string              `json:"currency"`
			EnableOnlineTopUp bool                `json:"enable_online_topup"`
			PayMethods        []map[string]string `json:"pay_methods"`
			MinTopUp          int                 `json:"min_topup"`
			MaxTopUp          int64               `json:"max_topup"`
			AmountOptions     []int               `json:"amount_options"`
			TopUpBonus        struct {
				Enabled bool             `json:"enabled"`
				Tiers   []TopUpBonusTier `json:"tiers"`
			} `json:"topup_bonus"`
			EnableCardTopUp bool `json:"enable_card_topup"`
			Card            *struct {
				PaymentCurrency string `json:"payment_currency"`
				CreditCurrency  string `json:"credit_currency"`
				MinAmount       int    `json:"min_amount"`
				MaxAmount       int    `json:"max_amount"`
				USDCNYRate      string `json:"usd_cny_rate"`
			} `json:"card"`
			BalanceCNY string `json:"balance_cny"`
			Quota      *int64 `json:"quota"`
		} `json:"data"`
	}
	if err := json.Unmarshal(raw, &envelope); err != nil {
		return TopUpInfoView{}, kernel.WrapAppError(http.StatusBadGateway, "读取充值配置失败", err)
	}
	if !envelope.Success {
		return TopUpInfoView{}, s.mapUpstreamEnvelopeError(raw, "读取充值配置失败")
	}
	s.applyRemoteBalanceIfCurrent(seq, envelope.Data.BalanceCNY, envelope.Data.Quota)
	methods := make([]TopUpMethod, 0, len(envelope.Data.PayMethods))
	for _, item := range envelope.Data.PayMethods {
		methodType := strings.ToLower(strings.TrimSpace(item["type"]))
		if methodType != "wxpay" && methodType != "alipay" {
			continue
		}
		name := strings.TrimSpace(item["name"])
		if name == "" {
			if methodType == "wxpay" {
				name = "微信支付"
			} else {
				name = "支付宝"
			}
		}
		minVal, _ := strconv.Atoi(strings.TrimSpace(item["min_topup"]))
		methods = append(methods, TopUpMethod{Type: methodType, Name: name, MinTopUp: minVal})
	}
	minTopUp := envelope.Data.MinTopUp
	if minTopUp < 1 {
		minTopUp = 20
	}
	maxTopUp := envelope.Data.MaxTopUp
	if maxTopUp <= 0 {
		maxTopUp = 100000
	}
	options := envelope.Data.AmountOptions
	if len(options) == 0 {
		options = []int{50, 100, 200, 500}
	}
	var card *TopUpCardInfo
	if envelope.Data.EnableCardTopUp && envelope.Data.Card != nil {
		card = &TopUpCardInfo{
			PaymentCurrency: strings.TrimSpace(envelope.Data.Card.PaymentCurrency),
			CreditCurrency:  strings.TrimSpace(envelope.Data.Card.CreditCurrency),
			MinAmount:       envelope.Data.Card.MinAmount,
			MaxAmount:       envelope.Data.Card.MaxAmount,
			USDCNYRate:      strings.TrimSpace(envelope.Data.Card.USDCNYRate),
		}
	}
	summary := s.Status()
	return TopUpInfoView{
		Currency:          "CNY",
		EnableOnlineTopUp: envelope.Data.EnableOnlineTopUp && len(methods) > 0,
		PayMethods:        methods,
		MinTopUp:          minTopUp,
		MaxTopUp:          maxTopUp,
		AmountOptions:     options,
		BonusEnabled:      envelope.Data.TopUpBonus.Enabled && len(envelope.Data.TopUpBonus.Tiers) > 0,
		BonusTiers:        envelope.Data.TopUpBonus.Tiers,
		EnableCardTopUp:   card != nil,
		Card:              card,
		BalanceCNY:        summary.BalanceCNY,
	}, nil
}

func (s *Service) StartTopUpCheckout(ctx context.Context, input TopUpCheckoutInput) (TopUpCheckoutResult, error) {
	method := strings.ToLower(strings.TrimSpace(input.PaymentMethod))
	if method != "wxpay" && method != "alipay" && method != "card" {
		return TopUpCheckoutResult{}, kernel.BadAuthRequest("请选择有效的支付方式")
	}
	payload := map[string]any{"payment_method": method}
	if tradeNo := strings.TrimSpace(input.TradeNo); tradeNo != "" {
		payload["trade_no"] = tradeNo
	} else if method == "card" {
		amountUSD := strings.TrimSpace(input.AmountUSD)
		if amountUSD == "" {
			return TopUpCheckoutResult{}, kernel.BadAuthRequest("请输入有效的美元充值金额")
		}
		payload["amount_usd"] = amountUSD
	} else {
		if input.Amount <= 0 {
			return TopUpCheckoutResult{}, kernel.BadAuthRequest("请输入有效的人民币充值金额")
		}
		payload["amount"] = input.Amount
	}
	// Keep backend timeout strictly shorter than frontend timeout (25s) so orders are not created after UI aborts.
	status, raw, err := s.authedJSONRequest(ctx, 20*time.Second, http.MethodPost, "/beeftv/topup/checkout", payload)
	if err != nil {
		return TopUpCheckoutResult{}, err
	}
	if status >= 300 {
		return TopUpCheckoutResult{}, s.mapUpstreamStatusError(status, raw, "创建充值订单失败，请稍后重试")
	}
	var envelope struct {
		Success bool   `json:"success"`
		Message string `json:"message"`
		Data    struct {
			CheckoutURL   string     `json:"checkout_url"`
			TradeNo       string     `json:"trade_no"`
			PaymentMethod string     `json:"payment_method"`
			FXRate        string     `json:"fx_rate"`
			Amount        TopUpMoney `json:"amount"`
			Credit        TopUpMoney `json:"credit"`
		} `json:"data"`
	}
	if err := json.Unmarshal(raw, &envelope); err != nil {
		return TopUpCheckoutResult{}, kernel.WrapAppError(http.StatusBadGateway, "创建充值订单失败，请稍后重试", err)
	}
	if !envelope.Success || strings.TrimSpace(envelope.Data.TradeNo) == "" {
		return TopUpCheckoutResult{}, s.mapUpstreamEnvelopeError(raw, "创建充值订单失败，请稍后重试")
	}
	result := TopUpCheckoutResult{
		TradeNo:       strings.TrimSpace(envelope.Data.TradeNo),
		PaymentMethod: strings.TrimSpace(envelope.Data.PaymentMethod),
		FXRate:        strings.TrimSpace(envelope.Data.FXRate),
		Amount:        envelope.Data.Amount,
		Credit:        envelope.Data.Credit,
	}
	validatedURL, err := ValidateCheckoutURL(s.Origin(), envelope.Data.CheckoutURL)
	if err != nil {
		result.Opened = false
		result.OpenError = "支付地址校验失败，请点击“重新打开支付页”重试"
		return result, nil
	}
	if err := s.openURL(validatedURL.String()); err != nil {
		result.Opened = false
		result.OpenError = "无法自动打开系统浏览器，请点击“重新打开支付页”继续付款"
		return result, nil
	}
	result.Opened = true
	return result, nil
}

func (s *Service) ReconcileTopUp(ctx context.Context, tradeNo string) (TopUpReconcileResult, error) {
	trimmed := strings.TrimSpace(tradeNo)
	if trimmed == "" {
		return TopUpReconcileResult{}, kernel.BadAuthRequest("充值订单号不能为空")
	}
	status, raw, err := s.authedJSONRequest(ctx, 12*time.Second, http.MethodPost, "/beeftv/topup/reconcile", map[string]string{"trade_no": trimmed})
	if err != nil {
		return TopUpReconcileResult{}, err
	}
	if status >= 300 {
		return TopUpReconcileResult{}, s.mapUpstreamStatusError(status, raw, "查询支付结果失败，请稍后重试")
	}
	var envelope struct {
		Success bool   `json:"success"`
		Message string `json:"message"`
		Data    struct {
			Status     string `json:"status"`
			Credited   bool   `json:"credited"`
			Settled    *bool  `json:"settled"`
			RetryAfter int    `json:"retry_after"`
			Message    string `json:"message"`
			BalanceCNY string `json:"balance_cny"`
			Quota      *int64 `json:"quota"`
		} `json:"data"`
	}
	if err := json.Unmarshal(raw, &envelope); err != nil {
		return TopUpReconcileResult{}, kernel.WrapAppError(http.StatusBadGateway, "查询支付结果失败，请稍后重试", err)
	}
	if !envelope.Success {
		return TopUpReconcileResult{}, s.mapUpstreamEnvelopeError(raw, "查询支付结果失败，请稍后重试")
	}
	s.applyAuthoritativeBalance(envelope.Data.BalanceCNY, envelope.Data.Quota)
	summary := s.Status()
	settled := envelope.Data.Credited || (envelope.Data.Settled != nil && *envelope.Data.Settled)
	return TopUpReconcileResult{
		Status:     strings.TrimSpace(envelope.Data.Status),
		Credited:   envelope.Data.Credited,
		Settled:    settled,
		RetryAfter: envelope.Data.RetryAfter,
		Message:    strings.TrimSpace(envelope.Data.Message),
		BalanceCNY: summary.BalanceCNY,
		Connection: summary,
	}, nil
}
