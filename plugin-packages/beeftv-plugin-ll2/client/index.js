// BeefTV 内置插件：LL2 (DMC) 算力与视频渠道（beeftv-plugin-ll2）
// 通过 app.settings 插槽提供一键 BYOK 配置面板，将 LL2 API Key 与预置协议模型一键同步至宿主「设置 -> 模型服务」。

export const DEFAULT_BASE_URL = "https://api.ll2.cn";
export const LL2_CHANNEL_ID = "ll2";
export const LL2_CHANNEL_NAME = "LL2 (DMC)";

const DEFAULT_VIDEO_REFERENCES = {
  promptMaxChars: 2000,
  minImages: 0,
  maxImages: 9,
  maxImageBytes: 30 * 1024 * 1024,
  minImageWidth: 0,
  maxImageWidth: 0,
  minImageHeight: 0,
  maxImageHeight: 0,
  minImageAspectRatio: 0,
  maxImageAspectRatio: 0,
  minImagePixels: 0,
  maxImagePixels: 0,
  maxVideos: 3,
  maxVideoBytes: 200 * 1024 * 1024,
  minVideoDurationSeconds: 0,
  maxVideoDurationSeconds: 15,
  maxVideoTotalDurationSeconds: 0,
  minVideoWidth: 0,
  maxVideoWidth: 0,
  minVideoHeight: 0,
  maxVideoHeight: 0,
  minVideoAspectRatio: 0,
  maxVideoAspectRatio: 0,
  minVideoPixels: 0,
  maxVideoPixels: 0,
  minVideoFps: 0,
  maxVideoFps: 0,
  maxAudios: 3,
  maxAudioBytes: 15 * 1024 * 1024,
  minAudioDurationSeconds: 0,
  maxAudioDurationSeconds: 15,
  maxAudioTotalDurationSeconds: 0,
  maxTotalReferences: 0,
};

