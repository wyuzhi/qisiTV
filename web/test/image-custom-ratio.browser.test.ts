import { expect, test } from "bun:test";
import { chromium } from "playwright";
import { existsSync } from "node:fs";
import postcss from "postcss";
import tailwindcss from "@tailwindcss/postcss";
import { buildLikeAICreateBody } from "../src/services/browser-likeai-client";

test("Vidu 自定义比例可点击或回车应用，重开仍保留比例和 2160p，非法输入明确报错", async () => {
    const build = await Bun.build({ entrypoints: [import.meta.dir + "/fixtures/image-custom-ratio-harness.tsx"], target: "browser",
        define: { "process.env.NODE_ENV": '"production"', "import.meta.env.DEV": "false", "import.meta.env.PROD": "true", "import.meta.env.VITE_QISITV_BROWSER_ONLY": '"1"' },
        plugins: [{ name: "assets", setup(builder) {
            builder.onResolve({ filter: /^@\// }, (args) => ({ path: Bun.resolveSync("../src/" + args.path.slice(2), import.meta.dir) }));
            builder.onLoad({ filter: /\.(css|svg|png|jpe?g|gif|webp|woff2?)$/ }, () => ({ contents: "export default ''", loader: "js" }));
        } }],
    });
    if (!build.success) throw new Error(build.logs.join("\n"));
    const script = await build.outputs[0].text();
    const { css } = await postcss([tailwindcss({ base: import.meta.dir + "/../src" })]).process('@import "tailwindcss";', { from: import.meta.dir + "/../fixture.css" });
    const pickerCSS = await Bun.file(import.meta.dir + "/../src/components/image-size-picker.css").text();
    const server = Bun.serve({ port: 0, fetch: (request) => new URL(request.url).pathname === "/harness.js"
        ? new Response(script, { headers: { "Content-Type": "text/javascript" } })
        : new Response(`<style>${css}\n${pickerCSS}</style><div id=root></div><script type="module" src="/harness.js"></script>`, { headers: { "Content-Type": "text/html" } }),
    });
    const executablePath = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((path) => path && existsSync(path));
    const browser = await chromium.launch({ executablePath, headless: true });
    try {
        for (const theme of ["dark", "light"]) {
            const page = await browser.newPage({ viewport: { width: 800, height: 720 } });
            const errors: string[] = [];
            page.on("pageerror", (error) => errors.push(error.message));
            await page.goto(`${server.url}?theme=${theme}`);
            const settings = page.getByRole("button", { name: /^高级设置：/ });
            await settings.click();
            expect(await page.getByRole("button", { name: /^(1K|2K|4K)$/ }).count()).toBe(0);
            await page.locator("summary").click();
            const input = page.getByRole("textbox", { name: "自定义比例或尺寸" });
            const selection = async () => JSON.parse((await page.getByTestId("selection").textContent())!);
            for (const [value, ratio, enter] of [["16:9", "16:9", false], ["9：16", "9:16", true], ["1920x1080", "16:9", false]] as const) {
                await input.fill(value);
                if (enter) await input.press("Enter");
                else await page.getByRole("button", { name: /^应\s*用$/ }).click();
                await page.waitForFunction((expected) => JSON.parse(document.querySelector('[data-testid="selection"]')!.textContent!).size === expected, ratio, { timeout: 2000 });
                const selected = await selection();
                expect(selected.quality).toBe("2160p");
                expect(selected.changes.every((key: string) => key === "size")).toBe(true);
                expect(await settings.getAttribute("aria-label")).toContain(`${ratio} · 2160p`);
                expect(await page.locator(".image-size-output").textContent()).toBe(ratio);
                expect(buildLikeAICreateBody({ mode: "image", prompt: "test", config: { model: "vidu_image2", size: selected.size, quality: selected.quality } })).toMatchObject({ api_name: "vidu_image2", aspect_ratio: ratio, resolution: "2160p" });
            }
            for (const invalid of ["0:9", "4:1", "invalid"]) {
                const before = await selection();
                await input.fill(invalid);
                await page.getByRole("button", { name: /^应\s*用$/ }).click();
                expect(await page.getByRole("alert").textContent()).toBeTruthy();
                expect(await selection()).toEqual(before);
            }
            await input.fill("4:3");
            await input.press("Enter");
            expect(await page.getByRole("alert").count()).toBe(0);
            await settings.click();
            await settings.click();
            expect(await page.locator(".image-size-output").textContent()).toBe("4:3");
            expect((await selection()).quality).toBe("2160p");
            expect(errors).toEqual([]);
            await page.close();
        }
    } finally { await browser.close(); server.stop(true); }
}, 60000);
