import { useState } from "react";
import { App, Button } from "antd";
import { useSyncProgressStore } from "@/stores/use-sync-progress-store";
import { keepLocalCanvasCopyAndLoadLatest, syncLocalCanvasProjectToBackend } from "@/services/local-workspace-repository";

export function CanvasLocalSaveStatus({ canvasId, onShowVersions }: { canvasId: string; onShowVersions: () => void }) {
    const progress = useSyncProgressStore((state) => state.syncingProjects[canvasId]);
    const [busy, setBusy] = useState(false);
    const { message } = App.useApp();
    if (!progress || !["error", "conflict", "done"].includes(progress.phase)) return null;
    if (progress.phase === "done" && progress.draftCount) return <div role="status" data-canvas-no-zoom className="absolute left-1/2 top-14 z-[var(--z-toast)] flex max-w-[90%] -translate-x-1/2 items-center gap-2 rounded-lg border bg-background p-3 text-sm text-foreground shadow-lg">
        <span>{progress.message}</span>
        <Button size="small" onClick={onShowVersions}>查看版本</Button>
        <Button size="small" onClick={() => useSyncProgressStore.getState().setProjectProgress(canvasId, null)}>知道了</Button>
    </div>;
    if (progress.phase === "done") return null;
    const resolve = async (keepCopy: boolean) => {
        setBusy(true);
        try {
            if (keepCopy) {
                await keepLocalCanvasCopyAndLoadLatest(canvasId);
                window.location.reload();
            } else await syncLocalCanvasProjectToBackend(canvasId);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "保存失败，请稍后重试");
        } finally { setBusy(false); }
    };
    return <div role="status" data-canvas-no-zoom className="absolute left-1/2 top-14 z-[var(--z-toast)] flex max-w-[90%] -translate-x-1/2 flex-wrap items-center gap-2 rounded-lg border bg-background p-3 text-sm text-foreground shadow-lg">
        <span>{progress.phase === "conflict" ? "存在同时编辑的内容，本地修改已保留。" : "画布尚未保存到本地服务。"}</span>
        <Button size="small" loading={busy} onClick={() => void resolve(false)}>重试保存</Button>
        {progress.phase === "conflict" && <>
            <Button size="small" disabled={busy} onClick={onShowVersions}>查看版本</Button>
            <Button size="small" disabled={busy} onClick={() => void resolve(true)}>保留副本并载入最新</Button>
        </>}
    </div>;
}
