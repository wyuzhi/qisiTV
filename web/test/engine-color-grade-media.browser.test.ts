import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chromium, type Browser } from "playwright";

let browser: Browser;
let web: ReturnType<typeof Bun.serve>;
let engine: ReturnType<typeof Bun.serve>;
let sourceBytes = new Uint8Array();
let renderedBytes = new Uint8Array();
let uploads = 0;
let redirected = false;
const requests: Array<{ path: string; token: string | null }> = [];
const token = "a".repeat(48);

beforeAll(async () => {
    engine = Bun.serve({ port: 0, async fetch(request) {
        const path = new URL(request.url).pathname;
        const headers = { "Access-Control-Allow-Origin": web.url.origin, "Access-Control-Allow-Headers": "content-type,x-qisitv-session", "Access-Control-Allow-Methods": "GET,POST,OPTIONS" };
        if (request.method === "OPTIONS") return new Response(null, { headers });
        requests.push({ path, token: request.headers.get("X-QisiTV-Session") });
        if (path === "/seed") { sourceBytes = new Uint8Array(await request.arrayBuffer()); return new Response(null, { headers }); }
        if (path.startsWith("/engine/api/") && request.headers.get("X-QisiTV-Session") !== token) return new Response("unauthorized", { status: 401, headers });
        if (path.includes("/denied/")) return new Response("denied", { status: 403, headers });
        if (path.includes("/redirect/")) return new Response(null, { status: 307, headers: { ...headers, Location: `${web.url}credential-sink` } });
        if (path === "/engine/api/resources" && request.method === "POST") {
            renderedBytes = new Uint8Array(await request.arrayBuffer()); uploads++;
            return Response.json({ id: "graded", mimeType: "image/png" }, { headers });
        }
        return new Response(path.includes("/graded/") ? renderedBytes : sourceBytes, { headers: { ...headers, "Content-Type": "image/png" } });
    } });
    const source = `import React from "react"; import {createRoot} from "react-dom/client";
        import {ENGINE_ORIGIN,installEngineFetch,rememberEngineSession} from "@/services/engine-session";
        import {readAuthenticatedMediaBlob} from "@/services/authenticated-media";
        import {AuthenticatedBackgroundImage} from "@/components/assets/authenticated-media";
        import {ColorGradeNodeContent} from "@/components/canvas/nodes/color-grade-node";
        import {resolveCanvasColorGradeReference} from "@/lib/canvas/canvas-color-grade";
        if(ENGINE_ORIGIN!=="http://127.0.0.1:${engine.port}")throw Error("test engine port override missing");
        installEngineFetch(); rememberEngineSession({token:"a".repeat(48),sessionId:"image-test",expiresAt:new Date(Date.now()+3600000).toISOString()});
        const seed=document.createElement("canvas");seed.width=seed.height=4;const ctx=seed.getContext("2d");ctx.fillStyle="rgb(80,40,20)";ctx.fillRect(0,0,4,4);
        await fetch(ENGINE_ORIGIN+"/seed",{method:"POST",body:await new Promise(resolve=>seed.toBlob(resolve,"image/png"))});
        const root=createRoot(document.getElementById("root"));
        const grade={brightness:150,contrast:100,saturate:100,hueRotate:0};
        window.show=(name)=>{window.source=ENGINE_ORIGIN+"/engine/api/resources/"+name+"/file";root.render(React.createElement(React.Fragment,null,
          React.createElement(ColorGradeNodeContent,{node:{id:"grade",title:"调色预览",metadata:{colorGrade:grade}},theme:{node:{fill:"black",muted:"white"}}}),
          React.createElement(AuthenticatedBackgroundImage,{id:"folder-cover",src:window.source,style:{width:50,height:50}})));};
        window.grade=async(name)=>{try{return await resolveCanvasColorGradeReference({id:name,name:"grade",type:"image/png",dataUrl:"",source:{kind:"colorgrade",url:ENGINE_ORIGIN+"/engine/api/resources/"+name+"/file",grade}});}catch(e){return {error:e.message};}};
        window.pixel=async(url)=>{const bitmap=await createImageBitmap(await readAuthenticatedMediaBlob(url));ctx.drawImage(bitmap,0,0);bitmap.close();return [...ctx.getImageData(1,1,1,1).data];};
        window.publicRead=()=>readAuthenticatedMediaBlob(ENGINE_ORIGIN+"/public.png").then(b=>b.size);
        window.expire=()=>rememberEngineSession();window.show("source");window.ready=true;`;
    const stubs: Record<string, string> = {
        "@/services/api/resources": `import {ENGINE_ORIGIN} from "@/services/engine-session";
            export const resourceFileUrl=id=>ENGINE_ORIGIN+"/engine/api/resources/"+id+"/file";
            export const resourceStorageKey=id=>"resource:"+id;export const ownedResourceIdFromMediaRef=()=>"";
            export const uploadResourceFile=async blob=>{const r=await fetch(ENGINE_ORIGIN+"/engine/api/resources",{method:"POST",body:blob});if(!r.ok)throw Error("upload failed");return r.json();};`,
        "@/hooks/use-resource-video-playback": "export const useResourceVideoPlayback=()=>({});",
        "@/components/canvas/canvas-node-graph-context": "export const useUpstreamNodes=()=>[{metadata:{content:window.source}}];",
        "@/components/canvas/canvas-node-action-context": "export const useCanvasNodeActions=()=>({});",
        "@/lib/canvas/node-registry": "export const getNodeResourceKind=()=>\"image\";",
    };
    const build = await Bun.build({ entrypoints: ["engine-media-harness"], target: "browser",
        define: { "import.meta.env": JSON.stringify({ VITE_QISITV_ENGINE_PORT: String(engine.port) }) },
        plugins: [{ name: "engine-media", setup(builder) {
            builder.onResolve({ filter: /^engine-media-harness$/ }, () => ({ path: "harness", namespace: "fixture" }));
            builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: source, loader: "ts", resolveDir: import.meta.dir }));
            builder.onResolve({ filter: /^@\// }, args => stubs[args.path] ? { path: args.path, namespace: "stub" } : { path: Bun.resolveSync("../src/" + args.path.slice(2), import.meta.dir) });
            builder.onLoad({ filter: /.*/, namespace: "stub" }, args => ({ contents: stubs[args.path], loader: "ts", resolveDir: import.meta.dir }));
        } }],
    });
    if (!build.success) throw new Error(build.logs.join("\n"));
    const js = await build.outputs[0].text();
    web = Bun.serve({ port: 0, fetch(request) {
        if (new URL(request.url).pathname === "/credential-sink") { redirected = true; return new Response("unexpected"); }
        return new URL(request.url).pathname === "/harness.js" ? new Response(js, { headers: { "Content-Type": "application/javascript" } }) : new Response('<div id="root"></div><script type="module" src="/harness.js"></script>', { headers: { "Content-Type": "text/html" } });
    } });
    const executablePath = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((path): path is string => Boolean(path && existsSync(path)));
    browser = await chromium.launch({ executablePath, headless: true });
}, 60000);

