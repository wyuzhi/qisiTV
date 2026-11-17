import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
import { inlineLocalCssImports } from "./app-style-source";

// 原始样式文本读取器：供单元测试与源码审计使用（计入 scripts/structure-budget.mjs 的读源码测试基线）。
export function readStyleSheet(entryPath: string): string {
    const file = resolve(import.meta.dir, "..", entryPath);
    return inlineLocalCssImports(
        readFileSync(file, "utf8"),
        (specifier, from) => {
            const id = resolve(dirname(from), specifier);
            return { id, css: readFileSync(id, "utf8") };
        },
        file,
    );
}

export function readAppGlobalsSource() {
    return readStyleSheet("../src/styles/globals.css");
}

export function readAppWorkspaceProductSource() {
    return readStyleSheet("../src/styles/workspace-product.css");
}

// 浏览器集成测试共用：编译真实的 globals.css（经过 Tailwind / PostCSS；仅注入 <style> 或页面样式服务时不计入读源码断言测试，传给 expect/assert 或用于非 Playwright 单元测试时计入）。
export async function compileAppGlobalsStyles() {
    const webRoot = import.meta.dir + "/../..";
    const globalsPath = webRoot + "/src/styles/globals.css";
    return (await postcss([tailwind({ base: webRoot })]).process(readAppGlobalsSource(), { from: globalsPath })).css;
}

// 组件浏览器测试共用：从源码编译工作台样式，不依赖构建产物（CI 的网页检查不跑 build）。
// extraCss 是测试入口自己打包出来的样式，拼在最后。
export async function compileAppStyles(extraCss: string[] = []) {
    const webRoot = import.meta.dir + "/../..";
    const compiled = await compileAppGlobalsStyles();
    return [compiled, readFileSync(webRoot + "/src/styles/beeftv-local-overrides.css", "utf8"), readAppWorkspaceProductSource(), ...extraCss].join("\n");
}
