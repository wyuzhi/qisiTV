/** The hosted plugin UI and Agent setup use APIs first shipped with this engine. */
export const MINIMUM_ENGINE_VERSION = "2.2.1";

export function engineCompatibilityError(version: string): string | undefined {
    const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/.exec(version || "");
    const [major, minor, patch] = match ? match.slice(1, 4).map(Number) : [];
    if (major === 2 && (minor > 2 || (minor === 2 && patch >= 1))) return;
    return `本机引擎版本${match ? ` ${version}` : "未知"}与当前网页不兼容。请安装 ${MINIMUM_ENGINE_VERSION} 或更新的 2.x 引擎，重新打开并连接。已有项目和素材继续保留在本机。`;
}
