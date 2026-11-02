import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser } from "playwright";

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
const root = resolve(import.meta.dir, "../src") + "/";
const image = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const step = "const step=(name,value)=>window.__mediaTest.step(name,value);";
const uploaded = JSON.stringify({ dataUrl: image, url: image, storageKey: "fixture-result", width: 320, height: 180, durationMs: 1000 });
const mocks: Record<string, string> = {
    "@/services/image-storage": `${step} export const uploadImage=async()=>step('uploadImage',${uploaded}); export const resolveImageUrl=async()=>step('resolveImageUrl',${JSON.stringify(image)}); export const getImageBlob=async()=>null;`,
    "@/services/file-storage": `${step} export const uploadMediaFile=async()=>step('uploadMediaFile',${uploaded}); export const resolveMediaUrl=async()=>step('resolveMediaUrl','fixture-video'); export const getMediaBlob=async()=>null;`,
    "@/services/api/video": `${step} export const storeGeneratedVideo=async()=>step('storeGeneratedVideo',${uploaded});`,
    "@/lib/canvas/canvas-image-data": `${step} export const cropDataUrl=async()=>step('cropDataUrl',${JSON.stringify(image)}); export const upscaleDataUrl=async()=>step('upscaleDataUrl',${JSON.stringify(image)}); export const splitDataUrl=async()=>step('splitDataUrl',[{row:0,column:0,dataUrl:${JSON.stringify(image)}},{row:0,column:1,dataUrl:${JSON.stringify(image)}}]);`,
    "@/lib/canvas/canvas-video-segment": `${step} export const cropVideo=async()=>step('cropVideo',new Blob(['fixture'])); export const trimVideoSegment=cropVideo; export const extractVideoAudio=cropVideo; export const removeAudioFromVideo=cropVideo;`,
    "@/lib/canvas/canvas-video-merge": `${step} export const warmFFmpeg=async()=>{}; export const mergeVideos=async()=>step('mergeVideos',new Blob(['fixture']));`,
    "@/lib/canvas/canvas-video-frame": `${step} export const captureVideoFrames=async()=>step('captureVideoFrames',{frames:[{timeMs:0,blob:new Blob(['fixture'])}],failures:[]}); export const resolveVideoFramePresetTimeMs=()=>0;`,
    "@/lib/canvas/canvas-media-persist": "export async function persistOwnedCanvasMediaNodes(input){window.__mediaTest.persisted++;return new Map(input.mediaNodes.map(node=>[node.id,'fixture-asset-'+node.id]));}",
    "@/lib/canvas/canvas-project-generation": `${step} export * from ${JSON.stringify(root + "lib/canvas/canvas-project-generation.ts")}; export const buildGenerationConfig=(config)=>config; export const buildImageGenerationMetadata=()=>({}); export const nodeReferenceImage=()=>({id:'source',dataUrl:${JSON.stringify(image)}}); export async function runBackendCanvasGenerationTask(input){const value=await step('createTask',{images:[{dataUrl:${JSON.stringify(image)}}]});input.onTaskCreated?.({id:'original-task'});return value;}`,
    "@/lib/model-capabilities": "export const modelCapabilityConfigFor=()=>({image:{references:{maskSupported:true}}});",
    "@/lib/model-selection": "export const defaultImageParamsForModel=()=>({size:'1024x1024',quality:'high',transparentBackground:'false'}); export const resolveMaskEditModel=(c)=>c?.imageModel||c?.model||''; export const normalizeMaskEditQuality=(q)=>q||'high'; export const normalizeMaskEditSize=(s)=>s||'1024x1024';",
    "@/stores/use-config-store": "export const defaultConfig={model:'fixture-model',imageModel:'fixture-model',count:'1',quality:'high',size:'1024x1024'}; export const useEffectiveConfig=()=>defaultConfig; export const useConfigStore=(select)=>select({isAiConfigReady:()=>true}); export const resolveModelRequestConfig=()=>({interfaceType:'openai-image'});",
    "@/lib/canvas/canvas-emotion": `${step} export * from ${JSON.stringify(root + "lib/canvas/canvas-emotion.ts")}; export const compositeEmotionImage=async()=>step('compositeEmotionImage',${JSON.stringify(image)});`,
};

