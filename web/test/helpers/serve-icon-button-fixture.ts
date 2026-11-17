import { fileURLToPath } from "node:url";
import { createServer as createHTTPServer } from "node:http";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";

/** Isolated IconButton fixture server: Vite CSS/TSX transforms without workspace or API side effects. */
export async function startIconButtonFixtureServer() {
    const root = fileURLToPath(new URL("../../", import.meta.url));
    const http = createHTTPServer();
    const server = await createServer({
        configFile: false,
        root,
        appType: "custom",
        logLevel: "error",
        plugins: [react()],
        resolve: { alias: { "@": fileURLToPath(new URL("../../src", import.meta.url)) } },
        server: { middlewareMode: true, hmr: false, ws: { server: http } },
    });
    server.middlewares.use(async (request, response, next) => {
        if (request.url?.split("?")[0] !== "/") return next();
        try {
            const html = await server.transformIndexHtml(
                "/",
                '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/test/fixtures/icon-button-harness.tsx"></script></body></html>',
            );
            response.setHeader("Content-Type", "text/html; charset=utf-8");
            response.end(html);
        } catch (error) {
            next(error);
        }
    });
    http.on("request", server.middlewares);
    try {
        await new Promise<void>((resolve, reject) => {
            http.once("error", reject);
            http.listen(0, "127.0.0.1", () => {
                http.removeListener("error", reject);
                resolve();
            });
        });
        const address = http.address();
        if (!address || typeof address === "string") throw new Error("IconButton fixture server has no TCP address");
        return {
            url: `http://127.0.0.1:${address.port}`,
            close: async () => {
                await Promise.all([
                    server.close(),
                    new Promise<void>((resolve, reject) => http.close((error) => (error ? reject(error) : resolve()))),
                ]);
            },
        };
    } catch (error) {
        http.close();
        await server.close();
        throw error;
    }
}
