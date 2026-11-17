import { App, Button, InputNumber } from "antd";
import { AlipayCircleOutlined, CreditCardOutlined, WechatOutlined } from "@ant-design/icons";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useBeefTVConnection } from "@/components/layout/beeftv-connection-provider";
import { AppModal } from "@/components/ui/product/app-modal";
import {
    beefTVConnectionLabel,
    getBeefTVConnectionEpoch,
    getBeefTVTopUpInfo,
    isBeefTVAuthenticated,
    reconcileBeefTVTopUp,
    startBeefTVTopUpCheckout,
    type BeefTVTopUpCheckoutResult,
    type BeefTVTopUpInfo,
} from "@/services/api/beeftv-connection";

type PaymentMethodKey = "wxpay" | "alipay" | "card";
type PaymentOption = { key: PaymentMethodKey; label: string; icon: typeof WechatOutlined };
type TopUpLoadState = "idle" | "loading" | "ready" | "error";

const DEFAULT_CNY_PRESETS = [50, 100, 200, 500];
const DEFAULT_USD_PRESETS = [5, 10, 20, 50];
const ALL_PAYMENT_OPTIONS: readonly PaymentOption[] = [
    { key: "wxpay", label: "微信支付", icon: WechatOutlined },
    { key: "alipay", label: "支付宝", icon: AlipayCircleOutlined },
    { key: "card", label: "国际银行卡", icon: CreditCardOutlined },
];

const formatMoney = (value: number) => value.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function pendingTopUpStorageKey(accountId?: string) {
    return accountId ? `beeftv:pending-topup:${accountId}` : "";
}

function readStoredPendingOrder(accountId?: string): BeefTVTopUpCheckoutResult | null {
    const key = pendingTopUpStorageKey(accountId);
    if (!key || typeof window === "undefined") return null;
    try {
        const raw = window.sessionStorage.getItem(key);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as Partial<BeefTVTopUpCheckoutResult>;
        if (typeof parsed?.tradeNo !== "string" || !parsed.tradeNo.trim() || !parsed.amount?.value || !parsed.credit?.value) {
            return null;
        }
        return {
            tradeNo: parsed.tradeNo.trim(),
            paymentMethod: String(parsed.paymentMethod || "wxpay"),
            fxRate: parsed.fxRate,
            amount: { currency: String(parsed.amount.currency || "CNY"), value: String(parsed.amount.value) },
            credit: { currency: String(parsed.credit.currency || "CNY"), value: String(parsed.credit.value) },
            opened: Boolean(parsed.opened),
            openError: parsed.openError,
        };
    } catch {
        return null;
    }
}

function writeStoredPendingOrder(accountId: string | undefined, order: BeefTVTopUpCheckoutResult | null) {
    const key = pendingTopUpStorageKey(accountId);
    if (!key || typeof window === "undefined") return;
    try {
        if (!order) window.sessionStorage.removeItem(key);
        else window.sessionStorage.setItem(key, JSON.stringify(order));
    } catch { /* ignore storage quota or privacy mode */ }
}

function formatBalanceDisplay(connected: boolean, balance?: string, balanceCny?: string) {
    if (!connected) return "—";
    if (balanceCny && /^\d+(?:\.\d{2})?$/.test(balanceCny)) {
        const parsed = Number(balanceCny);
        if (Number.isFinite(parsed)) return `¥ ${formatMoney(parsed)}`;
    }
    if (balance === "zero") return "¥ 0.00";
    return "—";
}

