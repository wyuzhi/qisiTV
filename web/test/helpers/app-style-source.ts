import postcss from "postcss";

type StyleLoader = (specifier: string, from: string) => { id: string; css: string };

/** Flattens the app's plain local CSS imports for raw-style browser fixtures. */
export function inlineLocalCssImports(source: string, load: StyleLoader, from = "globals.css", ancestors: string[] = []): string {
    // Loader IDs track file context below; passing `from` makes old Bun browser
    // bundles resolve Node paths through a process-dependent polyfill.
    const tree = postcss.parse(source);
    tree.walkAtRules("import", (rule) => {
        const match = rule.params.match(/^(["'])(\.[^"']+\.css)\1$/);
        if (!match) {
            if (/^(?:url\(\s*)?["']?\./.test(rule.params)) throw new Error(`Unsupported local CSS import: ${rule.params}`);
            return;
        }
        const imported = load(match[2], from);
        if ([...ancestors, from].includes(imported.id)) throw new Error(`Local CSS import cycle: ${imported.id}`);
        const replacement = postcss.parse(inlineLocalCssImports(imported.css, load, imported.id, [...ancestors, from]));
        if (replacement.first) replacement.first.raws.before = rule.raws.before + (replacement.first.raws.before || "");
        rule.replaceWith(...replacement.nodes);
    });
    return tree.toString();
}
