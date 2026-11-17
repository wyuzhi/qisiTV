import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const WEB_ROOT = path.resolve(import.meta.dir, "..");
const SRC_ROOT = path.join(WEB_ROOT, "src");
const ENTRY_FILE = path.join(SRC_ROOT, "pages/canvas/project.tsx");

const SOURCE_EXTENSIONS = [".tsx", ".ts", ".jsx", ".js", ".mjs"];

function resolveLocalModule(fromFile: string, specifier: string): string | null {
    let base: string | null = null;
    if (specifier.startsWith("@/")) {
        base = path.join(SRC_ROOT, specifier.slice(2));
    } else if (specifier.startsWith("./") || specifier.startsWith("../")) {
        base = path.resolve(path.dirname(fromFile), specifier);
    } else {
        return null;
    }

    const candidates = [
        base,
        ...SOURCE_EXTENSIONS.map((ext) => `${base}${ext}`),
        ...SOURCE_EXTENSIONS.map((ext) => path.join(base, `index${ext}`)),
    ];
    for (const candidate of candidates) {
        if (existsSync(candidate) && statSync(candidate).isFile()) {
            return candidate;
        }
    }
    return null;
}

function collectStaticImportClosure(entryFile: string) {
    const visitedFiles = new Set<string>();
    const externalPackages = new Set<string>();
    const edgePaths = new Map<string, string[]>();
    const queue: Array<{ file: string; chain: string[] }> = [{ file: entryFile, chain: [path.relative(SRC_ROOT, entryFile)] }];
    visitedFiles.add(entryFile);

    while (queue.length > 0) {
        const current = queue.shift()!;
        const ext = path.extname(current.file).replace(/^\./, "");
        const loader = (ext === "tsx" || ext === "ts" || ext === "jsx" || ext === "js") ? ext : "js";
        const transpiler = new Bun.Transpiler({ loader });
        const source = readFileSync(current.file, "utf8");

        for (const entry of transpiler.scanImports(source)) {
            if (entry.kind !== "import-statement") continue;
            const resolved = resolveLocalModule(current.file, entry.path);
            if (!resolved) {
                externalPackages.add(entry.path);
                if (!edgePaths.has(entry.path)) edgePaths.set(entry.path, [...current.chain, entry.path]);
                continue;
            }
            if (!SOURCE_EXTENSIONS.includes(path.extname(resolved))) continue;
            if (!visitedFiles.has(resolved)) {
                visitedFiles.add(resolved);
                const nextChain = [...current.chain, path.relative(SRC_ROOT, resolved)];
                edgePaths.set(path.relative(SRC_ROOT, resolved), nextChain);
                queue.push({ file: resolved, chain: nextChain });
            }
        }
    }

    return {
        files: new Set([...visitedFiles].map((file) => path.relative(SRC_ROOT, file))),
        externalPackages,
        edgePaths,
    };
}

describe("canvas initial static import boundaries", () => {
    test("pages/canvas/project.tsx static closure excludes heavy 3D, chart, rich-text editor, and lazy modal modules", () => {
        const closure = collectStaticImportClosure(ENTRY_FILE);

        const forbiddenExternals = [
            "three",
            "@react-three/fiber",
            "@react-three/drei",
            "recharts",
            "@reduxjs/toolkit",
            "@tiptap/core",
            "@tiptap/react",
            "@tiptap/starter-kit",
        ];
        for (const pkg of forbiddenExternals) {
            const matched = [...closure.externalPackages].filter((item) => item === pkg || item.startsWith(`${pkg}/`));
            expect({ pkg, matched, chain: matched.map((item) => closure.edgePaths.get(item)) }).toEqual({
                pkg,
                matched: [],
                chain: [],
            });
        }

        const forbiddenModules = [
            "components/canvas/canvas-node-emotion-panel.tsx",
            "components/canvas/canvas-node-lighting-dialog.tsx",
            "components/canvas/nodes/chart-node.tsx",
            "components/canvas/canvas-text-editor-modal.tsx",
            "components/canvas/asset-picker-modal.tsx",
            "components/canvas/canvas-style-picker-modal.tsx",
            "components/canvas/canvas-timeline-dialog.tsx",
            "components/canvas/director/canvas-director-workbench.tsx",
            "components/canvas/canvas-character-reference-modal.tsx",
            "components/canvas/canvas-folder-browser-modal.tsx",
            "components/canvas/canvas-generation-history-picker.tsx",
            "components/canvas/canvas-node-search-modal.tsx",
            "components/canvas/canvas-panorama-config-modal.tsx",
            "components/canvas/canvas-project-asset-modal.tsx",
            "components/canvas/canvas-subtitle-dialog.tsx",
            "components/canvas/canvas-version-compare-modal.tsx",
            "components/canvas/canvas-video-frame-dialog.tsx",
            "components/canvas/video-subtitle-erase-dialog.tsx",
            "components/canvas/canvas-drawing-editor-modal.tsx",
            "components/canvas/canvas-node-upscale-dialog.tsx",
            "pages/canvas/components/libtv-import-dialog.tsx",
            "pages/canvas/components/tapnow-import-dialog.tsx",
        ];
        for (const mod of forbiddenModules) {
            expect({ mod, exists: existsSync(path.join(SRC_ROOT, mod)) }).toEqual({ mod, exists: true });
            expect({ mod, present: closure.files.has(mod), chain: closure.edgePaths.get(mod) ?? null }).toEqual({
                mod,
                present: false,
                chain: null,
            });
        }
    });

    test("plugin-host-capabilities.ts and router.tsx static closures exclude canvas generation and local preprocess runtimes", () => {
        for (const entryRel of ["lib/plugins/plugin-host-capabilities.ts", "router.tsx"]) {
            const closure = collectStaticImportClosure(path.join(SRC_ROOT, entryRel));
            for (const mod of [
                "components/canvas/canvas-node-generation.ts",
                "services/depth-runtime.ts",
                "services/lineart-runtime.ts",
                "services/pose-runtime.ts",
                "services/approved-tool-execution.ts",
            ]) {
                expect({ entryRel, mod, exists: existsSync(path.join(SRC_ROOT, mod)) }).toEqual({
                    entryRel,
                    mod,
                    exists: true,
                });
                expect({
                    entryRel,
                    mod,
                    present: closure.files.has(mod),
                    chain: closure.edgePaths.get(mod) ?? null,
                }).toEqual({
                    entryRel,
                    mod,
                    present: false,
                    chain: null,
                });
            }
        }
    });
});
