export type EngineStorageUsage = {
    dataDir: string;
    usedBytes: number;
    freeBytes: number;
    engineExecutable: string;
    runtimeOS: string;
};

function absolutePath(value: string, windows: boolean) {
    if (!value || /[\u0000-\u001f\u007f]/.test(value)) return false;
    return windows ? /^(?:[a-z]:[\\/]|\\\\[^\\]+\\[^\\]+)/i.test(value) : value.startsWith("/");
}

/** A displayed command is copied to a terminal by the user, never executed by the website. */
export function engineMigrationCommand(storage: Pick<EngineStorageUsage, "engineExecutable" | "runtimeOS" | "dataDir">, target: string) {
    const windows = storage.runtimeOS === "windows";
    if (!windows && storage.runtimeOS !== "darwin" && storage.runtimeOS !== "linux") throw new Error("此系统暂不支持生成迁移命令。");
    if (!absolutePath(storage.engineExecutable, windows)) throw new Error("引擎程序路径无效，请重新读取本机状态。");
    if (!absolutePath(storage.dataDir, windows)) throw new Error("引擎数据目录无效，请重新读取本机状态。");
    if (!absolutePath(target, windows)) throw new Error("请输入不含换行的绝对目录路径，或点击选择文件夹。");
    const comparable = (value: string) => windows ? value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase() : value.replace(/\/+$/, "");
    if (comparable(target) === comparable(storage.dataDir)) throw new Error("请选择与当前引擎目录不同的空文件夹。");
    const quote = windows
        ? (value: string) => `'${value.replace(/'/g, "''")}'`
        : (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;
    return `${windows ? "& " : ""}${quote(storage.engineExecutable)} storage migrate --expected-source ${quote(storage.dataDir)} --to ${quote(target)}`;
}

export function storageSize(bytes: number) {
    if (!Number.isFinite(bytes) || bytes < 0) return "暂不可用";
    if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
    return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}
