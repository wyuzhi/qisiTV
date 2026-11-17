// 零依赖样式护栏与样式清单校验器（随 structure-budget.mjs 在 CI 安装依赖前纯 Node 运行）。
// 1. findLockCssFiles: 禁阻 *-lock.css / *-final.css 样式补丁文件。
// 2. countCssImportant / countTailwindImportant: 分别统计手写 CSS `!important` 与 TS/TSX `!` 修饰符数量（只降不升；Tailwind 检测器由 ./tailwind-important-detector.mjs 提供并在此重导出）。
// 3. findStyleManifestIssues: 守卫 globals.css（3 条包引入 + 40 条本地 @import + @source/@custom-variant dark）
//    与 workspace-product.css（3 条）的加载顺序、@import 置顶约束、无孤立拆分文件，以及各拆分模块 <=750 行与显式 @layer 级联归属。

export {
    TAILWIND_BARE_UTILITIES,
    countTailwindImportant,
    isTailwindImportantToken,
} from "./tailwind-important-detector.mjs";

export const MAX_SPLIT_CSS_MODULE_LINES = 750;

export const GLOBALS_PACKAGE_IMPORTS = ["tailwindcss", "tw-animate-css", "shadcn/tailwind.css"];

export const GLOBALS_REQUIRED_DIRECTIVES = [
    '@source "../../node_modules/streamdown/dist/*.js"',
    "@custom-variant dark (&:is(.dark *))",
];

export const GLOBALS_LOCAL_IMPORTS = [
    "./theme-tokens.css",
    "./tailwind-theme.css",
    "./globals/foundation/motion-and-public-surfaces.css",
    "./globals/foundation/semantic-tokens.css",
    "./globals/foundation/component-tokens-and-base.css",
    "./globals/shell/typography-and-workspace-shell.css",
    "./globals/shell/canvas-topbar-and-sidebar.css",
    "./globals/shell/route-and-fullscreen-loaders.css",
    "./globals/creation/creation-composer-and-chips.css",
    "./globals/creation/creation-studio-and-popovers.css",
    "./globals/creation/creation-chat-and-messages.css",
    "./globals/library/workspace-cards-and-folders.css",
    "./globals/library/library-headers-and-grids.css",
    "./globals/library/project-flow-and-tables.css",
    "./globals/library/style-center-modals.css",
    "./globals/shell/dock-auth-and-scrollbars.css",
    "./globals/canvas/canvas-controls-and-composer.css",
    "./globals/canvas/canvas-zoom-and-video-trim.css",
    "./globals/canvas/canvas-folder-nodes.css",
    "./globals/canvas/canvas-node-shell-and-inline.css",
    "./globals/canvas/canvas-prompt-optimizer.css",
    "./globals/canvas/canvas-node-composer-and-mentions.css",
    "./globals/canvas/canvas-node-inspector.css",
    "./globals/creation/project-chapter-and-creation-dock.css",
    "./globals/director/director-workbench-and-actors.css",
    "./globals/director/director-sequencer-and-pose.css",
    "./globals/creation/creation-home-and-parameters.css",
    "./globals/creation/creation-choice-history-and-picker.css",
    "./globals/library/story-and-skill-modals.css",
    "./globals/home/home-dashboard.css",
    "./globals/library/assets-library-and-drawer.css",
    "./globals/creation/ai-markdown-and-thread-media.css",
    "./globals/shell/editor-controls-and-upload.css",
    "./globals/workspace/workspace-alignment-sidebar.css",
    "./globals/workspace/workspace-alignment-pages.css",
    "./globals/home/featured-works-and-model-picker.css",
    "./globals/home/wallet-modal.css",
    "./globals/workspace/workspace-account-and-library.css",
    "./globals/workspace/workspace-launchpad-and-settings.css",
    "./globals/workspace/workspace-responsive-and-model-picker.css",
];

