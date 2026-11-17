import type { ReactNode } from "react";

import { Callout } from "@/components/ui/product/callout";
import type { WorkspaceNoticeItem as BaseWorkspaceNoticeItem } from "@/lib/workspace-notices";

export type WorkspaceNoticeItem = BaseWorkspaceNoticeItem & { action?: ReactNode };

/** 工作区顶部的非阻塞提示堆，复用 Callout 的语义样式和主题 token。 */
export function WorkspaceNoticeStack({ notices }: { notices: WorkspaceNoticeItem[] }) {
    if (!notices.length) return null;
    return (
        <div className="pointer-events-none fixed left-1/2 top-[calc(var(--canvas-topbar-offset,56px)+52px)] z-[var(--z-toast)] flex w-[min(400px,calc(100vw-32px))] -translate-x-1/2 flex-col gap-2" role="status" aria-live="polite">
            {notices.map((notice) => (
                <div key={notice.id} className="pointer-events-auto">
                    <Callout
                        tone={notice.tone ?? "info"}
                        title={notice.title}
                        action={notice.action}
                        onClose={notice.onClose}
                        closeLabel="关闭提示"
                        className="shadow-[0_18px_50px_rgba(15,23,42,.22)] backdrop-blur-2xl"
                    />
                </div>
            ))}
        </div>
    );
}
