package beeftv

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"qisitv/backend/internal/kernel"
	"qisitv/backend/internal/workspace"
)

func newConnectedTopUpTestServiceWithOpen(t *testing.T, handler http.HandlerFunc, openFn func(string) error) *Service {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	dataDir := t.TempDir()
	encrypted, err := encryptSecret(dataDir, "sk-test-desktop-token")
	if err != nil {
		t.Fatalf("encryptSecret: %v", err)
	}
	initial := persistedState{
		AuthorizationOrigin: server.URL,
		ProviderBaseURL:     server.URL,
		SchemaVersion:       connectionSchema,
		Status:              StateConnected,
		EncryptedAPIKey:     encrypted,
		Market:              "enterprise",
		Group:               "enterprise",
		Account:             &Account{ID: "42", Username: "creator", DisplayName: "测试创作者", Email: "creator@example.com"},
		KeyName:             "BeefTV - Mac",
		TokenID:             "9",
		Acked:               true,
		CatalogOK:           true,
		Balance:             BalanceUnknown,
	}
	if err := saveState(dataDir, initial); err != nil {
		t.Fatalf("saveState: %v", err)
	}
	svc, err := New(Options{
		DataDir:    dataDir,
		Origin:     server.URL,
		HTTPClient: server.Client(),
		Provider:   &workspace.ProviderConfig{},
		OpenURL:    openFn,
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	t.Cleanup(svc.Close)
	return svc
}

func newConnectedTopUpTestService(t *testing.T, handler http.HandlerFunc, opened *[]string) *Service {
	t.Helper()
	return newConnectedTopUpTestServiceWithOpen(t, handler, func(target string) error {
		if opened != nil {
			*opened = append(*opened, target)
		}
		return nil
	})
}

func TestValidateCheckoutURLAllowlist(t *testing.T) {
	cases := []struct {
		name    string
		origin  string
		raw     string
		wantErr bool
	}{
		{
			name:    "same-origin topup launch allowed",
			origin:  "https://beeftv.app",
			raw:     "https://beeftv.app/api/payments/enterprise/topup-launch?trade_no=T1&exp=1&sig=abc",
			wantErr: false,
		},
		{
			name:    "loopback test preview checkout allowed",
			origin:  "http://127.0.0.1:18080",
			raw:     "http://127.0.0.1:18080/api/preview/checkout?trade_no=T1",
			wantErr: false,
		},
		{
			name:    "third-party card gateway host rejected",
			origin:  "https://beeftv.app",
			raw:     "https://checkout.external-gateway.example/cs_live_123",
			wantErr: true,
		},
		{
			name:    "scheme downgrade rejected",
			origin:  "https://beeftv.app",
			raw:     "http://beeftv.app/api/payments/enterprise/topup-launch?trade_no=T1&exp=1&sig=abc",
			wantErr: true,
		},
		{
			name:    "non-matching port rejected",
			origin:  "https://beeftv.app",
			raw:     "https://beeftv.app:8443/api/payments/enterprise/topup-launch?trade_no=T1&exp=1&sig=abc",
			wantErr: true,
		},
		{
			name:    "userinfo rejected",
			origin:  "https://beeftv.app",
			raw:     "https://user@beeftv.app/api/payments/enterprise/topup-launch?trade_no=T1",
			wantErr: true,
		},
		{
			name:    "fragment rejected",
			origin:  "https://beeftv.app",
			raw:     "https://beeftv.app/api/payments/enterprise/topup-launch?trade_no=T1#frag",
			wantErr: true,
		},
		{
			name:    "arbitrary same-origin path rejected",
			origin:  "https://beeftv.app",
			raw:     "https://beeftv.app/evil-redirect",
			wantErr: true,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := ValidateCheckoutURL(tc.origin, tc.raw)
			if tc.wantErr && err == nil {
				t.Fatalf("expected error for %q, got nil", tc.raw)
			}
			if !tc.wantErr && err != nil {
				t.Fatalf("expected %q to pass, got %v", tc.raw, err)
			}
		})
	}
}

func TestTopUpLifecycleUpdatesConnectionBalance(t *testing.T) {
	var opened []string
	var reconcileCount atomic.Int32
	var svc *Service
	svc = newConnectedTopUpTestService(t, func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "Bearer sk-test-desktop-token" {
			t.Errorf("unexpected Authorization header: %q", got)
		}
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/v1/beeftv/connection":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"market":      "enterprise",
				"account":     map[string]any{"id": 42, "display_name": "测试创作者", "email": "creator@example.com"},
				"token_id":    9,
				"key_name":    "BeefTV - Mac",
				"balance_cny": "28.50",
				"quota":       14250000,
			})
		case "/v1/beeftv/topup/info":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"success": true,
				"data": map[string]any{
					"currency":            "CNY",
					"enable_online_topup": true,
					"pay_methods": []map[string]string{
						{"type": "wxpay", "name": "微信支付"},
						{"type": "alipay", "name": "支付宝"},
						{"type": "custom1", "name": "内部渠道"},
					},
					"min_topup":         20,
					"max_topup":         100000,
					"amount_options":    []int{50, 100, 200, 500},
					"enable_card_topup": true,
					"card": map[string]any{
						"payment_currency": "USD",
						"credit_currency":  "CNY",
						"min_amount":       5,
						"max_amount":       10000,
						"usd_cny_rate":     "7.12",
					},
					"balance_cny": "28.50",
					"quota":       14250000,
				},
			})
		case "/v1/beeftv/topup/checkout":
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			method, _ := body["payment_method"].(string)
			tradeNo := "T100"
			amount := map[string]string{"currency": "CNY", "value": "100.00"}
			credit := map[string]string{"currency": "CNY", "value": "100.00"}
			fxRate := ""
			if method == "card" {
				tradeNo = "TCARD200"
				amount = map[string]string{"currency": "USD", "value": "10.00"}
				credit = map[string]string{"currency": "CNY", "value": "71.20"}
				fxRate = "7.12"
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"success": true,
				"data": map[string]any{
					"checkout_url":   svc.Origin() + "/api/payments/enterprise/topup-launch?trade_no=" + tradeNo + "&exp=999&sig=ok",
					"trade_no":       tradeNo,
					"payment_method": method,
					"fx_rate":        fxRate,
					"amount":         amount,
					"credit":         credit,
				},
			})
		case "/v1/beeftv/topup/reconcile":
			call := reconcileCount.Add(1)
			credited := call == 1
			_ = json.NewEncoder(w).Encode(map[string]any{
				"success": true,
				"data": map[string]any{
					"status":      "success",
					"credited":    credited,
					"settled":     true,
					"balance_cny": "128.50",
					"quota":       64250000,
				},
			})
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}, &opened)

	summary, err := svc.RefreshBalance(context.Background())
	if err != nil {
		t.Fatalf("RefreshBalance: %v", err)
	}
	if summary.Balance != BalanceAvailable || summary.BalanceCNY != "28.50" {
		t.Fatalf("unexpected refreshed balance: %+v", summary)
	}

	info, err := svc.TopUpInfo(context.Background())
	if err != nil {
		t.Fatalf("TopUpInfo: %v", err)
	}
	if !info.EnableOnlineTopUp || !info.EnableCardTopUp || len(info.PayMethods) != 2 || info.Card == nil || info.Card.USDCNYRate != "7.12" {
		t.Fatalf("unexpected TopUpInfo: %+v", info)
	}

	checkout, err := svc.StartTopUpCheckout(context.Background(), TopUpCheckoutInput{PaymentMethod: "wxpay", Amount: 100})
	if err != nil {
		t.Fatalf("StartTopUpCheckout wxpay: %v", err)
	}
	if !checkout.Opened || checkout.TradeNo != "T100" || len(opened) != 1 || !strings.Contains(opened[0], "/api/payments/enterprise/topup-launch?trade_no=T100") {
		t.Fatalf("unexpected wxpay checkout result=%+v opened=%v", checkout, opened)
	}

	cardCheckout, err := svc.StartTopUpCheckout(context.Background(), TopUpCheckoutInput{PaymentMethod: "card", AmountUSD: "10.00"})
	if err != nil {
		t.Fatalf("StartTopUpCheckout card: %v", err)
	}
	if !cardCheckout.Opened || cardCheckout.TradeNo != "TCARD200" || cardCheckout.FXRate != "7.12" || len(opened) != 2 || !strings.Contains(opened[1], "/api/payments/enterprise/topup-launch?trade_no=TCARD200") {
		t.Fatalf("unexpected card checkout result=%+v opened=%v", cardCheckout, opened)
	}

	reconcile1, err := svc.ReconcileTopUp(context.Background(), "T100")
	if err != nil {
		t.Fatalf("ReconcileTopUp #1: %v", err)
	}
	if reconcile1.Status != "success" || !reconcile1.Credited || !reconcile1.Settled || reconcile1.Connection.BalanceCNY != "128.50" {
		t.Fatalf("unexpected first reconcile result: %+v", reconcile1)
	}

	// Second reconcile simulates webhook-already-settled idempotent response (credited=false, settled=true).
	reconcile2, err := svc.ReconcileTopUp(context.Background(), "T100")
	if err != nil {
		t.Fatalf("ReconcileTopUp #2: %v", err)
	}
	if reconcile2.Status != "success" || reconcile2.Credited || !reconcile2.Settled || reconcile2.Connection.BalanceCNY != "128.50" {
		t.Fatalf("unexpected idempotent reconcile result: %+v", reconcile2)
	}
}

