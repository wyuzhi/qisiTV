import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";

let browser: Browser;
let page: Page;
let server: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
    const build = await Bun.build({
        entrypoints: [import.meta.dir + "/fixtures/reference-preview-harness.tsx"], target: "browser", format: "esm",
        define: { "import.meta.env": "{}", "process.env.NODE_ENV": '"production"' },
        plugins: [{ name: "preview-io", setup(builder) {
            // This fixture supplies references directly; avoid booting the
            // unrelated registry of generation editors and provider adapters.
            builder.onResolve({ filter: /^@\/lib\/canvas\/node-registry$/ }, () => ({ path: Bun.resolveSync("../src/lib/canvas/node-registry/node-registry.ts", import.meta.dir) }));
            builder.onResolve({ filter: /^@\// }, (args) => ({ path: Bun.resolveSync("../src/" + args.path.slice(2), import.meta.dir) }));
            builder.onLoad({ filter: /src\/lib\/video-poster\.ts$/ }, () => ({ loader: "js", contents: `
                export async function detectVideoAudioTrackFromBlob() { return undefined; }
                export function detectVideoAudioTrack() { return undefined; }
                export async function detectVideoAudioTrackFromUrl() { return undefined; }
                export async function capturePresentedVideoPoster() { throw new Error('unexpected presented capture'); }
                export async function captureVideoPoster(url, {signal}) {
                    window.captures.push(url);
                    if (url.startsWith('slow')) await new Promise(resolve => window.pending.set(url, resolve));
                    if (signal.aborted) throw new DOMException('aborted', 'AbortError');
                    const bytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jO1sAAAAASUVORK5CYII='), c => c.charCodeAt(0));
                    return {poster: new Blob([bytes], {type:'image/png'}), width:40, height:30, capturedAtMs:0};
                }` }));
            builder.onLoad({ filter: /src\/services\/canvas-video-source\.ts$/ }, () => ({ loader: "js", contents: `export async function acquireCanvasVideoSource(key, content) { return {url: content || key, release() {}}; }` }));
            builder.onLoad({ filter: /src\/services\/image-storage\.ts$/ }, () => ({ loader: "js", contents: `
                export async function resolveImageUrl(key, fallback, options) { return window.mockResolveImageUrl ? window.mockResolveImageUrl(key, fallback, options) : ('data:image/png,' + key); }
                const unexpected = () => { throw new Error('unexpected image storage operation'); };
                export {unexpected as uploadImage, unexpected as getImageBlob, unexpected as setImageBlob, unexpected as imageToDataUrl, unexpected as deleteStoredImages, unexpected as cleanupUnusedImages, unexpected as collectImageStorageKeys};` }));
            builder.onLoad({ filter: /src\/lib\/canvas\/canvas-drawing-storage\.ts$/ }, () => ({ loader: "js", contents: `export async function loadCanvasDrawingPreview() { return null; } export async function loadCanvasDrawingRender() { return null; } export async function saveCanvasDrawingRenderPublication() {}` }));
            builder.onLoad({ filter: /src\/hooks\/use-personal-asset-library\.ts$/ }, () => ({ loader: "js", contents: `export function usePersonalAssetLibrary() { return []; }` }));
            builder.onResolve({ filter: /^@react-three\/fiber$/ }, (args) => args.importer.endsWith("director-viewport.tsx") ? { path: "r3f-stub", namespace: "stub" } : undefined);
            builder.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ loader: "js", contents: `export function Canvas() { return null; } export function useThree(selector) { const state = { invalidate() {} }; return selector ? selector(state) : state; } export function useFrame() {}` }));
        } }],
    });
    if (!build.success) throw new Error(build.logs.join("\n"));
    const script = await build.outputs[0].text();
    const globalStyles = (await Bun.file(Bun.resolveSync("../src/styles/globals.css", import.meta.dir)).text()).replace(/^@import .*$/gm, "");
    const onePixelPng = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jO1sAAAAASUVORK5CYII="), (char) => char.charCodeAt(0));
    server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(request) {
        const pathname = new URL(request.url).pathname;
        if (pathname === "/app.js") return new Response(script, { headers: { "Content-Type": "text/javascript" } });
        if (pathname === "/globals.css") return new Response(`${globalStyles}\n*, *::before, *::after { transition: none !important; }`, { headers: { "Content-Type": "text/css" } });
        if (pathname === "/api/resources/custom-folder-cover/file") return new Response(onePixelPng, { headers: { "Content-Type": "image/png" } });
        if (pathname === "/api/resources/missing-prop-glb/file") return new Response("forbidden", { status: 403 });
        return new Response(`<style>.canvas-resource-mention-menu {position:fixed;width:320px}.canvas-resource-mention-scroll {max-height:180px;overflow:auto}.canvas-resource-mention-item {display:flex;height:40px}.canvas-resource-mention-preview {display:block;width:32px;height:32px}.inline-flex {display:inline-flex} #result {max-height:80px;overflow:hidden}</style><div id="root"></div><script type="module" src="/app.js"></script>`, { headers: { "Content-Type": "text/html" } });
    } });
    const executablePath = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((path): path is string => Boolean(path && existsSync(path)));
    browser = await chromium.launch({ headless: true, executablePath });
    page = await browser.newPage();
    page.on("pageerror", (error) => console.error(error.message));
}, 30_000);
afterAll(async () => { await browser?.close(); server?.stop(); }, 30_000);

