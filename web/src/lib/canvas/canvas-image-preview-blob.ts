export function canvasImagePreviewSize(width: number, height: number, scale: number, dpr: number, naturalWidth: number, naturalHeight: number, mimeType: string) {
    if (!/^image\/(jpeg|png)$/i.test(mimeType) || !naturalWidth || !naturalHeight) return undefined;
    const required = Math.max(width, height) * scale * Math.max(1, dpr) * 2;
    const tier = [128, 512, 1024, 2048].find((size) => size >= required);
    return tier && tier < Math.max(naturalWidth, naturalHeight) ? tier : undefined;
}

/** Disposable display pixels; never replace the original resource. */
export async function createCanvasImagePreviewBlob(original: Blob, maxSize: number): Promise<Blob> {
    if (!/^image\/(jpeg|png)$/i.test(original.type)) return original;
    // APNG keeps its animation. acTL precedes the first image-data chunk.
    if (original.type === "image/png") {
        const header = new Uint8Array(await original.slice(0, 65536).arrayBuffer());
        if (header[24] === 16) return original;
        const view = new DataView(header.buffer);
        for (let offset = 8; offset + 8 <= header.length;) {
            const type = String.fromCharCode(...header.subarray(offset + 4, offset + 8));
            if (type === "acTL") return original;
            if (type === "IDAT") break;
            offset += view.getUint32(offset) + 12;
        }
    }
    const image = new Image();
    const source = URL.createObjectURL(original);
    const canvas = document.createElement("canvas");
    try {
        const context = canvas.getContext("2d", { colorSpace: "display-p3" });
        // Preserve Mac wide-gamut images; unsupported engines keep the original.
        if (!context || context.getContextAttributes?.().colorSpace !== "display-p3") return original;
        await new Promise<void>((resolve, reject) => {
            image.onload = () => resolve();
            image.onerror = () => reject(new Error("图片预览解码失败"));
            image.src = source;
        });
        const ratio = Math.min(1, maxSize / Math.max(image.naturalWidth, image.naturalHeight));
        if (ratio === 1) return original;
        canvas.width = Math.max(1, Math.round(image.naturalWidth * ratio));
        canvas.height = Math.max(1, Math.round(image.naturalHeight * ratio));
        context.imageSmoothingEnabled = true;
        context.imageSmoothingQuality = "high";
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        return await new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("图片预览编码失败")), "image/png"));
    } finally {
        image.onload = image.onerror = null;
        image.src = "";
        URL.revokeObjectURL(source);
        canvas.width = canvas.height = 1;
    }
}