beforeAll(async () => {
    const build = await Bun.build({ entrypoints: [import.meta.dir + "/fixtures/canvas-media-owner-harness.tsx"], target: "browser", define: { "import.meta.env.DEV": "false", "import.meta.env.PROD": "true", "import.meta.env.MODE": '"production"', "import.meta.env.VITE_CANVAS_LOCAL_MODE": '"true"', "import.meta.env.VITE_CANVAS_BACKEND_URL": '"/api"', "process.env.NODE_ENV": '"production"' }, plugins: [{ name: "media-boundaries", setup(builder) {
        builder.onResolve({ filter: /^@\// }, args => {
            if (/\/use-canvas-(?:media|video|image)-tools\.ts$/.test(args.importer) && mocks[args.path]) return { path: args.path, namespace: "media-boundary" };
            return { path: Bun.resolveSync("../src/" + args.path.slice(2), import.meta.dir) };
        });
        builder.onLoad({ filter: /.*/, namespace: "media-boundary" }, args => ({ contents: mocks[args.path], loader: "js" }));
        builder.onLoad({ filter: /\.(css|svg|png|jpe?g|gif|webp|woff2?)$/ }, () => ({ contents: "export default ''", loader: "js" }));
    } }] });
    if (!build.success) throw new Error(build.logs.join("\n"));
    const script = await build.outputs[0]!.text();
    server = Bun.serve({ port: 0, fetch: request => new URL(request.url).pathname === "/harness.js"
        ? new Response(script, { headers: { "Content-Type": "application/javascript" } })
        : new Response('<!doctype html><meta charset="utf-8"><div id="root"></div><script type="module" src="/harness.js"></script>', { headers: { "Content-Type": "text/html; charset=utf-8" } }) });
    const executablePath = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((path) => path && existsSync(path));
    browser = await chromium.launch({ executablePath, headless: true });
});
afterAll(async () => { await browser?.close(); server?.stop(true); });

const tools = ["cropImageNode", "cropVideoNode", "saveAnnotatedImageNode", "extractVideoFrames", "confirmInlineVideoTrim", "extractAudioFromVideo", "mergeVideosByIds", "addPanoramaCaptureNode", "splitImageNode", "maskEditImageNode", "upscaleImageNode", "generateAngleNode", "generateEmotionNode"];
for (const replacement of ["delete", "replace"]) {
    test(`extractAudioFromVideo: ${replacement} of its source prevents stale outputs`, async () => {
        const page = await browser.newPage();
        const errors: string[] = [];
        page.on("pageerror", error => errors.push(error.message));
        try {
            await page.goto(server.url.toString());
            try {
                await page.waitForFunction(() => Boolean((window as any).__mediaTest?.start), undefined, { timeout: 3000 });
            } catch (error) { throw new Error(`${error}\n${errors.join("\n")}`); }
            await page.evaluate(() => (window as any).__mediaTest.start("extractAudioFromVideo"));
            await page.waitForFunction(() => Boolean((window as any).__mediaTest.release));
            await page.evaluate(mode => (window as any).__mediaTest.changeSource(mode), replacement);
            await page.waitForFunction(mode => {
                const source = (window as any).__mediaTest.snapshot().nodes.find((node: any) => node.id === "n0");
                return mode === "delete" ? !source : source?.metadata?.storageKey === "replacement-source";
            }, replacement);
            const before = await page.evaluate(() => (window as any).__mediaTest.snapshot());
            await page.evaluate(() => (window as any).__mediaTest.release());
            await page.waitForFunction(() => (window as any).__mediaTest.done);
            const after = await page.evaluate(() => (window as any).__mediaTest.snapshot());
            expect(after.nodes).toEqual(before.nodes);
            expect(after.calls).toEqual(before.calls);
            expect(after.persisted).toBe(0);
            expect(after.connections).toEqual([]);
            expect(after.error).toBeNull();
        } finally { await page.close(); }
    });
}
for (const tool of tools) {
    test(`${tool}: same owner finishes and keeps the existing result path`, async () => {
        const page = await browser.newPage();
        try {
            await page.goto(server.url.toString());
            await page.waitForFunction(() => Boolean((window as any).__mediaTest?.start));
            await page.evaluate(name => (window as any).__mediaTest.start(name), tool);
            await page.waitForFunction(() => Boolean((window as any).__mediaTest.release) || (window as any).__mediaTest.done);
            expect(await page.evaluate(() => (window as any).__mediaTest.error)).toBeNull();
            expect(await page.evaluate(() => Boolean((window as any).__mediaTest.release))).toBe(true);
            await page.evaluate(() => (window as any).__mediaTest.release());
            await page.waitForFunction(() => (window as any).__mediaTest.done);
            const result = await page.evaluate(() => (window as any).__mediaTest.snapshot());
            expect(result.error).toBeNull();
            expect(result.nodes.length).toBeGreaterThan(2);
            expect(result.persisted).toBeGreaterThan(0);
        } finally { await page.close(); }
    });
    for (const mode of ["canvas", "canvas-back"]) {
        test(`${tool}: ${mode} during the first wait prevents late writes and another upload`, async () => {
            const page = await browser.newPage();
            try {
                await page.goto(server.url.toString());
                await page.waitForFunction(() => Boolean((window as any).__mediaTest?.start));
                await page.evaluate(name => (window as any).__mediaTest.start(name), tool);
                await page.waitForFunction(() => Boolean((window as any).__mediaTest.release) || (window as any).__mediaTest.done);
                expect(await page.evaluate(() => (window as any).__mediaTest.error)).toBeNull();
                expect(await page.evaluate(() => Boolean((window as any).__mediaTest.release))).toBe(true);
                await page.evaluate(value => (window as any).__mediaTest.switchOwner(value === "canvas-back" ? "canvas" : value), mode);
                await page.waitForFunction(() => (window as any).__mediaTest.snapshot().nodes.every((node: any) => node.title === "new-owner"));
                if (mode === "canvas-back") {
                    await page.evaluate(() => (window as any).__mediaTest.switchOwner("canvas-return"));
                    await page.waitForFunction(() => (window as any).__mediaTest.snapshot().projectId === "media-canvas-a");
                }
                const before = await page.evaluate(() => (window as any).__mediaTest.snapshot());
                await page.evaluate(() => (window as any).__mediaTest.release());
                await page.waitForFunction(() => (window as any).__mediaTest.done);
                const after = await page.evaluate(() => (window as any).__mediaTest.snapshot());
                expect(after.error).toBeNull();
                expect(after.nodes).toEqual(before.nodes);
                expect(after.connections).toEqual([]);
                expect(after.calls).toEqual(before.calls);
                expect(after.persisted).toBe(0);
                expect(after.bound).toBe(0);
                expect(after.running).toBeNull();
            } finally { await page.close(); }
        });
    }
}