async function mount() {
    await page.goto(server.url.href);
    await page.waitForFunction(() => Boolean((window as any).setReferences));
}
function video(id: string, active = false) {
    return { id, nodeId: id, kind: "video", label: id, title: id, active, videoPreviewSource: { metadata: { content: id } } };
}

test("33 unused videos leave the shared preview pool available to a visible node", async () => {
    await mount();
    await page.evaluate((references) => (window as any).setReferences(references), Array.from({ length: 33 }, (_, i) => video(`unused-${i}`)));
    await page.waitForFunction(() => JSON.parse(document.querySelector("#result")!.textContent!).length === 33);
    expect(await page.evaluate(() => (window as any).probePool())).toBe(true);
    expect(await page.evaluate(() => (window as any).captures)).toEqual(["probe"]);
});

test("a slow video never delays an image; changing sources fences late completion", async () => {
    await mount();
    await page.evaluate((references) => (window as any).setReferences(references), [video("slow-old", true), { id: "image", nodeId: "image", kind: "image", label: "image", title: "image", active: true, storageKey: "image-ready" }]);
    await page.waitForFunction(() => (window as any).captures.includes("slow-old"));
    expect(await page.locator("#result").textContent()).toContain("data:image/png,image-ready");
    await page.evaluate((references) => (window as any).setReferences(references), [video("new", true)]);
    await page.waitForFunction(() => document.querySelector("#result")!.textContent!.includes("blob:"));
    await page.evaluate(() => (window as any).pending.get("slow-old")());
    expect(await page.locator("#result").textContent()).not.toContain("slow-old");
    expect(await page.locator('#resolved-previews img[data-reference-id="new"]').evaluate((image) => !(window as any).revoked.includes((image as HTMLImageElement).src))).toBe(true);
    await page.evaluate(() => (window as any).setReferences([]));
    await page.waitForFunction(() => document.querySelector("#result")!.textContent === "[]");
    expect(await page.evaluate(() => (window as any).probePool())).toBe(true);
});

test("cloning reference arrays during typing keeps the visible lease alive", async () => {
    await mount();
    const reference = video("typing", true);
    await page.evaluate((references) => (window as any).setReferences(references), [reference]);
    await page.waitForFunction(() => document.querySelector("#result")!.textContent!.includes("blob:"));
    const src = await page.locator('#resolved-previews img').getAttribute("src");
    for (let i = 0; i < 4; i++) await page.evaluate((references) => (window as any).setReferences(references), [reference]);
    expect(await page.locator('#resolved-previews img').getAttribute("src")).toBe(src);
    expect(await page.evaluate((url) => (window as any).revoked.includes(url), src)).toBe(false);
    expect(await page.evaluate(() => (window as any).captures)).toEqual(["typing"]);
});