func TestStartTopUpCheckoutPreservesOrderOnOpenOrURLFailure(t *testing.T) {
	var returnUntrustedURL atomic.Bool
	var svc *Service
	svc = newConnectedTopUpTestServiceWithOpen(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		checkoutURL := svc.Origin() + "/api/payments/enterprise/topup-launch?trade_no=T-OPEN-ERR&exp=999&sig=ok"
		if returnUntrustedURL.Load() {
			checkoutURL = "https://untrusted.example/pay"
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"success": true,
			"data": map[string]any{
				"checkout_url":   checkoutURL,
				"trade_no":       "T-OPEN-ERR",
				"payment_method": "alipay",
				"amount":         map[string]string{"currency": "CNY", "value": "50.00"},
				"credit":         map[string]string{"currency": "CNY", "value": "50.00"},
			},
		})
	}, func(string) error {
		return errors.New("launcher unavailable")
	})

	resOpenFail, err := svc.StartTopUpCheckout(context.Background(), TopUpCheckoutInput{PaymentMethod: "alipay", Amount: 50})
	if err != nil {
		t.Fatalf("expected order summary to be preserved when openURL fails, got err=%v", err)
	}
	if resOpenFail.TradeNo != "T-OPEN-ERR" || resOpenFail.Opened || resOpenFail.OpenError == "" {
		t.Fatalf("expected Opened=false with preserved TradeNo and OpenError, got %+v", resOpenFail)
	}

	returnUntrustedURL.Store(true)
	resURLFail, err := svc.StartTopUpCheckout(context.Background(), TopUpCheckoutInput{PaymentMethod: "alipay", Amount: 50})
	if err != nil {
		t.Fatalf("expected order summary to be preserved when checkout_url fails validation, got err=%v", err)
	}
	if resURLFail.TradeNo != "T-OPEN-ERR" || resURLFail.Opened || resURLFail.OpenError == "" {
		t.Fatalf("expected Opened=false with preserved TradeNo on untrusted URL, got %+v", resURLFail)
	}
}

