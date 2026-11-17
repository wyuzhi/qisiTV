// 零依赖 TS/TSX 词法与对象字面量检测器（CI 在未安装 node_modules 阶段直接以纯 Node 运行）。
// 禁止在 web/src/lib/task-outcome.ts 之外手拼同时含 phase + regenerate 属性的运行时对象字面量，
// 同时跳过 TS 类型字面量（type / interface / 参数与返回类型注解 / as / satisfies / 泛型参数）和对象解构模式。

export const TASK_OUTCOME_OWNER = "web/src/lib/task-outcome.ts";

const REGEX_PREFIX_KEYWORDS = new Set(["return", "case", "typeof", "void", "delete", "throw", "new", "in", "of", "yield", "await"]);
const REGEX_PREFIX_PUNCT = new Set(["(", "[", "{", ",", ";", ":", "=", "?", "!", "&", "|", "^", "~", "+", "-", "*", "%", "<", ">", "=>", "&&", "||", "??", "==", "===", "!=", "!==", "..."]);
const JSX_START_KEYWORDS = new Set(["return", "yield", "default", "case", "throw", "await"]);
const JSX_START_PUNCT = new Set(["(", "[", "{", ",", ";", ":", "=", "?", "=>", "&&", "||", "??", "!", "+", "-"]);
const TWO_CHAR_PUNCT = new Set(["=>", "&&", "||", "??", "?.", "==", "!=", "<=", ">=", "++", "--"]);
const THREE_CHAR_PUNCT = new Set(["===", "!==", "..."]);
const OBJECT_LITERAL_PRECEDING_PUNCT = new Set(["=", "(", "[", ",", "?", ":", "&&", "||", "??", "!", "+", "-", "==", "===", "!=", "!==", "..."]);
const OBJECT_LITERAL_PRECEDING_KEYWORDS = new Set(["return", "yield", "throw", "await", "void", "typeof", "delete", "case", "default", "of", "in"]);
const STMT_START_KEYWORDS = new Set(["export", "import", "const", "let", "var", "function", "class", "interface", "type", "return", "if", "for", "while", "switch", "try", "throw"]);
const NON_GENERIC_RECEIVER_KEYWORDS = new Set([
    ...STMT_START_KEYWORDS,
    ...OBJECT_LITERAL_PRECEDING_KEYWORDS,
    "else",
    "do",
    "finally",
    "catch",
    "instanceof",
    "as",
    "satisfies",
    "extends",
]);
const NON_TYPE_ARG_PUNCT = new Set([";", "=", "?", "&&", "||", "??", "?.", "==", "===", "!=", "!==", "<=", ">=", "+", "-", "*", "%", "++", "--"]);
const PARAM_MODIFIER_KEYWORDS = new Set(["public", "private", "protected", "readonly", "override"]);

function skipJsxGenericTypeArguments(text, startIdx) {
    if (text[startIdx] !== "<") return startIdx;
    let angleDepth = 0;
    let braceDepth = 0;
    let parenDepth = 0;
    let bracketDepth = 0;
    let quote = "";
    for (let i = startIdx; i < text.length; i++) {
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
        if (ch === "{") braceDepth++;
        else if (ch === "}") braceDepth = Math.max(0, braceDepth - 1);
        else if (ch === "(") parenDepth++;
        else if (ch === ")") parenDepth = Math.max(0, parenDepth - 1);
        else if (ch === "[") bracketDepth++;
        else if (ch === "]") bracketDepth = Math.max(0, bracketDepth - 1);
        else if (braceDepth === 0 && parenDepth === 0 && bracketDepth === 0) {
            if (ch === "<") angleDepth++;
            else if (ch === ">") {
                if (i > startIdx && text[i - 1] === "=") continue;
                angleDepth--;
                if (angleDepth === 0) return i + 1;
            }
        }
    }
    return -1;
}

function findJsxOpeningTagEnd(text, startIdx) {
    const attrStart = text[startIdx] === "<" ? skipJsxGenericTypeArguments(text, startIdx) : startIdx;
    if (attrStart < 0) return null;
    let braceDepth = 0;
    let quote = "";
    for (let i = attrStart; i < text.length; i++) {
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
        if (ch === "{") braceDepth++;
        else if (ch === "}") braceDepth = Math.max(0, braceDepth - 1);
        else if (ch === ">" && braceDepth === 0) {
            if (i > attrStart && text[i - 1] === "=") continue;
            return { attrStart, endIdx: i, selfClosing: text[i - 1] === "/" };
        }
    }
    return null;
}