export const LL2_PRESET_MODELS = [
  {
    model: "deepseek-v4.1-flash",
    displayName: "DeepSeek V4.1 Flash",
    family: "DeepSeek 文本",
    capability: "text",
    protocol: "chat-completion",
    endpoint: "POST /v1/chat/completions",
    capabilityConfig: {
      version: 1,
      text: {
        references: { promptMaxChars: 12000, maxImages: 0, maxImageBytes: 0 },
        streaming: true,
        thinking: true,
      },
    },
  },
  {
    model: "doubao-seedance-2-0-fast",
    displayName: "Seedance 2.0 Fast",
    family: "Seedance 2.0",
    capability: "video",
    protocol: "ll2-seedance-video",
    endpoint: "POST /seedance/api/v3/contents/generations/tasks",
    capabilityConfig: {
      version: 1,
      video: {
        references: {
          ...DEFAULT_VIDEO_REFERENCES,
          minVideoDurationSeconds: 2,
          minAudioDurationSeconds: 2,
        },
        duration: { selection: "range", min: 4, max: 15, step: 1, default: 5 },
        ratios: ["16:9", "9:16", "4:3", "3:4", "1:1", "21:9", "adaptive"],
        defaultRatio: "16:9",
        resolutions: ["480p", "720p"],
        defaultResolution: "720p",
        generateAudio: { supported: true, default: true },
        watermark: { supported: true, default: false },
        returnLastFrame: { supported: true, default: false },
        operations: ["text_to_video", "image_to_video", "reference_to_video"],
        defaultOperation: "text_to_video",
      },
    },
  },
  {
    model: "doubao-seedance-2-0",
    displayName: "Seedance 2.0",
    family: "Seedance 2.0",
    capability: "video",
    protocol: "ll2-seedance-video",
    endpoint: "POST /seedance/api/v3/contents/generations/tasks",
    capabilityConfig: {
      version: 1,
      video: {
        references: {
          ...DEFAULT_VIDEO_REFERENCES,
          minVideoDurationSeconds: 2,
          minAudioDurationSeconds: 2,
        },
        duration: { selection: "range", min: 4, max: 15, step: 1, default: 5 },
        ratios: ["16:9", "9:16", "4:3", "3:4", "1:1", "21:9", "adaptive"],
        defaultRatio: "16:9",
        resolutions: ["480p", "720p"],
        defaultResolution: "720p",
        generateAudio: { supported: true, default: true },
        watermark: { supported: true, default: false },
        returnLastFrame: { supported: true, default: false },
        operations: ["text_to_video", "image_to_video", "reference_to_video"],
        defaultOperation: "text_to_video",
      },
    },
  },
  {
    model: "viduq3-turbo",
    displayName: "Vidu Q3 Turbo",
    family: "Vidu Q3",
    capability: "video",
    protocol: "ll2-vidu-video",
    endpoint: "POST /vidu/ent/v2/text2video",
    capabilityConfig: {
      version: 1,
      video: {
        references: {
          ...DEFAULT_VIDEO_REFERENCES,
          maxImages: 2,
          maxVideos: 0,
          maxAudios: 0,
        },
        duration: { selection: "range", min: 1, max: 16, step: 1, default: 5 },
        ratios: ["16:9", "9:16", "4:3", "3:4", "1:1"],
        defaultRatio: "16:9",
        resolutions: ["540p", "720p", "1080p"],
        defaultResolution: "720p",
        generateAudio: { supported: true, default: true },
        watermark: { supported: true, default: false },
        operations: ["text_to_video", "image_to_video"],
        defaultOperation: "text_to_video",
      },
    },
  },
  {
    model: "viduq3-pro",
    displayName: "Vidu Q3 Pro",
    family: "Vidu Q3",
    capability: "video",
    protocol: "ll2-vidu-video",
    endpoint: "POST /vidu/ent/v2/text2video",
    capabilityConfig: {
      version: 1,
      video: {
        references: {
          ...DEFAULT_VIDEO_REFERENCES,
          maxImages: 2,
          maxVideos: 0,
          maxAudios: 0,
        },
        duration: { selection: "range", min: 1, max: 16, step: 1, default: 5 },
        ratios: ["16:9", "9:16", "4:3", "3:4", "1:1"],
        defaultRatio: "16:9",
        resolutions: ["540p", "720p", "1080p"],
        defaultResolution: "720p",
        generateAudio: { supported: true, default: true },
        watermark: { supported: true, default: false },
        operations: ["text_to_video", "image_to_video"],
        defaultOperation: "text_to_video",
      },
    },
  },
  {
    model: "MiniMax-H3",
    displayName: "MiniMax H3",
    family: "MiniMax H3",
    capability: "video",
    protocol: "ll2-minimax-video",
    endpoint: "POST /v2/video_generation",
    capabilityConfig: {
      version: 1,
      video: {
        references: {
          ...DEFAULT_VIDEO_REFERENCES,
          maxVideoBytes: 50 * 1024 * 1024,
        },
        duration: {
          selection: "enum",
          values: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
          default: 5,
        },
        ratios: ["adaptive", "21:9", "16:9", "4:3", "1:1", "3:4", "9:16"],
        defaultRatio: "16:9",
        resolutions: ["768P"],
        defaultResolution: "768P",
        generateAudio: { supported: false, default: false },
        watermark: { supported: false, default: false },
        operations: ["text_to_video", "image_to_video", "reference_to_video"],
        defaultOperation: "text_to_video",
      },
    },
  },
  {
    model: "Super Vega 1.0-pro-mini",
    displayName: "Super Vega 1.0 Pro Mini",
    family: "Super Vega",
    capability: "video",
    protocol: "ll2-super-vega-video",
    endpoint: "POST /super-vega/tasks",
    capabilityConfig: {
      version: 1,
      video: {
        references: {
          ...DEFAULT_VIDEO_REFERENCES,
          maxImages: 7,
          maxVideos: 1,
          maxAudios: 0,
        },
        duration: { selection: "range", min: 4, max: 15, step: 1, default: 5 },
        ratios: ["16:9", "9:16", "4:3", "3:4", "1:1", "21:9"],
        defaultRatio: "16:9",
        resolutions: ["720P", "1080P"],
        defaultResolution: "720P",
        generateAudio: { supported: true, default: true },
        watermark: { supported: false, default: false },
        operations: ["text_to_video", "image_to_video", "reference_to_video"],
        defaultOperation: "text_to_video",
      },
    },
  },
  {
    model: "Super Vega 1.0-lite",
    displayName: "Super Vega 1.0 Lite",
    family: "Super Vega",
    capability: "video",
    protocol: "ll2-super-vega-video",
    endpoint: "POST /super-vega/tasks",
    capabilityConfig: {
      version: 1,
      video: {
        references: {
          ...DEFAULT_VIDEO_REFERENCES,
          maxImages: 7,
          maxVideos: 1,
          maxAudios: 0,
        },
        duration: { selection: "range", min: 4, max: 15, step: 1, default: 5 },
        ratios: ["16:9", "9:16", "4:3", "3:4", "1:1", "21:9"],
        defaultRatio: "16:9",
        resolutions: ["768P", "1080P"],
        defaultResolution: "768P",
        generateAudio: { supported: false, default: false },
        watermark: { supported: false, default: false },
        operations: ["text_to_video", "image_to_video", "reference_to_video"],
        defaultOperation: "text_to_video",
      },
    },
  },
  {
    model: "auto-hd",
    displayName: "Auto HD 视频超分",
    family: "Auto HD 超分",
    capability: "video",
    protocol: "ll2-auto-hd-video",
    endpoint: "POST /hd/tasks",
    defaultOptions: {
      testVideoUrl:
        "https://h3-gz-public-1483601991.cos.ap-guangzhou.myqcloud.com/outputs/f1303d6f8190c0dbc697b30b65c0eae1b648d4efa166e81689b4af735dbf6a6d.mp4",
    },
    capabilityConfig: {
      version: 1,
      video: {
        durationSupported: false,
        references: {
          ...DEFAULT_VIDEO_REFERENCES,
          maxImages: 0,
          maxVideos: 1,
          maxVideoBytes: 500 * 1024 * 1024,
          maxVideoDurationSeconds: 300,
          maxAudios: 0,
        },
        duration: { selection: "enum", values: [5], default: 5 },
        ratios: [],
        defaultRatio: "",
        resolutions: ["720p", "1080p", "2k", "4k"],
        defaultResolution: "1080p",
        generateAudio: { supported: false, default: false },
        watermark: { supported: false, default: false },
        operations: ["reference_to_video"],
        defaultOperation: "reference_to_video",
      },
    },
  },
];

