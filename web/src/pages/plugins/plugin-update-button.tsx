import { Button } from "antd";
import { ArrowUpCircle, RefreshCw } from "lucide-react";
import type { PluginUpdateCheck } from "@/services/api/plugins";
import { isLocalFolderSource } from "./plugin-install-confirm-modal";

/**
 * 从文件夹装的插件随时可以「重新加载」。从 npm 或精选列表装的插件，有新版本时写明版本号，
 * 确认已是最新时不显示按钮；查不了版本的（GitHub、网址来源或查询失败）照旧给「更新」。
 */
export function PluginUpdateButton({ pluginId, packageSpec, check, loading, onUpdate }: {
    pluginId: string;
    packageSpec: string;
    check?: PluginUpdateCheck;
    loading: boolean;
    onUpdate: () => void;
}) {
    if (isLocalFolderSource(packageSpec)) {
        return <Button className="plugin-settings-button" icon={<RefreshCw className="size-4" />} loading={loading} onClick={onUpdate}>重新加载</Button>;
    }
    const notice = check?.updates.find((item) => item.id === pluginId);
    if (!notice && check?.upToDate.includes(pluginId)) return null;
    return (
        <Button className="plugin-settings-button" type={notice ? "primary" : "default"} icon={<ArrowUpCircle className="size-4" />} loading={loading} onClick={onUpdate}>
            {notice ? `更新到 v${notice.latest}` : "更新"}
        </Button>
    );
}
