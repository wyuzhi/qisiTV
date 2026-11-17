// 零依赖 Tailwind v4 TS/TSX `!important` 修饰符识别器（随 structure-budget.mjs 在 CI 安装依赖前纯 Node 运行）。
// 同时支持前导 `!`（如 `!p-0`）与 Tailwind v4 尾随 `!`（如 `h-full!`、`shadow/50%!`、`bg-(--brand)!`），
// 并在保持对引号注释与任意值括号追踪的前提下过滤常规 TS 非空断言与自然语言感叹号。

// Tailwind v4 全部 40 个无连字符实用类（经 tailwindcss compile(globals.css) 全量校验）
export const TAILWIND_BARE_UTILITIES = [
    "absolute", "antialiased", "block", "blur", "border", "capitalize", "collapse", "container",
    "contents", "filter", "fixed", "flex", "grayscale", "grid", "grow", "hidden", "inline",
    "invert", "invisible", "isolate", "italic", "lowercase", "ordinal", "outline", "overline",
    "relative", "resize", "ring", "sepia", "shadow", "shrink", "static", "sticky", "table",
    "transform", "transition", "truncate", "underline", "uppercase", "visible",
];

const TAILWIND_BARE_UTILITY_SET = new Set(TAILWIND_BARE_UTILITIES);
// Tailwind 4.3.3 实测仅无连字符 utility `shadow` 支持 `/opacity`（含 `/50%`），border/flex/ring/outline/50! 均不生成规则
const TAILWIND_BARE_SLASH_UTILITIES = new Set(["shadow"]);
// 经 Tailwind 4.3.3 compile(globals.css) 全量校验：`/N%` 仅对这些真实存在的阴影透明度通道 stem 生效（排除 *-none 与裸 inset/text-shadow）
const SHADOW_ALPHA_STEMS = new Set([
    "shadow", "shadow-2xs", "shadow-xs", "shadow-sm", "shadow-md", "shadow-lg", "shadow-xl", "shadow-2xl", "shadow-inner",
    "inset-shadow-2xs", "inset-shadow-xs", "inset-shadow-sm",
    "text-shadow-2xs", "text-shadow-xs", "text-shadow-sm", "text-shadow-md", "text-shadow-lg",
    "shadow-[]", "shadow-()", "inset-shadow-[]", "inset-shadow-()", "text-shadow-[]", "text-shadow-()",
]);

function isValidTailwindVarShorthand(inner) {
    let b = 0;
    let p = 0;
    let quote = "";
    let commaIdx = -1;
    for (let i = 0; i < inner.length; i++) {
        const ch = inner[i];
        if (quote) {
            if (ch === "\\" && i + 1 < inner.length) i++;
            else if (ch === quote) quote = "";
            continue;
        }
        if (ch === "'" || ch === '"') {
            quote = ch;
            continue;
        }
        if (ch === "[") b++;
        else if (ch === "]") b--;
        else if (ch === "(") p++;
        else if (ch === ")") p--;
        else if (ch === "," && b === 0 && p === 0) {
            commaIdx = i;
            break;
        }
    }
    const varName = commaIdx >= 0 ? inner.slice(0, commaIdx) : inner;
    return /^--[A-Za-z0-9_-]+$/.test(varName);
}

