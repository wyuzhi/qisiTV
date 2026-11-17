// 零依赖源码文本断言检测器（CI 在未安装 node_modules 阶段直接以纯 Node 运行）。
// 判定规则：
// - 非 Playwright 测试：调用源码/样式读取函数（含别名导入）或 ?raw 导入 src 文件，
//   或在打包插件钩子（onResolve / onLoad / alias / import()）之外以 src 路径调用读文件 API 时计入。
// - Playwright 浏览器测试：仅在将读取/编译出的样式或 src 文件文本传给 expect / assert
//   （含变量传递、路径变量、Bun.resolveSync、解构赋值、成员调用、别名与 ?raw 导入）时计入；
//   若仅注入 <style> 或测试服务器响应并断言真实渲染/计算样式，则不计入。

const READ_CALL = /\b(?:readFileSync|readdirSync|Bun\.file|readStyleSheet)\s*\(/;
const SRC_PATH = /["'`]\/?(?:\.\.\/)+src(?:\/[^"'`]*)?["'`]|["'`](?:web\/)?src\/[^"'`]+["'`]|\bsrcRoot\b/;
const RAW_SRC_SPECIFIER_RE = /^(?:@\/|\/?(?:\.\.\/)+src\/|(?:web\/)?src\/)[^"'`]*\?raw$/;
const IMPORT_STMT_RE = /^\s*import\s+([\s\S]*?)\s+from\s*["'`]([^"'`]+)["'`]\s*;?/gm;
const DYNAMIC_RAW_SRC_IMPORT_RE = /\bimport\s*\(\s*["'`](?:@\/|\/?(?:\.\.\/)+src\/|(?:web\/)?src\/)[^"'`]*\?raw["'`]\s*\)/;
const IMPORTS = /^\s*(?:import|export)\b[^;]*?\bfrom\s*["'`][^"'`]*["'`];?|^\s*import\s*["'`][^"'`]*["'`];?/gm;
const BUNDLER_ALIAS_RE = /\b(?:onResolve|onLoad)\s*\(|\balias\s*:|\bimport\s*\(/;

const CANONICAL_DIRECT_READERS = [
    "readAppGlobalsSource",
    "readAppWorkspaceProductSource",
    "compileAppGlobalsStyles",
    "compileAppStyles",
];
const CANONICAL_PATH_READERS = ["readStyleSheet", "readFileSync", "readdirSync"];

function escapeIdRegex(id) {
    return id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasTrackedIdentifier(span, ids) {
    if (ids.size === 0) return false;
    const alt = [...ids].map(escapeIdRegex).join("|");
    return new RegExp(`(?<![.\\w$])(?:${alt})(?![\\w$])`).test(span);
}

function findMatchingDelimiter(text, openIdx, openCh, closeCh) {
    let depth = 0;
    let quote = "";
    for (let i = openIdx; i < text.length; i++) {
        const ch = text[i];
        if (quote) {
            if (ch === "\\") {
                i++;
                continue;
            }
            if (ch === quote) quote = "";
            continue;
        }
        if (ch === "'" || ch === '"' || ch === "`") {
            quote = ch;
            continue;
        }
        if (ch === openCh) depth++;
        else if (ch === closeCh) {
            depth--;
            if (depth === 0) return i + 1;
        }
    }
    return -1;
}

export const findMatchingParen = (text, openIdx) => findMatchingDelimiter(text, openIdx, "(", ")");
const findMatchingBrace = (text, openIdx) => findMatchingDelimiter(text, openIdx, "{", "}");
const findMatchingBracket = (text, openIdx) => findMatchingDelimiter(text, openIdx, "[", "]");

function splitTopLevelCommas(text) {
    const parts = [];
    let paren = 0, bracket = 0, brace = 0, quote = "", start = 0;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (quote) {
            if (ch === "\\") i++;
            else if (ch === quote) quote = "";
            continue;
        }
        if (ch === "'" || ch === '"' || ch === "`") quote = ch;
        else if (ch === "(") paren++;
        else if (ch === ")" && paren > 0) paren--;
        else if (ch === "[") bracket++;
        else if (ch === "]" && bracket > 0) bracket--;
        else if (ch === "{") brace++;
        else if (ch === "}" && brace > 0) brace--;
        else if (ch === "," && paren === 0 && bracket === 0 && brace === 0) {
            parts.push(text.slice(start, i));
            start = i + 1;
        }
    }
    parts.push(text.slice(start));
    return parts;
}

function findTopLevelToken(text, tokenCh) {
    let paren = 0, bracket = 0, brace = 0, quote = "";
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (quote) {
            if (ch === "\\") i++;
            else if (ch === quote) quote = "";
            continue;
        }
        if (ch === "'" || ch === '"' || ch === "`") quote = ch;
        else if (ch === "(") paren++;
        else if (ch === ")" && paren > 0) paren--;
        else if (ch === "[") bracket++;
        else if (ch === "]" && bracket > 0) bracket--;
        else if (ch === "{") brace++;
        else if (ch === "}" && brace > 0) brace--;
        else if (paren === 0 && bracket === 0 && brace === 0 && ch === tokenCh) {
            if (tokenCh === "=" && (text[i + 1] === "=" || text[i + 1] === ">" || "!=<>".includes(text[i - 1] || ""))) continue;
            return i;
        }
    }
    return -1;
}

function extractBoundIdentifiers(pattern) {
    const trimmed = pattern.trim();
    if (/^[A-Za-z_$][\w$]*$/.test(trimmed)) return [trimmed];
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
        const out = [];
        for (const rawElem of splitTopLevelCommas(trimmed.slice(1, -1))) {
            let elem = rawElem.trim();
            if (!elem) continue;
            if (elem.startsWith("...")) elem = elem.slice(3).trim();
            const eqIdx = findTopLevelToken(elem, "=");
            if (eqIdx >= 0) elem = elem.slice(0, eqIdx).trim();
            out.push(...extractBoundIdentifiers(elem));
        }
        return out;
    }
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
        const out = [];
        for (const rawProp of splitTopLevelCommas(trimmed.slice(1, -1))) {
            let prop = rawProp.trim();
            if (!prop) continue;
            if (prop.startsWith("...")) {
                const restId = prop.slice(3).trim();
                if (/^[A-Za-z_$][\w$]*$/.test(restId)) out.push(restId);
                continue;
            }
            const colonIdx = findTopLevelToken(prop, ":");
            let target = colonIdx >= 0 ? prop.slice(colonIdx + 1).trim() : prop;
            const eqIdx = findTopLevelToken(target, "=");
            if (eqIdx >= 0) target = target.slice(0, eqIdx).trim();
            out.push(...extractBoundIdentifiers(target));
        }
        return out;
    }
    return [];
}

function extractDestructuredReaderAliases(pattern, directSet, pathSet) {
    const trimmed = pattern.trim();
    if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return;
    for (const rawProp of splitTopLevelCommas(trimmed.slice(1, -1))) {
        const prop = rawProp.trim();
        const colonIdx = findTopLevelToken(prop, ":");
        if (colonIdx < 0) continue;
        const orig = prop.slice(0, colonIdx).trim();
        let target = prop.slice(colonIdx + 1).trim();
        const eqIdx = findTopLevelToken(target, "=");
        if (eqIdx >= 0) target = target.slice(0, eqIdx).trim();
        if (!/^[A-Za-z_$][\w$]*$/.test(target)) continue;
        if (directSet.has(orig)) directSet.add(target);
        if (pathSet.has(orig)) pathSet.add(target);
    }
}

function extractImportBindings(noComments) {
    const rawImportIds = new Set();
    const importedDirectReaders = new Set();
    const importedPathReaders = new Set();
    const directSet = new Set(CANONICAL_DIRECT_READERS);
    const pathSet = new Set(CANONICAL_PATH_READERS);

    for (const match of noComments.matchAll(IMPORT_STMT_RE)) {
        const clause = match[1].trim();
        const specifier = match[2];
        if (/^type\s+/.test(clause)) continue;

        if (RAW_SRC_SPECIFIER_RE.test(specifier)) {
            const braceIdx = clause.indexOf("{");
            if (braceIdx >= 0) {
                const beforeBrace = clause.slice(0, braceIdx).replace(/,\s*$/, "").trim();
                if (/^[A-Za-z_$][\w$]*$/.test(beforeBrace)) rawImportIds.add(beforeBrace);
                const closeBrace = clause.indexOf("}", braceIdx);
                if (closeBrace > braceIdx) {
                    for (const rawSpec of clause.slice(braceIdx + 1, closeBrace).split(",")) {
                        const spec = rawSpec.trim();
                        if (!spec || /^type\s+/.test(spec)) continue;
                        const asMatch = spec.match(/^(?:[A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/);
                        if (asMatch) rawImportIds.add(asMatch[1]);
                        else if (/^[A-Za-z_$][\w$]*$/.test(spec)) rawImportIds.add(spec);
                    }
                }
            } else {
                const nsMatch = clause.match(/^\*\s*as\s+([A-Za-z_$][\w$]*)$/);
                if (nsMatch) rawImportIds.add(nsMatch[1]);
                else if (/^[A-Za-z_$][\w$]*$/.test(clause)) rawImportIds.add(clause);
            }
            continue;
        }

        const braceIdx = clause.indexOf("{");
        const closeBrace = braceIdx >= 0 ? clause.indexOf("}", braceIdx) : -1;
        if (braceIdx >= 0 && closeBrace > braceIdx) {
            for (const rawSpec of clause.slice(braceIdx + 1, closeBrace).split(",")) {
                const spec = rawSpec.trim();
                if (!spec || /^type\s+/.test(spec)) continue;
                const asMatch = spec.match(/^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/);
                const orig = asMatch ? asMatch[1] : spec;
                const local = asMatch ? asMatch[2] : spec;
                if (directSet.has(orig)) importedDirectReaders.add(local);
                if (pathSet.has(orig)) importedPathReaders.add(local);
            }
        }
    }

    return {
        rawImportIds: [...rawImportIds],
        importedDirectReaders: [...importedDirectReaders],
        importedPathReaders: [...importedPathReaders],
    };
}

function readRhsExpression(text, startIdx) {
    let parenDepth = 0, bracketDepth = 0, braceDepth = 0;
    let quote = "";
    let seenToken = false;
    for (let i = startIdx; i < text.length; i++) {
        const ch = text[i];
        if (quote) {
            seenToken = true;
            if (ch === "\\") {
                i++;
                continue;
            }
            if (ch === quote) quote = "";
            continue;
        }
        if (ch === "'" || ch === '"' || ch === "`") {
            seenToken = true;
            quote = ch;
            continue;
        }
        if (ch === "(") {
            seenToken = true;
            parenDepth++;
        } else if (ch === ")") {
            if (parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) return text.slice(startIdx, i);
            if (parenDepth > 0) parenDepth--;
        } else if (ch === "[") {
            seenToken = true;
            bracketDepth++;
        } else if (ch === "]") {
            if (parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) return text.slice(startIdx, i);
            if (bracketDepth > 0) bracketDepth--;
        } else if (ch === "{") {
            seenToken = true;
            braceDepth++;
        } else if (ch === "}") {
            if (parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) return text.slice(startIdx, i);
            if (braceDepth > 0) braceDepth--;
        } else if (parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
            if (ch === ";" || ch === ",") return text.slice(startIdx, i);
            if (ch === "\n") {
                if (seenToken) {
                    const rest = text.slice(i + 1).trimStart();
                    if (!/^[.?+,:|&]/.test(rest)) return text.slice(startIdx, i);
                }
            } else if (!/\s/.test(ch)) {
                seenToken = true;
            }
        } else if (!/\s/.test(ch)) {
            seenToken = true;
        }
    }
    return text.slice(startIdx);
}

function maskQuotedStrings(text) {
    let out = "";
    let quote = "";
    let prevSig = "";
    let prevWord = "";
    const regexPrefixWords = new Set(["return", "throw", "case", "in", "of", "typeof", "void", "delete", "await", "yield", "else"]);
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (quote) {
            out += ch === "\n" ? "\n" : " ";
            if (quote === "/" && ch === "[") {
                for (i++; i < text.length; i++) {
                    out += text[i] === "\n" ? "\n" : " ";
                    if (text[i] === "\\" && i + 1 < text.length) {
                        i++;
                        out += text[i] === "\n" ? "\n" : " ";
                        continue;
                    }
                    if (text[i] === "]") break;
                }
                continue;
            }
            if (ch === "\\" && i + 1 < text.length) {
                i++;
                out += text[i] === "\n" ? "\n" : " ";
                continue;
            }
            if (ch === quote || (quote === "/" && ch === "\n")) quote = "";
            continue;
        }
        if (ch === "'" || ch === '"' || ch === "`") {
            quote = ch;
            out += " ";
            prevSig = ch;
            prevWord = "";
            continue;
        }
        if (ch === "/" && text[i + 1] === "/") {
            out += "  ";
            for (i += 2; i < text.length && text[i] !== "\n"; i++) out += " ";
            if (i < text.length) out += "\n";
            continue;
        }
        if (ch === "/" && text[i + 1] === "*") {
            out += "  ";
            for (i += 2; i < text.length && !(text[i] === "*" && text[i + 1] === "/"); i++) {
                out += text[i] === "\n" ? "\n" : " ";
            }
            if (i + 1 < text.length) {
                out += "  ";
                i++;
            }
            continue;
        }
        if (ch === "/" && text[i + 1] !== "/" && text[i + 1] !== "*" && (prevSig === "" || "([,;={:!?~^+-*%<>|&".includes(prevSig) || regexPrefixWords.has(prevWord))) {
            quote = "/";
            out += " ";
            prevSig = "/";
            prevWord = "";
            continue;
        }
        if (/[A-Za-z_$]/.test(ch)) {
            let j = i + 1;
            while (j < text.length && /[\w$]/.test(text[j])) j++;
            prevWord = text.slice(i, j);
            prevSig = text[j - 1];
            out += prevWord;
            i = j - 1;
            continue;
        }
        if (!/\s/.test(ch)) {
            prevSig = ch;
            prevWord = "";
        }
        out += ch;
    }
    return out;
}

function blankRangePreservingNewlines(text, startIdx, endIdx) {
    let mid = "";
    for (let i = startIdx; i < endIdx; i++) {
        mid += text[i] === "\n" ? "\n" : " ";
    }
    return text.slice(0, startIdx) + mid + text.slice(endIdx);
}

// 将 builder.onResolve(...) / builder.onLoad(...) 整段抹空（保留换行），避免误伤内部 ../src 解析，
// 同时让测试体里真实的 Bun.resolveSync("../src/...") 被路径跟踪捕获。
function stripBundlerHooks(body, codeMask) {
    let cleanBody = body;
    let cleanMask = codeMask;
    let skipUntil = 0;
    const hookRe = /\.\s*(?:onResolve|onLoad)\s*\(/g;
    for (const match of codeMask.matchAll(hookRe)) {
        if (match.index < skipUntil) continue;
        const openIdx = match.index + match[0].length - 1;
        const afterClose = findMatchingParen(body, openIdx);
        if (afterClose > openIdx) {
            cleanBody = blankRangePreservingNewlines(cleanBody, match.index, afterClose);
            cleanMask = blankRangePreservingNewlines(cleanMask, match.index, afterClose);
            skipUntil = afterClose;
        }
    }
    return { body: cleanBody, codeMask: cleanMask };
}

function findAssignEqAfterPattern(body, codeMask, closeIdx) {
    const firstNonWs = codeMask.slice(closeIdx).search(/\S/);
    if (firstNonWs < 0) return -1;
    const firstCh = codeMask[closeIdx + firstNonWs];
    if (firstCh !== ":" && firstCh !== "=") return -1;
    let paren = 0, bracket = 0, brace = 0, angle = 0;
    for (let i = closeIdx + firstNonWs; i < codeMask.length; i++) {
        const ch = codeMask[i];
        if (ch === "(") paren++;
        else if (ch === ")" && paren > 0) paren--;
        else if (ch === "[") bracket++;
        else if (ch === "]" && bracket > 0) bracket--;
        else if (ch === "{") brace++;
        else if (ch === "}" && brace > 0) brace--;
        else if (ch === "<") angle++;
        else if (ch === ">" && angle > 0 && body[i - 1] !== "=") angle--;
        else if (paren === 0 && bracket === 0 && brace === 0 && angle === 0) {
            if (ch === ";") return -1;
            if (ch === "=" && body[i + 1] !== "=" && body[i + 1] !== ">" && !"!=<>".includes(body[i - 1] || "")) return i;
        }
    }
    return -1;
}

function collectVarBindings(body, codeMask) {
    const bindings = [];
    const destructPatterns = [];
    const assignRe = /(?:\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)(?:\s*:\s*[^=;\n]+)?|(?<![.\w$])([A-Za-z_$][\w$]*))\s*(?:\+=|(?<![=!<>+\-*/%&|^])=(?![=>]))/g;
    for (const match of codeMask.matchAll(assignRe)) {
        const id = match[1] || match[2];
        const rhs = readRhsExpression(body, match.index + match[0].length);
        bindings.push({ id, rhs });
    }
    const destructRe = /\b(?:const|let|var)\s*(?=[[{])/g;
    for (const match of codeMask.matchAll(destructRe)) {
        const patStart = match.index + match[0].length;
        const closeIdx = codeMask[patStart] === "["
            ? findMatchingBracket(body, patStart)
            : findMatchingBrace(body, patStart);
        if (closeIdx <= patStart) continue;
        const eqIdx = findAssignEqAfterPattern(body, codeMask, closeIdx);
        if (eqIdx < 0) continue;
        const pattern = body.slice(patStart, closeIdx);
        destructPatterns.push(pattern);
        const rhs = readRhsExpression(body, eqIdx + 1);
        for (const id of extractBoundIdentifiers(pattern)) bindings.push({ id, rhs });
    }
    const forOfRe = /\bfor\s*(?:await\s*)?\(\s*(?:const|let|var)\s+/g;
    for (const match of codeMask.matchAll(forOfRe)) {
        const patStart = match.index + match[0].length;
        const parenIdx = codeMask.indexOf("(", match.index);
        const afterParen = parenIdx >= 0 ? findMatchingParen(body, parenIdx) : -1;
        if (afterParen <= patStart) continue;
        let patEnd = -1;
        let ids = [];
        if (codeMask[patStart] === "[" || codeMask[patStart] === "{") {
            patEnd = codeMask[patStart] === "["
                ? findMatchingBracket(body, patStart)
                : findMatchingBrace(body, patStart);
            if (patEnd > patStart) ids = extractBoundIdentifiers(body.slice(patStart, patEnd));
        } else {
            const idMatch = codeMask.slice(patStart, afterParen - 1).match(/^([A-Za-z_$][\w$]*)/);
            if (idMatch) {
                patEnd = patStart + idMatch[1].length;
                ids = [idMatch[1]];
            }
        }
        if (ids.length === 0 || patEnd < 0) continue;
        const ofMatch = codeMask.slice(patEnd, afterParen - 1).match(/^\s+of\s+/);
        if (!ofMatch) continue;
        const rhs = body.slice(patEnd + ofMatch[0].length, afterParen - 1);
        for (const id of ids) bindings.push({ id, rhs });
    }
    return { bindings, destructPatterns };
}

function collectFunctionDefs(body, codeMask) {
    const defs = [];
    const fnDeclRe = /\b(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g;
    for (const match of codeMask.matchAll(fnDeclRe)) {
        const openParen = match.index + match[0].length - 1;
        const afterParams = findMatchingParen(body, openParen);
        if (afterParams < 0) continue;
        const paramsText = body.slice(openParen + 1, afterParams - 1);
        const sigTail = codeMask.slice(afterParams).match(/^\s*(?::[^{=;\n]+)?\{/);
        if (!sigTail) continue;
        const openBrace = afterParams + sigTail[0].length - 1;
        const afterBrace = findMatchingBrace(body, openBrace);
        if (afterBrace < 0) continue;
        defs.push({ fnName: match[1], paramsText, fnBody: body.slice(openBrace + 1, afterBrace - 1) });
    }
    const arrowRe = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)(?:\s*:\s*[^=;\n]+)?\s*=\s*(?:async\s*)?(?:(\([^)]*\))|([A-Za-z_$][\w$]*))\s*(?::\s*[^=;\n]+)?=>\s*/g;
    for (const match of codeMask.matchAll(arrowRe)) {
        const bodyStart = match.index + match[0].length;
        const paramsText = match[2] || match[3] || "";
        let fnBody = "";
        if (body[bodyStart] === "{") {
            const afterBrace = findMatchingBrace(body, bodyStart);
            fnBody = afterBrace > bodyStart ? body.slice(bodyStart + 1, afterBrace - 1) : "";
        } else {
            fnBody = readRhsExpression(body, bodyStart);
        }
        defs.push({ fnName: match[1], paramsText, fnBody });
    }
    return defs;
}

function buildFnCallPattern(canonicalNames, localNames, prefixExtra = []) {
    const branches = [];
    if (canonicalNames.length > 0) branches.push(`\\b(?:${canonicalNames.map(escapeIdRegex).join("|")})`);
    for (const prefix of prefixExtra) branches.push(prefix);
    if (localNames.size > 0) branches.push(`(?<![.\\w$])(?:${[...localNames].map(escapeIdRegex).join("|")})`);
    return new RegExp(`(?:${branches.join("|")})\\s*\\(`);
}

function playwrightAssertsSourceText(rawBody, importBindings) {
    const masked = maskQuotedStrings(rawBody);
    const { body, codeMask } = stripBundlerHooks(rawBody, masked);
    const { bindings, destructPatterns } = collectVarBindings(body, codeMask);

    const localDirectFns = new Set(importBindings.importedDirectReaders);
    const localPathFns = new Set(importBindings.importedPathReaders);
    const allDirectNames = new Set([...CANONICAL_DIRECT_READERS, ...localDirectFns]);
    const allPathNames = new Set([...CANONICAL_PATH_READERS, ...localPathFns]);
    for (const pattern of destructPatterns) {
        extractDestructuredReaderAliases(pattern, allDirectNames, allPathNames);
    }
    for (const name of allDirectNames) if (!CANONICAL_DIRECT_READERS.includes(name)) localDirectFns.add(name);
    for (const name of allPathNames) if (!CANONICAL_PATH_READERS.includes(name)) localPathFns.add(name);
    for (const { id, rhs } of bindings) {
        const rhsTrim = rhs.trim();
        const tailMatch = rhsTrim.match(/(?:^|\.)([A-Za-z_$][\w$]*)$/);
        if (!tailMatch) continue;
        const ref = tailMatch[1];
        if (CANONICAL_DIRECT_READERS.includes(ref) || localDirectFns.has(ref)) localDirectFns.add(id);
        if (CANONICAL_PATH_READERS.includes(ref) || localPathFns.has(ref)) localPathFns.add(id);
    }

    const initialPathCallRe = buildFnCallPattern(CANONICAL_PATH_READERS, localPathFns, ["\\bBun\\.file"]);
    const initialDirectRe = buildFnCallPattern(CANONICAL_DIRECT_READERS, localDirectFns);
    const srcPathVars = new Set();
    for (let pass = 0; pass < 2; pass++) {
        for (const { id, rhs } of bindings) {
            if (BUNDLER_ALIAS_RE.test(rhs) || initialPathCallRe.test(rhs) || initialDirectRe.test(rhs)) continue;
            if (SRC_PATH.test(rhs) || hasTrackedIdentifier(rhs, srcPathVars)) srcPathVars.add(id);
        }
    }

    const fnDefs = collectFunctionDefs(body, codeMask);
    for (let pass = 0; pass < 2; pass++) {
        const directCallRe = buildFnCallPattern(CANONICAL_DIRECT_READERS, localDirectFns);
        const pathCallRe = buildFnCallPattern(CANONICAL_PATH_READERS, localPathFns, ["\\bBun\\.file"]);
        for (const { fnName, paramsText, fnBody } of fnDefs) {
            const paramIds = new Set(paramsText.match(/[A-Za-z_$][\w$]*/g) ?? []);
            const unshadowedSrcVars = new Set([...srcPathVars].filter((id) => !paramIds.has(id)));
            const readsPath = pathCallRe.test(fnBody);
            const hasSrcTarget = SRC_PATH.test(fnBody) || hasTrackedIdentifier(fnBody, unshadowedSrcVars);
            if (directCallRe.test(fnBody) || DYNAMIC_RAW_SRC_IMPORT_RE.test(fnBody) || (readsPath && hasSrcTarget && !BUNDLER_ALIAS_RE.test(fnBody))) {
                localDirectFns.add(fnName);
            } else if (readsPath) {
                localPathFns.add(fnName);
            }
        }
    }

    const directCallRe = buildFnCallPattern(CANONICAL_DIRECT_READERS, localDirectFns);
    const pathCallReGlobal = new RegExp(buildFnCallPattern(CANONICAL_PATH_READERS, localPathFns, ["\\bBun\\.file"]).source, "g");
    const spanReadsSource = (span) => {
        if (directCallRe.test(span) || DYNAMIC_RAW_SRC_IMPORT_RE.test(span)) return true;
        for (const match of span.matchAll(pathCallReGlobal)) {
            const openIdx = match.index + match[0].length - 1;
            const afterClose = findMatchingParen(span, openIdx);
            const callArgs = span.slice(openIdx + 1, afterClose > 0 ? afterClose - 1 : span.length);
            if ((SRC_PATH.test(callArgs) || hasTrackedIdentifier(callArgs, srcPathVars)) && !BUNDLER_ALIAS_RE.test(callArgs)) {
                return true;
            }
        }
        return false;
    };

    const fnExprStartRe = /^\s*(?:(?:async\s+)?function\b|(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::\s*[^=;\n]+)?=>)/;
    const harnessRhsStartRe = /^\s*(?:await\s+)?(?:Bun\.(?:build|serve)|browser\.new(?:Page|Context)|page\.(?:evaluate|setContent|addStyleTag|goto|locator|getBy\w+)|createHash)\b/;
    const sourceResultVars = new Set(importBindings.rawImportIds);
    for (let pass = 0; pass < 2; pass++) {
        for (const { id, rhs } of bindings) {
            if (harnessRhsStartRe.test(rhs) || fnExprStartRe.test(rhs)) continue;
            if (spanReadsSource(rhs) || hasTrackedIdentifier(rhs, sourceResultVars)) sourceResultVars.add(id);
        }
    }

    const assertCallRe = /\b(?:expect(?:\.(?:poll|soft))?|assert(?:\.\w+)?)\s*\(/g;
    for (const match of codeMask.matchAll(assertCallRe)) {
        const openIdx = match.index + match[0].length - 1;
        const afterClose = findMatchingParen(body, openIdx);
        const argSpan = body.slice(openIdx + 1, afterClose > 0 ? afterClose - 1 : body.length);
        if (spanReadsSource(argSpan) || hasTrackedIdentifier(argSpan, sourceResultVars)) return true;
    }
    return false;
}

export function readsSourceText(text) {
    // Only strip full-line comments so JS regex literals such as /https?:\/\// stay intact.
    const noComments = text.replace(/^\s*\/\*[\s\S]*?\*\/\s*$/gm, "").replace(/^\s*\/\/.*$/gm, "");
    const importBindings = extractImportBindings(noComments);
    const rawBody = noComments.replace(IMPORTS, "");
    if (/\bfrom\s*["'`]playwright["'`]/.test(noComments)) return playwrightAssertsSourceText(rawBody, importBindings);

    const { body } = stripBundlerHooks(rawBody, maskQuotedStrings(rawBody));
    const directRe = buildFnCallPattern(CANONICAL_DIRECT_READERS, new Set(importBindings.importedDirectReaders));
    if (importBindings.rawImportIds.length > 0 || DYNAMIC_RAW_SRC_IMPORT_RE.test(body) || directRe.test(body)) return true;
    const pathRe = buildFnCallPattern(CANONICAL_PATH_READERS, new Set(importBindings.importedPathReaders), ["\\bBun\\.file"]);
    if (!pathRe.test(body)) return false;
    return body.split("\n").some((line) => SRC_PATH.test(line) && !BUNDLER_ALIAS_RE.test(line));
}