export function AccountBalancePane() {
    const { message } = App.useApp();
    const account = useBeefTVConnection();
    const { connection, busy, balanceRefreshFailed } = account;
    const connected = isBeefTVAuthenticated(connection);
    const pending = connection?.state === "pending" || connection?.state === "connecting";
    const accountId = connection?.account?.id;
    const name = connection?.account?.display_name || connection?.account?.username || connection?.account?.email || "BeefTV 账户";

    const accountRef = useRef(account);
    accountRef.current = account;
    const messageRef = useRef(message);
    messageRef.current = message;
    const accountIdRef = useRef(accountId);
    accountIdRef.current = accountId;

    const [topUpInfo, setTopUpInfo] = useState<BeefTVTopUpInfo | null>(null);
    const [topUpState, setTopUpState] = useState<TopUpLoadState>("idle");
    const [reloadSeq, setReloadSeq] = useState(0);
    const [method, setMethod] = useState<PaymentMethodKey>("wxpay");
    const [cnySelection, setCnySelection] = useState<number | "custom">(100);
    const [cnyCustom, setCnyCustom] = useState<number | null>(null);
    const [usdSelection, setUsdSelection] = useState<number | "custom">(10);
    const [usdCustom, setUsdCustom] = useState<number | null>(null);
    const [checkoutOpen, setCheckoutOpen] = useState(false);
    const [modalMode, setModalMode] = useState<"confirm" | "waiting">("confirm");
    const [submitting, setSubmitting] = useState(false);
    const [checkingOrder, setCheckingOrder] = useState(false);
    const [pendingOrder, setPendingOrder] = useState<BeefTVTopUpCheckoutResult | null>(null);
    const [orderHint, setOrderHint] = useState("");
    const reconcileBusy = useRef(false);
    const activeTradeNoRef = useRef<string | null>(null);
    const autoReconcileAbortRef = useRef<AbortController | null>(null);
    const manualReconcileAbortRef = useRef<AbortController | null>(null);

    const abortAllReconciles = useCallback(() => {
        autoReconcileAbortRef.current?.abort();
        autoReconcileAbortRef.current = null;
        manualReconcileAbortRef.current?.abort();
        manualReconcileAbortRef.current = null;
    }, []);

    const updatePendingOrder = useCallback((next: BeefTVTopUpCheckoutResult | null) => {
        activeTradeNoRef.current = next?.tradeNo ?? null;
        setPendingOrder(next);
        writeStoredPendingOrder(accountIdRef.current, next);
    }, []);

    useEffect(() => {
        if (!connected) {
            abortAllReconciles();
            activeTradeNoRef.current = null;
            setTopUpInfo(null);
            setTopUpState("idle");
            setPendingOrder(null);
            setCheckoutOpen(false);
            setModalMode("confirm");
            setOrderHint("");
            return;
        }
        const restored = readStoredPendingOrder(accountId);
        activeTradeNoRef.current = restored?.tradeNo ?? null;
        setPendingOrder(restored);
    }, [connected, accountId, abortAllReconciles]);

    useEffect(() => {
        if (!connected) return;
        const controller = new AbortController();
        const epoch = getBeefTVConnectionEpoch();
        const seq = accountRef.current.getMutationSeq();
        setTopUpState("loading");
        void accountRef.current.refreshBalance();
        void getBeefTVTopUpInfo(controller.signal)
            .then((info) => {
                if (controller.signal.aborted || epoch !== getBeefTVConnectionEpoch()) return;
                setTopUpInfo(info);
                setTopUpState("ready");
                if (info.balanceCny) {
                    accountRef.current.applyBalanceCnyIfCurrent(seq, info.balanceCny);
                }
            })
            .catch(() => {
                if (!controller.signal.aborted && epoch === getBeefTVConnectionEpoch()) {
                    setTopUpInfo(null);
                    setTopUpState("error");
                }
            });
        return () => controller.abort();
    }, [connected, accountId, reloadSeq]);

    const availableMethods = useMemo<PaymentOption[]>(() => {
        if (!connected) return [...ALL_PAYMENT_OPTIONS];
        if (topUpState !== "ready" || !topUpInfo) return [];
        const enabled = new Set<PaymentMethodKey>();
        if (topUpInfo.enableOnlineTopup) {
            for (const item of topUpInfo.payMethods || []) {
                if (item.type === "wxpay" || item.type === "alipay") enabled.add(item.type);
            }
        }
        if (topUpInfo.enableCardTopup) enabled.add("card");
        return ALL_PAYMENT_OPTIONS.filter((opt) => enabled.has(opt.key));
    }, [connected, topUpState, topUpInfo]);

    useEffect(() => {
        if (availableMethods.length > 0 && !availableMethods.some((item) => item.key === method)) {
            setMethod(availableMethods[0].key);
        }
    }, [availableMethods, method]);

    const isCard = method === "card";
    const cnyMin = Math.max(1, topUpInfo?.minTopup || 20);
    const cnyMax = Math.max(cnyMin, topUpInfo?.maxTopup || 100000);
    const usdMin = Math.max(1, topUpInfo?.card?.minAmount || 5);
    const usdMax = Math.max(usdMin, topUpInfo?.card?.maxAmount || 10000);
    const usdRate = Number(topUpInfo?.card?.usdCnyRate || 0);

    const cnyPresets = useMemo(() => {
        const raw = topUpInfo?.amountOptions?.length ? topUpInfo.amountOptions : DEFAULT_CNY_PRESETS;
        const filtered = raw.filter((v) => Number.isInteger(v) && v >= cnyMin && v <= cnyMax).slice(0, 4);
        return filtered.length ? filtered : DEFAULT_CNY_PRESETS.filter((v) => v >= cnyMin);
    }, [topUpInfo, cnyMin, cnyMax]);

    const usdPresets = useMemo(() => DEFAULT_USD_PRESETS.filter((v) => v >= usdMin && v <= usdMax), [usdMin, usdMax]);

    const bonusTiers = useMemo(() => {
        if (!topUpInfo?.bonusEnabled || !Array.isArray(topUpInfo.bonusTiers)) return [];
        return [...topUpInfo.bonusTiers].filter((t) => t.threshold > 0 && t.bonus > 0).sort((a, b) => a.threshold - b.threshold);
    }, [topUpInfo]);

    const computeBonus = (cnyValue: number) => {
        let matched = 0;
        for (const tier of bonusTiers) {
            if (cnyValue >= tier.threshold) matched = tier.bonus;
        }
        return matched;
    };

    const selectedAmount = isCard ? (usdSelection === "custom" ? usdCustom : usdSelection) : (cnySelection === "custom" ? cnyCustom : cnySelection);
    const validAmount = typeof selectedAmount === "number" && Number.isFinite(selectedAmount) && (
        isCard
            ? selectedAmount >= usdMin && selectedAmount <= usdMax && Math.round(selectedAmount * 100) === Number((selectedAmount * 100).toFixed(4))
            : Number.isInteger(selectedAmount) && selectedAmount >= cnyMin && selectedAmount <= cnyMax
    );
    const estimatedCardCNY = isCard && validAmount && usdRate > 0 ? Number((selectedAmount * usdRate).toFixed(2)) : 0;
    const matchedBonus = validAmount ? computeBonus(isCard ? estimatedCardCNY : selectedAmount) : 0;
    const currencySymbol = isCard ? "$" : "¥";
    const serviceClosed = connected && topUpState === "ready" && availableMethods.length === 0;
    const rechargeReady = connected && topUpState === "ready" && availableMethods.length > 0;
    const hasPendingOrder = pendingOrder !== null;
    const showingWaitingOrder = modalMode === "waiting" && pendingOrder !== null;

    const runReconcile = useCallback(async (tradeNo: string, manual: boolean) => {
        if (!tradeNo || activeTradeNoRef.current !== tradeNo) return;
        if (manual) {
            autoReconcileAbortRef.current?.abort();
            autoReconcileAbortRef.current = null;
            if (manualReconcileAbortRef.current) return;
            setCheckingOrder(true);
        } else if (reconcileBusy.current || manualReconcileAbortRef.current) {
            return;
        }
        reconcileBusy.current = true;
        const controller = new AbortController();
        if (manual) manualReconcileAbortRef.current = controller;
        else autoReconcileAbortRef.current = controller;
        const epoch = getBeefTVConnectionEpoch();
        try {
            const result = await reconcileBeefTVTopUp(tradeNo, controller.signal);
            if (controller.signal.aborted || epoch !== getBeefTVConnectionEpoch() || activeTradeNoRef.current !== tradeNo) {
                return;
            }
            if (result.connection) accountRef.current.applySummary(result.connection);
            if (result.status === "success") {
                if (result.settled || result.credited) {
                    updatePendingOrder(null);
                    setCheckoutOpen(false);
                    setModalMode("confirm");
                    setOrderHint("");
                    messageRef.current.success("充值已到账，账户余额已更新");
                    return;
                }
                setOrderHint(result.message || "订单已完成支付，正在同步入账额度，请稍候…");
                return;
            }
            if (result.status === "expired") {
                updatePendingOrder(null);
                setModalMode("confirm");
                setOrderHint("当前充值订单已超时关闭，请重新发起支付。");
                return;
            }
            if (manual) {
                setOrderHint(result.message || "暂未收到支付成功通知，如已完成付款请稍候，系统会自动同步余额。");
            }
        } catch (error) {
            if (!controller.signal.aborted && manual) {
                messageRef.current.error(error instanceof Error ? error.message : "查询支付结果失败，请稍后重试");
            }
        } finally {
            if (manual && manualReconcileAbortRef.current === controller) {
                manualReconcileAbortRef.current = null;
            }
            if (!manual && autoReconcileAbortRef.current === controller) {
                autoReconcileAbortRef.current = null;
            }
            reconcileBusy.current = Boolean(manualReconcileAbortRef.current || autoReconcileAbortRef.current);
            if (manual) setCheckingOrder(false);
        }
    }, [updatePendingOrder]);

    useEffect(() => {
        if (!connected || !pendingOrder?.tradeNo) return;
        const tradeNo = pendingOrder.tradeNo;
        let stopped = false;
        let attempts = 0;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const tick = async () => {
            if (stopped || activeTradeNoRef.current !== tradeNo) return;
            if (document.visibilityState !== "hidden") {
                attempts += 1;
                await runReconcile(tradeNo, false);
            }
            if (!stopped && activeTradeNoRef.current === tradeNo && attempts < 45) {
                timer = setTimeout(() => void tick(), 4000);
            }
        };
        timer = setTimeout(() => void tick(), 3000);
        const onVisible = () => {
            if (document.visibilityState === "visible" && activeTradeNoRef.current === tradeNo) {
                void runReconcile(tradeNo, false);
            }
        };
        window.addEventListener("focus", onVisible);
        document.addEventListener("visibilitychange", onVisible);
        return () => {
            stopped = true;
            clearTimeout(timer);
            autoReconcileAbortRef.current?.abort();
            autoReconcileAbortRef.current = null;
            window.removeEventListener("focus", onVisible);
            document.removeEventListener("visibilitychange", onVisible);
        };
    }, [connected, pendingOrder?.tradeNo, runReconcile]);

    const handlePay = async (resumeTradeNo?: string) => {
        if (submitting) return;
        if (!resumeTradeNo && (!rechargeReady || !validAmount || hasPendingOrder)) return;
        setSubmitting(true);
        setOrderHint("");
        abortAllReconciles();
        try {
            const payload = resumeTradeNo
                ? { paymentMethod: (pendingOrder?.paymentMethod as PaymentMethodKey) || method, tradeNo: resumeTradeNo }
                : isCard
                    ? { paymentMethod: "card" as const, amountUsd: selectedAmount!.toFixed(2) }
                    : { paymentMethod: method, amount: selectedAmount! };
            const created = await startBeefTVTopUpCheckout(payload);
            updatePendingOrder(created);
            setModalMode("waiting");
            if (!created.opened) {
                const errHint = created.openError || "无法自动打开系统浏览器，请点击“重新打开支付页”继续付款。";
                setOrderHint(errHint);
                messageRef.current.warning(errHint);
            } else {
                setOrderHint("已在系统浏览器打开支付收银台，完成付款后将自动刷新账户余额。");
            }
        } catch (error) {
            messageRef.current.error(error instanceof Error ? error.message : "拉起支付失败，请稍后重试");
        } finally {
            setSubmitting(false);
        }
    };

    const dismissModal = () => {
        if (submitting) return;
        setCheckoutOpen(false);
        if (!showingWaitingOrder) {
            setOrderHint("");
        }
    };

    const abandonPendingOrder = () => {
        abortAllReconciles();
        updatePendingOrder(null);
        setModalMode("confirm");
        setOrderHint("");
    };

    const activeMethodKey = showingWaitingOrder ? pendingOrder.paymentMethod : method;
    const currentMethodLabel = ALL_PAYMENT_OPTIONS.find((item) => item.key === activeMethodKey)?.label || "在线支付";
    const displayedBalanceCny = connection?.balanceCny;

    return <>
        <div className="account-balance-identity">
            <div><h3>{connected ? name : "登录 BeefTV"}</h3>
                {connected && connection?.account?.email && name !== connection.account.email ? <p>{connection.account.email}</p> : null}
                {connection?.state !== "connected" ? <p role="status" aria-live="polite">{beefTVConnectionLabel(connection)}</p> : null}
            </div>
            {!connected ? <Button loading={busy} disabled={pending} onClick={() => void account.connect()}>{pending ? "等待授权" : "登录"}</Button> : null}
        </div>
        {pending ? <div className="account-login-actions">
            {connection?.verificationUri ? <Button onClick={() => { void navigator.clipboard.writeText(connection.verificationUri!).then(() => message.success("授权地址已复制")).catch(() => message.error("复制失败，请重试")); }}>复制授权地址</Button> : null}
            <Button loading={busy} onClick={() => void account.cancel()}>取消本次登录</Button>
        </div> : null}
        <div className="account-balance-overview">
            <div><span className="account-balance-label">可用余额</span><div className="account-balance-value">{formatBalanceDisplay(connected, connection?.balance, displayedBalanceCny)}</div>
                {!connected ? <p>登录后查看账户余额</p> : balanceRefreshFailed && topUpState !== "ready" ? <p role="status">余额同步失败，当前展示上次记录</p> : connection?.balance === "zero" || displayedBalanceCny === "0.00" ? <p>充值后即可使用</p> : null}
            </div>
            <Button disabled={!connected || busy} onClick={() => void account.openAccount()}>余额与用量</Button>
        </div>
        <section className="account-recharge" aria-labelledby="account-recharge-title">
            <div className="account-recharge-heading">
                <h3 id="account-recharge-title">账户充值</h3>
                {connected && topUpState === "loading" ? <span>正在读取充值配置…</span> : serviceClosed ? <span>维护中</span> : bonusTiers.length > 0 ? <span>充值满赠活动进行中</span> : null}
            </div>
            {connected && topUpState === "error" ? (
                <div className="account-topup-status" role="alert">
                    <span>充值配置读取失败，请重试后再发起支付</span>
                    <Button size="small" onClick={() => setReloadSeq((seq) => seq + 1)}>重试</Button>
                </div>
            ) : null}
            {connected && pendingOrder && !checkoutOpen ? (
                <div className="account-pending-order" role="status">
                    <div>
                        <strong>待确认订单 {pendingOrder.tradeNo}</strong>
                        <span>{pendingOrder.amount.currency === "USD" ? "$" : "¥"} {formatMoney(Number(pendingOrder.amount.value))}</span>
                    </div>
                    <div className="account-pending-order-actions">
                        <Button size="small" onClick={abandonPendingOrder}>放弃跟踪</Button>
                        <Button size="small" type="primary" onClick={() => { setModalMode("waiting"); setCheckoutOpen(true); }}>继续查看</Button>
                    </div>
                </div>
            ) : null}
            <div className="account-recharge-options" role="group" aria-label="充值金额">
                {(isCard ? usdPresets : cnyPresets).map((value) => (
                    <button
                        type="button"
                        key={`${currencySymbol}-${value}`}
                        aria-pressed={(isCard ? usdSelection : cnySelection) === value}
                        onClick={() => { if (isCard) setUsdSelection(value); else setCnySelection(value); }}
                    >
                        <span>{currencySymbol} {value}</span>
                        {!isCard && computeBonus(value) > 0 ? <small>+赠 ¥{computeBonus(value)}</small> : null}
                    </button>
                ))}
                <button
                    type="button"
                    aria-pressed={(isCard ? usdSelection : cnySelection) === "custom"}
                    onClick={() => { if (isCard) setUsdSelection("custom"); else setCnySelection("custom"); }}
                >
                    自定义
                </button>
            </div>
            {(isCard ? usdSelection : cnySelection) === "custom" ? (
                <label className="account-custom-amount">
                    <span>{isCard ? `充值金额（$${usdMin}–$${usdMax}）` : `充值金额（最低 ¥${cnyMin}，整数）`}</span>
                    <InputNumber
                        aria-label="自定义充值金额"
                        prefix={currencySymbol}
                        value={isCard ? usdCustom : cnyCustom}
                        min={isCard ? usdMin : cnyMin}
                        max={isCard ? usdMax : cnyMax}
                        precision={isCard ? 2 : 0}
                        placeholder={isCard ? `最低 ${usdMin}` : `最低 ${cnyMin}`}
                        controls={false}
                        onChange={(val) => { if (isCard) setUsdCustom(val); else setCnyCustom(val); }}
                    />
                </label>
            ) : null}
            {availableMethods.length > 0 ? (
                <div className="account-payment-section">
                    <h3>支付方式</h3>
                    <PaymentMethodPicker options={availableMethods} value={method} onChange={setMethod} />
                </div>
            ) : null}
            <div className="account-recharge-total">
                <div>
                    <span>支付金额</span>
                    <strong>{currencySymbol} {validAmount ? formatMoney(selectedAmount!) : "—"}</strong>
                    {hasPendingOrder ? <span className="account-recharge-hint">请先完成或放弃上方待确认订单</span> : isCard && estimatedCardCNY > 0 ? <span className="account-recharge-hint">预计到账 ¥ {formatMoney(estimatedCardCNY + matchedBonus)}</span> : matchedBonus > 0 ? <span className="account-recharge-hint">含赠送 ¥ {formatMoney(matchedBonus)}</span> : null}
                </div>
                <Button
                    type="primary"
                    disabled={!rechargeReady || !validAmount || serviceClosed || hasPendingOrder}
                    onClick={() => {
                        setModalMode("confirm");
                        setOrderHint("");
                        setCheckoutOpen(true);
                    }}
                >
                    充值
                </Button>
            </div>
        </section>
        <AppModal
            open={checkoutOpen}
            title={showingWaitingOrder ? "等待支付确认" : "确认充值"}
            width={440}
            className="account-checkout-modal"
            onCancel={dismissModal}
            footer={showingWaitingOrder ? (
                <div className="account-checkout-actions">
                    <Button onClick={dismissModal}>稍后查看</Button>
                    <Button loading={submitting} onClick={() => void handlePay(pendingOrder.tradeNo)}>重新打开支付页</Button>
                    <Button type="primary" loading={checkingOrder} onClick={() => void runReconcile(pendingOrder.tradeNo, true)}>我已完成支付</Button>
                </div>
            ) : (
                <div className="account-checkout-actions">
                    <Button disabled={submitting} onClick={dismissModal}>返回修改</Button>
                    <Button type="primary" loading={submitting} disabled={!rechargeReady || !validAmount || hasPendingOrder} onClick={() => void handlePay()}>立即支付</Button>
                </div>
            )}
        >
            <div className="account-checkout-content">
                <div className="account-checkout-amount">
                    <span>支付金额</span>
                    <strong>{showingWaitingOrder ? `${pendingOrder.amount.currency === "USD" ? "$" : "¥"} ${formatMoney(Number(pendingOrder.amount.value))}` : `${currencySymbol} ${validAmount ? formatMoney(selectedAmount!) : "—"}`}</strong>
                </div>
                <dl>
                    <div><dt>充值账户</dt><dd>{name}</dd></div>
                    {showingWaitingOrder ? (
                        <>
                            <div><dt>支付方式</dt><dd>{currentMethodLabel}</dd></div>
                            <div><dt>到账额度</dt><dd>¥ {formatMoney(Number(pendingOrder.credit.value))}</dd></div>
                            <div><dt>充值单号</dt><dd>{pendingOrder.tradeNo}</dd></div>
                        </>
                    ) : isCard && estimatedCardCNY > 0 ? (
                        <div><dt>预计到账</dt><dd>¥ {formatMoney(estimatedCardCNY + matchedBonus)}</dd></div>
                    ) : matchedBonus > 0 ? (
                        <div><dt>预计到账</dt><dd>¥ {formatMoney(selectedAmount! + matchedBonus)}（含赠 ¥{formatMoney(matchedBonus)}）</dd></div>
                    ) : null}
                </dl>
                {!showingWaitingOrder ? (
                    <div className="account-checkout-method">
                        <span>支付方式</span>
                        <PaymentMethodPicker options={availableMethods} value={method} onChange={setMethod} />
                    </div>
                ) : null}
                <p role="status">{orderHint || "点击立即支付后将在系统浏览器打开收银台完成付款。"}</p>
            </div>
        </AppModal>
    </>;
}

function PaymentMethodPicker({ options, value, onChange }: { options: readonly PaymentOption[]; value: PaymentMethodKey; onChange: (value: PaymentMethodKey) => void }) {
    return <div className="account-payment-methods" role="group" aria-label="支付方式">
        {options.map(({ key, label, icon: Icon }) => (
            <button type="button" key={key} aria-pressed={value === key} onClick={() => onChange(key)}>
                <Icon aria-hidden="true" /><span>{label}</span>
            </button>
        ))}
    </div>;
}
