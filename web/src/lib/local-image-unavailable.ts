export function localImageRecoveryMessage(source = "") {
    let otherOrigin = false;
    try {
        otherOrigin = source.startsWith("blob:") && typeof window !== "undefined"
            && new URL(source.slice(5)).origin !== window.location.origin;
    } catch { /* Invalid object URLs cannot be recovered by reloading. */ }
    return otherOrigin
        ? "图片保存在另一个站点地址的浏览器中。请用原来的地址打开画布，或重新上传、重画此图片。localhost 与 127.0.0.1 不共享图片缓存。"
        : "本地图片不可用，可能已被清理或属于另一个浏览器。请重新上传或重画此图片。";
}

export class LocalImageUnavailableError extends Error {
    readonly code = "local_storage_failed";
    constructor(source = "") {
        super(localImageRecoveryMessage(source));
        this.name = "LocalImageUnavailableError";
    }
}
