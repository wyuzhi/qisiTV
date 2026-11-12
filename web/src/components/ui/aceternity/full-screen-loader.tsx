import { useEffect, useState } from "react";

import { resolveEmbeddedAssetUrl } from "@/lib/embedded-runtime";
import { cn } from "@/lib/utils";

type FullScreenLoaderProps = {
    label?: string;
    detail?: string;
    className?: string;
};

export function FullScreenLoader({ label = "正在恢复工作区", detail = "正在读取本机工作区", className }: FullScreenLoaderProps) {
    return (
        <div
            data-full-screen-loader
            role="status"
            aria-live="polite"
            aria-label={`${label}，${detail}`}
            className={cn("full-screen-loader", className)}
        >
            <img alt="" src={resolveEmbeddedAssetUrl("/qisitv-logo.jpg")} className="qisitv-loading-logo" aria-hidden="true" />
        </div>
    );
}

export function WorkspaceRouteLoader({ label = "正在打开页面" }: { label?: string }) {
    const [visible, setVisible] = useState(false);

    useEffect(() => {
        const timer = window.setTimeout(() => setVisible(true), 140);
        return () => window.clearTimeout(timer);
        }, []);

    return (
        <section data-workspace-route-loader className={cn("workspace-route-loader", visible && "is-visible")} role="status" aria-live="polite" aria-label={label}>
            <div className="workspace-route-loader-content">
                <img alt="" src={resolveEmbeddedAssetUrl("/qisitv-logo.jpg")} className="qisitv-loading-logo is-compact" aria-hidden="true" />
                <span>{label}</span>
            </div>
        </section>
    );
}
