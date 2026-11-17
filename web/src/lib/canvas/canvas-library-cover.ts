import { readFileAsDataUrl } from "@/lib/image-utils";

export async function readCanvasLibraryCover(file: File): Promise<string> {
    if (!file.type.startsWith("image/")) throw new Error("封面请选择图片文件");
    if (file.size > 12 * 1024 * 1024) throw new Error("封面图片不能超过 12 MB");

    const image = new Image();
    image.src = await readFileAsDataUrl(file);
    try {
        await image.decode();
    } catch {
        throw new Error("无法读取封面图片，请选择可打开的图片");
    }

    const scale = Math.min(1, 1280 / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("无法处理封面图片");
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.84);
}