test("passing parent-resolved active video references into mention textarea reuses the active lease without re-capturing", async () => {
    await mount();
    await page.evaluate((references) => {
        (window as any).captures = [];
        (window as any).setReferences(references);
        (window as any).showMenu(true);
    }, [video("active-self", true), video("inactive-peer", false)]);
    await page.waitForFunction(() => document.querySelector("#result")!.textContent!.includes("blob:"));
    const src = await page.locator('#resolved-previews img[data-reference-id="active-self"]').getAttribute("src");
    await page.waitForTimeout(150);
    expect(await page.evaluate(() => (window as any).captures)).toEqual(["active-self"]);
    // Latch the resolved reference array on the child textarea, then drop the parent lease.
    // Because the child reused the parent lease (refcount === 1), dropping the parent lease
    // immediately revokes the object URL even while the child remains mounted with the latched array.
    await page.evaluate(() => {
        (window as any).latchMenuReferences();
        (window as any).setReferences([]);
    });
    await page.waitForFunction((url) => document.querySelector("#result")!.textContent === "[]" && (window as any).revoked.includes(url), src);
    expect(await page.evaluate((url) => (window as any).revoked.includes(url), src)).toBe(true);
});

test("mention menu decodes only visible rows and releases them when closed", async () => {
    await mount();
    // A visible canvas node can hold the same poster while menu rows unmount.
    await page.evaluate(() => (window as any).holdVideo("menu-0"));
    await page.evaluate((references) => { (window as any).setReferences(references); (window as any).showMenu(); }, Array.from({ length: 40 }, (_, i) => video(`menu-${i}`)));
    const editor = page.getByRole("textbox", { name: "引用编辑" });
    await editor.pressSequentially("@menu");
    await page.locator("[data-canvas-resource-mention-menu]").waitFor({ state: "visible", timeout: 3000 });
    expect(await page.locator(".canvas-resource-mention-item").count()).toBe(40);
    // menu-0 was captured by the held canvas lease before this menu opened.
    // Wait for a different visible row before testing scrolling and disposal.
    await page.waitForFunction(() => (window as any).captures.some((url: string) => url.startsWith("menu-") && url !== "menu-0"), undefined, { timeout: 3000 });
    const first = await page.evaluate(() => [...(window as any).captures] as string[]);
    expect(first.length).toBeGreaterThan(1);
    expect(first.length).toBeLessThan(10);
    expect(first).not.toContain("menu-39");
    await page.locator(".canvas-resource-mention-scroll").evaluate((element) => { element.scrollTop = element.scrollHeight; });
    try {
        await page.waitForFunction(() => (window as any).captures.includes("menu-39"), undefined, { timeout: 5000 });
    } catch (error) {
        console.error("preview scroll state", await page.evaluate(() => {
            const scroll = document.querySelector(".canvas-resource-mention-scroll");
            return { captures: (window as any).captures, menuPresent: !!scroll, scrollTop: scroll?.scrollTop, scrollHeight: scroll?.scrollHeight, clientHeight: scroll?.clientHeight,
                rows: [...(scroll?.querySelectorAll("button") || [])].map(row => ({ title: row.textContent, y: row.getBoundingClientRect().y, height: row.getBoundingClientRect().height })) };
        }));
        throw error;
    }
    await page.locator(".canvas-resource-mention-scroll").evaluate((element) => { element.scrollTop = 0; });
    await page.waitForFunction(() => { const image = document.querySelector('.canvas-resource-mention-item img') as HTMLImageElement | null; return image && !(window as any).revoked.includes(image.src) && image.naturalWidth > 0; });
    await editor.press("Escape");
    await page.waitForFunction(() => !document.querySelector("[data-canvas-resource-mention-menu]"), undefined, { timeout: 3000 });
    expect(await page.evaluate(() => (window as any).probePool())).toBe(true);
    await editor.press("End");
    await page.waitForFunction(() => { const image = document.querySelector('.canvas-resource-mention-item img') as HTMLImageElement | null; return image && !(window as any).revoked.includes(image.src) && image.naturalWidth > 0; });
    await page.evaluate(() => (window as any).releaseHeld());
}, 30_000);

