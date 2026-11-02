import { createRoot } from "react-dom/client";
import { App, ConfigProvider } from "antd";
import { getAntThemeConfig } from "../../src/lib/app-theme";
import { ModelServiceEditor } from "../../src/pages/settings/model-service-editor";
import { createModelChannel, useConfigStore, type ModelChannel } from "../../src/stores/use-config-store";

// 场景用 query 切换，避免为每种凭证类型重复一份构建。
const scenario = new URLSearchParams(location.search).get("scenario") || "ark-none";

function initialChannel(): ModelChannel {
    if (scenario === "jimeng") {
        return createModelChannel({
            name: "即梦视频",
            baseUrl: "https://visual.volcengineapi.com",
            models: ["jimeng_t2v_v30"],
            modelProfiles: [{ model: "jimeng_t2v_v30", capability: "video", protocol: "volcengine-jimeng-video", authType: "volcengine-v4" }],
        });
    }
    if (scenario === "jimeng-saved") {
        // 外部工作区回读配置就是这个样子：密钥被清成空串，另由后端回 hasSecretKey 说明存过。
        return createModelChannel({
            name: "即梦视频",
            baseUrl: "https://visual.volcengineapi.com",
            models: ["jimeng_t2v_v30"],
            modelProfiles: [{ model: "jimeng_t2v_v30", capability: "video", protocol: "volcengine-jimeng-video", authType: "volcengine-v4" }],
            hasApiKey: true,
            hasSecretKey: true,
        });
    }
    if (scenario === "jimeng-switched") {
        // 已保存的普通 API Key 连接：后端只有 apiKey，没有 SK 可沿用，现在改成了即梦协议。
        return createModelChannel({
            name: "即梦视频",
            baseUrl: "https://visual.volcengineapi.com",
            models: ["jimeng_t2v_v30"],
            modelProfiles: [{ model: "jimeng_t2v_v30", capability: "video", protocol: "volcengine-jimeng-video", authType: "volcengine-v4" }],
            hasApiKey: true,
        });
    }
    if (scenario === "ark-legacy-text") {
        // 旧连接：文本模型没有 profile（协议会在保存时补成预设协议），视频已经是 Agent Plan。
        return createModelChannel({
            name: "火山方舟",
            baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
            models: ["doubao-seed", "doubao-seedance-2.5"],
            modelProfiles: [{ model: "doubao-seedance-2.5", capability: "video", protocol: "volcengine-ark-agent-plan-video", authType: "bearer" }],
        });
    }
    if (scenario === "agent-plan") {
        return createModelChannel({
            name: "方舟 Agent Plan",
            baseUrl: "https://ark.cn-beijing.volces.com/api/plan/v3",
            models: ["doubao-seedance-2.5"],
            modelProfiles: [{ model: "doubao-seedance-2.5", capability: "video", protocol: "volcengine-ark-agent-plan-video", authType: "bearer" }],
        });
    }
    if (scenario === "ark-mixed") {
        return createModelChannel({
            name: "火山方舟",
            baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
            models: ["doubao-seedance-2.5", "doubao-seedance-2.0"],
            modelProfiles: [
                { model: "doubao-seedance-2.5", capability: "video", protocol: "volcengine-ark-video", authType: "bearer" },
                { model: "doubao-seedance-2.0", capability: "video", protocol: "volcengine-ark-agent-plan-video", authType: "bearer" },
            ],
        });
    }
    if (scenario === "ark-native") {
        return createModelChannel({
            name: "火山方舟",
            baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
            models: ["doubao-seedance-2.5"],
            modelProfiles: [{ model: "doubao-seedance-2.5", capability: "video", protocol: "volcengine-ark-video", authType: "bearer" }],
        });
    }
    if (scenario === "compatible-seedance") {
        return createModelChannel({
            name: "第三方模型服务",
            baseUrl: "https://relay.example.com/v1",
            apiKey: "synthetic-key",
            models: ["doubao-seedance-2-0-260128", "doubao-seedance-2-0-fast-260128"],
        });
    }
    return createModelChannel({ name: "火山方舟", baseUrl: "https://ark.cn-beijing.volces.com/api/v3", models: [] });
}

const dark = new URLSearchParams(location.search).get("theme") === "dark";
const channel = initialChannel();
// 这两个场景是「打开一条已存在的连接」：把它放进配置里，编辑器才会走管理分支。
if (scenario.startsWith("jimeng-saved") || scenario === "jimeng-switched") {
    const current = useConfigStore.getState().config;
    useConfigStore.setState({ config: { ...current, channels: [channel] } });
}
// 保存结果回写给测试：没有这一步，浏览器用例只能证明文字出现，证明不了行为。
const saved: Array<{ apiKey: string; secretKey?: string; models: string[]; profiles: Array<{ model: string; capability: string }> }> = [];
(globalThis as unknown as { __saved: typeof saved }).__saved = saved;

createRoot(document.getElementById("root")!).render(
    <ConfigProvider theme={getAntThemeConfig(dark)}>
        <App>
            <ModelServiceEditor initial={channel} onClose={() => {}} onSave={async (savedChannel) => { saved.push({ apiKey: savedChannel.apiKey, secretKey: savedChannel.secretKey, models: savedChannel.models, profiles: (savedChannel.modelProfiles || []).map((profile) => ({ model: profile.model, capability: profile.capability })) }); }} />
        </App>
    </ConfigProvider>,
);
