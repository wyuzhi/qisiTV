import { browserCapabilities } from "./browser-environment";
import { DEFAULT_DIAGNOSTIC_WINDOW_MS } from "./diagnostic-window";

type RequiredCapabilities = { secureRandom: boolean; structuredClone: boolean; indexedDB: boolean };

// This module must remain independent of React, stores and backend bootstrap:
// importing those first can fail before an unsupported runtime sees the notice.
export async function startCheckedWorkspace(load: () => Promise<unknown>, capabilities: RequiredCapabilities = browserCapabilities()) {
    const missing = Object.entries(capabilities).filter(([key, supported]) => ["secureRandom", "structuredClone", "indexedDB"].includes(key) && !supported).map(([key]) => key);
    if (missing.length) {
        showFailure("capability", capabilities);
        return false;
    }
    try {
        await load();
        return true;
    } catch (error) {
        showFailure("workspace", capabilities, error);
        return false;
    }
}

function extractSafeReason(error: unknown): string | undefined {
    if (!error || typeof error !== "object" || !("failure" in error)) return undefined;
    const failure = (error as { failure?: { reason?: unknown } }).failure;
    const reason = typeof failure?.reason === "string" ? failure.reason.trim() : "";
    if (!reason || !/^[a-z0-9_:-]{1,64}$/i.test(reason)) return undefined;
    if (/secret|token|password|api[_-]?key|bearer|path/i.test(reason)) return undefined;
    return reason;
}