export const WORKSPACE_PRODUCT_LOCAL_IMPORTS = [
    "./workspace-product/01-product-components.css",
    "./workspace-product/02-workspace-shell.css",
    "./workspace-product/03-changelog-and-surfaces.css",
];

// 每个拆分模块显式锁定其 CSS @layer 级联归属（防止脱层后优先级反转）：
// - full:utilities  : 整文件被单个顶层 @layer utilities { ... } 包裹
// - mixed:base      : 含顶层未分层规则 + 单个顶层 @layer base { ... } 块
// - mixed:utilities : 含顶层未分层规则 + 单个顶层 @layer utilities { ... } 块
// - unlayered       : 全文件不带任何 @layer 块
export const MODULE_LAYER_MODE = {
    "./globals/foundation/motion-and-public-surfaces.css": "unlayered",
    "./globals/foundation/semantic-tokens.css": "unlayered",
    "./globals/foundation/component-tokens-and-base.css": "mixed:base",
    "./globals/shell/typography-and-workspace-shell.css": "full:utilities",
    "./globals/shell/canvas-topbar-and-sidebar.css": "full:utilities",
    "./globals/shell/route-and-fullscreen-loaders.css": "full:utilities",
    "./globals/creation/creation-composer-and-chips.css": "full:utilities",
    "./globals/creation/creation-studio-and-popovers.css": "full:utilities",
    "./globals/creation/creation-chat-and-messages.css": "full:utilities",
    "./globals/library/workspace-cards-and-folders.css": "full:utilities",
    "./globals/library/library-headers-and-grids.css": "full:utilities",
    "./globals/library/project-flow-and-tables.css": "full:utilities",
    "./globals/library/style-center-modals.css": "full:utilities",
    "./globals/shell/dock-auth-and-scrollbars.css": "full:utilities",
    "./globals/canvas/canvas-controls-and-composer.css": "full:utilities",
    "./globals/canvas/canvas-zoom-and-video-trim.css": "full:utilities",
    "./globals/canvas/canvas-folder-nodes.css": "full:utilities",
    "./globals/canvas/canvas-node-shell-and-inline.css": "full:utilities",
    "./globals/canvas/canvas-prompt-optimizer.css": "full:utilities",
    "./globals/canvas/canvas-node-composer-and-mentions.css": "full:utilities",
    "./globals/canvas/canvas-node-inspector.css": "full:utilities",
    "./globals/creation/project-chapter-and-creation-dock.css": "unlayered",
    "./globals/director/director-workbench-and-actors.css": "unlayered",
    "./globals/director/director-sequencer-and-pose.css": "unlayered",
    "./globals/creation/creation-home-and-parameters.css": "mixed:utilities",
    "./globals/creation/creation-choice-history-and-picker.css": "unlayered",
    "./globals/library/story-and-skill-modals.css": "unlayered",
    "./globals/home/home-dashboard.css": "unlayered",
    "./globals/library/assets-library-and-drawer.css": "unlayered",
    "./globals/creation/ai-markdown-and-thread-media.css": "unlayered",
    "./globals/shell/editor-controls-and-upload.css": "unlayered",
    "./globals/workspace/workspace-alignment-sidebar.css": "unlayered",
    "./globals/workspace/workspace-alignment-pages.css": "unlayered",
    "./globals/home/featured-works-and-model-picker.css": "unlayered",
    "./globals/home/wallet-modal.css": "unlayered",
    "./globals/workspace/workspace-account-and-library.css": "unlayered",
    "./globals/workspace/workspace-launchpad-and-settings.css": "unlayered",
    "./globals/workspace/workspace-responsive-and-model-picker.css": "mixed:utilities",
    "./workspace-product/01-product-components.css": "mixed:utilities",
    "./workspace-product/02-workspace-shell.css": "unlayered",
    "./workspace-product/03-changelog-and-surfaces.css": "mixed:utilities",
};