test("protected desktop resource URLs are never exposed to native img and failed initial resolution does not poison preview cache", async () => {
    await mount();
    const protectedUrl = "http://127.0.0.1:61688/api/resources/char-cover/file";
    const validPng = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jO1sAAAAASUVORK5CYII=";
    await page.evaluate(({ url }) => {
        (window as any).resolvedKeys = [];
        (window as any).resetPreviewCache();
        (window as any).mockResolveImageUrl = async (key: string, fallback: string) => {
            (window as any).resolvedKeys.push(key);
            return fallback;
        };
        (window as any).setReferences([
            { id: "char-1", nodeId: "char-1", kind: "character", label: "角色1", title: "银甲守卫", previewUrl: url, active: true },
        ]);
    }, { url: protectedUrl });

    await page.waitForFunction(() => ((window as any).resolvedKeys?.length || 0) >= 1);
    expect(await page.evaluate(() => (window as any).resolvedKeys)).toEqual(["resource:char-cover"]);
    expect(await page.locator("#result").textContent()).not.toContain(protectedUrl);
    expect(await page.locator("#resolved-previews img").count()).toBe(0);

    await page.evaluate(({ url, png }) => {
        (window as any).mockResolveImageUrl = async (key: string) => {
            (window as any).resolvedKeys.push(key);
            return png;
        };
        (window as any).setReferences([]);
        setTimeout(() => {
            (window as any).setReferences([
                { id: "char-1", nodeId: "char-1", kind: "character", label: "角色1", title: "银甲守卫", previewUrl: url, active: true },
            ]);
        }, 0);
    }, { url: protectedUrl, png: validPng });

    await page.waitForFunction(() => document.querySelectorAll("#resolved-previews img").length === 1);
    expect(await page.locator("#resolved-previews img").getAttribute("src")).toBe(validPng);
    expect(await page.evaluate(() => (window as any).resolvedKeys)).toEqual(["resource:char-cover", "resource:char-cover"]);
    await page.evaluate(() => { delete (window as any).mockResolveImageUrl; });
}, 30_000);

test("CanvasConfigComposer upgrades reference chips asynchronously without exposing protected URLs or dropping active editor focus", async () => {
    await mount();
    const protectedUrl = "http://127.0.0.1:61688/api/resources/composer-ref-1/file";
    const validPng = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jO1sAAAAASUVORK5CYII=";
    await page.evaluate(({ url }) => {
        (window as any).composerResolveCalls = [];
        (window as any).mockResolveImageUrl = (key: string, fallback: string, options: unknown) =>
            new Promise<string>((resolve) => {
                (window as any).composerResolveCalls.push({ key, fallback, options });
                (window as any).resolveComposerImage = resolve;
            });
        (window as any).mountComposer(
            [
                {
                    nodeId: "img-1",
                    type: "image",
                    title: "场景原画",
                    image: { id: "img-1", name: "场景原画.png", mimeType: "image/png", dataUrl: url },
                },
            ],
            "@[node:img-1] 镜头推进",
        );
    }, { url: protectedUrl });

    const chip = page.locator('[data-reference-node-id="img-1"]');
    await chip.waitFor({ state: "visible", timeout: 3000 });
    expect(await chip.locator("img").count()).toBe(0);
    expect(await chip.textContent()).toContain("场景原画");
    expect(await page.evaluate((url) => [...document.querySelectorAll("img")].some((img) => img.getAttribute("src") === url), protectedUrl)).toBe(false);
    await page.waitForFunction(() => Boolean((window as any).resolveComposerImage));
    expect(await page.evaluate(() => (window as any).composerResolveCalls)).toEqual([
        { key: "resource:composer-ref-1", fallback: protectedUrl, options: { cacheMiss: true, renderable: true } },
    ]);

    const editor = page.locator(".canvas-config-composer-editor [contenteditable='true']");
    await editor.evaluate((el) => {
        (el as HTMLElement).focus();
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(el);
        range.collapse(false);
        selection?.removeAllRanges();
        selection?.addRange(range);
    });
    await page.keyboard.type(" 中景");
    expect(await page.locator("#composer-value").textContent()).toBe("@[node:img-1] 镜头推进 中景");
    expect(await page.evaluate(() => document.activeElement?.getAttribute("contenteditable"))).toBe("true");

    await page.evaluate((png) => (window as any).resolveComposerImage(png), validPng);
    await page.waitForFunction(() => document.querySelectorAll('[data-reference-node-id="img-1"] img').length === 1);
    expect(await chip.locator("img").getAttribute("src")).toBe(validPng);
    expect(await page.evaluate(() => document.activeElement?.getAttribute("contenteditable"))).toBe("true");

    await page.keyboard.type(" 逆光");
    expect(await page.locator("#composer-value").textContent()).toBe("@[node:img-1] 镜头推进 中景 逆光");
    expect(await page.evaluate((url) => [...document.querySelectorAll("img")].some((img) => img.getAttribute("src") === url), protectedUrl)).toBe(false);
    await page.evaluate(() => { delete (window as any).mockResolveImageUrl; });
}, 30_000);