func TestReconcileBalanceNotOverwrittenByStaleRefresh(t *testing.T) {
	refreshEntered := make(chan struct{})
	releaseRefresh := make(chan struct{})
	svc := newConnectedTopUpTestService(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/v1/beeftv/connection":
			close(refreshEntered)
			<-releaseRefresh
			_ = json.NewEncoder(w).Encode(map[string]any{
				"market":      "enterprise",
				"account":     map[string]any{"id": 42, "display_name": "测试创作者"},
				"balance_cny": "10.00",
				"quota":       5000000,
			})
		case "/v1/beeftv/topup/reconcile":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"success": true,
				"data": map[string]any{
					"status":      "success",
					"credited":    true,
					"settled":     true,
					"balance_cny": "110.00",
					"quota":       55000000,
				},
			})
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}, nil)

	refreshDone := make(chan error, 1)
	go func() {
		_, err := svc.RefreshBalance(context.Background())
		refreshDone <- err
	}()

	<-refreshEntered
	reconciled, err := svc.ReconcileTopUp(context.Background(), "T-RACE-1")
	if err != nil {
		t.Fatalf("ReconcileTopUp: %v", err)
	}
	if reconciled.BalanceCNY != "110.00" {
		t.Fatalf("expected reconciled balance 110.00, got %+v", reconciled)
	}

	close(releaseRefresh)
	if err := <-refreshDone; err != nil {
		t.Fatalf("RefreshBalance: %v", err)
	}
	if got := svc.Status().BalanceCNY; got != "110.00" {
		t.Fatalf("stale RefreshBalance overwrote authoritative reconciled balance: got %q, want 110.00", got)
	}
}

func TestTopUpUpstreamErrorMapping(t *testing.T) {
	var upstreamStatus atomic.Int32
	var upstreamBody atomic.Value
	upstreamBody.Store(`{"message":"网关暂不可用"}`)

	svc := newConnectedTopUpTestService(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(int(upstreamStatus.Load()))
		_, _ = w.Write([]byte(upstreamBody.Load().(string)))
	}, nil)

	for _, tc := range []struct {
		status     int
		body       string
		wantStatus int
		wantReason kernel.ErrorReason
	}{
		{http.StatusTooManyRequests, `{"message":"请求过于频繁"}`, http.StatusTooManyRequests, kernel.ReasonRateLimited},
		{http.StatusBadGateway, `{"message":"上游收银台不可用"}`, http.StatusBadGateway, kernel.ReasonBadGateway},
		{http.StatusServiceUnavailable, `{"message":"充值维护中"}`, http.StatusServiceUnavailable, kernel.ReasonUnavailable},
		{http.StatusOK, `{"success":false,"error":{"code":"desktop_token_required","message":"forbidden"}}`, http.StatusUnauthorized, kernel.ReasonUnauthorized},
	} {
		upstreamStatus.Store(int32(tc.status))
		upstreamBody.Store(tc.body)
		_, err := svc.TopUpInfo(context.Background())
		var appErr *kernel.AppError
		if !errors.As(err, &appErr) {
			t.Fatalf("status=%d expected *kernel.AppError, got %T (%v)", tc.status, err, err)
		}
		if appErr.Status != tc.wantStatus || appErr.Reason != tc.wantReason {
			t.Fatalf("status=%d got AppError{Status:%d, Reason:%q}, want Status:%d Reason:%q", tc.status, appErr.Status, appErr.Reason, tc.wantStatus, tc.wantReason)
		}
	}
	if got := svc.Status().State; got != StateRevoked {
		t.Fatalf("expected desktop_token_required to mark connection revoked, got %q", got)
	}
}