function getReact(host) {
  if (host?.React) return host.React;
  if (host?.ui?.React) return host.ui.React;
  if (typeof window !== "undefined") {
    return window.__BEEFTV_REACT__ || window.React || null;
  }
  return null;
}

export function buildLL2ModelChannel({ apiKey, baseUrl, selectedModels }) {
  const cleanUrl = String(baseUrl || DEFAULT_BASE_URL).trim().replace(/\/+$/, "") || DEFAULT_BASE_URL;
  const cleanKey = String(apiKey || "").trim();
  const chosenSet = new Set(
    Array.isArray(selectedModels) && selectedModels.length
      ? selectedModels
      : LL2_PRESET_MODELS.map((item) => item.model),
  );
  const activePresets = LL2_PRESET_MODELS.filter((item) => chosenSet.has(item.model));
  const models = activePresets.map((item) => item.model);
  const modelProfiles = activePresets.map((item) => ({
    model: item.model,
    displayName: item.displayName,
    capability: item.capability,
    protocol: item.protocol,
    authType: "bearer",
    ...(item.defaultOptions ? { defaultOptions: item.defaultOptions } : {}),
    capabilityConfig: item.capabilityConfig,
  }));

  return {
    id: LL2_CHANNEL_ID,
    name: LL2_CHANNEL_NAME,
    scope: "user",
    baseUrl: cleanUrl,
    apiKey: cleanKey,
    hasApiKey: Boolean(cleanKey),
    apiFormat: "openai",
    models,
    modelProfiles,
  };
}

