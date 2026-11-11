import { Modal, Upload } from "antd";
import { AlertTriangle, CloudUpload } from "lucide-react";
import { useRef, useState } from "react";

import type { RegisteredPlugin } from "@/lib/plugins/plugin-types";
import type { PluginManagement } from "@/services/api/plugins";
import { AppModal } from "@/components/ui/product/app-modal";

import pluginDevelopmentPage from "../../../../docs/content/docs/plugins/plugin-development.mdx?raw";
import { getPluginDocumentation, PLUGIN_PERMISSION_LABELS, PLUGIN_ORIGIN_LABELS, pluginOrigin } from "./plugin-documentation";
import { PluginMarkdown } from "./plugin-markdown";
import "./plugins.css";

const pluginDevelopmentGuideMarkdown = pluginDevelopmentPage.replace(/^---[\s\S]*?---\s*/, "");

type UploadPluginModalProps = {
    open: boolean;
    onClose: () => void;
    onUpload: (file: File) => void;
};

export function UploadPluginModal({ open, onClose, onUpload }: UploadPluginModalProps) {
    const [isDraggingPlugin, setIsDraggingPlugin] = useState(false);
    const dragDepth = useRef(0);

    const handlePluginDragEnter = (event: React.DragEvent<HTMLDivElement>) => {
        event.preventDefault();
        dragDepth.current += 1;
        setIsDraggingPlugin(true);
    };

    const handlePluginDragLeave = (event: React.DragEvent<HTMLDivElement>) => {
        event.preventDefault();
        dragDepth.current -= 1;
        if (dragDepth.current <= 0) {
            dragDepth.current = 0;
            setIsDraggingPlugin(false);
        }
    };

    const handlePluginDrop = (event: React.DragEvent<HTMLDivElement>) => {
        event.preventDefault();
        dragDepth.current = 0;
        setIsDraggingPlugin(false);
    };

    return (
        <Modal
            className="workspace-modal workspace-modal-wide plugin-upload-modal"
            title="上传插件"
            open={open}
            centered
            footer={null}
            destroyOnHidden
            onCancel={onClose}
            styles={{ body: { maxHeight: "min(82vh, 900px)", overflowY: "auto", overscrollBehavior: "contain" } }}
        >
            <div className="plugin-upload-layout">
                <section className="plugin-upload-guide">
                    <PluginMarkdown source={pluginDevelopmentGuideMarkdown} />
                </section>
                <aside className="plugin-upload-panel">
                    <div className="plugin-upload-panel-heading">
                        <span className="plugin-upload-panel-icon"><CloudUpload className="size-5" /></span>
                        <div>
                            <h2>安装插件包</h2>
                            <p>选择统一站点插件包，安装后会显示在插件列表中。</p>
                        </div>
                    </div>
                    <div
                        className={`plugin-upload-dropzone-shell${isDraggingPlugin ? " is-dragging" : ""}`}
                        onDragEnter={handlePluginDragEnter}
                        onDragLeave={handlePluginDragLeave}
                        onDragOver={(event) => event.preventDefault()}
                        onDrop={handlePluginDrop}
                    >
                        <Upload.Dragger
                            className="plugin-upload-dropzone"
                            accept=".beeftv-plugin,.tgz,application/zip,application/gzip"
                            maxCount={1}
                            showUploadList={false}
                            beforeUpload={(file) => {
                                onUpload(file);
                                return false;
                            }}
                        >
                            <CloudUpload className="plugin-upload-dropzone-icon" />
                            <p className="ant-upload-text">{isDraggingPlugin ? "释放文件以上传插件" : "点击选择插件文件，也可拖拽到此处"}</p>
                            <p className="ant-upload-hint">支持 .beeftv-plugin 包或 npm 打出的 .tgz 包 · 大小不超过 48 MiB</p>
                        </Upload.Dragger>
                    </div>
                    <div className="plugin-upload-notice">
                        <AlertTriangle className="size-4" />
                        <span>插件会运行它自带的代码，能读取你在 BeefTV 里的数据和本机保存的 API Key。请只上传你信任的插件。</span>
                    </div>
                </aside>
            </div>
        </Modal>
    );
}

type PluginDetailsModalProps = {
    plugin?: RegisteredPlugin;
    management?: PluginManagement;
    restoreFocus: boolean;
    onClose: () => void;
};

export function PluginDetailsModal({ plugin, management, restoreFocus, onClose }: PluginDetailsModalProps) {
    const contributions = plugin?.manifest.contributes;
    const capabilities = [
        contributions?.providers?.length ? "模型渠道" : "",
        contributions?.canvasNodes?.length ? "画布节点" : "",
        contributions?.workflows?.length ? "工作流" : "",
        contributions && "editorSlots" in contributions && contributions.editorSlots?.length ? "编辑器扩展" : "",
    ].filter(Boolean);
    return (
        <AppModal
            flush
            scrollBody
            className="plugin-details-modal"
            wrapClassName="plugin-details-wrap"
            width="min(760px, calc(100vw - 32px))"
            title={plugin?.manifest.name}
            open={Boolean(plugin)}
            centered
            footer={null}
            destroyOnHidden
            focusTriggerAfterClose={restoreFocus}
            onCancel={onClose}
        >
            {plugin ? (
                <article className="plugin-details-content" tabIndex={0} aria-label="插件详情内容">
                    <div className="plugin-details-overview">
                        <dl className="plugin-details-metadata">
                            <div><dt>版本</dt><dd>{plugin.manifest.version}</dd></div>
                            {plugin.manifest.author ? <div><dt>作者</dt><dd>{plugin.manifest.author}</dd></div> : null}
                            <div><dt>来源</dt><dd>{PLUGIN_ORIGIN_LABELS[pluginOrigin(plugin)]}</dd></div>
                        </dl>
                        {plugin.manifest.description ? <p>{plugin.manifest.description}</p> : null}
                    </div>
                    <div className="plugin-details-sections">
                    <details>
                        <summary>使用说明</summary>
                        <PluginMarkdown className="plugin-details-document" source={getPluginDocumentation(plugin.manifest)} />
                    </details>
                    <details>
                        <summary>权限与能力</summary>
                        <ul className="plugin-details-permissions">
                            {plugin.manifest.permissions.length ? plugin.manifest.permissions.map(permission => (
                                <li key={permission}>{PLUGIN_PERMISSION_LABELS[permission] || permission}</li>
                            )) : <li>未声明额外权限</li>}
                        </ul>
                    </details>
                    <details>
                        <summary>插件与高级信息</summary>
                        <dl>
                            <div><dt>插件 ID</dt><dd>{plugin.manifest.id}</dd></div>
                            <div><dt>功能类型</dt><dd>{capabilities.join("、") || "应用扩展"}</dd></div>
                            {management ? <div><dt>启停范围</dt><dd>{management.activationScope === "user" ? "当前用户" : "整个工作区"}</dd></div> : null}
                            <div><dt>信任依据</dt><dd>{plugin.manifest.trusted
                                ? "运行时授予内置信任，依据随应用发布的来源配置。"
                                : "由用户自行确认安装来源与所需权限。"}</dd></div>
                        </dl>
                    </details>
                    </div>
                </article>
            ) : null}
        </AppModal>
    );
}
