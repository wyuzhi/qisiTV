import { expect, test } from "bun:test";
import postcss from "postcss";
import { inlineLocalCssImports } from "./helpers/app-style-source";

const modules: Record<string, string> = { "./tokens.css": ":root{--ink:#123456;--radius:7px}", "./map.css": "@theme inline{--color-ink:var(--ink)}", "./nested.css": '@import "./tokens.css";' };
const load = (specifier: string) => {
    if (!(specifier in modules)) throw new Error("Missing style module");
    return { id: specifier, css: modules[specifier] };
};

test("local imports preserve token values and cascade order, leaving package imports to the compiler", () => {
    const result = inlineLocalCssImports('@import "tailwindcss";\n@property --x{syntax:"*";inherits:false;initial-value:0}\n@import "./tokens.css";\n.page{color:var(--ink)}\n@import "./map.css";', load);
    const tree = postcss.parse(result);
    expect(tree.nodes.map((node) => (node.type === "rule" ? node.selector : node.type === "atrule" ? `${node.name}:${node.params}` : node.type))).toEqual(['import:"tailwindcss"', "property:--x", ":root", ".page", "theme:inline"]);
    const values: string[] = [];
    tree.walkDecls((node) => {
        if (node.prop.startsWith("--")) values.push(`${node.prop}:${node.value}`);
    });
    expect(values).toEqual(["--ink:#123456", "--radius:7px", "--color-ink:var(--ink)"]);
});

test("nested imports resolve once without duplicating the declarations", () => {
    const tree = postcss.parse(inlineLocalCssImports('@import "./nested.css";', load));
    expect(tree.nodes.filter((node) => node.type === "rule" && node.selector === ":root")).toHaveLength(1);
});

test("cycles and missing imports fail instead of silently dropping styles", () => {
    expect(() => inlineLocalCssImports('@import "./missing.css";', load)).toThrow("Missing style module");
    expect(() => inlineLocalCssImports('@import "./cycle.css";', () => ({ id: "cycle", css: '@import "./cycle.css";' }))).toThrow("cycle");
});

test("an import mentioned in a comment is not loaded", () => {
    expect(inlineLocalCssImports('/* @import "./missing.css"; */ .page{color:var(--ink)}', load)).toContain(".page");
});