// 结构化归一化判定 Tailwind v4 !important token：
// 1. 按顶层（方/圆括号深度为 0 且在引号外）的 `:` 剥离变体前缀（如 hover: / [&_.lucide]: / [&[data-x=':foo']]:）
// 2. 剥离单个前导或尾随 `!`（仅在任意值外部拒绝多余 `!`，允许 `content-['!']!` 等任意值内部 `!`）
// 3. 引号感知地校验 `[...]` / `(--var[,fallback])` 与 `/opacity` 结构
export function isTailwindImportantToken(token) {
    if (!token || !token.includes("!")) return false;
    let bracketDepth = 0;
    let parenDepth = 0;
    let variantQuote = "";
    let start = 0;
    for (let i = 0; i < token.length; i++) {
        const ch = token[i];
        if (variantQuote) {
            if (ch === "\\" && i + 1 < token.length) i++;
            else if (ch === variantQuote) variantQuote = "";
            continue;
        }
        if ((ch === "'" || ch === '"') && (bracketDepth > 0 || parenDepth > 0)) {
            variantQuote = ch;
            continue;
        }
        if (ch === "[") bracketDepth++;
        else if (ch === "]") {
            if (--bracketDepth < 0) return false;
        } else if (ch === "(") parenDepth++;
        else if (ch === ")") {
            if (--parenDepth < 0) return false;
        } else if (ch === ":" && bracketDepth === 0 && parenDepth === 0) {
            if (i === start) return false;
            start = i + 1;
        }
    }
    if (variantQuote || bracketDepth !== 0 || parenDepth !== 0 || start >= token.length) return false;

    const core = token.slice(start);
    const hasLeading = core.startsWith("!");
    const hasTrailing = core.endsWith("!");
    if (hasLeading === hasTrailing) return false;
    const body = hasLeading ? core.slice(1) : core.slice(0, -1);
    if (!body) return false;
    if (TAILWIND_BARE_UTILITY_SET.has(body)) return true;

    let outer = "";
    let hasArbitrary = false;
    let bDepth = 0;
    let pDepth = 0;
    let bodyQuote = "";
    let topKind = "";
    let segStart = -1;
    for (let i = 0; i < body.length; i++) {
        const ch = body[i];
        if (bodyQuote) {
            if (ch === "\\" && i + 1 < body.length) i++;
            else if (ch === bodyQuote) bodyQuote = "";
            continue;
        }
        if (ch === "'" || ch === '"') {
            if (!topKind) return false;
            bodyQuote = ch;
            continue;
        }
        if (!topKind) {
            if (ch === "[") {
                topKind = "bracket";
                bDepth = 1;
                segStart = i + 1;
            } else if (ch === "(") {
                if (body.slice(i + 1, i + 3) !== "--") return false;
                topKind = "paren";
                pDepth = 1;
                segStart = i + 1;
            } else if (ch === "]" || ch === ")" || ch === "!") {
                return false;
            } else {
                outer += ch;
            }
            continue;
        }
        if (ch === "[") bDepth++;
        else if (ch === "]") {
            if (--bDepth < 0) return false;
        } else if (ch === "(") pDepth++;
        else if (ch === ")") {
            if (--pDepth < 0) return false;
        }
        if (topKind === "bracket" && bDepth === 0) {
            if (pDepth !== 0 || i <= segStart) return false;
            hasArbitrary = true;
            outer += "[]";
            topKind = "";
        } else if (topKind === "paren" && pDepth === 0) {
            if (bDepth !== 0 || !isValidTailwindVarShorthand(body.slice(segStart, i))) return false;
            hasArbitrary = true;
            outer += "()";
            topKind = "";
        }
    }
    if (bodyQuote || topKind || bDepth !== 0 || pDepth !== 0) return false;

    const slashIdx = outer.indexOf("/");
    let stem = outer;
    let suffix = "";
    if (slashIdx >= 0) {
        if (slashIdx === 0) return false;
        stem = outer.slice(0, slashIdx);
        suffix = outer.slice(slashIdx + 1);
        if (!suffix || suffix.includes("/")) return false;
        if (suffix.endsWith("%")) {
            if (!SHADOW_ALPHA_STEMS.has(stem) || !/^\d+(?:\.\d+)?%$/.test(suffix)) return false;
        } else if (!/^(?:\[\]|\(\)|[a-z0-9_.-]+)$/.test(suffix)) {
            return false;
        }
    }

    if (TAILWIND_BARE_UTILITY_SET.has(stem)) {
        return slashIdx < 0 || (TAILWIND_BARE_SLASH_UTILITIES.has(stem) && /^(?:\[\]|\(\)|\d+(?:\.\d+)?%?)$/.test(suffix));
    }
    if (stem === "()") return false;
    if (stem === "[]") return body.includes(":");
    if (!hasArbitrary && !stem.includes("-")) return false;
    return /^-?[a-z][a-z0-9_.]*(?:-(?:[a-z0-9_.]+|\[\]|\(\)))+$/.test(stem);
}

