// BeefTV 预装官方插件市场：通过 pluginCenter.section 插槽在插件中心挂载「插件市场」栏。
// 支持「精选推荐」（联网读取 GitHub raw，断网或超时自动回退内置离线副本）与「npm 社区搜索」（keywords:beeftv-plugin），
// 点击安装或更新时统一调用宿主确认框，不由市场插件自行绕过确认。

const REMOTE_REGISTRY_URL =
  "https://raw.githubusercontent.com/Sunnyender-org/beeftv-plugins/main/registry.json";
const LOCAL_FALLBACK_URL =
  "/api/plugins/beeftv-plugin-market/files/registry.json";

const REGISTRY_MIRRORS = [
  {
    value: "https://registry.npmmirror.com",
    label: "国内镜像（npmmirror，默认）",
  },
  {
    value: "https://registry.npmjs.org",
    label: "npm 官方源（npmjs.org）",
  },
];

const EMBEDDED_FALLBACK_PLUGINS = [
  {
    id: "beeftv-plugin-ecommerce-hero",
    packageName: "beeftv-plugin-ecommerce-hero",
    name: "一键商品主图",
    version: "0.1.0",
    description:
      "上传商品图并选择场景图数量，自动编排电商主图画布节点、助手工具与生成技能。",
    author: "BeefTV",
    category: "电商创作",
    recommended: true,
    tags: ["画布节点", "助手工具", "技能", "电商"],
    localSource: "plugin-packages/beeftv-plugin-ecommerce-hero",
  },
  {
    id: "beeftv-plugin-sticky-note",
    packageName: "beeftv-plugin-sticky-note",
    name: "画布便签",
    version: "0.1.0",
    description:
      "在画布上放置可换色、可编辑的便签卡片，并支持创作助手直接创建和修改便签。",
    author: "BeefTV",
    category: "画布效率",
    recommended: true,
    tags: ["画布节点", "助手工具"],
    localSource: "plugin-packages/beeftv-plugin-sticky-note",
  },
  {
    id: "beeftv-plugin-aihubkit-video",
    packageName: "beeftv-plugin-aihubkit-video",
    name: "AIHubKit 视频渠道",
    version: "1.0.0",
    description:
      "接入 AIHubKit 统一视频生成与轮询协议，作为可插拔视频模型渠道使用。",
    author: "Community",
    category: "模型渠道",
    recommended: true,
    tags: ["视频协议", "异步轮询"],
    localSource: "plugin-packages/beeftv-plugin-aihubkit-video",
  },
  {
    id: "beeftv-plugin-slot-test",
    packageName: "beeftv-plugin-slot-test",
    name: "全插槽演示插件",
    version: "0.1.0",
    description:
      "完整演示 BeefTV 全部 21 个界面扩展位与 8 类宿主事件的标准参考插件。",
    author: "BeefTV",
    category: "开发示例",
    recommended: false,
    tags: ["开发模板", "全插槽"],
    localSource: "plugin-packages/beeftv-plugin-slot-test",
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

async function fetchWithTimeout(url, timeoutMs = 3000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function loadCuratedRegistry() {
  try {
    const remote = await fetchWithTimeout(REMOTE_REGISTRY_URL, 3000);
    if (Array.isArray(remote?.plugins) && remote.plugins.length > 0) {
      return { plugins: remote.plugins, source: "remote" };
    }
  } catch {
    // 断网、超时或远端尚未创建时平滑回退到内置离线副本
  }
  try {
    const local = await fetchWithTimeout(LOCAL_FALLBACK_URL, 2000);
    if (Array.isArray(local?.plugins) && local.plugins.length > 0) {
      return { plugins: local.plugins, source: "offline-file" };
    }
  } catch {
    // 静态文件不可达时回退到内存常量
  }
  return { plugins: EMBEDDED_FALLBACK_PLUGINS, source: "offline-embedded" };
}

async function searchNpmPlugins(query) {
  const trimmed = String(query || "").trim();
  const apiUrl = `/api/plugins/market/search?q=${encodeURIComponent(trimmed)}`;
  try {
    const res = await fetchWithTimeout(apiUrl, 8000);
    const items = Array.isArray(res?.data)
      ? res.data
      : Array.isArray(res?.results)
        ? res.results
        : Array.isArray(res)
          ? res
          : null;
    if (items) return items;
  } catch {
    // 后端搜索代理不可用时回退到直接请求 npmjs 搜索接口
  }
  const searchText = `keywords:beeftv-plugin${trimmed ? ` ${trimmed}` : ""}`;
  const npmUrl = `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(searchText)}&size=20`;
  const body = await fetchWithTimeout(npmUrl, 8000);
  return (body?.objects || []).map((entry) => {
    const pkg = entry?.package || {};
    return {
      id: pkg.name,
      packageName: pkg.name,
      name: pkg.name,
      version: pkg.version || "0.1.0",
      description: pkg.description || "社区发布的 BeefTV 插件包",
      author: pkg.publisher?.username || pkg.author?.name || "Community",
      category: "社区插件",
      tags: Array.isArray(pkg.keywords) ? pkg.keywords : ["beeftv-plugin"],
      homepage: pkg.links?.homepage || pkg.links?.repository || pkg.links?.npm || "",
      repository: pkg.links?.repository || "",
    };
  });
}

export function activate(host) {
  const React = getReact(host);
  if (!React) return;
  const h = React.createElement;

  function PluginMarketView(props) {
    const [activeTab, setActiveTab] = React.useState("curated");
    const [registryMirror, setRegistryMirror] = React.useState(
      REGISTRY_MIRRORS[0].value,
    );
    const [curatedPlugins, setCuratedPlugins] = React.useState(
      EMBEDDED_FALLBACK_PLUGINS,
    );
    const [curatedSource, setCuratedSource] = React.useState("offline");
    const [loadingCurated, setLoadingCurated] = React.useState(false);

    const [searchQuery, setSearchQuery] = React.useState("");
    const [searchResults, setSearchResults] = React.useState([]);
    const [searching, setSearching] = React.useState(false);
    const [searchError, setSearchError] = React.useState("");

    const [selectedPlugin, setSelectedPlugin] = React.useState(null);
    const [detailReadme, setDetailReadme] = React.useState("");
    const [loadingReadme, setLoadingReadme] = React.useState(false);

    const installedMap = React.useMemo(() => {
      const map = new Map();
      const list = Array.isArray(props?.installedPlugins)
        ? props.installedPlugins
        : [];
      for (const item of list) {
        const id = item?.id || item?.manifest?.id || item?.packageName;
        const version = item?.version || item?.manifest?.version;
        if (id) map.set(id, { version, item });
      }
      return map;
    }, [props?.installedPlugins]);

    React.useEffect(() => {
      let cancelled = false;
      setLoadingCurated(true);
      loadCuratedRegistry()
        .then((result) => {
          if (cancelled) return;
          setCuratedPlugins(result.plugins);
          setCuratedSource(result.source);
        })
        .finally(() => {
          if (!cancelled) setLoadingCurated(false);
        });
      return () => {
        cancelled = true;
      };
    }, []);

    const handleSearch = React.useCallback(
      async (event) => {
        if (event?.preventDefault) event.preventDefault();
        setSearching(true);
        setSearchError("");
        try {
          const items = await searchNpmPlugins(searchQuery);
          setSearchResults(items);
        } catch (err) {
          setSearchError(
            err?.message || "连接 npm 搜索服务失败，请检查网络后重试。",
          );
        } finally {
          setSearching(false);
        }
      },
      [searchQuery],
    );

    const handleOpenDetail = React.useCallback((item) => {
      setSelectedPlugin(item);
      setDetailReadme(item?.readme || "");
      const pkgName = item?.packageName || item?.id;
      if (!pkgName) return;
      setLoadingReadme(true);
      fetchWithTimeout(
        `/api/plugins/${encodeURIComponent(pkgName)}/files/README.md`,
        2000,
      )
        .then((res) => {
          if (typeof res === "string") setDetailReadme(res);
        })
        .catch(() => {
          // 未安装时使用包描述展示
        })
        .finally(() => setLoadingReadme(false));
    }, []);

    const triggerInstall = React.useCallback(
      (item, isUpdate = false) => {
        const packageName = item.packageName || item.id;
        const source = item.localSource || `npm:${packageName}@${item.version || "latest"}`;
        const payload = {
          name: item.name || packageName,
          packageName,
          version: item.version || "0.1.0",
          description: item.description || "",
          author: item.author || "Community",
          source,
          sourceLabel: item.localSource ? "内置推荐插件包" : `npm (${registryMirror})`,
          registry: registryMirror,
          isUpdate,
        };
        if (typeof props?.requestInstallPlugin === "function") {
          props.requestInstallPlugin(payload);
          return;
        }
        if (typeof host?.ui?.requestInstallPlugin === "function") {
          host.ui.requestInstallPlugin(payload);
          return;
        }
        if (typeof host?.requestInstallPlugin === "function") {
          host.requestInstallPlugin(payload);
          return;
        }
        if (
          typeof window !== "undefined" &&
          typeof window.__BEEFTV_REQUEST_INSTALL_PLUGIN__ === "function"
        ) {
          window.__BEEFTV_REQUEST_INSTALL_PLUGIN__(payload);
          return;
        }
        host?.ui?.notify?.(
          `准备${isUpdate ? "更新" : "安装"}插件：${payload.name} (${payload.packageName}@${payload.version})`,
          "info",
        );
      },
      [props, registryMirror],
    );

    const visibleList = activeTab === "curated" ? curatedPlugins : searchResults;

    return h(
      "div",
      {
        "data-testid": "beeftv-plugin-market-view",
        style: {
          display: "flex",
          flexDirection: "column",
          gap: 16,
          padding: "4px 0",
        },
      },
      // 免责与信任提示横幅（阶段 2 必选文案）
      h(
        "div",
        {
          "data-testid": "plugin-market-disclaimer",
          style: {
            padding: "10px 14px",
            borderRadius: 10,
            background: "rgba(245, 158, 11, 0.12)",
            border: "1px solid rgba(245, 158, 11, 0.35)",
            fontSize: 13,
            lineHeight: 1.5,
          },
        },
        "被推荐列表收录不代表我们为它担保；请仅安装你信任来源的插件。",
      ),

      // 顶部导航栏与下载源切换
      h(
        "div",
        {
          style: {
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
          },
        },
        h(
          "div",
          { style: { display: "flex", gap: 8 } },
          h(
            "button",
            {
              type: "button",
              "data-testid": "market-tab-curated",
              onClick: () => setActiveTab("curated"),
              style: {
                padding: "6px 14px",
                borderRadius: 8,
                border: "1px solid rgba(148, 163, 184, 0.35)",
                background:
                  activeTab === "curated"
                    ? "rgba(59, 130, 246, 0.16)"
                    : "transparent",
                fontWeight: activeTab === "curated" ? 600 : 400,
                cursor: "pointer",
              },
            },
            "精选推荐",
          ),
          h(
            "button",
            {
              type: "button",
              "data-testid": "market-tab-npm",
              onClick: () => setActiveTab("npm"),
              style: {
                padding: "6px 14px",
                borderRadius: 8,
                border: "1px solid rgba(148, 163, 184, 0.35)",
                background:
                  activeTab === "npm"
                    ? "rgba(59, 130, 246, 0.16)"
                    : "transparent",
                fontWeight: activeTab === "npm" ? 600 : 400,
                cursor: "pointer",
              },
            },
            "npm 社区搜索",
          ),
        ),
        h(
          "div",
          {
            style: {
              display: "flex",
              alignItems: "center",
              gap: 8,
              fontSize: 12,
            },
          },
          h("span", { style: { opacity: 0.75 } }, "安装下载源："),
          h(
            "select",
            {
              "data-testid": "market-registry-select",
              value: registryMirror,
              onChange: (e) => setRegistryMirror(e.target.value),
              style: {
                padding: "5px 10px",
                borderRadius: 6,
                border: "1px solid rgba(148, 163, 184, 0.35)",
                background: "transparent",
              },
            },
            REGISTRY_MIRRORS.map((mirror) =>
              h(
                "option",
                { key: mirror.value, value: mirror.value },
                mirror.label,
              ),
            ),
          ),
        ),
      ),

      // npm 搜索栏
      activeTab === "npm"
        ? h(
            "form",
            {
              onSubmit: handleSearch,
              style: { display: "flex", gap: 8, alignItems: "center" },
            },
            h("input", {
              type: "search",
              "data-testid": "market-npm-search-input",
              value: searchQuery,
              onChange: (e) => setSearchQuery(e.target.value),
              placeholder: "搜索含 beeftv-plugin 关键词的 npm 插件包…",
              style: {
                flex: 1,
                padding: "8px 12px",
                borderRadius: 8,
                border: "1px solid rgba(148, 163, 184, 0.35)",
                background: "transparent",
              },
            }),
            h(
              "button",
              {
                type: "submit",
                "data-testid": "market-npm-search-button",
                disabled: searching,
                style: {
                  padding: "8px 16px",
                  borderRadius: 8,
                  border: "1px solid rgba(59, 130, 246, 0.45)",
                  background: "rgba(59, 130, 246, 0.18)",
                  cursor: searching ? "wait" : "pointer",
                  fontWeight: 500,
                },
              },
              searching ? "搜索中…" : "搜索 npm",
            ),
          )
        : h(
            "div",
            { style: { fontSize: 12, opacity: 0.72 } },
            loadingCurated
              ? "正在同步推荐列表…"
              : curatedSource === "remote"
                ? "已同步 Sunnyender-org/beeftv-plugins 最新推荐列表"
                : "当前展示内置推荐列表（离线可用）",
          ),

      searchError && activeTab === "npm"
        ? h(
            "div",
            {
              style: {
                padding: "10px 12px",
                borderRadius: 8,
                background: "rgba(239, 68, 68, 0.12)",
                color: "#ef4444",
                fontSize: 13,
              },
            },
            searchError,
          )
        : null,

      // 插件卡片网格
      h(
        "div",
        {
          "data-testid": "market-plugin-grid",
          style: {
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
            gap: 14,
          },
        },
        visibleList.map((item) => {
          const pkgId = item.id || item.packageName;
          const installed = installedMap.get(pkgId);
          const hasUpdate =
            installed?.version &&
            item.version &&
            installed.version !== item.version;

          return h(
            "div",
            {
              key: pkgId,
              "data-testid": `market-plugin-card-${pkgId}`,
              onClick: () => handleOpenDetail(item),
              style: {
                display: "flex",
                flexDirection: "column",
                justifyContent: "space-between",
                gap: 12,
                padding: 16,
                borderRadius: 12,
                border: "1px solid rgba(148, 163, 184, 0.28)",
                cursor: "pointer",
              },
            },
            h(
              "div",
              { style: { display: "flex", flexDirection: "column", gap: 6 } },
              h(
                "div",
                {
                  style: {
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 8,
                  },
                },
                h(
                  "span",
                  { style: { fontWeight: 600, fontSize: 15 } },
                  item.name || pkgId,
                ),
                h(
                  "span",
                  {
                    style: {
                      fontSize: 11,
                      padding: "2px 8px",
                      borderRadius: 999,
                      background: "rgba(148, 163, 184, 0.16)",
                    },
                  },
                  `v${item.version || "0.1.0"}`,
                ),
              ),
              h(
                "div",
                { style: { fontSize: 12, opacity: 0.7 } },
                `${item.packageName || pkgId} · 作者：${item.author || "Community"}`,
              ),
              h(
                "p",
                {
                  style: {
                    fontSize: 13,
                    lineHeight: 1.5,
                    margin: "4px 0 0",
                    opacity: 0.9,
                  },
                },
                item.description || "暂无简介",
              ),
              Array.isArray(item.tags) && item.tags.length > 0
                ? h(
                    "div",
                    {
                      style: {
                        display: "flex",
                        flexWrap: "wrap",
                        gap: 6,
                        marginTop: 4,
                      },
                    },
                    item.tags.map((tag) =>
                      h(
                        "span",
                        {
                          key: tag,
                          style: {
                            fontSize: 11,
                            padding: "2px 6px",
                            borderRadius: 4,
                            background: "rgba(59, 130, 246, 0.12)",
                          },
                        },
                        tag,
                      ),
                    ),
                  )
                : null,
            ),
            h(
              "div",
              {
                style: {
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  paddingTop: 8,
                  borderTop: "1px solid rgba(148, 163, 184, 0.15)",
                },
              },
              h(
                "span",
                { style: { fontSize: 12, opacity: 0.75 } },
                item.category || "扩展插件",
              ),
              h(
                "div",
                {
                  style: { display: "flex", gap: 8 },
                  onClick: (e) => e.stopPropagation(),
                },
                hasUpdate
                  ? h(
                      "button",
                      {
                        type: "button",
                        "data-testid": `market-update-btn-${pkgId}`,
                        onClick: () => triggerInstall(item, true),
                        style: {
                          padding: "5px 12px",
                          borderRadius: 6,
                          border: "1px solid rgba(245, 158, 11, 0.5)",
                          background: "rgba(245, 158, 11, 0.18)",
                          fontSize: 12,
                          fontWeight: 600,
                          cursor: "pointer",
                        },
                      },
                      `更新至 v${item.version}`,
                    )
                  : null,
                h(
                  "button",
                  {
                    type: "button",
                    "data-testid": `market-install-btn-${pkgId}`,
                    onClick: () => triggerInstall(item, false),
                    style: {
                      padding: "5px 12px",
                      borderRadius: 6,
                      border: "1px solid rgba(59, 130, 246, 0.45)",
                      background: "rgba(59, 130, 246, 0.16)",
                      fontSize: 12,
                      fontWeight: 500,
                      cursor: "pointer",
                    },
                  },
                  installed ? "重新安装" : "安装",
                ),
              ),
            ),
          );
        }),
      ),

      // 插件详情弹窗
      selectedPlugin
        ? h(
            "div",
            {
              "data-testid": "market-plugin-detail-modal",
              onClick: () => setSelectedPlugin(null),
              style: {
                position: "fixed",
                inset: 0,
                background: "rgba(0, 0, 0, 0.5)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                zIndex: 1000,
                padding: 24,
              },
            },
            h(
              "div",
              {
                onClick: (e) => e.stopPropagation(),
                style: {
                  width: "100%",
                  maxWidth: 640,
                  maxHeight: "82vh",
                  overflow: "auto",
                  borderRadius: 14,
                  padding: 24,
                  background: "#1e293b",
                  color: "#f8fafc",
                  border: "1px solid rgba(148, 163, 184, 0.3)",
                  display: "flex",
                  flexDirection: "column",
                  gap: 14,
                },
              },
              h(
                "div",
                {
                  style: {
                    display: "flex",
                    alignItems: "flex-start",
                    justifyContent: "space-between",
                    gap: 12,
                  },
                },
                h(
                  "div",
                  null,
                  h(
                    "h3",
                    { style: { margin: 0, fontSize: 18, fontWeight: 600 } },
                    selectedPlugin.name || selectedPlugin.packageName,
                  ),
                  h(
                    "div",
                    { style: { fontSize: 12, opacity: 0.75, marginTop: 4 } },
                    `包名：${selectedPlugin.packageName || selectedPlugin.id} · 版本：v${selectedPlugin.version || "0.1.0"} · 作者：${selectedPlugin.author || "Community"}`,
                  ),
                ),
                h(
                  "button",
                  {
                    type: "button",
                    onClick: () => setSelectedPlugin(null),
                    style: {
                      padding: "4px 10px",
                      borderRadius: 6,
                      border: "1px solid rgba(148, 163, 184, 0.3)",
                      background: "transparent",
                      color: "inherit",
                      cursor: "pointer",
                    },
                  },
                  "关闭",
                ),
              ),
              h(
                "p",
                { style: { margin: 0, fontSize: 14, lineHeight: 1.6 } },
                selectedPlugin.description,
              ),
              selectedPlugin.homepage || selectedPlugin.repository
                ? h(
                    "div",
                    { style: { fontSize: 12, opacity: 0.85 } },
                    `仓库 / 主页：${selectedPlugin.repository || selectedPlugin.homepage}`,
                  )
                : null,
              h(
                "div",
                {
                  style: {
                    padding: 12,
                    borderRadius: 8,
                    background: "rgba(15, 23, 42, 0.65)",
                    fontSize: 12,
                    lineHeight: 1.6,
                    whiteSpace: "pre-wrap",
                  },
                },
                loadingReadme
                  ? "正在读取插件说明文档…"
                  : detailReadme ||
                      `# ${selectedPlugin.name || selectedPlugin.packageName}\n\n${selectedPlugin.description || ""}\n\n安装来源：${selectedPlugin.localSource || `npm:${selectedPlugin.packageName}@${selectedPlugin.version || "latest"}`}`,
              ),
              h(
                "div",
                {
                  style: {
                    display: "flex",
                    justifyContent: "flex-end",
                    gap: 10,
                  },
                },
                h(
                  "button",
                  {
                    type: "button",
                    "data-testid": "market-detail-install-btn",
                    onClick: () => {
                      const target = selectedPlugin;
                      setSelectedPlugin(null);
                      triggerInstall(target, false);
                    },
                    style: {
                      padding: "8px 18px",
                      borderRadius: 8,
                      border: "1px solid rgba(59, 130, 246, 0.6)",
                      background: "#2563eb",
                      color: "#ffffff",
                      fontWeight: 600,
                      cursor: "pointer",
                    },
                  },
                  "安装此插件",
                ),
              ),
            ),
          )
        : null,
    );
  }

  return host.contribute("pluginCenter.section", {
    id: "market",
    label: "插件市场",
    description: "发现推荐插件与社区扩展",
    render: PluginMarketView,
  });
}

export default activate;