const LOCK_CSS_RE = /(?:^|\/)(?:[^/]*-)?(?:frame-lock|final-lock|lock|final)\.css$/i;
export function findLockCssFiles(webCssPaths) {
    return webCssPaths.filter((p) => LOCK_CSS_RE.test(p)).sort();
}

export function countCssImportant(cssText) {
    let cleaned = "";
    let quote = "";
    for (let i = 0; i < cssText.length; i++) {
        const ch = cssText[i];
        if (quote) {
            if (ch === "\\" && i + 1 < cssText.length) {
                i++;
                continue;
            }
            if (ch === quote) quote = "";
            continue;
        }
        if (ch === "'" || ch === '"') {
            quote = ch;
            cleaned += " ";
            continue;
        }
        if (ch === "/" && cssText[i + 1] === "*") {
            i += 2;
            while (i < cssText.length && !(cssText[i] === "*" && cssText[i + 1] === "/")) {
                if (cssText[i] === "\n") cleaned += "\n";
                i++;
            }
            i++;
            cleaned += " ";
            continue;
        }
        cleaned += ch;
    }
    const unescaped = cleaned.replace(/\\([0-9a-fA-F]{1,6})[ \t\r\n\f]?|\\([^\r\n\f0-9a-fA-F])/g, (_, hex, ch) => {
        if (hex) {
            const cp = Number.parseInt(hex, 16);
            return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : "\ufffd";
        }
        return ch;
    });
    return (unescaped.match(/!\s*important\b/gi) || []).length;
}

function stripCssStrings(cssText) {
    let out = "";
    let quote = "";
    for (let i = 0; i < cssText.length; i++) {
        const ch = cssText[i];
        if (quote) {
            if (ch === "\n") out += "\n";
            if (ch === "\\" && i + 1 < cssText.length) {
                if (cssText[i + 1] === "\n") out += "\n";
                i++;
            } else if (ch === quote) quote = "";
            continue;
        }
        if (ch === "'" || ch === '"') {
            quote = ch;
            out += " ";
            continue;
        }
        if ((i === 0 || !/[A-Za-z0-9_-]/.test(cssText[i - 1])) && cssText.slice(i, i + 4).toLowerCase() === "url(") {
            out += "url( ";
            i += 4;
            let pDepth = 1;
            let urlQuote = "";
            for (; i < cssText.length && pDepth > 0; i++) {
                const uch = cssText[i];
                if (uch === "\n") out += "\n";
                if (urlQuote) {
                    if (uch === "\\" && i + 1 < cssText.length) {
                        if (cssText[i + 1] === "\n") out += "\n";
                        i++;
                    } else if (uch === urlQuote) urlQuote = "";
                } else if (uch === "'" || uch === '"') urlQuote = uch;
                else if (uch === "(") pDepth++;
                else if (uch === ")") pDepth--;
            }
            out += ")";
            i--;
            continue;
        }
        out += ch;
    }
    return out;
}

function stripCssComments(cssText) {
    let out = "";
    let quote = "";
    for (let i = 0; i < cssText.length; i++) {
        const ch = cssText[i];
        if (quote) {
            out += ch;
            if (ch === "\\" && i + 1 < cssText.length) out += cssText[++i];
            else if (ch === quote) quote = "";
            continue;
        }
        if (ch === "'" || ch === '"') {
            quote = ch;
            out += ch;
            continue;
        }
        if (ch === "/" && cssText[i + 1] === "*") {
            i += 2;
            while (i < cssText.length && !(cssText[i] === "*" && cssText[i + 1] === "/")) {
                if (cssText[i] === "\n") out += "\n";
                i++;
            }
            i++;
            continue;
        }
        out += ch;
    }
    return out;
}