export function tokenizeTsxForOutcomeCheck(text) {
    const tokens = [];
    const modes = [{ kind: "code" }];
    let i = 0;

    const canStartRegex = () => {
        const prev = tokens[tokens.length - 1];
        if (!prev) return true;
        if (prev.kind === "jsxOpenBrace") return true;
        if (prev.kind === "id") return REGEX_PREFIX_KEYWORDS.has(prev.value);
        if (prev.kind === "punct") return REGEX_PREFIX_PUNCT.has(prev.value);
        return false;
    };

    const canStartJsx = () => {
        const top = modes[modes.length - 1];
        if (top.kind === "jsxChildren") return true;
        const prev = tokens[tokens.length - 1];
        if (!prev || prev.kind === "jsxOpenBrace") return true;
        if (prev.kind === "id") return JSX_START_KEYWORDS.has(prev.value);
        if (prev.kind === "punct") return JSX_START_PUNCT.has(prev.value);
        return false;
    };

    const scanTemplateChunk = (startIdx) => {
        let cur = startIdx;
        let value = "";
        while (cur < text.length) {
            const ch = text[cur];
            if (ch === "\\") {
                value += text.slice(cur, cur + 2);
                cur += 2;
                continue;
            }
            if (ch === "`") {
                return { nextIdx: cur + 1, value, hasExpr: false };
            }
            if (ch === "$" && text[cur + 1] === "{") {
                return { nextIdx: cur + 2, value, hasExpr: true };
            }
            value += ch;
            cur++;
        }
        return { nextIdx: cur, value, hasExpr: false };
    };

    while (i < text.length) {
        const top = modes[modes.length - 1];
        if (top.kind === "jsxChildren") {
            const ch = text[i];
            if (ch === "{") {
                tokens.push({ kind: "jsxOpenBrace", value: "{" });
                modes.push({ kind: "jsxExpr", depth: 1 });
                i++;
                continue;
            }
            if (ch === "<") {
                if (text[i + 1] === "/") {
                    const closeGt = text.indexOf(">", i + 2);
                    modes.pop();
                    i = closeGt >= 0 ? closeGt + 1 : text.length;
                    continue;
                }
                if (text[i + 1] === ">") {
                    modes.push({ kind: "jsxChildren" });
                    i += 2;
                    continue;
                }
                const tagMatch = /^<([A-Za-z_$][\w$.:-]*)/.exec(text.slice(i));
                if (tagMatch) {
                    const tagInfo = findJsxOpeningTagEnd(text, i + tagMatch[0].length);
                    if (tagInfo) {
                        modes.push({ kind: "jsxTag", endIdx: tagInfo.endIdx, selfClosing: tagInfo.selfClosing });
                        tokens.push({ kind: "jsxTagOpen", value: "<" });
                        tokens.push({ kind: "id", value: tagMatch[1] });
                        i = tagInfo.attrStart;
                        continue;
                    }
                }
            }
            i++;
            continue;
        }

        if (top.kind === "jsxTag" && i >= top.endIdx) {
            const selfClosing = top.selfClosing;
            modes.pop();
            tokens.push({ kind: "jsxTagClose", value: ">" });
            if (!selfClosing) modes.push({ kind: "jsxChildren" });
            i = top.endIdx + 1;
            continue;
        }

        const ch = text[i];
        if (/\s/.test(ch)) {
            i++;
            continue;
        }
        if (ch === "/" && text[i + 1] === "/") {
            const nl = text.indexOf("\n", i + 2);
            i = nl >= 0 ? nl + 1 : text.length;
            continue;
        }
        if (ch === "/" && text[i + 1] === "*") {
            const endComment = text.indexOf("*/", i + 2);
            i = endComment >= 0 ? endComment + 2 : text.length;
            continue;
        }
        if (ch === "'" || ch === '"') {
            let cur = i + 1;
            let val = "";
            while (cur < text.length && text[cur] !== "\n") {
                if (text[cur] === "\\") {
                    val += text[cur + 1] ?? "";
                    cur += 2;
                    continue;
                }
                if (text[cur] === ch) {
                    cur++;
                    break;
                }
                val += text[cur];
                cur++;
            }
            tokens.push({ kind: "str", value: val });
            i = cur;
            continue;
        }
        if (ch === "`") {
            const chunk = scanTemplateChunk(i + 1);
            tokens.push({ kind: "str", value: chunk.hasExpr ? "`" : chunk.value, isTemplate: true });
            if (chunk.hasExpr) {
                tokens.push({ kind: "jsxOpenBrace", value: "${" });
                modes.push({ kind: "templateExpr", depth: 1 });
            }
            i = chunk.nextIdx;
            continue;
        }
        if (ch === "/" && text[i + 1] !== "/" && text[i + 1] !== "*" && canStartRegex()) {
            let cur = i + 1;
            let inCharClass = false;
            let matched = false;
            while (cur < text.length && text[cur] !== "\n") {
                if (text[cur] === "\\") {
                    cur += 2;
                    continue;
                }
                if (text[cur] === "[") inCharClass = true;
                else if (text[cur] === "]") inCharClass = false;
                else if (text[cur] === "/" && !inCharClass) {
                    cur++;
                    while (cur < text.length && /[A-Za-z]/.test(text[cur])) cur++;
                    matched = true;
                    break;
                }
                cur++;
            }
            if (matched) {
                tokens.push({ kind: "str", value: "/regex/" });
                i = cur;
                continue;
            }
        }
        if (ch === "<" && canStartJsx()) {
            if (text[i + 1] === ">" && text.includes("</>", i + 2)) {
                modes.push({ kind: "jsxChildren" });
                i += 2;
                continue;
            }
            const tagMatch = /^<([A-Za-z_$][\w$.:-]*)/.exec(text.slice(i));
            if (tagMatch) {
                const tagName = tagMatch[1];
                const tagInfo = findJsxOpeningTagEnd(text, i + tagMatch[0].length);
                if (tagInfo && (tagInfo.selfClosing || text.includes(`</${tagName}`, tagInfo.endIdx + 1))) {
                    modes.push({ kind: "jsxTag", endIdx: tagInfo.endIdx, selfClosing: tagInfo.selfClosing });
                    tokens.push({ kind: "jsxTagOpen", value: "<" });
                    tokens.push({ kind: "id", value: tagName });
                    i = tagInfo.attrStart;
                    continue;
                }
            }
        }
        if (ch === "{") {
            if (top.kind === "jsxTag") {
                tokens.push({ kind: "jsxOpenBrace", value: "{" });
                modes.push({ kind: "jsxExpr", depth: 1 });
                i++;
                continue;
            }
            if (top.kind === "jsxExpr" || top.kind === "templateExpr") top.depth++;
            tokens.push({ kind: "punct", value: "{" });
            i++;
            continue;
        }
        if (ch === "}") {
            if (top.kind === "jsxExpr") {
                top.depth--;
                if (top.depth === 0) {
                    modes.pop();
                    tokens.push({ kind: "jsxCloseBrace", value: "}" });
                    i++;
                    continue;
                }
            } else if (top.kind === "templateExpr") {
                top.depth--;
                if (top.depth === 0) {
                    modes.pop();
                    tokens.push({ kind: "jsxCloseBrace", value: "}" });
                    const chunk = scanTemplateChunk(i + 1);
                    if (chunk.hasExpr) {
                        tokens.push({ kind: "jsxOpenBrace", value: "${" });
                        modes.push({ kind: "templateExpr", depth: 1 });
                    }
                    i = chunk.nextIdx;
                    continue;
                }
            }
            tokens.push({ kind: "punct", value: "}" });
            i++;
            continue;
        }
        if (/[A-Za-z_$]/.test(ch)) {
            let cur = i + 1;
            while (cur < text.length && /[\w$]/.test(text[cur])) cur++;
            tokens.push({ kind: "id", value: text.slice(i, cur) });
            i = cur;
            continue;
        }
        if (/\d/.test(ch)) {
            let cur = i + 1;
            while (cur < text.length && /[\w.]/.test(text[cur])) cur++;
            tokens.push({ kind: "str", value: text.slice(i, cur) });
            i = cur;
            continue;
        }
        const three = text.slice(i, i + 3);
        if (THREE_CHAR_PUNCT.has(three)) {
            tokens.push({ kind: "punct", value: three });
            i += 3;
            continue;
        }
        const two = text.slice(i, i + 2);
        if (TWO_CHAR_PUNCT.has(two)) {
            tokens.push({ kind: "punct", value: two });
            i += 2;
            continue;
        }
        tokens.push({ kind: "punct", value: ch });
        i++;
    }
    return tokens;
}

