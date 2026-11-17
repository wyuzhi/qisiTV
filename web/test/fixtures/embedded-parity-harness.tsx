import { createRoot } from "react-dom/client";
import { useEffect, useRef, useState } from "react";
import { Button, ConfigProvider } from "antd";

import { CanvasProjectSelectionToolbar } from "@/pages/canvas/canvas-project-selection-toolbar";
import { WorkspaceNoticeStack, type WorkspaceNoticeItem } from "@/components/layout/workspace-notice";
import { embeddedCanvasNoticeText } from "@/lib/embedded-workspace-sync";

window.__BEEFTV_HARNESS__ = { embedded: true, apiBase: "/beeftv/app/api", basePath: "/beeftv/app", parentOrigin: window.location.origin };

function NoticeDemo({ count }: { count: number }) {
    const [open, setOpen] = useState(true);
    if (!open) return null;
    const notices: WorkspaceNoticeItem[] = [
        { id: "demo", tone: "info", title: embeddedCanvasNoticeText("canvas-created", "雨夜街道") || "", action: <Button size="small" autoInsertSpace={false}>打开</Button>, onClose: () => setOpen(false) },
    ];
    if (count > 1) notices.push({ id: "ask", tone: "warning", title: "右侧正在发送，稍后再点", onClose: () => setOpen(false) });
    return <WorkspaceNoticeStack notices={notices} />;
}

function Harness() {
    const anchorRef = useRef<HTMLDivElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const params = new URLSearchParams(window.location.search);
    const noticeCount = Number(params.get("notice") || 0);
    const guide = params.get("guide") === "1";
    const [mounted, setMounted] = useState(false);
    const [behindClicks, setBehindClicks] = useState(0);
    useEffect(() => setMounted(true), []);
    return (
        <div style={{ minHeight: "100vh", background: "#0f1115", padding: 48 }}>
            <button id="behind" type="button" aria-label="空白区" onClick={() => setBehindClicks((value) => value + 1)} style={{ position: "fixed", inset: 0, zIndex: 100, border: 0, background: "transparent" }} />
            {guide ? <div id="guide-bar" style={{ position: "fixed", left: "50%", top: "var(--canvas-topbar-offset,56px)", width: 320, height: 40, transform: "translateX(-50%)", zIndex: "var(--z-toolbar)" }} /> : null}
            <div ref={containerRef} style={{ position: "relative", width: 760, height: 260, border: "1px solid rgba(255,255,255,.14)", borderRadius: 16, background: "#151922" }}>
                <div ref={anchorRef} style={{ position: "absolute", left: 378, top: 150, width: 4, height: 4 }} />
                {mounted ? <CanvasProjectSelectionToolbar
                    anchorRef={anchorRef}
                    containerRef={containerRef}
                    count={2}
                    selectedVideoCount={0}
                    mergingVideos={false}
                    onAlign={() => {}}
                    onArrange={() => {}}
                    onCreateStoryboard={() => {}}
                    onCreateReferenceGroup={() => {}}
                    onBatchConnect={() => {}}
                    onMergeVideos={() => {}}
                    onAskAssistant={() => {}}
                    onSaveWorkflow={() => {}}
                /> : null}
            </div>
            <output id="behind-count">{behindClicks}</output>
            {noticeCount > 0 ? <NoticeDemo count={noticeCount} /> : null}
        </div>
    );
}

createRoot(document.getElementById("root")!).render(
    <ConfigProvider>
        <Harness />
    </ConfigProvider>,
);