function inspectBalancedCss(cssText) {
    let depth = 0;
    let quote = "";
    let inComment = false;
    for (let i = 0; i < cssText.length; i++) {
        const ch = cssText[i];
        if (inComment) {
            if (ch === "*" && cssText[i + 1] === "/") {
                inComment = false;
                i++;
            }
            continue;
        }
        if (quote) {
            if (ch === "\\" && i + 1 < cssText.length) {
                i++;
                continue;
            }
            if (ch === quote) quote = "";
            continue;
        }
        if (ch === "/" && cssText[i + 1] === "*") {
            inComment = true;
            i++;
            continue;
        }
        if (ch === "'" || ch === '"') {
            quote = ch;
            continue;
        }
        if (ch === "{") depth++;
        else if (ch === "}") {
            depth--;
            if (depth < 0) return "存在多余的右花括号 }（可能提前闭合 @layer/@media 块）";
        }
    }
    if (inComment) return "存在未闭合的 CSS 注释 /*";
    if (quote) return `存在未闭合的字符串引号 ${quote}`;
    if (depth !== 0) return `花括号未闭合（结尾剩余 depth=${depth}）`;
    return null;
}

const cssLineCount = (text) => text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
const normalizeCssText = (text) => text.replace(/\s+/g, " ").trim();

function parseTopLevelCssItems(strippedCss) {
    const items = [];
    let depth = 0;
    let quote = "";
    let stmtStart = 0;
    let blockHeader = "";
    let bodyStart = 0;

    for (let i = 0; i < strippedCss.length; i++) {
        const ch = strippedCss[i];
        if (quote) {
            if (ch === "\\" && i + 1 < strippedCss.length) i++;
            else if (ch === quote) quote = "";
            continue;
        }
        if (ch === "'" || ch === '"') {
            quote = ch;
            continue;
        }
        if (ch === "{") {
            if (depth === 0) {
                blockHeader = strippedCss.slice(stmtStart, i).trim();
                bodyStart = i + 1;
            }
            depth++;
            continue;
        }
        if (ch === "}") {
            depth = Math.max(0, depth - 1);
            if (depth === 0) {
                items.push({ kind: "block", header: blockHeader, body: strippedCss.slice(bodyStart, i) });
                stmtStart = i + 1;
            }
            continue;
        }
        if (ch === ";" && depth === 0) {
            const text = strippedCss.slice(stmtStart, i).trim();
            stmtStart = i + 1;
            if (text) items.push({ kind: "stmt", text, missingSemicolon: false });
        }
    }

    if (depth === 0) {
        const trailing = strippedCss.slice(stmtStart).trim();
        if (trailing) items.push({ kind: "stmt", text: trailing, missingSemicolon: true });
    }
    return items;
}

function validateSplitModuleLayer(path, stripped) {
    const issues = [];
    const relSpec = `./${path.slice("web/src/styles/".length)}`;
    const mode = MODULE_LAYER_MODE[relSpec];
    if (!mode) {
        issues.push(`${path}: 未在 MODULE_LAYER_MODE 中登记预期 @layer 级联归属`);
        return issues;
    }

    const items = parseTopLevelCssItems(stripped);
    for (const item of items) {
        if (item.kind === "stmt" && item.missingSemicolon) {
            issues.push(`${path}: 存在缺少分号的顶层语句（${item.text.slice(0, 60)}）`);
        }
    }

    if (mode === "unlayered") {
        if (/@layer\b/.test(stripCssStrings(stripped))) {
            issues.push(`${path}: 未分层模块不得包含 @layer 块（否则会改变级联优先级）`);
        } else if (items.length === 0) {
            issues.push(`${path}: 拆分模块内容为空`);
        }
        return issues;
    }

    if (mode === "full:utilities") {
        const only = items.length === 1 ? items[0] : null;
        if (
            !only ||
            only.kind !== "block" ||
            !/^@layer\s+utilities$/.test(only.header) ||
            only.body.trim().length === 0 ||
            /@layer\b/.test(stripCssStrings(only.body))
        ) {
            issues.push(`${path}: 必须由单个顶层 @layer utilities { ... } 完整包裹（禁止脱层或提前闭合重开）`);
        }
        return issues;
    }

    const expectedLayer = mode.slice("mixed:".length);
    const layerHeaderRe = new RegExp(`^@layer\\s+${expectedLayer}$`);
    const layerBlocks = [];
    let unlayeredBlocks = 0;
    let hasBadStmtOrNestedLayer = false;

    for (const item of items) {
        if (item.kind === "stmt") {
            if (/@layer\b/.test(stripCssStrings(item.text))) hasBadStmtOrNestedLayer = true;
            continue;
        }
        if (/@layer\b/.test(stripCssStrings(item.body))) hasBadStmtOrNestedLayer = true;
        if (/^@layer\b/.test(item.header)) {
            if (layerHeaderRe.test(item.header) && item.body.trim().length > 0) layerBlocks.push(item);
            else hasBadStmtOrNestedLayer = true;
        } else {
            unlayeredBlocks++;
        }
    }

    if (hasBadStmtOrNestedLayer || layerBlocks.length !== 1 || unlayeredBlocks < 1) {
        issues.push(`${path}: 混合层级模块必须保留顶层未分层规则且仅含单个顶层 @layer ${expectedLayer} 块`);
    }
    return issues;
}

