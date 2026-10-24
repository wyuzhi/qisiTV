import { engineRequest, pairEngine, restoreEngineSession, type EngineStatus } from "@/services/engine-session";
import { engineInstallerUrl, ENGINE_INSTALLER_BETA_NOTICE, ENGINE_INSTALLER_PLATFORM } from "@/services/engine-installer";
import { ENGINE_UPGRADE_HELP_STEPS, ENGINE_UPGRADE_HELP_TITLE } from "@/services/engine-upgrade-help";
import { publicAssetUrl } from "@/lib/public-asset";

/** Runs before stores hydrate, so a disconnected engine never creates a second workspace. */
export async function requireEngineConnection(): Promise<void> {
    const invitation = new URLSearchParams(location.hash.split("?")[1] || "").get("pair") || "";
    if (invitation) {
        const route = location.hash.split("?")[0] || "#/";
        const params = new URLSearchParams(location.hash.split("?")[1] || "");
        params.delete("pair");
        history.replaceState(null, "", `${location.pathname}${location.search}${route}${params.size ? `?${params}` : ""}`);
    }
    if (!invitation && restoreEngineSession()) {
        try {
            const status = await engineRequest<EngineStatus>("/engine/status");
            if (status.ready && status.workspaceConfigured) return;
        } catch { /* Keep drafts untouched and present an explicit reconnection screen. */ }
    }
    await showConnectionGate(invitation);
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string) {
    const result = document.createElement(tag);
    if (text) result.textContent = text;
    return result;
}

async function showConnectionGate(invitation: string): Promise<void> {
    const root = document.getElementById("root");
    if (!root) throw new Error("画布页面缺少挂载点");
    const style = element("style");
    style.textContent = `body{margin:0;background:#111214;color:#eee;font:15px/1.7 system-ui,-apple-system,sans-serif}.engine-setup{max-width:620px;margin:7vh auto;padding:32px;border:1px solid #303237;border-radius:24px;background:#191b1e}.engine-setup h1{font-size:30px;line-height:1.3;margin:12px 0}.engine-setup p{color:#b8bec8}.engine-setup input{box-sizing:border-box;background:#111214;color:#eee;border:1px solid #444;border-radius:9px;padding:10px 14px;min-width:0;flex:1;font:inherit}.engine-setup button,.engine-setup a{font:inherit;border-radius:9px;padding:10px 16px;border:1px solid #42464d;background:#24272d;color:#eee;cursor:pointer;text-decoration:none}.engine-setup button:disabled{opacity:.5;cursor:wait}.engine-setup .primary{background:#27cae1;color:#0b2228;border:0;font-weight:650}.engine-setup .row{display:flex;gap:10px;flex-wrap:wrap;margin:16px 0}.engine-setup .feedback{white-space:pre-wrap;color:#f2cc8f}.engine-setup small{color:#a3acb8}.engine-setup img{width:52px;height:52px;border-radius:50%}@media(max-width:700px){.engine-setup{margin:20px;padding:22px}}`;
    const panel = element("main"); panel.className = "engine-setup";
    const logo = element("img"); logo.src = publicAssetUrl("qisitv-logo.jpg"); logo.alt = "qisiTV";
    panel.append(logo, element("h1", "连接这台电脑的 qisiTV"), element("p", "在网页里使用创作助手、工作流、导演台和媒体工具。项目与素材保存在你选择的本机文件夹。"));
    const launchRow = element("div"); launchRow.className = "row";
    const launch = element("a", "打开本机引擎"); launch.className = "primary"; launch.href = "qisitv://open";
    const install = element("a", "首次安装 · 下载 Mac 引擎"); install.href = engineInstallerUrl(); install.setAttribute("download", "");
    launchRow.append(launch, install); panel.append(launchRow);
    panel.append(element("p", `${ENGINE_INSTALLER_PLATFORM}。${ENGINE_INSTALLER_BETA_NOTICE}`));
    panel.append(element("small", "首次安装后，点击打开本机引擎。引擎会给出连接链接或连接码；浏览器询问访问本地网络时请选择允许。"));
    const upgradeHelp = element("details");
    upgradeHelp.append(element("summary", ENGINE_UPGRADE_HELP_TITLE));
    const upgradeSteps = element("ol");
    for (const step of ENGINE_UPGRADE_HELP_STEPS) upgradeSteps.append(element("li", step));
    upgradeHelp.append(upgradeSteps); panel.append(upgradeHelp);
    const row = element("div"); row.className = "row";
    const code = element("input"); code.value = invitation; code.placeholder = "输入本机引擎的连接码"; code.autocomplete = "off"; code.setAttribute("aria-label", "本机连接码");
    const connect = element("button", "确认连接"); connect.className = "primary";
    row.append(code, connect); panel.append(row);
    const feedback = element("p"); feedback.className = "feedback"; feedback.setAttribute("role", "status"); panel.append(feedback);
    const folderBox = element("section"); folderBox.hidden = true;
    folderBox.append(element("h2", "项目文件夹"), element("p", "选择项目的保存位置。已有项目会先核对完整性，确认导入后保留原文件备份。"));
    const folderRow = element("div"); folderRow.className = "row";
    const directory = element("input"); directory.placeholder = "项目根目录的完整路径"; directory.setAttribute("aria-label", "项目根目录");
    const choose = element("button", "选择文件夹"); folderRow.append(directory, choose); folderBox.append(folderRow);
    const enter = element("button", "使用此文件夹并打开画布"); enter.className = "primary"; folderBox.append(enter); panel.append(folderBox);
    root.replaceChildren(style, panel);
    return new Promise<void>((resolve) => {
        let busy = false;
        const run = async (operation: () => Promise<void>) => {
            if (busy) return;
            busy = true; connect.disabled = true; choose.disabled = true; enter.disabled = true;
            feedback.textContent = "正在连接本机…";
            try { await operation(); }
            catch (error) { feedback.textContent = error instanceof TypeError ? "未连接到本机引擎。请先打开引擎，并允许浏览器访问本地网络。" : error instanceof Error ? error.message : "连接未完成"; }
            finally { busy = false; connect.disabled = false; choose.disabled = false; enter.disabled = false; }
        };
        const finish = () => { root.replaceChildren(); resolve(); };
        const check = async () => {
            const status = await engineRequest<EngineStatus>("/engine/status");
            if (!status.ready) throw new Error("本机引擎正在准备，请稍后再连接");
            if (status.workspaceConfigured) { finish(); return; }
            folderBox.hidden = false; directory.value = status.projectDirectory || "";
            feedback.textContent = "已连接本机，请选择项目文件夹。";
        };
        connect.onclick = () => { void run(async () => { if (code.value.trim()) await pairEngine(code.value); await check(); }); };
        choose.onclick = () => { void run(async () => {
            const result = await engineRequest<{ path: string }>("/engine/shell/project-folders/choose", { method: "POST", signal: AbortSignal.timeout(5 * 60_000) });
            if (result.path) directory.value = result.path;
            feedback.textContent = result.path ? "确认后将使用此目录保存项目。" : "已取消选择。";
        }); };
        enter.onclick = () => { void run(async () => {
            if (!directory.value.trim()) throw new Error("请先选择项目文件夹");
            await engineRequest("/engine/shell/project-folders/configure", { method: "POST", body: JSON.stringify({ path: directory.value.trim(), confirmed: true }) });
            await check();
        }); };
    });
}
