import { dirname, resolve } from "node:path";
import { readFileSync, readdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

import { resolveHeavyMediaEnabled } from "./media-build-mode";

const webDir = dirname(fileURLToPath(import.meta.url));
const appVersion = process.env.CANVAS_BUILD_VERSION?.trim() || readFileSync(resolve(webDir, "../VERSION"), "utf8").trim();
const appChangelog = readFileSync(resolve(webDir, "../CHANGELOG.md"), "utf8");
const apiProxyTarget = process.env.VITE_API_PROXY_TARGET?.trim() || "http://127.0.0.1:8080";
const desktopLaunchToken = process.env.VITE_DESKTOP_LAUNCH_TOKEN?.trim();
const heavyMediaEnabled = resolveHeavyMediaEnabled(process.env.QISITV_FULL_MEDIA_RESOURCES ?? process.env.BEEFTV_FULL_MEDIA_RESOURCES);

function pruneOptionalMediaPlugin() {
    return {
        name: "qisitv-prune-optional-media",
        closeBundle() {
            const dist = resolve(webDir, "dist");
            // The retired public welcome site is never part of the application.
            rmSync(resolve(dist, "welcome"), { recursive: true, force: true });
            if (heavyMediaEnabled) return;
            for (const directory of ["mediapipe", "lighting-presets", "three"]) {
                rmSync(resolve(dist, directory), { recursive: true, force: true });
            }
            rmSync(resolve(dist, "canvas/models/blaze-face-full-range-sparse.tflite"), { force: true });
            const staticDir = resolve(dist, "static");
            for (const file of readdirSync(staticDir)) {
                if (file.startsWith("ffmpeg-core-")) rmSync(resolve(staticDir, file), { force: true });
            }
        },
    };
}

export default defineConfig({
    plugins: [react(), pruneOptionalMediaPlugin()],
    define: {
        __APP_VERSION__: JSON.stringify(appVersion),
        __APP_CHANGELOG__: JSON.stringify(appChangelog),
        __QISITV_HEAVY_MEDIA_ENABLED__: JSON.stringify(heavyMediaEnabled),
        "import.meta.env.VITE_APP_VERSION": JSON.stringify(appVersion),
    },
    server: {
        proxy: {
            "/api": {
                target: apiProxyTarget,
                changeOrigin: true,
                xfwd: true,
                ...(desktopLaunchToken ? { headers: { "X-Desktop-Token": desktopLaunchToken } } : {}),
            },
        },
    },
    resolve: {
        alias: {
            "@": resolve(webDir, "src"),
        },
    },
    build: {
        // Keep the SPA route `/assets` distinct from Vite's emitted static files.
        // Otherwise vite preview treats `/assets` as the physical asset directory
        // and a direct refresh of the asset library can return 404.
        assetsDir: "static",
        rolldownOptions: {
            output: {
                strictExecutionOrder: true,
                codeSplitting: {
                    // Keep route-level lazy imports isolated. Recursively merging dependencies
                    // pulls unrelated pages into the initial modulepreload graph.
                    includeDependenciesRecursively: false,
                    minSize: 40 * 1024,
                    groups: [
                        {
                            // Shared interop helpers must not be emitted into a route entry:
                            // AntD would import that entry back and execute its bootstrap early.
                            name: "vendor-babel-runtime",
                            minSize: 0,
                            test: /node_modules[\\/]@babel[\\/]runtime[\\/]/,
                            priority: 40,
                        },
                        {
                            name: "vendor-react",
                            test: /node_modules[\\/](?:react(?:-dom|-router|-router-dom)?|scheduler|zustand|use-sync-external-store|@tanstack[\\/](?:query-core|react-query))[\\/]/,
                            priority: 30,
                        },
                        {
                            name: "vendor-icons",
                            test: /node_modules[\\/](?:lucide-react|@ant-design[\\/]icons)[\\/]/,
                            priority: 20,
                            entriesAware: true,
                            entriesAwareMergeThreshold: 48 * 1024,
                        },
                        {
                            name: "vendor-antd",
                            test: /node_modules[\\/](?:antd|@ant-design|@rc-component|rc-[^\\/]+|dayjs)[\\/]/,
                            priority: 10,
                            entriesAware: true,
                            entriesAwareMergeThreshold: 80 * 1024,
                        },
                    ],
                },
            },
        },
    },
});
