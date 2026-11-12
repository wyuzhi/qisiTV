import { App, Button, InputNumber } from "antd";
import { AlipayCircleOutlined, CreditCardOutlined, WechatOutlined } from "@ant-design/icons";
import { useState } from "react";

import { useBeefTVConnection } from "@/components/layout/beeftv-connection-provider";
import { AppModal } from "@/components/ui/product/app-modal";
import { beefTVConnectionLabel, isBeefTVAuthenticated } from "@/services/api/beeftv-connection";

const rechargeAmounts = [50, 100, 200, 500];
const paymentMethods = [
    { label: "微信支付", icon: WechatOutlined },
    { label: "支付宝", icon: AlipayCircleOutlined },
    { label: "国际银行卡", icon: CreditCardOutlined },
] as const;
const formatAmount = (value: number) => value.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function AccountBalancePane() {
    const { message } = App.useApp();
    const account = useBeefTVConnection();
    const { connection, busy } = account;
    const connected = isBeefTVAuthenticated(connection);
    const pending = connection?.state === "pending" || connection?.state === "connecting";
    const name = connection?.account?.display_name || connection?.account?.username || connection?.account?.email || "BeefTV 账户";
    const [selection, setSelection] = useState<number | "custom">(100);
    const [customAmount, setCustomAmount] = useState<number | null>(null);
    const [method, setMethod] = useState<string>("微信支付");
    const [checkout, setCheckout] = useState<{ amount: number } | null>(null);
    const amount = selection === "custom" ? customAmount : selection;
    const validAmount = typeof amount === "number" && Number.isFinite(amount) && amount >= 0.01;

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
            <div><span className="account-balance-label">可用余额</span><div className="account-balance-value">{connected && connection?.balance === "zero" ? "¥ 0.00" : "—"}</div>
                {!connected ? <p>登录后查看账户余额</p> : connection?.balance === "zero" ? <p>充值后即可使用</p> : null}
            </div>
            <Button disabled={!connected || busy} onClick={() => void account.openAccount()}>余额与用量</Button>
        </div>
        <section className="account-recharge" aria-labelledby="account-recharge-title">
            <div className="account-recharge-heading"><h3 id="account-recharge-title">账户充值</h3><span>暂未开放</span></div>
            <div className="account-recharge-options" role="group" aria-label="充值金额">
                {rechargeAmounts.map((value) => <button type="button" key={value} aria-pressed={selection === value} onClick={() => setSelection(value)}>¥ {value}</button>)}
                <button type="button" aria-pressed={selection === "custom"} onClick={() => setSelection("custom")}>自定义</button>
            </div>
            {selection === "custom" ? <label className="account-custom-amount"><span>充值金额</span><InputNumber aria-label="自定义充值金额" prefix="¥" value={customAmount} min={0.01} precision={2} placeholder="输入金额" controls={false} onChange={setCustomAmount} /></label> : null}
            <div className="account-payment-section"><h3>支付方式</h3><PaymentMethodPicker value={method} onChange={setMethod} /></div>
            <div className="account-recharge-total"><div><span>支付金额</span><strong>¥ {validAmount ? formatAmount(amount!) : "—"}</strong></div>
                <Button type="primary" disabled={!connected || !validAmount} onClick={() => { if (validAmount) setCheckout({ amount: amount! }); }}>充值</Button>
            </div>
        </section>
        <AppModal open={Boolean(checkout)} title="确认充值" width={440} className="account-checkout-modal" onCancel={() => setCheckout(null)} footer={<div className="account-checkout-actions"><Button onClick={() => setCheckout(null)}>返回修改</Button><Button type="primary" disabled>支付暂未开放</Button></div>}>
            {checkout ? <div className="account-checkout-content">
                <div className="account-checkout-amount"><span>支付金额</span><strong>¥ {formatAmount(checkout.amount)}</strong></div>
                <dl><div><dt>充值账户</dt><dd>{name}</dd></div></dl>
                <div className="account-checkout-method"><span>支付方式</span><PaymentMethodPicker value={method} onChange={setMethod} /></div>
                <p role="status">充值服务暂未开放，当前不会产生扣款。</p>
            </div> : null}
        </AppModal>
    </>;
}

function PaymentMethodPicker({ value, onChange }: { value: string; onChange: (value: string) => void }) {
    return <div className="account-payment-methods" role="group" aria-label="支付方式">
        {paymentMethods.map(({ label, icon: Icon }) => <button type="button" key={label} aria-pressed={value === label} onClick={() => onChange(label)}><Icon aria-hidden="true" /><span>{label}</span></button>)}
    </div>;
}