function createLL2SettingsPanel(host) {
  const React = getReact(host);
  if (!React) return () => null;
  const h = React.createElement;

  return function LL2SettingsPanel(props) {
    const existingChannel = React.useMemo(() => {
      try {
        const channels = host?.channels?.list?.() || [];
        return channels.find(
          (item) =>
            item.id === LL2_CHANNEL_ID ||
            String(item.baseUrl || "").includes("api.ll2.cn"),
        );
      } catch {
        return undefined;
      }
    }, []);

    const initialApiKey =
      props?.config?.apiKey ||
      host?.config?.get?.("apiKey", "") ||
      existingChannel?.apiKey ||
      "";
    const initialBaseUrl =
      props?.config?.baseUrl ||
      host?.config?.get?.("baseUrl", DEFAULT_BASE_URL) ||
      existingChannel?.baseUrl ||
      DEFAULT_BASE_URL;

    const [apiKey, setApiKey] = React.useState(String(initialApiKey));
    const [baseUrl, setBaseUrl] = React.useState(String(initialBaseUrl));
    const [showKey, setShowKey] = React.useState(false);
    const [selectedModels, setSelectedModels] = React.useState(() =>
      existingChannel?.models?.length
        ? existingChannel.models
        : LL2_PRESET_MODELS.map((item) => item.model),
    );
    const [catalogChecking, setCatalogChecking] = React.useState(false);
    const [saving, setSaving] = React.useState(false);
    const [onlineModels, setOnlineModels] = React.useState([]);
    const [synced, setSynced] = React.useState(
      Boolean(existingChannel?.hasApiKey || existingChannel?.apiKey),
    );
    const [statusMessage, setStatusMessage] = React.useState(
      existingChannel?.hasApiKey || existingChannel?.apiKey
        ? `已连接「${existingChannel.name}」渠道（已启用 ${existingChannel.models?.length || 0} 个模型）`
        : "",
    );
    const [errorMessage, setErrorMessage] = React.useState("");

    const toggleModel = (modelId) => {
      setSelectedModels((prev) =>
        prev.includes(modelId)
          ? prev.filter((item) => item !== modelId)
          : [...prev, modelId],
      );
    };

    const handleFetchCatalog = async () => {
      const trimmedKey = apiKey.trim();
      const trimmedUrl = baseUrl.trim().replace(/\/+$/, "") || DEFAULT_BASE_URL;
      if (!trimmedKey) {
        setErrorMessage("请先填写 LL2 API Key");
        return;
      }
      setCatalogChecking(true);
      setErrorMessage("");
      try {
        let ids = [];
        if (typeof host?.channels?.fetchCatalog === "function") {
          const catalog = await host.channels.fetchCatalog({
            baseUrl: trimmedUrl,
            apiKey: trimmedKey,
            apiFormat: "openai",
          });
          ids = Array.isArray(catalog?.models) ? catalog.models : [];
        } else {
          const resp = await fetch("/api/ai/models", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              baseUrl: trimmedUrl,
              apiKey: trimmedKey,
              apiFormat: "openai",
            }),
          });
          const data = await resp.json().catch(() => ({}));
          if (!resp.ok || (typeof data?.code === "number" && data.code !== 0)) {
            throw new Error(
              data?.msg || data?.error || `读取在线目录失败（HTTP ${resp.status}）`,
            );
          }
          const rawModels = Array.isArray(data?.data?.models)
            ? data.data.models
            : Array.isArray(data?.models)
              ? data.models
              : [];
          ids = rawModels
            .map((item) => (typeof item === "string" ? item : item?.id))
            .filter(Boolean);
        }
        setOnlineModels(ids);
        setStatusMessage(`在线目录验证成功：共发现 ${ids.length} 个上游模型`);
      } catch (err) {
        setErrorMessage(err instanceof Error ? err.message : "读取在线目录失败");
      } finally {
        setCatalogChecking(false);
      }
    };

    const handleSaveAndSync = async () => {
      const trimmedKey = apiKey.trim();
      const trimmedUrl = baseUrl.trim().replace(/\/+$/, "") || DEFAULT_BASE_URL;
      if (!trimmedKey) {
        setErrorMessage("请填写有效的 LL2 API Key（sk-...）");
        return;
      }
      if (!selectedModels.length) {
        setErrorMessage("请至少勾选 1 个要同步的模型");
        return;
      }
      setSaving(true);
      setErrorMessage("");
      try {
        const patch = { apiKey: trimmedKey, baseUrl: trimmedUrl };
        if (typeof props?.updateConfig === "function") {
          await props.updateConfig(patch);
        } else if (host?.config?.set) {
          await host.config.set(patch);
        }
        const channel = buildLL2ModelChannel({
          apiKey: trimmedKey,
          baseUrl: trimmedUrl,
          selectedModels,
        });
        if (!host?.channels?.upsert) {
          throw new Error("当前宿主版本不支持同步模型渠道");
        }
        await host.channels.upsert(channel);
        setSynced(true);
        setStatusMessage(
          `已将「${LL2_CHANNEL_NAME}」与 ${channel.models.length} 个模型同步至「设置 -> 模型服务」！`,
        );
        host?.ui?.notify?.("LL2 渠道与模型已同步至模型服务", "success");
      } catch (err) {
        setErrorMessage(err instanceof Error ? err.message : "保存并同步渠道失败");
      } finally {
        setSaving(false);
      }
    };

    return h(
      "div",
      {
        style: {
          display: "flex",
          flexDirection: "column",
          gap: "16px",
          padding: "4px 0",
        },
      },
      // 顶部品牌介绍卡片
      h(
        "div",
        {
          style: {
            borderRadius: "12px",
            border: "1px solid rgba(59, 130, 246, 0.22)",
            background:
              "linear-gradient(135deg, rgba(59, 130, 246, 0.08) 0%, rgba(16, 185, 129, 0.05) 100%)",
            padding: "14px 16px",
          },
        },
        h(
          "div",
          {
            style: {
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "12px",
              marginBottom: "6px",
            },
          },
          h(
            "div",
            { style: { fontWeight: 600, fontSize: "14px" } },
            "LL2 (DMC) 算力与视频渠道 · BYOK 一键接入",
          ),
          h(
            "span",
            {
              style: {
                fontSize: "11px",
                padding: "2px 8px",
                borderRadius: "999px",
                background: "rgba(16, 185, 129, 0.14)",
                color: "#059669",
                fontWeight: 600,
              },
            },
            "官方内置插件",
          ),
        ),
        h(
          "p",
          {
            style: {
              margin: 0,
              fontSize: "12px",
              opacity: 0.75,
              lineHeight: 1.6,
            },
          },
          "只需填写一个 LL2 API Key，即可一键配置 DeepSeek V4.1、Seedance 2.0、Vidu Q3、MiniMax H3、Super Vega 1.0 与 Auto HD 视频超分共 6 套模型协议，不改动 BeefTV 原有默认模型配置。",
        ),
      ),

      // 表单区
      h(
        "div",
        {
          style: {
            display: "grid",
            gridTemplateColumns: "1fr",
            gap: "12px",
          },
        },
        h(
          "div",
          { style: { display: "flex", flexDirection: "column", gap: "6px" } },
          h(
            "label",
            {
              htmlFor: "ll2-plugin-base-url",
              style: { fontSize: "12px", fontWeight: 600 },
            },
            "接口地址 (Base URL)",
          ),
          h("input", {
            id: "ll2-plugin-base-url",
            type: "text",
            value: baseUrl,
            onChange: (e) => setBaseUrl(e.target.value),
            placeholder: DEFAULT_BASE_URL,
            style: {
              width: "100%",
              padding: "8px 12px",
              borderRadius: "8px",
              border: "1px solid rgba(128,128,128,0.28)",
              background: "transparent",
              fontSize: "13px",
              fontFamily: "monospace",
            },
          }),
        ),
        h(
          "div",
          { style: { display: "flex", flexDirection: "column", gap: "6px" } },
          h(
            "label",
            {
              htmlFor: "ll2-plugin-api-key",
              style: { fontSize: "12px", fontWeight: 600 },
            },
            "LL2 API Key",
          ),
          h(
            "div",
            { style: { display: "flex", gap: "8px" } },
            h("input", {
              id: "ll2-plugin-api-key",
              "aria-label": "LL2 API Key",
              type: showKey ? "text" : "password",
              value: apiKey,
              onChange: (e) => setApiKey(e.target.value),
              placeholder: "sk-...",
              style: {
                flex: 1,
                padding: "8px 12px",
                borderRadius: "8px",
                border: "1px solid rgba(128,128,128,0.28)",
                background: "transparent",
                fontSize: "13px",
                fontFamily: "monospace",
              },
            }),
            h(
              "button",
              {
                type: "button",
                onClick: () => setShowKey((v) => !v),
                style: {
                  padding: "0 12px",
                  borderRadius: "8px",
                  border: "1px solid rgba(128,128,128,0.28)",
                  background: "transparent",
                  fontSize: "12px",
                  cursor: "pointer",
                },
              },
              showKey ? "隐藏" : "显示",
            ),
            h(
              "button",
              {
                type: "button",
                disabled: catalogChecking,
                onClick: handleFetchCatalog,
                style: {
                  padding: "0 12px",
                  borderRadius: "8px",
                  border: "1px solid rgba(59, 130, 246, 0.35)",
                  background: "rgba(59, 130, 246, 0.08)",
                  color: "#2563eb",
                  fontSize: "12px",
                  fontWeight: 500,
                  cursor: catalogChecking ? "wait" : "pointer",
                },
              },
              catalogChecking ? "验证中..." : "验证在线目录",
            ),
          ),
        ),
      ),

      // 预置模型与协议映射清单
      h(
        "div",
        {
          style: {
            display: "flex",
            flexDirection: "column",
            gap: "8px",
          },
        },
        h(
          "div",
          {
            style: {
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
            },
          },
          h(
            "span",
            { style: { fontSize: "12px", fontWeight: 600 } },
            `预置协议模型（已选 ${selectedModels.length} / ${LL2_PRESET_MODELS.length}）`,
          ),
          h(
            "button",
            {
              type: "button",
              onClick: () =>
                setSelectedModels(
                  selectedModels.length === LL2_PRESET_MODELS.length
                    ? []
                    : LL2_PRESET_MODELS.map((item) => item.model),
                ),
              style: {
                border: "none",
                background: "transparent",
                color: "#2563eb",
                fontSize: "12px",
                cursor: "pointer",
              },
            },
            selectedModels.length === LL2_PRESET_MODELS.length ? "取消全选" : "全选模型",
          ),
        ),
        h(
          "div",
          {
            style: {
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))",
              gap: "8px",
            },
          },
          LL2_PRESET_MODELS.map((item) => {
            const checked = selectedModels.includes(item.model);
            const isOnline =
              onlineModels.includes(item.model) ||
              onlineModels.some((m) =>
                String(m).toLowerCase().endsWith(item.model.toLowerCase()),
              );
            return h(
              "label",
              {
                key: item.model,
                style: {
                  display: "flex",
                  alignItems: "flex-start",
                  gap: "8px",
                  padding: "8px 10px",
                  borderRadius: "8px",
                  border: checked
                    ? "1px solid rgba(59, 130, 246, 0.45)"
                    : "1px solid rgba(128, 128, 128, 0.2)",
                  background: checked ? "rgba(59, 130, 246, 0.05)" : "transparent",
                  cursor: "pointer",
                  fontSize: "12px",
                },
              },
              h("input", {
                type: "checkbox",
                checked,
                onChange: () => toggleModel(item.model),
                style: { marginTop: "3px" },
              }),
              h(
                "div",
                { style: { flex: 1, minWidth: 0 } },
                h(
                  "div",
                  {
                    style: {
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: "4px",
                      fontWeight: 600,
                    },
                  },
                  h("span", null, item.displayName),
                  h(
                    "span",
                    {
                      style: {
                        fontSize: "10px",
                        padding: "1px 6px",
                        borderRadius: "4px",
                        background:
                          item.capability === "text"
                            ? "rgba(59, 130, 246, 0.12)"
                            : "rgba(139, 92, 246, 0.12)",
                        color: item.capability === "text" ? "#2563eb" : "#7c3aed",
                      },
                    },
                    item.capability === "text" ? "文本" : "视频",
                  ),
                ),
                h(
                  "div",
                  {
                    style: {
                      fontSize: "11px",
                      opacity: 0.65,
                      fontFamily: "monospace",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    },
                  },
                  `${item.model} · ${item.endpoint}`,
                ),
                isOnline
                  ? h(
                      "div",
                      { style: { fontSize: "10px", color: "#059669", marginTop: "2px" } },
                      "● 上游目录已确认在线",
                    )
                  : null,
              ),
            );
          }),
        ),
      ),

      // 状态反馈区
      errorMessage
        ? h(
            "div",
            {
              role: "alert",
              style: {
                padding: "10px 12px",
                borderRadius: "8px",
                background: "rgba(239, 68, 68, 0.1)",
                border: "1px solid rgba(239, 68, 68, 0.3)",
                color: "#dc2626",
                fontSize: "12px",
              },
            },
            errorMessage,
          )
        : null,
      statusMessage
        ? h(
            "div",
            {
              style: {
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: "12px",
                padding: "10px 12px",
                borderRadius: "8px",
                background: "rgba(16, 185, 129, 0.1)",
                border: "1px solid rgba(16, 185, 129, 0.3)",
                color: "#059669",
                fontSize: "12px",
              },
            },
            h("span", null, statusMessage),
            synced
              ? h(
                  "button",
                  {
                    type: "button",
                    onClick: () => host?.ui?.navigate?.("/settings?section=channels"),
                    style: {
                      padding: "4px 10px",
                      borderRadius: "6px",
                      border: "1px solid rgba(16, 185, 129, 0.4)",
                      background: "rgba(16, 185, 129, 0.12)",
                      color: "#047857",
                      fontSize: "12px",
                      fontWeight: 600,
                      cursor: "pointer",
                      whiteSpace: "nowrap",
                    },
                  },
                  "前往模型服务查看与测试 →",
                )
              : null,
          )
        : null,

      // 底部操作按钮
      h(
        "div",
        {
          style: {
            display: "flex",
            justifyContent: "flex-end",
            gap: "10px",
            paddingTop: "4px",
          },
        },
        h(
          "button",
          {
            type: "button",
            disabled: saving,
            onClick: handleSaveAndSync,
            style: {
              padding: "8px 18px",
              borderRadius: "8px",
              border: "none",
              background: "#2563eb",
              color: "#ffffff",
              fontSize: "13px",
              fontWeight: 600,
              cursor: saving ? "wait" : "pointer",
            },
          },
          saving ? "同步中..." : "一键保存并同步到模型服务",
        ),
      ),
    );
  };
}

export function activate(host) {
  const SettingsPanel = createLL2SettingsPanel(host);
  const dispose = host.contribute("app.settings", {
    id: "ll2-settings",
    label: "LL2 算力与视频渠道",
    component: SettingsPanel,
  });
  return () => {
    if (typeof dispose === "function") dispose();
  };
}

export default { activate };
