import { Checkbox, InputNumber, Segmented, Select } from "antd";

import { Switch } from "@/components/ui/base/switch";
import type { canvasThemes } from "@/lib/canvas-theme";
import {
    resolveSmartEraseCapabilityOptions,
    SMART_ERASE_MODE_SPECS,
    type PrivacyProtectModel,
    type PrivacyTarget,
    type SmartEraseControlState,
    type SmartEraseType,
    type SubtitleEraseCapabilities,
    type SubtitleEraseFormat,
    type SubtitleEraseMethod,
    type SubtitleEraseModel,
    type WatermarkEraseModel,
} from "@/services/api/video-subtitle-erase";

export type { SmartEraseControlState };

type CanvasTheme = (typeof canvasThemes)[keyof typeof canvasThemes];

export const SMART_ERASE_TYPE_LABELS: Record<SmartEraseType, string> = {
    subtitle: SMART_ERASE_MODE_SPECS.subtitle.label,
    watermark: SMART_ERASE_MODE_SPECS.watermark.label,
    privacy: SMART_ERASE_MODE_SPECS.privacy.label,
};

export const SUBTITLE_MODEL_LABELS: Record<SubtitleEraseModel, string> = {
    standard: "标准无痕",
    area: "花字增强",
    mega: "大模型精擦",
};

export const WATERMARK_MODEL_LABELS: Record<WatermarkEraseModel, string> = {
    advanced: "高级去水印",
    basic: "基础去水印",
};

export const PRIVACY_MODEL_LABELS: Record<PrivacyProtectModel, string> = {
    blur: "高斯模糊",
    mosaic: "马赛克",
};

export const PRIVACY_TARGET_LABELS: Record<PrivacyTarget, string> = {
    face: "人脸",
    plate: "车牌",
};

export const TRANSLATE_LANG_LABELS: Record<string, string> = {
    en: "英语 (en)",
    ja: "日语 (ja)",
    ko: "韩语 (ko)",
    zh: "简体中文 (zh)",
    fr: "法语 (fr)",
    de: "德语 (de)",
    es: "西班牙语 (es)",
    pt: "葡萄牙语 (pt)",
    ru: "俄语 (ru)",
    it: "意大利语 (it)",
    tr: "土耳其语 (tr)",
    ar: "阿拉伯语 (ar)",
    th: "泰语 (th)",
    vi: "越南语 (vi)",
    id: "印尼语 (id)",
    ms: "马来语 (ms)",
    hi: "印地语 (hi)",
};

export const TRANSLATE_LANG_OPTIONS: Array<{ value: string; label: string }> = Object.entries(TRANSLATE_LANG_LABELS).map(
    ([value, label]) => ({ value, label }),
);

type VideoSmartEraseControlsProps = {
    theme: CanvasTheme;
    capabilities: SubtitleEraseCapabilities | null;
    state: SmartEraseControlState;
    onChange: (patch: Partial<SmartEraseControlState>) => void;
    onSnapFullWidthSubtitle?: () => void;
};