test("CachedResourceImage settles to fallback when a local image key misses and fallback src is a protected desktop URL", async () => {
    await mount();
    const protectedUrl = "http://127.0.0.1:61688/api/resources/protected-fallback/file";
    await page.evaluate(({ url }) => {
        (window as any).localResolveArgs = null;
        (window as any).mockResolveImageUrl = (key: string, fallback: string, options: unknown) =>
            new Promise<string>((resolve) => {
                (window as any).localResolveArgs = { key, fallback, options };
                (window as any).finishLocalResolve = resolve;
            });
        (window as any).mountLocalCachedImage({ storageKey: "image:missing-local", src: url });
    }, { url: protectedUrl });

    await page.locator('#local-cached-image [data-loading="true"]').waitFor({ state: "visible", timeout: 3000 });
    expect(await page.locator("#local-cached-image img").count()).toBe(0);
    await page.waitForFunction(() => Boolean((window as any).finishLocalResolve));
    expect(await page.evaluate(() => (window as any).localResolveArgs)).toEqual({
        key: "image:missing-local",
        fallback: "",
        options: { renderable: true },
    });

    await page.evaluate(() => (window as any).finishLocalResolve(""));
    await page.locator('#local-cached-image [data-error-fallback="true"]').waitFor({ state: "visible", timeout: 3000 });
    expect(await page.locator('#local-cached-image [data-loading="true"]').count()).toBe(0);
    expect(await page.locator("#local-cached-image img").count()).toBe(0);
    await page.evaluate(() => {
        (window as any).mountLocalCachedImage(null);
        delete (window as any).mockResolveImageUrl;
    });
}, 30_000);