afterAll(async () => { await browser?.close(); web?.stop(true); engine?.stop(true); });

test("protected color grading and folder covers load with the session; denied/expired/redirected reads never publish", async () => {
    const page = await browser.newPage();
    const browserError = new Promise<never>((_, reject) => page.on("pageerror", reject));
    await page.goto(web.url.toString());
    await Promise.race([page.waitForFunction(() => (window as any).ready), browserError]);
    await page.waitForFunction(() => { const image=document.querySelector('img[alt="调色预览"]') as HTMLImageElement; return image?.complete && image.naturalWidth === 4; });
    await page.waitForFunction(() => (document.querySelector("#folder-cover") as HTMLElement)?.style.backgroundImage.includes("blob:"));
    expect(await page.evaluate(async () => {
        const style=(document.querySelector("#folder-cover") as HTMLElement).style.backgroundImage;
        return (window as any).pixel(JSON.parse(style.slice(4,-1)));
    })).toEqual([80, 40, 20, 255]);
    const result = await page.evaluate(() => (window as any).grade("source"));
    expect(result.storageKey).toBe("resource:graded");
    expect(await page.evaluate((url) => (window as any).pixel(url), result.url)).toEqual([120, 60, 30, 255]);
    expect(uploads).toBe(1);
    expect(await page.evaluate(() => (window as any).publicRead())).toBeGreaterThan(0);
    expect(requests.filter(item => item.path.startsWith("/engine/api/")).every(item => item.token === token)).toBe(true);
    expect(requests.filter(item => !item.path.startsWith("/engine/api/")).every(item => item.token === null)).toBe(true);

    await page.evaluate(() => (window as any).show("denied"));
    await page.getByText("缩略图不可用", { exact: true }).waitFor();
    await page.getByText("封面读取失败", { exact: true }).waitFor();
    expect((await page.evaluate(() => (window as any).grade("denied"))).error).toContain("403");
    expect((await page.evaluate(() => (window as any).grade("redirect"))).error).toBeTruthy();
    expect(redirected).toBe(false);
    await page.evaluate(() => (window as any).expire());
    expect((await page.evaluate(() => (window as any).grade("expired"))).error).toContain("本机授权已结束");
    expect(requests.some(item => item.path.includes("expired"))).toBe(false);
    expect(uploads).toBe(1);
    await page.close();
}, 30000);