export function VideoSmartEraseControls({
    theme,
    capabilities,
    state,
    onChange,
    onSnapFullWidthSubtitle,
}: VideoSmartEraseControlsProps) {
    const resolved = resolveSmartEraseCapabilityOptions(capabilities);
    const {
        eraseTypes,
        eraseMethods,
        subtitleModels,
        watermarkModels,
        privacyModels,
        privacyTargets,
        subtitleLangs,
        subtitleFormats,
    } = resolved;
    const translateLangOptions = resolved.translateDstLangs.map((code) => ({
        value: code,
        label: TRANSLATE_LANG_LABELS[code] || code,
    }));

    const togglePrivacyTarget = (target: PrivacyTarget) => {
        const exists = state.privacyTargets.includes(target);
        if (exists && state.privacyTargets.length <= 1) return;
        const next = exists ? state.privacyTargets.filter((item) => item !== target) : [...state.privacyTargets, target];
        onChange({ privacyTargets: next });
    };

    return (
        <div className="space-y-3.5">
            {eraseTypes.length > 1 ? (
                <div className="space-y-1.5">
                    <div className="text-xs font-medium">处理类型</div>
                    <Segmented
                        block
                        value={state.eraseType}
                        options={eraseTypes.map((type) => ({ label: SMART_ERASE_TYPE_LABELS[type] || type, value: type }))}
                        onChange={(value) => {
                            const nextType = value as SmartEraseType;
                            onChange({
                                eraseType: nextType,
                                ...(nextType === "subtitle" && state.subtitleModel === "mega" ? { eraseMethod: "auto" } : {}),
                            });
                        }}
                    />
                </div>
            ) : null}

            {state.eraseType === "subtitle" ? (
                <>
                    <div className="grid gap-3 sm:grid-cols-2">
                        <div className="space-y-1.5">
                            <div className="text-xs font-medium">消除强度</div>
                            <Segmented
                                block
                                value={state.subtitleModel}
                                options={subtitleModels.map((model) => ({ label: SUBTITLE_MODEL_LABELS[model] || model, value: model }))}
                                onChange={(value) => {
                                    const nextModel = value as SubtitleEraseModel;
                                    onChange({
                                        subtitleModel: nextModel,
                                        ...(nextModel === "mega" ? { eraseMethod: "auto", ocrExtract: false, translate: false } : {}),
                                    });
                                }}
                            />
                            <p className="text-xs leading-relaxed" style={{ color: theme.node.muted }}>
                                {state.subtitleModel === "standard"
                                    ? "适合常规对白硬字幕，保留原画面背景细节。"
                                    : state.subtitleModel === "area"
                                      ? "适合综艺花字、大号特效字或带底色条的字幕。"
                                      : "大模型全画面精修复杂花字，自动扫描全幅画面。"}
                            </p>
                        </div>

                        <div className="space-y-1.5">
                            <div className="flex items-center justify-between gap-2">
                                <span className="text-xs font-medium">识别范围</span>
                                {state.subtitleModel !== "mega" && state.eraseMethod === "custom" && onSnapFullWidthSubtitle ? (
                                    <button
                                        type="button"
                                        className="text-xs underline transition-opacity hover:opacity-80"
                                        style={{ color: theme.accent.primary }}
                                        onClick={onSnapFullWidthSubtitle}
                                    >
                                        铺满底部通栏
                                    </button>
                                ) : null}
                            </div>
                            <Segmented
                                block
                                disabled={state.subtitleModel === "mega"}
                                value={state.subtitleModel === "mega" ? "auto" : state.eraseMethod}
                                options={eraseMethods.map((method) => ({
                                    label: method === "auto" ? "自动识别字幕" : "框选字幕区域",
                                    value: method,
                                }))}
                                onChange={(value) => onChange({ eraseMethod: value as SubtitleEraseMethod })}
                            />
                            <p className="text-xs leading-relaxed" style={{ color: theme.node.muted }}>
                                {state.subtitleModel === "mega"
                                    ? "大模型精擦固定采用全画面自动识别，无需手动框选。"
                                    : state.eraseMethod === "auto"
                                      ? "自动识别中下部常见字幕；贴边长字幕或顶部字幕可切换框选。"
                                      : "拖动或拉满白色选框覆盖字幕（支持左右贴满全宽），仅消除框内文字。"}
                            </p>
                        </div>
                    </div>

                    {state.subtitleModel !== "mega" && state.eraseMethod === "auto" ? (
                        <div
                            className="space-y-2.5 rounded-[var(--r-md)] border px-3.5 py-2.5"
                            style={{ background: theme.node.panel, borderColor: theme.node.edge }}
                        >
                            <div className="flex flex-wrap items-center justify-between gap-3">
                                <div>
                                    <div className="text-xs font-medium">提取字幕与 AI 翻译</div>
                                    <div className="text-xs" style={{ color: theme.node.muted }}>
                                        消除硬字幕的同时导出时间轴字幕文件，可在结果节点的「字幕」面板查看与下载
                                    </div>
                                </div>
                                <div className="flex items-center gap-4 text-xs">
                                    <label className="inline-flex cursor-pointer items-center gap-1.5">
                                        <span>提取原文字幕</span>
                                        <Switch
                                            size="sm"
                                            checked={state.ocrExtract || state.translate}
                                            onChange={(checked) => onChange({ ocrExtract: checked, ...(!checked ? { translate: false } : {}) })}
                                        />
                                    </label>
                                    <label className="inline-flex cursor-pointer items-center gap-1.5">
                                        <span>AI 翻译</span>
                                        <Switch
                                            size="sm"
                                            checked={state.translate}
                                            onChange={(checked) => onChange({ translate: checked, ...(checked ? { ocrExtract: true } : {}) })}
                                        />
                                    </label>
                                </div>
                            </div>

                            {state.ocrExtract || state.translate ? (
                                <div className="grid gap-2.5 border-t pt-2.5 sm:grid-cols-3" style={{ borderColor: theme.node.edge }}>
                                    <div className="space-y-1">
                                        <div className="text-xs" style={{ color: theme.node.muted }}>原字幕语种</div>
                                        <Segmented
                                            block
                                            size="small"
                                            value={state.subtitleLang}
                                            options={subtitleLangs.map((lang) => ({
                                                label: lang === "zh_en" ? "中英" : lang === "multi" ? "多语种" : lang,
                                                value: lang,
                                            }))}
                                            onChange={(value) => onChange({ subtitleLang: String(value) })}
                                        />
                                    </div>
                                    <div className="space-y-1">
                                        <div className="text-xs" style={{ color: theme.node.muted }}>导出格式</div>
                                        <Segmented
                                            block
                                            size="small"
                                            value={state.subtitleFormat}
                                            options={subtitleFormats.map((fmt) => ({
                                                label: fmt.toUpperCase(),
                                                value: fmt,
                                            }))}
                                            onChange={(value) => onChange({ subtitleFormat: value as SubtitleEraseFormat })}
                                        />
                                    </div>
                                    {state.translate ? (
                                        <div className="space-y-1">
                                            <div className="text-xs" style={{ color: theme.node.muted }}>翻译目标语种</div>
                                            <Select
                                                size="small"
                                                className="w-full"
                                                value={state.translateDstLang}
                                                options={translateLangOptions}
                                                onChange={(value) => onChange({ translateDstLang: value })}
                                            />
                                        </div>
                                    ) : null}
                                </div>
                            ) : null}

                            {state.translate ? (
                                <div className="space-y-2 pt-0.5 text-xs">
                                    <button
                                        type="button"
                                        className="underline transition-opacity hover:opacity-80"
                                        style={{ color: theme.node.muted }}
                                        onClick={() => onChange({ embedAdvancedOpen: !state.embedAdvancedOpen })}
                                    >
                                        {state.embedAdvancedOpen ? "收起云端压制模板设置" : "高级：指定云端字幕压制模板（可选）"}
                                    </button>
                                    {state.embedAdvancedOpen ? (
                                        <div className="flex flex-wrap items-center gap-3 pt-1">
                                            <label className="inline-flex items-center gap-1.5">
                                                <span style={{ color: theme.node.muted }}>模板 ID</span>
                                                <InputNumber
                                                    size="small"
                                                    min={1}
                                                    precision={0}
                                                    placeholder="不填则仅导出字幕文件"
                                                    value={state.subtitleEmbedId}
                                                    onChange={(val) => onChange({ subtitleEmbedId: typeof val === "number" && val > 0 ? val : null })}
                                                    className="w-40"
                                                />
                                            </label>
                                            {state.subtitleEmbedId ? (
                                                <>
                                                    <Checkbox
                                                        checked={state.useOriginalPos}
                                                        onChange={(e) => onChange({ useOriginalPos: e.target.checked })}
                                                    >
                                                        <span className="text-xs">沿用原字幕位置</span>
                                                    </Checkbox>
                                                    <Checkbox
                                                        checked={state.useOriginalSize}
                                                        onChange={(e) => onChange({ useOriginalSize: e.target.checked })}
                                                    >
                                                        <span className="text-xs">沿用原字幕字号</span>
                                                    </Checkbox>
                                                </>
                                            ) : null}
                                        </div>
                                    ) : null}
                                </div>
                            ) : null}
                        </div>
                    ) : null}
                </>
            ) : null}

            {state.eraseType === "watermark" ? (
                <div className="grid gap-3 sm:grid-cols-2">
                    <div className="space-y-1.5">
                        <div className="text-xs font-medium">识别范围</div>
                        <Segmented
                            block
                            value={state.eraseMethod}
                            options={eraseMethods.map((method) => ({
                                label: method === "auto" ? "自动识别水印" : "框选水印区域",
                                value: method,
                            }))}
                            onChange={(value) => onChange({ eraseMethod: value as SubtitleEraseMethod })}
                        />
                        <p className="text-xs leading-relaxed" style={{ color: theme.node.muted }}>
                            {state.eraseMethod === "auto"
                                ? "自动检测画面常见台标、角标与固定浮水印。"
                                : "拖动或缩放白色选框覆盖需要擦除的角标或水印区域。"}
                        </p>
                    </div>

                    <div className="space-y-1.5">
                        <div className="text-xs font-medium">消除模式</div>
                        <Segmented
                            block
                            value={state.watermarkModel}
                            options={watermarkModels.map((model) => ({ label: WATERMARK_MODEL_LABELS[model] || model, value: model }))}
                            onChange={(value) => onChange({ watermarkModel: value as WatermarkEraseModel })}
                        />
                        <p className="text-xs leading-relaxed" style={{ color: theme.node.muted }}>
                            {state.watermarkModel === "advanced"
                                ? "结合前后帧纹理修补复杂动态背景下的水印。"
                                : "适合边缘清晰、背景简单的半透明静态角标。"}
                        </p>
                    </div>
                </div>
            ) : null}

            {state.eraseType === "privacy" ? (
                <div className="grid gap-3 sm:grid-cols-2">
                    <div className="space-y-1.5">
                        <div className="text-xs font-medium">打码样式</div>
                        <Segmented
                            block
                            value={state.privacyModel}
                            options={privacyModels.map((model) => ({ label: PRIVACY_MODEL_LABELS[model] || model, value: model }))}
                            onChange={(value) => onChange({ privacyModel: value as PrivacyProtectModel })}
                        />
                        <p className="text-xs leading-relaxed" style={{ color: theme.node.muted }}>
                            {state.privacyModel === "blur"
                                ? "对识别到的目标施加柔和自然的高斯模糊遮挡。"
                                : "对识别到的目标施加经典像素马赛克遮挡。"}
                        </p>
                    </div>

                    <div className="space-y-1.5">
                        <div className="text-xs font-medium">保护目标（可多选）</div>
                        <div className="grid grid-cols-2 gap-2">
                            {privacyTargets.map((target) => {
                                const active = state.privacyTargets.includes(target);
                                return (
                                    <button
                                        key={target}
                                        type="button"
                                        aria-pressed={active}
                                        onClick={() => togglePrivacyTarget(target)}
                                        className="rounded-[var(--r-md)] border px-3 py-1.5 text-xs font-medium transition-opacity"
                                        style={{
                                            background: active ? theme.accent.primarySoft : theme.node.panel,
                                            borderColor: active ? theme.accent.primary : theme.node.edge,
                                            color: active ? theme.accent.primary : theme.node.text,
                                        }}
                                    >
                                        {PRIVACY_TARGET_LABELS[target] || target}
                                    </button>
                                );
                            })}
                        </div>
                        <p className="text-xs leading-relaxed" style={{ color: theme.node.muted }}>
                            自动检测并全程跟踪画面中的人物面部或车牌号，保留原视频声音。
                        </p>
                    </div>
                </div>
            ) : null}
        </div>
    );
}