test("DirectorBillboard resolves storageKey before TextureLoader and skips loading when protected URL cannot hydrate", async () => {
    await mount();
    const protectedUrl = "http://127.0.0.1:61688/api/resources/billboard-1/file";
    const validPng = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jO1sAAAAASUVORK5CYII=";
    await page.evaluate(({ url }) => {
        (window as any).textureLoads = [];
        (window as any).billboardResolveCalls = [];
        (window as any).mockResolveImageUrl = async (key: string, fallback: string, options: unknown) => {
            (window as any).billboardResolveCalls.push({ key, fallback, options });
            return "";
        };
        (window as any).mountBillboard({
            id: "billboard-1",
            name: "背景立牌",
            kind: "billboard",
            url,
            storageKey: "resource:billboard-1",
            color: "#888888",
            castShadow: false,
            receiveShadow: false,
            transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
            keyframes: [],
        });
    }, { url: protectedUrl });

    await page.waitForFunction(() => ((window as any).billboardResolveCalls?.length || 0) === 1);
    await page.waitForTimeout(50);
    expect(await page.evaluate(() => (window as any).billboardResolveCalls)).toEqual([
        { key: "resource:billboard-1", fallback: protectedUrl, options: { cacheMiss: true, renderable: true } },
    ]);
    expect(await page.evaluate(() => (window as any).textureLoads)).toEqual([]);

    await page.evaluate(({ url, png }) => {
        (window as any).mockResolveImageUrl = async (key: string, fallback: string, options: unknown) => {
            (window as any).billboardResolveCalls.push({ key, fallback, options });
            return png;
        };
        (window as any).mountBillboard({
            id: "billboard-1",
            name: "背景立牌",
            kind: "billboard",
            url,
            storageKey: "resource:billboard-2",
            color: "#888888",
            castShadow: false,
            receiveShadow: false,
            transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
            keyframes: [],
        });
    }, { url: protectedUrl, png: validPng });

    await page.waitForFunction(() => ((window as any).textureLoads?.length || 0) === 1);
    expect(await page.evaluate(() => (window as any).textureLoads)).toEqual([validPng]);
    await page.evaluate(() => {
        (window as any).mountBillboard(null);
        delete (window as any).mockResolveImageUrl;
    });
}, 30_000);

test("DirectorModel with storageKey fails cleanly without falling back to default actor URL when resource cannot hydrate", async () => {
    await mount();
    await page.evaluate(() => {
        (window as any).gltfLoads = [];
        (window as any).modelLoadStates = [];
        (window as any).mountModel({
            id: "model-storage-only",
            name: "道具模型",
            kind: "model",
            storageKey: "resource:missing-prop-glb",
            color: "#888888",
            castShadow: true,
            receiveShadow: true,
            transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
            keyframes: [],
        });
    });

    await page.waitForFunction(() => ((window as any).modelLoadStates || []).some((entry: { signal: string }) => entry.signal === "error"), undefined, { timeout: 5000 });
    expect(await page.evaluate(() => (window as any).gltfLoads)).toEqual([]);
    await page.evaluate(() => (window as any).mountModel(null));
}, 30_000);

test("CanvasFolderPreview preserves blur, scale, and hover styles when resource-backed theme cover renders inside CachedResourceImage", async () => {
    await mount();
    const coverResourceUrl = `${server.url.origin}/api/resources/custom-folder-cover/file`;
    await page.evaluate(async (url) => {
        await new Promise<void>((resolve, reject) => {
            const link = document.createElement("link");
            link.rel = "stylesheet";
            link.href = "/globals.css";
            link.onload = () => resolve();
            link.onerror = () => reject(new Error("failed to load globals.css"));
            document.head.appendChild(link);
        });
        (window as any).mountFolderPreview(url);
    }, coverResourceUrl);

    const frontImg = page.locator(".canvas-folder-front-media > .cached-resource-image-shell > img");
    await frontImg.waitFor({ state: "visible", timeout: 5000 });
    expect(await frontImg.getAttribute("src")).toStartWith("blob:");
    const restStyle = await frontImg.evaluate((el) => {
        const computed = getComputedStyle(el);
        const backImg = document.querySelector(".canvas-folder-back > .cached-resource-image-shell > img");
        return {
            filter: computed.filter,
            transform: computed.transform,
            backObjectFit: backImg ? getComputedStyle(backImg).objectFit : "",
        };
    });
    expect(restStyle.filter).toBe("blur(22px) saturate(0.72)");
    expect(restStyle.transform).toStartWith("matrix(1.18,");
    expect(restStyle.backObjectFit).toBe("cover");

    await page.locator(".canvas-folder-preview").hover();
    const hoverStyle = await frontImg.evaluate((el) => {
        const computed = getComputedStyle(el);
        return { filter: computed.filter, transform: computed.transform };
    });
    expect(hoverStyle.filter).toBe("blur(16px) saturate(0.86)");
    expect(hoverStyle.transform).toStartWith("matrix(1.14,");
}, 30_000);
