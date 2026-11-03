// BeefTV 预装的插件市场：通过 pluginCenter.section 插槽在插件中心挂一栏「插件市场」。
// 推荐列表和 npm 搜索都由 BeefTV 后端 /api/plugins/market/search 合并返回（推荐列表联网读 GitHub，断网用内置副本）；
// 安装与更新统一走宿主的确认框，市场插件自己不安装任何东西。

const REGISTRY_MIRRORS = [
  { value: "https://registry.npmmirror.com", label: "国内镜像（npmmirror，默认）" },
  { value: "https://registry.npmjs.org", label: "npm 官方源（npmjs.org）" },
];

async function fetchMarket(query, registry) {
  const q = encodeURIComponent(String(query || "").trim());
  const reg = registry ? `&registry=${encodeURIComponent(String(registry).trim())}` : "";
  const response = await fetch(`/api/plugins/market/search?q=${q}${reg}`);
  const body = await response.json().catch(() => null);
  if (!response.ok || !body || body.code !== 0) throw new Error(body?.msg || `插件市场暂时打不开（HTTP ${response.status}）`);
  return Array.isArray(body.data?.items) ? body.data.items : [];
}

async function fetchReadme(item, registry) {
  const pluginId = String(item?.id || item?.packageName || "").trim();
  if (!pluginId) return "";
  if (item?.installed || item?.bundled) {
    const localResp = await fetch(`/api/plugins/${encodeURIComponent(pluginId)}/files/README.md`);
    if (localResp.ok) {
      const text = await localResp.text();
      if (text && text.trim()) return text;
    }
  }
  const reg = registry ? `&registry=${encodeURIComponent(String(registry).trim())}` : "";
  const response = await fetch(`/api/plugins/market/readme?id=${encodeURIComponent(pluginId)}${reg}`);
  if (!response.ok) return "";
  const body = await response.json().catch(() => null);
  return typeof body?.data?.readme === "string" ? body.data.readme : "";
}

export function activate(host) {
  const React = host.React;
  const h = React.createElement;

  function PluginMarketView(props) {
    const [activeTab, setActiveTab] = React.useState("curated");
    const [registryMirror, setRegistryMirror] = React.useState(
      REGISTRY_MIRRORS[0].value,
    );
    const [curatedPlugins, setCuratedPlugins] = React.useState([]);
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
      fetchMarket("", registryMirror)
        .then((items) => {
          if (!cancelled) setCuratedPlugins(items.filter((item) => item.recommended));
        })
        .catch((err) => {
          if (!cancelled) setSearchError(err?.message || "插件市场暂时打不开");
        })
        .finally(() => {
          if (!cancelled) setLoadingCurated(false);
        });
      return () => {
        cancelled = true;
      };
    }, [registryMirror]);

    const handleSearch = React.useCallback(
      async (event) => {
        if (event?.preventDefault) event.preventDefault();
        setSearching(true);
        setSearchError("");
        try {
          const items = await fetchMarket(searchQuery, registryMirror);
          setSearchResults(items);
        } catch (err) {
          setSearchError(
            err?.message || "连接 npm 搜索服务失败，请检查网络后重试。",
          );
        } finally {
          setSearching(false);
        }
      },
      [searchQuery, registryMirror],
    );

    const handleOpenDetail = React.useCallback(
      (item) => {
        setSelectedPlugin(item);
        setDetailReadme("");
        if (!item?.id && !item?.packageName) return;
        setLoadingReadme(true);
        fetchReadme(item, registryMirror)
          .then((text) => setDetailReadme(text))
          .catch(() => {
            // 未能读取远程 README 时回退使用包描述展示
          })
          .finally(() => setLoadingReadme(false));
      },
      [registryMirror],
    );

    const triggerInstall = React.useCallback(
      (item, isUpdate = false) => {
        host.ui.requestInstallPlugin({
          source: item.packageName || item.id,
          name: item.name,
          version: item.version,
          description: item.description,
          author: item.author,
          registry: registryMirror,
          isUpdate,
        });
      },
      [registryMirror],
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
            loadingCurated ? "正在读取推荐列表…" : "推荐列表来自 Sunnyender-org/beeftv-plugins，断网时显示内置副本",
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
                      `# ${selectedPlugin.name || selectedPlugin.packageName}\n\n${selectedPlugin.description || ""}\n\n安装来源：${selectedPlugin.bundled ? "BeefTV 自带示例" : `npm 包 ${selectedPlugin.packageName}`}`,
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