const REGEX_PREFIX_WORDS = new Set(["return", "throw", "case", "in", "of", "typeof", "void", "delete", "await", "yield", "else"]);

function extractJsStringChunks(src) {
    const chunks = [];
    let prevSig = "";
    let prevTwo = "";
    let prevWord = "";

    function scanExpr(i, stopBrace) {
        while (i < src.length) {
            const ch = src[i];
            if (stopBrace && ch === "}") return i + 1;
            if (ch === "{") {
                prevTwo = prevSig + "{";
                prevSig = "{";
                prevWord = "";
                i = scanExpr(i + 1, true);
                continue;
            }
            if (ch === "/" && src[i + 1] === "/") {
                while (i < src.length && src[i] !== "\n") i++;
                continue;
            }
            if (ch === "/" && src[i + 1] === "*") {
                i += 2;
                while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
                i += 2;
                continue;
            }
            if (
                ch === "/" &&
                src[i - 1] !== "<" &&
                src[i + 1] !== "/" &&
                src[i + 1] !== "*" &&
                (prevSig === "" || "([,;={:!?~^+-*%&|".includes(prevSig) || prevTwo === "=>" || REGEX_PREFIX_WORDS.has(prevWord))
            ) {
                i++;
                while (i < src.length && src[i] !== "/" && src[i] !== "\n") {
                    if (src[i] === "\\") {
                        i += 2;
                        continue;
                    }
                    if (src[i] === "[") {
                        i++;
                        while (i < src.length && src[i] !== "]" && src[i] !== "\n") {
                            if (src[i] === "\\") i++;
                            i++;
                        }
                    }
                    i++;
                }
                prevTwo = prevSig + "/";
                prevSig = "/";
                prevWord = "";
                i++;
                continue;
            }
            if (ch === "'" || ch === '"' || ch === "`") {
                const quote = ch;
                i++;
                let buf = "";
                while (i < src.length && src[i] !== quote) {
                    if ((quote === "'" || quote === '"') && src[i] === "\n") break;
                    if (src[i] === "\\") {
                        if (i + 1 < src.length) i += 2;
                        else i++;
                        continue;
                    }
                    if (quote === "`" && src[i] === "$" && src[i + 1] === "{") {
                        chunks.push(buf);
                        buf = "";
                        prevTwo = "";
                        prevSig = "{";
                        prevWord = "";
                        i = scanExpr(i + 2, true);
                        continue;
                    }
                    buf += src[i++];
                }
                chunks.push(buf);
                prevTwo = prevSig + quote;
                prevSig = quote;
                prevWord = "";
                if (i < src.length && src[i] === quote) i++;
                continue;
            }
            if (/[A-Za-z_$]/.test(ch)) {
                let j = i + 1;
                while (j < src.length && /[\w$]/.test(src[j])) j++;
                prevWord = src.slice(i, j);
                prevTwo = src.slice(Math.max(0, j - 2), j);
                prevSig = src[j - 1];
                i = j;
                continue;
            }
            if (!/\s/.test(ch)) {
                prevTwo = prevSig + ch;
                prevSig = ch;
                prevWord = "";
            }
            i++;
        }
        return i;
    }

    scanExpr(0, false);
    return chunks;
}

export function countTailwindImportant(tsSource) {
    let count = 0;
    for (const chunk of extractJsStringChunks(tsSource)) {
        for (const token of chunk.split(/\s+/)) {
            if (isTailwindImportantToken(token)) count++;
        }
    }
    return count;
}