function showFailure(stage: "capability" | "workspace", capabilities: RequiredCapabilities, error?: unknown) {
    const root = document.getElementById("root");
    if (!root) return;
    const section = document.createElement("section");
    section.className = "app-user-workspace";
    section.setAttribute("role", "alert");
    section.style.cssText =
        "box-sizing:border-box;width:calc(100% - 32px);max-width:36rem;margin:8vh auto;padding:24px;border-radius:var(--user-radius-card,12px);border:1px solid var(--user-border,rgba(128,128,128,0.28));background:var(--user-surface,var(--background,#18181b));color:var(--user-ink,var(--foreground,#f4f4f5));font-family:var(--font-sans,system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI','Microsoft YaHei',sans-serif);font-size:var(--fs-body,14px);line-height:22px;overflow-wrap:anywhere";
    const heading = document.createElement("h1");
    heading.style.cssText = "margin:0 0 8px;font-family:inherit;font-size:var(--fs-heading,16px);line-height:22px;font-weight:500";
    heading.textContent = stage === "capability" ? "运行环境需要更新" : "工作区暂时无法打开";
    const detail = document.createElement("p");
    detail.style.cssText = "margin:0;font-family:inherit;font-size:var(--fs-body,14px);line-height:22px";
    detail.textContent =
        stage === "capability"
            ? "当前环境缺少必要能力，请检查浏览器存储权限，或更新浏览器和系统 WebView 后重试。"
            : "请重启应用，或确认后端服务可用后重试。仍无法打开时，请把下方排查信息提供给支持人员。";

    const actions = document.createElement("div");
    actions.style.cssText = "display:flex;flex-wrap:wrap;gap:8px;margin-top:16px";
    const reloadButton = document.createElement("button");
    reloadButton.type = "button";
    reloadButton.style.cssText =
        "padding:8px 16px;border:0;border-radius:var(--button-radius,8px);background:var(--btn-solid-bg,#f4f4f5);color:var(--btn-solid-fg,#111113);font-family:inherit;font-size:var(--typ-caption,13px);line-height:20px;font-weight:550;cursor:pointer";
    reloadButton.textContent = "重新加载";
    reloadButton.onclick = () => location.reload();
    actions.appendChild(reloadButton);

    const reason = extractSafeReason(error);
    const evidencePayload = {
        stage,
        ...(reason ? { reason } : {}),
        capabilities: {
            secureRandom: capabilities.secureRandom,
            structuredClone: capabilities.structuredClone,
            indexedDB: capabilities.indexedDB,
        },
    };
    const evidenceText = JSON.stringify(evidencePayload, null, 2);

    const desktopApp = typeof window !== "undefined" ? window.go?.main?.DesktopApp : undefined;
    const statusLine = document.createElement("p");
    statusLine.style.cssText = "margin:10px 0 0;font-family:inherit;font-size:var(--fs-caption,12px);line-height:18px;display:none";

    if (typeof desktopApp?.ExportStartupDiagnostics === "function") {
        const exportButton = document.createElement("button");
        exportButton.type = "button";
        exportButton.style.cssText =
            "padding:8px 14px;border:1px solid var(--user-border-strong,rgba(128,128,128,0.36));border-radius:var(--button-radius,8px);background:transparent;color:inherit;font-family:inherit;font-size:var(--typ-caption,13px);line-height:20px;font-weight:550;cursor:pointer";
        exportButton.textContent = "导出诊断包";
        const revealButton =
            typeof desktopApp?.RevealDiagnosticBundle === "function"
                ? (() => {
                      const btn = document.createElement("button");
                      btn.type = "button";
                      btn.style.cssText =
                          "display:none;padding:8px 14px;border:1px solid var(--user-border-strong,rgba(128,128,128,0.36));border-radius:var(--button-radius,8px);background:transparent;color:inherit;font-family:inherit;font-size:var(--typ-caption,13px);line-height:20px;font-weight:550;cursor:pointer";
                      btn.textContent = "在文件夹中显示";
                      btn.onclick = () => {
                          void desktopApp.RevealDiagnosticBundle!();
                      };
                      return btn;
                  })()
                : null;

        exportButton.onclick = () => {
            exportButton.disabled = true;
            void desktopApp
                .ExportStartupDiagnostics!(
                    JSON.stringify({
                        from: new Date(Date.now() - DEFAULT_DIAGNOSTIC_WINDOW_MS).toISOString(),
                        to: new Date().toISOString(),
                        description: `preflight:${stage}${reason ? `:${reason}` : ""}`,
                        runtime: {
                            browser: typeof navigator !== "undefined" ? navigator.userAgent : "",
                            os: typeof navigator !== "undefined" ? navigator.platform : "",
                        },
                        clientEvents: [],
                    }),
                )
                .then((savedPath) => {
                    statusLine.style.display = "block";
                    statusLine.textContent = savedPath ? `诊断包已保存：${savedPath}` : "已取消保存诊断包";
                    if (savedPath && revealButton) revealButton.style.display = "inline-block";
                })
                .catch(() => {
                    statusLine.style.display = "block";
                    statusLine.textContent = "导出诊断包未完成，请打开数据目录查看 diagnostics 文件夹。";
                })
                .finally(() => {
                    exportButton.disabled = false;
                });
        };
        actions.appendChild(exportButton);
        if (revealButton) actions.appendChild(revealButton);
    }

    if (typeof desktopApp?.OpenUpdateLogDirectory === "function") {
        const openDirButton = document.createElement("button");
        openDirButton.type = "button";
        openDirButton.style.cssText =
            "padding:8px 14px;border:1px solid var(--user-border-strong,rgba(128,128,128,0.36));border-radius:var(--button-radius,8px);background:transparent;color:inherit;font-family:inherit;font-size:var(--typ-caption,13px);line-height:20px;font-weight:550;cursor:pointer";
        openDirButton.textContent = "打开数据目录";
        openDirButton.onclick = () => {
            void desktopApp.OpenUpdateLogDirectory!();
        };
        actions.appendChild(openDirButton);
    }

    const evidence = document.createElement("pre");
    evidence.style.cssText =
        "margin:16px 0 0;padding:12px;border-radius:var(--user-radius-control,8px);background:var(--user-surface-muted,rgba(128,128,128,0.14));white-space:pre-wrap;font-family:var(--font-mono,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);font-size:var(--fs-caption,12px);line-height:20px";
    evidence.textContent = evidenceText;
    for (const element of [heading, detail, actions, statusLine, evidence]) section.appendChild(element);
    while (root.firstChild) root.removeChild(root.firstChild);
    root.appendChild(section);
}
