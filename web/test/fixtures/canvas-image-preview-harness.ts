import { cacheResourceImagePreviewObjectUrl, getCachedResourceBlob, primeResourceBlobCache } from "../../src/services/resource-blob-cache";
import { canvasImagePreviewSize, createCanvasImagePreviewBlob } from "../../src/lib/canvas/canvas-image-preview-blob";
import { setActiveUserScope } from "../../src/lib/user-scope";
import React from "react";
import { createRoot } from "react-dom/client";
import { CanvasNodeContent } from "../../src/components/canvas/canvas-node-content";
import { CanvasNodeType } from "../../src/types/canvas";
import { canvasThemes } from "../../src/lib/canvas-theme";

Object.assign(window, { async mountDprImage() {
    const canvas=document.createElement("canvas");canvas.width=1200;canvas.height=800;
    canvas.getContext("2d")!.fillRect(0,0,1200,800);
    const original=await new Promise<Blob>(resolve=>canvas.toBlob(blob=>resolve(blob!),"image/png"));
    const storageKey="resource:preview-dpr-test";
    await primeResourceBlobCache(storageKey,original);
    const host=document.createElement("div");host.id="preview-dpr";host.style.cssText="width:400px;height:267px";document.body.append(host);
    createRoot(host).render(React.createElement(CanvasNodeContent, { node:{id:"preview-dpr",type:CanvasNodeType.Image,title:"DPR",position:{x:0,y:0},width:400,height:267,metadata:{storageKey,content:"/api/resources/preview-dpr-test/file",mimeType:"image/png",naturalWidth:1200,naturalHeight:800}}, theme:canvasThemes.light,scale:1,isEditingContent:false,textareaRef:{current:null},isBatchRoot:false,batchCount:0,batchExpanded:false,batchOpening:false,batchRecovering:false,onContentChange:()=>{},onStopEditing:()=>{},mentionReferences:[] }));
} });

Object.assign(window, { async checkImagePreviews() {
    setActiveUserScope("image-preview-browser-test");
    const canvas = document.createElement("canvas");
    canvas.width = 1200; canvas.height = 800;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#ff0000"; context.fillRect(0, 0, 600, 800);
    const original = await new Promise<Blob>((resolve) => canvas.toBlob((blob) => resolve(blob!), "image/png"));
    const originalBytes = await original.arrayBuffer();
    const key = "resource:preview-browser-test";
    const originalUrl = await primeResourceBlobCache(key, original);
    const draw = CanvasRenderingContext2D.prototype.drawImage;
    let draws = 0;
    CanvasRenderingContext2D.prototype.drawImage = function (...args: any[]) { draws++; return (draw as any).apply(this, args); };
    const urls = await Promise.all(Array.from({ length: 40 }, () => cacheResourceImagePreviewObjectUrl(key, 128)));
    const oneTierDraws = draws;
    const larger = await cacheResourceImagePreviewObjectUrl(key, 1024);
    CanvasRenderingContext2D.prototype.drawImage = draw;
    const dimensions = async (url: string) => {
        const image = new Image(); image.src = url; await image.decode();
        return { width: image.naturalWidth, height: image.naturalHeight, image };
    };
    const small = await dimensions(urls[0]), large = await dimensions(larger), full = await dimensions(originalUrl);
    const probe = document.createElement("canvas"); probe.width = small.width; probe.height = small.height;
    const pixels = probe.getContext("2d")!; pixels.drawImage(small.image, 0, 0);
    const red = [...pixels.getImageData(10, 10, 1, 1).data], transparent = [...pixels.getImageData(100, 10, 1, 1).data];
    const retained = await getCachedResourceBlob(key);
    const hash = async (bytes: ArrayBuffer) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].join(",");
    const animatedHeader = new Uint8Array(32); animatedHeader.set([0,0,0,8,97,99,84,76],8);
    const animated = new Blob([animatedHeader], { type: "image/png" });
    const wide = document.createElement("canvas");wide.width=400;wide.height=200;
    const wideContext=wide.getContext("2d",{colorSpace:"display-p3"})!;
    wideContext.fillStyle="color(display-p3 1 0 0)";wideContext.fillRect(0,0,400,200);
    const wideOriginal=await new Promise<Blob>(resolve=>wide.toBlob(blob=>resolve(blob!),"image/png"));
    const widePreview=await createCanvasImagePreviewBlob(wideOriginal,128);
    const wideImage=await dimensions(URL.createObjectURL(widePreview));
    const wideProbe=document.createElement("canvas");wideProbe.width=128;wideProbe.height=64;
    const widePixels=wideProbe.getContext("2d",{colorSpace:"display-p3"})!;widePixels.drawImage(wideImage.image,0,0);
    const wideRed=[...widePixels.getImageData(10,10,1,1,{colorSpace:"display-p3"}).data];
    return { uniqueUrls: new Set(urls).size, oneTierDraws, allDraws: draws,
        small: [small.width, small.height], large: [large.width, large.height], full: [full.width, full.height],
        differentTier: larger !== urls[0], red, transparent, originalUnchanged: await hash(originalBytes) === await hash(await retained!.arrayBuffer()),
        animatedUnchanged: await createCanvasImagePreviewBlob(animated, 128) === animated, wideRed,
        tiers: [canvasImagePreviewSize(420,280,.05,1,4096,2731,"image/png"), canvasImagePreviewSize(420,280,1,1,4096,2731,"image/png"), canvasImagePreviewSize(420,280,1,2,4096,2731,"image/png"), canvasImagePreviewSize(420,280,6,1,4096,2731,"image/png"), canvasImagePreviewSize(420,280,.05,1,0,0,"image/png"), canvasImagePreviewSize(420,280,.05,1,4096,2731,"image/gif")].map(v => v ?? null) };
} });