for (const tool of ["cropImageNode", "cropVideoNode", "splitImageNode", "upscaleImageNode"]) {
    for (const ending of ["canvas", "unmount", "late-error"]) {
        test(`${tool}: ${ending} after a later wait keeps the new owner untouched`, async () => {
            const page = await browser.newPage();
            try {
                await page.goto(server.url.toString());
                await page.waitForFunction(() => Boolean((window as any).__mediaTest?.start));
                await page.evaluate(name => (window as any).__mediaTest.start(name, 2), tool);
                await page.waitForFunction(() => Boolean((window as any).__mediaTest.release) || (window as any).__mediaTest.done);
                expect(await page.evaluate(() => (window as any).__mediaTest.calls.length)).toBe(2);
                expect(await page.evaluate(() => (window as any).__mediaTest.error)).toBeNull();
                if (ending === "unmount") await page.evaluate(() => (window as any).__mediaTest.unmount());
                else {
                    await page.evaluate(mode => (window as any).__mediaTest.switchOwner(mode === "late-error" ? "canvas" : mode), ending);
                    await page.waitForFunction(() => (window as any).__mediaTest.snapshot().nodes.every((node: any) => node.title === "new-owner"));
                }
                const before = await page.evaluate(() => (window as any).__mediaTest.snapshot());
                await page.evaluate(fail => fail ? (window as any).__mediaTest.reject() : (window as any).__mediaTest.release(), ending === "late-error");
                await page.waitForFunction(() => (window as any).__mediaTest.done);
                const after = await page.evaluate(() => (window as any).__mediaTest.snapshot());
                expect(after.nodes).toEqual(before.nodes);
                expect(after.calls).toEqual(before.calls);
                expect(after.persisted).toBe(0);
                expect(after.bound).toBe(0);
                expect(after.error).toBeNull();
            } finally { await page.close(); }
        });
    }
}
