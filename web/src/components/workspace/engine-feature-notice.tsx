import type { ReactNode } from "react";
import { Button } from "antd";
import { Link } from "react-router";
import { HardDrive } from "lucide-react";

import { WorkspacePage } from "@/components/layout/workspace-page";
import { isBrowserWorkspace } from "@/services/browser-workspace";

/** Shown only after opening a feature that executes in the native engine. */
export function EngineFeatureNotice({ feature, onClose }: { feature: string; onClose?: () => void }) {
    return <section className="space-y-4 rounded-2xl border border-border bg-card p-5" aria-label={`${feature}需要本机引擎`}>
        <HardDrive className="size-6 text-muted-foreground" aria-hidden />
        <h2 className="text-lg font-semibold">使用{feature}时连接本机引擎</h2>
        <p className="text-sm leading-6 text-muted-foreground">此功能需要在你的电脑上执行。基础画布、素材导入和图片／视频 API 生成可以继续在网页使用。</p>
        <p className="text-xs leading-5 text-muted-foreground">连接前请保存当前项目。网页项目不会自动合并到引擎工作区，可在连接后按需接入原项目文件夹。</p>
        <div className="flex flex-wrap gap-2">
            <Link to="/engine"><Button type="primary">设置本机引擎</Button></Link>
            {onClose ? <Button onClick={onClose}>继续使用画布</Button> : <Link to="/project"><Button>返回项目</Button></Link>}
        </div>
    </section>;
}

export function RequireLocalEngine({ feature, children }: { feature: string; children: ReactNode }) {
    if (!isBrowserWorkspace()) return children;
    return <WorkspacePage><div className="mx-auto max-w-2xl py-8"><EngineFeatureNotice feature={feature} /></div></WorkspacePage>;
}