function skipBalancedTokens(tokens, idx) {
    const open = tokens[idx]?.value;
    const close = open === "{" ? "}" : open === "(" ? ")" : open === "[" ? "]" : open === "<" ? ">" : "";
    if (!close) return idx + 1;
    let depth = 0;
    for (let i = idx; i < tokens.length; i++) {
        const tok = tokens[i];
        if (tok.kind === "punct" && tok.value === open) depth++;
        else if (tok.kind === "punct" && tok.value === close) {
            depth--;
            if (depth === 0) return i + 1;
        }
    }
    return tokens.length;
}

function skipTypeExpression(tokens, startIdx) {
    let i = startIdx;
    let angleDepth = 0;
    while (i < tokens.length) {
        const tok = tokens[i];
        if (tok.kind === "punct") {
            if (tok.value === "{" || tok.value === "(" || tok.value === "[") {
                i = skipBalancedTokens(tokens, i);
                continue;
            }
            if (tok.value === "<") {
                angleDepth++;
                i++;
                continue;
            }
            if (tok.value === ">") {
                if (angleDepth > 0) {
                    angleDepth--;
                    i++;
                    continue;
                }
                break;
            }
            if (angleDepth === 0 && (tok.value === "," || tok.value === ";" || tok.value === ")" || tok.value === "]" || tok.value === "}" || tok.value === "=" || tok.value === "=>")) {
                break;
            }
        }
        if (tok.kind === "jsxCloseBrace" && angleDepth === 0) break;
        i++;
    }
    return i;
}

