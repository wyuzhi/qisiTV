// BeefTV 预装的插件市场：通过 pluginCenter.section 插槽在插件中心挂一栏「插件市场」。
// 推荐列表和 npm 搜索都由 BeefTV 后端 /api/plugins/market/search 合并返回（推荐列表联网读 GitHub，断网用内置副本）；
// 安装与更新统一走宿主的确认框，市场插件自己不安装任何东西。

const REGISTRY_MIRRORS = [
  { value: "https://registry.npmmirror.com", label: "国内镜像（npmmirror，默认）" },
  { value: "https://registry.npmjs.org", label: "npm 官方源（npmjs.org）" },
];

const recommendationCache = new Map();

async function fetchRecommendations(registry, cached) {
  const params = new URLSearchParams({ registry, cached: cached ? "1" : "0" });
  const response = await fetch(`/api/plugins/market/curated?${params}`);
  const body = await response.json().catch(() => null);
  if (!response.ok || !body || body.code !== 0) {
    throw new Error(body?.msg || "推荐列表暂时打不开");
  }
  return (body.data?.items || []).filter(item => item.recommended);
}

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
  const remoteKey = String(item?.packageName || item?.id || "").trim();
  if (!pluginId && !remoteKey) return "";
  if (pluginId && (item?.installed || item?.bundled)) {
    const localResp = await fetch(`/api/plugins/${encodeURIComponent(pluginId)}/files/README.md`);
    if (localResp.ok) {
      const text = await localResp.text();
      if (text && text.trim()) return text;
    }
  }
  const reg = registry ? `&registry=${encodeURIComponent(String(registry).trim())}` : "";
  const response = await fetch(`/api/plugins/market/readme?id=${encodeURIComponent(remoteKey || pluginId)}${reg}`);
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
    const [curatedPlugins, setCuratedPlugins] = React.useState(() => recommendationCache.get(REGISTRY_MIRRORS[0].value) || []);
    const [loadingCurated, setLoadingCurated] = React.useState(false);
    const [curatedError, setCuratedError] = React.useState("");

    const [searchQuery, setSearchQuery] = React.useState("");
    const [searchResults, setSearchResults] = React.useState([]);
    const [searching, setSearching] = React.useState(false);
    const [searchError, setSearchError] = React.useState("");

    const [selectedPlugin, setSelectedPlugin] = React.useState(null);
    const [detailReadme, setDetailReadme] = React.useState("");
    const [loadingReadme, setLoadingReadme] = React.useState(false);
    const readmeReqIdRef = React.useRef(0);

    const closeDetailModal = React.useCallback(() => {
      readmeReqIdRef.current += 1;
      setSelectedPlugin(null);
      setLoadingReadme(false);
    }, []);

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
      const previous = recommendationCache.get(registryMirror) || [];
      setCuratedPlugins(previous);
      setCuratedError("");
      setLoadingCurated(previous.length === 0);
      const publish = (items, final = false) => {
        if (cancelled) return;
        recommendationCache.set(registryMirror, items);
        setCuratedPlugins(items);
        if (items.length > 0 || final) {
          setCuratedError("");
          setLoadingCurated(false);
        }
      };
      const load = async () => {
        try {
          if (previous.length === 0) publish(await fetchRecommendations(registryMirror, true));
        } catch (error) {
          // A remote refresh can still recover when the local catalog is unavailable.
        }
        try {
          publish(await fetchRecommendations(registryMirror, false), true);
        } catch (error) {
          if (!cancelled && !recommendationCache.get(registryMirror)?.length) {
            setCuratedError(error.message || "插件市场暂时打不开");
          }
        } finally {
          if (!cancelled) setLoadingCurated(false);
        }
      };
      void load();
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
        const reqId = readmeReqIdRef.current + 1;
        readmeReqIdRef.current = reqId;
        setSelectedPlugin(item);
        setDetailReadme("");
        if (!item?.id && !item?.packageName) {
          setLoadingReadme(false);
          return;
        }
        setLoadingReadme(true);
        fetchReadme(item, registryMirror)
          .then((text) => {
            if (readmeReqIdRef.current === reqId) {
              setDetailReadme(text);
            }
          })
          .catch(() => {
            // 未能读取远程 README 时回退使用包描述展示
          })
          .finally(() => {
            if (readmeReqIdRef.current === reqId) {
              setLoadingReadme(false);
            }
          });
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
    const visibleError = activeTab === "curated" ? curatedError : searchError;

    const metadata = (label, value) => h("div", { key: label }, h("dt", null, label), h("dd", null, value));
    const loading = activeTab === "curated" ? loadingCurated : searching;
    if (!props?.Card || !props?.Button || !props?.DetailsModal || !props?.Markdown || !props?.RegistrySelect) {
      return null;
    }

    return h("div", { className: "plugin-market", "data-testid": "beeftv-plugin-market-view" },
      h("div", { className: "plugin-market-toolbar" },
        h("div", { className: "plugin-market-tabs", role: "group", "aria-label": "市场来源" },
          [["curated", "精选推荐"], ["npm", "社区搜索"]].map(([value, label]) =>
            h("button", {
              key: value,
              type: "button",
              "aria-pressed": activeTab === value,
              "data-testid": `market-tab-${value}`,
              onClick: () => setActiveTab(value),
            }, label),
          ),
        ),
        h(props.RegistrySelect, {
          className: "plugin-market-registry",
          "aria-label": "安装下载源",
          "data-testid": "market-registry-select",
          value: registryMirror,
          onChange: setRegistryMirror,
          options: REGISTRY_MIRRORS,
        }),
      ),
      activeTab === "npm" ? h("form", { className: "plugin-market-search", onSubmit: handleSearch },
        h("input", {
          type: "search",
          "aria-label": "搜索社区插件",
          "data-testid": "market-npm-search-input",
          placeholder: "搜索社区插件",
          value: searchQuery,
          onChange: event => setSearchQuery(event.target.value),
        }),
        h("button", { type: "submit", className: "plugin-market-button", disabled: searching, "data-testid": "market-npm-search-button" }, searching ? "搜索中…" : "搜索"),
      ) : null,
      visibleError ? h("p", { role: "alert", className: "plugin-market-error" }, visibleError) : null,
      loading ? h("p", { role: "status", className: "plugin-market-empty" }, "正在读取插件…") : null,
      !loading && !visibleError && !visibleList.length ? h("p", { className: "plugin-market-empty" }, activeTab === "npm" ? "搜索社区插件，查找可安装的扩展。" : "暂无推荐插件") : null,
      h("div", { className: "plugins-grid", "data-testid": "market-plugin-grid" },
        visibleList.map(item => {
          const id = item.id || item.packageName;
          const installed = installedMap.get(id) || installedMap.get(item.packageName);
          const hasUpdate = installed?.version && item.version && installed.version !== item.version;
          return h(props.Card, {
            key: id,
            "data-testid": `market-plugin-card-${id}`,
            name: item.name || id,
            description: item.description || "暂无简介",
            sourceLabel: item.bundled ? "官方" : "第三方",
            status: installed ? "已安装" : "未安装",
            onOpen: () => handleOpenDetail(item),
            actions: h(React.Fragment, null,
              hasUpdate ? h(props.Button, { className: "plugin-settings-button", "data-testid": `market-update-btn-${id}`, onClick: () => triggerInstall(item, true) }, "更新") : null,
              h(props.Button, { className: "plugin-settings-button", "data-testid": `market-install-btn-${id}`, onClick: () => triggerInstall(item) }, installed ? "重新安装" : "安装"),
            ),
          });
        }),
      ),
      h(props.DetailsModal, {
        flush: true,
        scrollBody: true,
        className: "plugin-details-modal",
        wrapClassName: "plugin-details-wrap",
        width: "min(760px, calc(100vw - 32px))",
        title: selectedPlugin?.name || selectedPlugin?.packageName,
        open: Boolean(selectedPlugin),
        onCancel: closeDetailModal,
        footer: selectedPlugin ? h("button", {
          type: "button",
          className: "plugin-market-button plugin-market-install",
          "data-testid": "market-detail-install-btn",
          onClick: () => { const item = selectedPlugin; closeDetailModal(); triggerInstall(item); },
        }, "安装此插件") : null,
      }, selectedPlugin ? h("article", { className: "plugin-details-content", tabIndex: 0, "aria-label": "市场插件详情" },
        h("div", { className: "plugin-details-overview" },
          h("dl", { className: "plugin-details-metadata" }, metadata("版本", selectedPlugin.version || "未提供"), metadata("作者", selectedPlugin.author || "未提供")),
          h("p", null, selectedPlugin.description),
        ),
        h("div", { className: "plugin-details-sections" },
          h("details", null, h("summary", null, "使用说明"), loadingReadme
            ? h("p", { role: "status" }, "正在读取使用说明…")
            : h(props.Markdown, { className: "plugin-details-document", source: detailReadme || "此插件未提供独立的使用说明。" })),
          h("details", null, h("summary", null, "安装来源"),
            h("p", { className: "plugin-market-notice", "data-testid": "plugin-market-disclaimer" }, "被推荐列表收录不代表我们为它担保；请仅安装你信任来源的插件。"),
            h("dl", null, metadata("插件包", selectedPlugin.packageName || selectedPlugin.id), metadata("下载源", registryMirror)),
          ),
          h("details", null, h("summary", null, "插件与高级信息"),
            h("dl", null,
              metadata("分类", selectedPlugin.category || "扩展插件"),
              metadata("标签", (selectedPlugin.tags || []).join("、") || "未提供"),
              metadata("仓库 / 主页", selectedPlugin.repository || selectedPlugin.homepage || "未提供"),
            ),
          ),
        ),
      ) : null),
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
