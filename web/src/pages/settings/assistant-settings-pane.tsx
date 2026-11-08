import { Alert, App, Button, Switch } from "antd";
import { useEffect, useState } from "react";

import { getAssistantSettings, updateAssistantSettings } from "@/services/api/assistant-settings";

export function AssistantSettingsPane() {
    const { message } = App.useApp();
    const [enabled, setEnabled] = useState(false);
    const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading");
    const [loadError, setLoadError] = useState("");
    const [reloadKey, setReloadKey] = useState(0);
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        let cancelled = false;
        setLoadState("loading");
        setLoadError("");
        getAssistantSettings()
            .then((settings) => {
                if (cancelled) return;
                setEnabled(settings.skillScriptAutoRun);
                setLoadState("ready");
            })
            .catch((error) => {
                if (cancelled) return;
                // 读取失败时不能沿用默认 OFF，否则会把实际已开启的设置显示成需要确认。
                setLoadState("error");
                setLoadError(error instanceof Error ? error.message : "读取助手设置失败");
            });
        return () => { cancelled = true; };
    }, [reloadKey]);

    const toggle = async (checked: boolean) => {
        setSaving(true);
        try {
            const settings = await updateAssistantSettings({ skillScriptAutoRun: checked });
            setEnabled(settings.skillScriptAutoRun);
            message.success(settings.skillScriptAutoRun ? "已开启自动运行技能脚本" : "已关闭自动运行技能脚本");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "保存助手设置失败");
        } finally {
            setSaving(false);
        }
    };

    return (
        <section className="settings-section storage-settings-block space-y-4" aria-label="技能脚本设置">
            <div className="settings-pane-header">
                <div className="min-w-0">
                    <h2>技能脚本</h2>
                </div>
            </div>
            {loadState === "error" ? (
                <Alert
                    type="error"
                    showIcon
                    title="读取助手设置失败，暂时无法修改。"
                    description={loadError}
                    action={<Button onClick={() => setReloadKey((key) => key + 1)}>重试</Button>}
                />
            ) : null}
            <div className="flex items-center justify-between gap-4">
                <div className="min-w-0 space-y-1">
                    <div className="text-sm font-medium">自动运行技能脚本</div>
                    <p className="text-sm leading-6 text-foreground/60">
                        打开后，助手运行技能里的脚本前不再询问。脚本在技能副本里运行，拿不到你的 API Key。
                    </p>
                </div>
                <Switch
                    checked={enabled}
                    loading={loadState === "loading" || saving}
                    disabled={loadState !== "ready" || saving}
                    aria-label="自动运行技能脚本"
                    onChange={(checked) => void toggle(checked)}
                />
            </div>
        </section>
    );
}