function validateManifestEntry(entryPath, { expectedPackageImports, expectedLocalImports, requiredDirectives, dirPrefix }, availableCssSet, readIn) {
    const issues = [];
    if (!availableCssSet.has(entryPath)) {
        issues.push(`缺少样式入口文件：${entryPath}`);
        return issues;
    }
    const entryRaw = readIn(entryPath);
    const entryBalance = inspectBalancedCss(entryRaw);
    if (entryBalance) {
        issues.push(`${entryPath}: ${entryBalance}`);
        return issues;
    }

    const stripped = stripCssComments(entryRaw);
    const actualImports = [];
    const otherStmts = [];
    let seenNonImport = false;
    for (const item of parseTopLevelCssItems(stripped)) {
        if (item.kind === "block") {
            seenNonImport = true;
            issues.push(`${entryPath}: 样式入口清单不得直接内联规则块（${item.header || "{}"}）`);
            continue;
        }
        if (item.missingSemicolon) {
            issues.push(`${entryPath}: 存在缺少分号的顶层指令（${item.text.slice(0, 60)}）`);
            continue;
        }
        if (/^@import\b/.test(item.text)) {
            const imp = item.text.match(/^@import\s+(["'])([^"']+)\1\s*$/);
            if (!imp) {
                issues.push(`${entryPath}: 不支持的 @import 写法（${item.text}）`);
                continue;
            }
            if (seenNonImport) {
                issues.push(`${entryPath}: @import "${imp[2]}" 出现在 @source / @custom-variant / 规则之后`);
            }
            actualImports.push(imp[2]);
        } else {
            seenNonImport = true;
            otherStmts.push(normalizeCssText(item.text));
        }
    }

    const expectedAllImports = [...expectedPackageImports, ...expectedLocalImports];
    if (actualImports.length !== expectedAllImports.length) {
        issues.push(`${entryPath}: @import 数量异常（预期 ${expectedAllImports.length} 条，实际 ${actualImports.length} 条）`);
    } else {
        for (let i = 0; i < expectedAllImports.length; i++) {
            if (actualImports[i] !== expectedAllImports[i]) {
                issues.push(`${entryPath}: 第 ${i + 1} 条 @import 顺序偏移（预期 ${expectedAllImports[i]}，实际 ${actualImports[i]}）`);
                break;
            }
        }
    }

    const expectedDirSet = new Set(requiredDirectives.map(normalizeCssText));
    const actualDirCounts = new Map();
    for (const stmt of otherStmts) {
        if (!expectedDirSet.has(stmt)) {
            issues.push(`${entryPath}: 包含未登记的顶层指令（${stmt}）`);
        } else {
            actualDirCounts.set(stmt, (actualDirCounts.get(stmt) || 0) + 1);
        }
    }
    for (const expectedDir of expectedDirSet) {
        const count = actualDirCounts.get(expectedDir) || 0;
        if (count === 0) issues.push(`${entryPath}: 缺少必需顶层指令（${expectedDir}）`);
        else if (count > 1) issues.push(`${entryPath}: 重复出现必需顶层指令（${expectedDir}，共 ${count} 次）`);
    }

    const expectedSubPaths = new Set();
    for (const rel of expectedLocalImports) {
        const resolved = `web/src/styles/${rel.slice(2)}`;
        if (!availableCssSet.has(resolved)) issues.push(`${entryPath} 引用的模块不存在：${resolved}`);
        if (resolved.startsWith(dirPrefix)) expectedSubPaths.add(resolved);
    }

    for (const path of availableCssSet) {
        if (!path.startsWith(dirPrefix)) continue;
        if (!expectedSubPaths.has(path)) issues.push(`未从 ${entryPath} 引入的孤立样式模块：${path}`);
        const text = readIn(path);
        const lines = cssLineCount(text);
        if (lines > MAX_SPLIT_CSS_MODULE_LINES) {
            issues.push(`样式拆分模块超过 ${MAX_SPLIT_CSS_MODULE_LINES} 行上限：${path} (${lines} 行)`);
        }
        const balanceError = inspectBalancedCss(text);
        if (balanceError) {
            issues.push(`${path}: ${balanceError}`);
            continue;
        }
        const modStripped = stripCssComments(text);
        if (/^\s*@import\b/m.test(stripCssStrings(modStripped))) {
            issues.push(`${path}: 拆分模块内部不得再嵌套 @import`);
        }
        issues.push(...validateSplitModuleLayer(path, modStripped));
    }
    return issues;
}

const VALID_LAYER_MODES = new Set(["full:utilities", "mixed:base", "mixed:utilities", "unlayered"]);

function validateLayerModeRegistry() {
    const issues = [];
    const expectedSplitSet = new Set([
        ...GLOBALS_LOCAL_IMPORTS.filter((rel) => rel.startsWith("./globals/")),
        ...WORKSPACE_PRODUCT_LOCAL_IMPORTS.filter((rel) => rel.startsWith("./workspace-product/")),
    ]);
    for (const rel of expectedSplitSet) {
        if (!(rel in MODULE_LAYER_MODE)) issues.push(`MODULE_LAYER_MODE 缺少模块登记：${rel}`);
    }
    for (const [rel, mode] of Object.entries(MODULE_LAYER_MODE)) {
        if (!expectedSplitSet.has(rel)) issues.push(`MODULE_LAYER_MODE 包含过期或未知模块键：${rel}`);
        if (!VALID_LAYER_MODES.has(mode)) issues.push(`MODULE_LAYER_MODE[${rel}] 使用了未知层级模式：${mode}`);
    }
    return issues;
}

export function findStyleManifestIssues(webCssPaths, readIn) {
    const cssSet = new Set(webCssPaths);
    return [
        ...validateLayerModeRegistry(),
        ...validateManifestEntry(
            "web/src/styles/globals.css",
            {
                expectedPackageImports: GLOBALS_PACKAGE_IMPORTS,
                expectedLocalImports: GLOBALS_LOCAL_IMPORTS,
                requiredDirectives: GLOBALS_REQUIRED_DIRECTIVES,
                dirPrefix: "web/src/styles/globals/",
            },
            cssSet,
            readIn,
        ),
        ...validateManifestEntry(
            "web/src/styles/workspace-product.css",
            {
                expectedPackageImports: [],
                expectedLocalImports: WORKSPACE_PRODUCT_LOCAL_IMPORTS,
                requiredDirectives: [],
                dirPrefix: "web/src/styles/workspace-product/",
            },
            cssSet,
            readIn,
        ),
    ];
}
