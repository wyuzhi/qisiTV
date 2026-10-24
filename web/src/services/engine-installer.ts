import { publicAssetUrl } from "@/lib/public-asset";

export const ENGINE_INSTALLER_PLATFORM = "Mac · Apple 芯片 · macOS 13.5 或更新版本";
export const ENGINE_INSTALLER_BETA_NOTICE = "当前为本机试用测试版，安装包使用临时签名，尚未通过 Apple 公证。Intel Mac、Windows 和 Linux 安装包尚未提供。";

export function engineInstallerFilename(version: string) {
    const release = version.replace(/^v/, "");
    if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(release)) throw new Error("本机引擎安装包版本无效");
    return `qisiTV-Engine-${release}-darwin-arm64.dmg`;
}

/** The same versioned, same-origin package is used by the install gate and update link. */
export function engineInstallerUrl(version = import.meta.env?.VITE_APP_VERSION || "") {
    return publicAssetUrl(`downloads/engine/${engineInstallerFilename(version)}`);
}