function isParameterParenAt(tokens, openParenIdx) {
    const closeParenIdx = skipBalancedTokens(tokens, openParenIdx) - 1;
    if (closeParenIdx <= openParenIdx) return false;
    const prev = tokens[openParenIdx - 1];
    if (prev?.kind === "id" && prev.value === "function") return true;
    if (prev?.kind === "id" && tokens[openParenIdx - 2]?.kind === "id" && tokens[openParenIdx - 2].value === "function") return true;
    let after = closeParenIdx + 1;
    if (tokens[after]?.kind === "punct" && tokens[after].value === ":") {
        after = skipTypeExpression(tokens, after + 1);
    }
    return tokens[after]?.kind === "punct" && tokens[after].value === "=>";
}

function isDestructuringBrace(tokens, openBraceIdx, closeBraceIdx) {
    let after = closeBraceIdx + 1;
    if (tokens[after]?.kind === "punct" && tokens[after].value === ":") {
        after = skipTypeExpression(tokens, after + 1);
    }
    const next = tokens[after];
    if (next?.kind === "punct" && next.value === "=") return true;
    if (next?.kind === "id" && (next.value === "of" || next.value === "in")) return true;
    return false;
}

function inspectObjectLiteralProperties(tokens, openBraceIdx, closeBraceIdx) {
    let hasPhase = false;
    let hasRegenerate = false;
    let i = openBraceIdx + 1;

    while (i < closeBraceIdx) {
        const entryStart = i;
        while (i < closeBraceIdx) {
            const tok = tokens[i];
            if (tok.kind === "punct") {
                if (tok.value === ";") return false;
                if (tok.value === ",") break;
                if (tok.value === "{" || tok.value === "(" || tok.value === "[") {
                    i = skipBalancedTokens(tokens, i);
                    continue;
                }
            }
            i++;
        }
        const entryEnd = i;
        if (entryEnd > entryStart) {
            const first = tokens[entryStart];
            const second = entryStart + 1 < entryEnd ? tokens[entryStart + 1] : null;
            let propName = "";
            if ((first.kind === "id" || first.kind === "str") && second?.kind === "punct" && second.value === ":") {
                propName = first.value;
            } else if (
                first.kind === "punct" &&
                first.value === "[" &&
                entryStart + 3 < entryEnd &&
                tokens[entryStart + 1].kind === "str" &&
                tokens[entryStart + 2].kind === "punct" &&
                tokens[entryStart + 2].value === "]" &&
                tokens[entryStart + 3].kind === "punct" &&
                tokens[entryStart + 3].value === ":"
            ) {
                propName = tokens[entryStart + 1].value;
            } else if (first.kind === "id" && (!second || (second.kind === "punct" && second.value === "="))) {
                propName = first.value;
            }
            if (propName === "phase") hasPhase = true;
            else if (propName === "regenerate") hasRegenerate = true;
            if (hasPhase && hasRegenerate) return true;
        }
        i = entryEnd + 1;
    }
    return false;
}

function containsOnlyTypeArgumentTokens(tokens, startIdx, endIdx) {
    if (endIdx <= startIdx) return false;
    let i = startIdx;
    while (i < endIdx) {
        const tok = tokens[i];
        if (tok.kind === "punct") {
            if (tok.value === "{" || tok.value === "(" || tok.value === "[") {
                const next = skipBalancedTokens(tokens, i);
                if (next > endIdx) return false;
                i = next;
                continue;
            }
            if (NON_TYPE_ARG_PUNCT.has(tok.value)) return false;
            i++;
            continue;
        }
        if (tok.kind === "id") {
            if (STMT_START_KEYWORDS.has(tok.value)) return false;
            i++;
            continue;
        }
        if (tok.kind === "str") {
            i++;
            continue;
        }
        return false;
    }
    return true;
}

function isObjectExpressionPrefix(tok) {
    if (!tok) return false;
    return (
        tok.kind === "jsxOpenBrace" ||
        (tok.kind === "punct" && OBJECT_LITERAL_PRECEDING_PUNCT.has(tok.value)) ||
        (tok.kind === "id" && OBJECT_LITERAL_PRECEDING_KEYWORDS.has(tok.value))
    );
}

export function usesAdhocTaskOutcomeLiteral(text) {
    if (!text.includes("phase") || !text.includes("regenerate")) return false;
    const tokens = tokenizeTsxForOutcomeCheck(text);
    const typeBraces = new Set();
    const paramObjectBraces = new Set();
    const angleAssertionBraces = new Set();

    const markBracesInRange = (start, end) => {
        for (let k = start; k < end; k++) {
            if (tokens[k].kind === "punct" && tokens[k].value === "{") typeBraces.add(k);
        }
    };

    for (let i = 0; i < tokens.length; i++) {
        const tok = tokens[i];
        if (tok.kind === "id" && tok.value === "interface") {
            let cur = i + 1;
            while (cur < tokens.length && !(tokens[cur].kind === "punct" && (tokens[cur].value === "{" || tokens[cur].value === ";"))) {
                if (tokens[cur].kind === "punct" && tokens[cur].value === "<") {
                    const angleEnd = skipBalancedTokens(tokens, cur);
                    markBracesInRange(cur + 1, angleEnd - 1);
                    cur = angleEnd;
                    continue;
                }
                cur++;
            }
            if (tokens[cur]?.kind === "punct" && tokens[cur].value === "{") {
                const end = skipBalancedTokens(tokens, cur);
                markBracesInRange(cur, end);
                i = end - 1;
                continue;
            }
        }
        if (tok.kind === "id" && (tok.value === "function" || tok.value === "class")) {
            let cur = i + 1;
            if (tokens[cur]?.kind === "punct" && tokens[cur].value === "*") cur++;
            if (tokens[cur]?.kind === "id") cur++;
            if (tokens[cur]?.kind === "punct" && tokens[cur].value === "<") {
                const angleEnd = skipBalancedTokens(tokens, cur);
                markBracesInRange(cur + 1, angleEnd - 1);
            }
        }
        if (tok.kind === "id" && tok.value === "type" && tokens[i + 1]?.kind === "id") {
            const prev = tokens[i - 1];
            if (!prev || (prev.kind === "id" && prev.value === "export") || (prev.kind === "punct" && (prev.value === ";" || prev.value === "}" || prev.value === "{"))) {
                let cur = i + 2;
                if (tokens[cur]?.kind === "punct" && tokens[cur].value === "<") {
                    const angleEnd = skipBalancedTokens(tokens, cur);
                    markBracesInRange(cur + 1, angleEnd - 1);
                    cur = angleEnd;
                }
                if (tokens[cur]?.kind === "punct" && tokens[cur].value === "=") {
                    cur++;
                    while (cur < tokens.length) {
                        const t = tokens[cur];
                        if (t.kind === "punct" && t.value === "{") {
                            const end = skipBalancedTokens(tokens, cur);
                            markBracesInRange(cur, end);
                            cur = end;
                            continue;
                        }
                        if (t.kind === "punct" && (t.value === "(" || t.value === "[")) {
                            cur = skipBalancedTokens(tokens, cur);
                            continue;
                        }
                        if (t.kind === "punct" && t.value === ";") break;
                        if (t.kind === "id" && STMT_START_KEYWORDS.has(t.value) && tokens[cur - 1]?.value !== "|" && tokens[cur - 1]?.value !== "&" && tokens[cur - 1]?.value !== "extends") break;
                        cur++;
                    }
                    i = cur;
                    continue;
                }
            }
        }
        if (tok.kind === "id" && (tok.value === "as" || tok.value === "satisfies" || tok.value === "extends")) {
            const end = skipTypeExpression(tokens, i + 1);
            for (let k = i + 1; k < end; k++) if (tokens[k].kind === "punct" && tokens[k].value === "{") typeBraces.add(k);
            continue;
        }
        if (tok.kind === "punct" && tok.value === "(" && isParameterParenAt(tokens, i)) {
            const closeParen = skipBalancedTokens(tokens, i) - 1;
            let cur = i + 1;
            let atParamStart = true;
            while (cur < closeParen) {
                const paramTok = tokens[cur];
                if (paramTok.kind === "punct" && paramTok.value === ",") {
                    atParamStart = true;
                    cur++;
                    continue;
                }
                if (atParamStart && ((paramTok.kind === "punct" && paramTok.value === "...") || (paramTok.kind === "id" && PARAM_MODIFIER_KEYWORDS.has(paramTok.value)))) {
                    cur++;
                    continue;
                }
                if (atParamStart && (paramTok.kind === "punct" && (paramTok.value === "{" || paramTok.value === "["))) {
                    if (paramTok.value === "{") paramObjectBraces.add(cur);
                    cur = skipBalancedTokens(tokens, cur);
                    atParamStart = false;
                    continue;
                }
                if (!atParamStart && paramTok.kind === "punct" && paramTok.value === ":") {
                    const typeEnd = skipTypeExpression(tokens, cur + 1);
                    for (let k = cur + 1; k < typeEnd; k++) if (tokens[k].kind === "punct" && tokens[k].value === "{") typeBraces.add(k);
                    cur = typeEnd;
                    continue;
                }
                if (!atParamStart && paramTok.kind === "punct" && paramTok.value === "=") {
                    // 参数默认值是运行时表达式，不标为解构或类型，留给后续对象字面量扫描检查。
                    cur++;
                    while (cur < closeParen && !(tokens[cur].kind === "punct" && tokens[cur].value === ",")) {
                        if (tokens[cur].kind === "punct" && (tokens[cur].value === "(" || tokens[cur].value === "[" || tokens[cur].value === "{")) {
                            cur = skipBalancedTokens(tokens, cur);
                            continue;
                        }
                        cur++;
                    }
                    continue;
                }
                atParamStart = false;
                cur++;
            }
        }
    }

    const scopeStack = [];
    for (let i = 0; i < tokens.length; i++) {
        const tok = tokens[i];
        if (tok.kind === "punct" && (tok.value === "(" || tok.value === "[")) {
            scopeStack.push({ kind: tok.value, ternaryDepth: 0 });
            continue;
        }
        if (tok.kind === "punct" && (tok.value === ")" || tok.value === "]")) {
            scopeStack.pop();
            continue;
        }
        if (tok.kind === "jsxOpenBrace") {
            scopeStack.push({ kind: "jsxExpr", ternaryDepth: 0 });
            continue;
        }
        if (tok.kind === "jsxCloseBrace") {
            scopeStack.pop();
            continue;
        }
        if (tok.kind === "punct" && tok.value === "?") {
            const next = tokens[i + 1];
            const prev = tokens[i - 1];
            const isOptionalPropOrParam = prev?.kind === "id" && next?.kind === "punct" && next.value === ":";
            if (!isOptionalPropOrParam) {
                if (scopeStack.length) scopeStack[scopeStack.length - 1].ternaryDepth++;
                else scopeStack.push({ kind: "root", ternaryDepth: 1 });
            }
            continue;
        }
        if (tok.kind === "punct" && tok.value === ":") {
            const currentScope = scopeStack[scopeStack.length - 1];
            if (currentScope && currentScope.ternaryDepth > 0) {
                currentScope.ternaryDepth--;
                continue;
            }
            if (currentScope?.kind === "object") {
                continue;
            }
            const typeEnd = skipTypeExpression(tokens, i + 1);
            for (let k = i + 1; k < typeEnd; k++) if (tokens[k].kind === "punct" && tokens[k].value === "{") typeBraces.add(k);
            continue;
        }
        if (tok.kind === "punct" && tok.value === "<") {
            const prev = tokens[i - 1];
            const closeAngle = skipBalancedTokens(tokens, i);
            if (closeAngle <= tokens.length && tokens[closeAngle - 1]?.kind === "punct" && tokens[closeAngle - 1]?.value === ">") {
                const after = tokens[closeAngle];
                if (after?.kind === "punct" && after.value === "(" && isParameterParenAt(tokens, closeAngle)) {
                    markBracesInRange(i + 1, closeAngle - 1);
                    continue;
                }
                if (containsOnlyTypeArgumentTokens(tokens, i + 1, closeAngle - 1)) {
                    const isGenericReceiver =
                        prev &&
                        ((prev.kind === "id" && !NON_GENERIC_RECEIVER_KEYWORDS.has(prev.value)) ||
                            (prev.kind === "punct" && (prev.value === "." || prev.value === "?.")));
                    const isGenericCallContinuation =
                        after &&
                        ((after.kind === "punct" && (after.value === "(" || after.value === "." || after.value === "?." || after.value === "[")) ||
                            (after.kind === "str" && Boolean(after.isTemplate)));
                    const isGenericCall = Boolean(isGenericReceiver && isGenericCallContinuation);
                    const isAngleTypeAssertion = isObjectExpressionPrefix(prev) && after?.kind === "punct" && after.value === "{";
                    if (isGenericCall || isAngleTypeAssertion) {
                        markBracesInRange(i + 1, closeAngle - 1);
                        if (isAngleTypeAssertion) angleAssertionBraces.add(closeAngle);
                    }
                }
            }
            continue;
        }
        if (tok.kind === "punct" && tok.value === "}") {
            if (scopeStack[scopeStack.length - 1]?.kind === "object" || scopeStack[scopeStack.length - 1]?.kind === "block") {
                scopeStack.pop();
            }
            continue;
        }
        if (tok.kind === "punct" && tok.value === "{") {
            if (typeBraces.has(i) || paramObjectBraces.has(i)) {
                scopeStack.push({ kind: "block", ternaryDepth: 0 });
                continue;
            }
            const closeBrace = skipBalancedTokens(tokens, i) - 1;
            if (closeBrace <= i || isDestructuringBrace(tokens, i, closeBrace)) {
                scopeStack.push({ kind: "block", ternaryDepth: 0 });
                continue;
            }
            const prev = tokens[i - 1];
            if (!isObjectExpressionPrefix(prev) && !angleAssertionBraces.has(i)) {
                scopeStack.push({ kind: "block", ternaryDepth: 0 });
                continue;
            }
            if (inspectObjectLiteralProperties(tokens, i, closeBrace)) return true;
            scopeStack.push({ kind: "object", ternaryDepth: 0 });
        }
    }
    return false;
}

export function findAdhocTaskOutcomes(webTsFiles, readText) {
    return webTsFiles
        .filter((path) => path !== TASK_OUTCOME_OWNER && !path.endsWith(".d.ts") && usesAdhocTaskOutcomeLiteral(readText(path)))
        .sort();
}
