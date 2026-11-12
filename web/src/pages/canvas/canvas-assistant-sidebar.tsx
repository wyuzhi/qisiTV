import { createClientId } from "@/lib/client-id";
import { Button, Dropdown, Tooltip } from "antd";
import { History, MessageSquarePlus, Trash2, X, ArrowUpRight } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { AppDrawer } from "@/components/ui/product/app-drawer";
import { EngineFeatureNotice } from "@/components/workspace/engine-feature-notice";
import { isBrowserWorkspace } from "@/services/browser-workspace";
import { assetLibraryQueryKey, assetPickerQueryKey } from "@/components/assets/asset-view-session";
import { appQueryClient } from "@/lib/query-client";
import { referencedAssetIdsInPrompt, type CanvasResourceReference } from "@/lib/canvas/canvas-resource-references";
import type { AssistantAttachment, AssistantGenerationProposal, AssistantSkillSelection, AssistantPlan } from "@/services/api/agent-assistant";
import type { CanvasNodeData } from "@/types/canvas";
import { listAddedSkills, type Skill } from "@/services/api/skills";
import { SkillInstallModal } from "@/pages/skills/skill-install-modal";
import { AssistantPublicationEntry } from "@/pages/skills/assistant-publication-entry";
import { Link } from "react-router";
import { attachmentFromCanvasReference, attachmentRangeError, readAssistantInputDraft, saveAssistantInputDraft, uploadAssistantAttachment, type AssistantInputDraft } from "@/services/assistant-attachments";
import { CanvasAssistantAttachments } from "./canvas-assistant-attachments";
import { ASSISTANT_CONTINUE_PROMPT, ASSISTANT_CHECK_RESULTS_PROMPT, ASSISTANT_STARTER_PROMPTS, appendAssistantDraft, assistantSkillLabel, assistantStatusNotice, assistantVisibleReply } from "./canvas-assistant-copy";
import { CanvasAssistantComposer } from "./canvas-assistant-composer";
import { CanvasAssistantReply, CanvasAssistantTurnView, CanvasAssistantUserMessage } from "./canvas-assistant-turn";
import { AssistantReasoning } from "@/components/ai/message-reasoning";
import { usePluginSlot } from "@/lib/plugins/slot-registry";
import { ASSISTANT_LIVE_TURN_KEY, ASSISTANT_MAX_WIDTH, ASSISTANT_MIN_WIDTH, type CanvasAssistantController } from "./use-canvas-assistant";
import "./canvas-assistant-sidebar.css";

type Props = {
    assistant: CanvasAssistantController;
    canvasTitle: string;
    dockable: boolean;
    readOnly: boolean;
    selectedNodeIds: string[];
    references: CanvasResourceReference[];
    onLocateNodes: (nodeIds: string[]) => void;
    onRunProposal: (proposal: AssistantGenerationProposal, turnId: string) => void;
    onOpenModelSettings: () => void;
    proposalFeedback?: Record<string, string>;
    runningProposalIds?: ReadonlySet<string>;
    nodes?: CanvasNodeData[];
    continuation?: { pending: boolean; notice: string; stop: () => Promise<void>; refresh: () => void };
};

const PLAN_STATUS_TEXT: Record<AssistantPlan["items"][number]["status"], string> = { todo: "待做", doing: "进行中", done: "已完成", needs_user: "等待确认", blocked: "需要处理" };

export function CanvasAssistantPlan({ plan }: { plan: AssistantPlan | null | undefined }) {
    if (!plan?.items.length) return null;
    return <details className="canvas-assistant-card canvas-assistant-plan" open aria-label="当前制作计划">
        <summary>步骤进度 · {plan.items.filter(item => item.status === "done").length}/{plan.items.length}</summary>
        {plan.goal ? <p>{plan.goal}</p> : null}
        <ol>{plan.items.map(item => <li key={item.id}>
            <span>{item.title}</span><span className="canvas-assistant-meta">{PLAN_STATUS_TEXT[item.status]}</span>
            {item.note ? <span className="canvas-assistant-meta canvas-assistant-plan-note">{item.note}</span> : null}
        </li>)}</ol>
    </details>;
}

export function CanvasAssistantSidebar(props: Props) {
    if (isBrowserWorkspace()) {
        const close = () => props.assistant.setOpen(false);
        const content = <div className="p-4"><EngineFeatureNotice feature="内置创作助手" onClose={close} /></div>;
        return props.dockable
            ? <aside className="canvas-assistant-sidebar" style={{ width: props.assistant.width, flexBasis: props.assistant.width }} aria-label="创作助手">{content}</aside>
            : <AppDrawer flush open placement="right" title="创作助手" size="min(380px, 92vw)" onClose={close}>{content}</AppDrawer>;
    }
    return <ConnectedCanvasAssistantSidebar {...props} />;
}

function ConnectedCanvasAssistantSidebar(props: Props) {
    const { assistant, dockable, readOnly, selectedNodeIds, references, onLocateNodes, onRunProposal, onOpenModelSettings } = props;
    const [draft, setDraft] = useState("");
    const [attachments, setAttachments] = useState<AssistantAttachment[]>([]);
    const [selectedSkills, setSelectedSkills] = useState<AssistantSkillSelection[]>([]);
    const [uploads, setUploads] = useState<{ id: string; file: File; busy: boolean; error?: string }[]>([]);
    const attachmentCount = useRef(0);
    attachmentCount.current = attachments.length + uploads.length;
    const [inputError, setInputError] = useState("");
    const [draftLoaded, setDraftLoaded] = useState(false);
    const [draftReadAttempt, setDraftReadAttempt] = useState(0);
    const [loadedDraftIdentity, setLoadedDraftIdentity] = useState<string | null>(null);
    const draftWriteVersion = useRef(0);
    const [skillsOpen, setSkillsOpen] = useState(false);
    const [skillInstallOpen, setSkillInstallOpen] = useState(false);
    const [skillInstallGeneration, setSkillInstallGeneration] = useState(0);
    const [referencePickerOpen, setReferencePickerOpen] = useState(false);
    const [availableSkills, setAvailableSkills] = useState<Skill[]>([]);
    const [skillsLoading, setSkillsLoading] = useState(false);
    const [skillsError, setSkillsError] = useState("");
    const inputGeneration = useRef(0);
    const draftIdentity = assistant.canvasId;
    const [selectionAttached, setSelectionAttached] = useState(true);
    const [resultSelection, setResultSelection] = useState<AssistantInputDraft["resultSelection"]>(null);
    const resultNodeIds = assistant.sessionId && resultSelection?.sessionId === assistant.sessionId ? resultSelection.nodeIds : [];
    const logRef = useRef<HTMLDivElement | null>(null);
    const sidebarRef = useRef<HTMLDivElement | null>(null);
    const followLatestRef = useRef(true);
    const mediaReferences = references.filter(item => ["image", "video", "audio"].includes(item.kind));

    useEffect(() => {
        const generation = ++inputGeneration.current;
        setDraftLoaded(false); setLoadedDraftIdentity(null); setDraft(""); setAttachments([]); setSelectedSkills([]); setResultSelection(null); setUploads([]); setInputError(""); setAvailableSkills([]); setSkillsOpen(false); setSkillInstallOpen(false); setReferencePickerOpen(false);
        void readAssistantInputDraft(assistant.canvasId).then(saved => {
            if (generation !== inputGeneration.current) return;
            if (saved) { setDraft(saved.text || ""); setAttachments(saved.attachments || []); setSelectedSkills(saved.skills || []); setResultSelection(saved.resultSelection ?? null); }
            setDraftLoaded(true);
            setLoadedDraftIdentity(draftIdentity);
        }).catch(() => { if (generation === inputGeneration.current) { setInputError("暂时无法读取未发送的素材，请重新添加。"); setDraftLoaded(true); } });
    }, [assistant.canvasId, draftIdentity, draftReadAttempt]);

    useEffect(() => {
        if (!draftLoaded || loadedDraftIdentity !== draftIdentity) return;
        const generation = inputGeneration.current;
        const version = ++draftWriteVersion.current;
        void saveAssistantInputDraft(assistant.canvasId, { text: draft, attachments, skills: selectedSkills, resultSelection })
            .catch(() => { if (generation === inputGeneration.current && version === draftWriteVersion.current) setInputError("未发送内容暂时无法保存，请保持窗口打开。"); });
    }, [assistant.canvasId, attachments, draft, draftIdentity, draftLoaded, loadedDraftIdentity, selectedSkills, resultSelection]);

    const upload = useCallback(async (id: string, file: File) => {
        const generation = inputGeneration.current;
        setUploads(items => items.map(item => item.id === id ? { ...item, busy: true, error: undefined } : item));
        try {
            const attachment = await uploadAssistantAttachment(file, id);
            if (generation !== inputGeneration.current) return;
            void appQueryClient.invalidateQueries({ queryKey: assetLibraryQueryKey() });
            void appQueryClient.invalidateQueries({ queryKey: assetPickerQueryKey() });
            setAttachments(items => [...items, attachment]); setUploads(items => items.filter(item => item.id !== id));
        } catch (error) {
            if (generation !== inputGeneration.current) return;
            setUploads(items => items.map(item => item.id === id ? { ...item, busy: false, error: error instanceof Error ? error.message : "上传没有完成" } : item));
        }
    }, []);

    const addFiles = useCallback((files: File[]) => {
        if (readOnly || !draftLoaded || loadedDraftIdentity !== draftIdentity) return;
        if (attachmentCount.current + files.length > 8) { setInputError("一次最多添加 8 份参考素材"); return; }
        setInputError("");
        attachmentCount.current += files.length;
        const entries = files.map(file => ({ id: createClientId(), file, busy: true }));
        setUploads(items => [...items, ...entries]);
        entries.forEach(item => void upload(item.id, item.file));
    }, [attachments.length, draftIdentity, draftLoaded, loadedDraftIdentity, readOnly, upload, uploads.length]);

    const loadSkills = useCallback(async () => {
        setSkillsLoading(true); setSkillsError("");
        try { const data = await listAddedSkills(); setAvailableSkills(data.skills.filter(skill => skill.status === 1 && skill.isAdded)); }
        catch { setSkillsError("没有读到已安装技能，请重试。"); }
        finally { setSkillsLoading(false); }
    }, []);

    // 新的一条选择又可以被带上：用户移除只对当前这条消息生效。
    useEffect(() => {
        setSelectionAttached(true);
    }, [selectedNodeIds.join(",")]);

    const [slowStreamingHint, setSlowStreamingHint] = useState(false);
    useEffect(() => {
        if (!assistant.streaming || Boolean(assistant.streamed)) {
            setSlowStreamingHint(false);
            return;
        }
        setSlowStreamingHint(false);
        const timer = setTimeout(() => setSlowStreamingHint(true), 12_000);
        return () => clearTimeout(timer);
    }, [assistant.streaming, assistant.streamed]);

    const turnCount = assistant.turns.length;
    useLayoutEffect(() => {
        const node = logRef.current;
        if (node && followLatestRef.current) node.scrollTop = node.scrollHeight;
    }, [turnCount, assistant.streamed, assistant.reasoning, assistant.pendingUserText, assistant.lifecycleNotice, props.proposalFeedback]);

    const notice = assistant.status && !assistant.status.available && assistant.status.reason !== "host_starting" ? assistantStatusNotice(assistant.status.reason) : null;
    const inputReady = draftLoaded && loadedDraftIdentity === draftIdentity;
    const composerDisabled = readOnly || !inputReady;
    const composerReason = readOnly ? "这个画布是只读的，不能让助手改动。" : !draftLoaded ? "正在读取未发送内容…" : loadedDraftIdentity !== draftIdentity ? "未能读取草稿，请重新读取后继续。" : undefined;
    const attachedIds = [...new Set([...(selectionAttached ? selectedNodeIds : []), ...resultNodeIds])];
    const prepareResultCheck = useCallback((nodeIds: string[]) => {
        if (!inputReady || readOnly || assistant.streaming || assistant.sessionBusy || !assistant.sessionId) return;
        setDraft(current => appendAssistantDraft(current, ASSISTANT_CHECK_RESULTS_PROMPT));
        setResultSelection(current => ({ sessionId: assistant.sessionId!, nodeIds: [...new Set([...(current?.sessionId === assistant.sessionId ? current.nodeIds : []), ...nodeIds])] }));
    }, [assistant.sessionId, assistant.sessionBusy, assistant.streaming, inputReady, readOnly]);

    const send = useCallback(() => {
        const text = draft;
        if ((!text.trim() && !attachments.length) || readOnly || !draftLoaded || loadedDraftIdentity !== draftIdentity || uploads.length || attachments.some(item => attachmentRangeError(item)) || assistant.awaitingReceipt || assistant.sessionBusy || assistant.supplementBusy || (assistant.streaming && !assistant.canSupplement)) return;
        followLatestRef.current = true;
        setDraft("");
        setResultSelection(null);
        setAttachments([]); setSelectedSkills([]);
        // @ 引用到的素材库素材由界面按用户原文推导后交给后端校验归属：
        // 模型不能自己声明要读哪些素材。
        const assetReferences = [...new Set([...referencedAssetIdsInPrompt(text), ...attachments.flatMap(item => item.assetId ? [item.assetId] : [])])]
            .map((id) => ({ kind: "asset" as const, id }));
        void assistant.send(text, assistant.streaming ? [] : attachedIds, assetReferences, { attachments, skills: selectedSkills });
    }, [assistant, attachedIds, attachments, draft, draftIdentity, draftLoaded, loadedDraftIdentity, readOnly, selectedSkills, uploads.length]);

    const startResize = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
        event.preventDefault();
        const startX = event.clientX;
        const startWidth = sidebarRef.current?.getBoundingClientRect().width ?? assistant.width;
        const move = (moveEvent: PointerEvent) => assistant.setWidth(startWidth + (startX - moveEvent.clientX));
        const done = () => {
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", done);
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", done);
    }, [assistant]);

    const sessionItems = assistant.sessions.length
        ? assistant.sessions.map((item) => {
              const displayTitle = item.title || "还没有内容的对话";
              const deleteTitle = item.title || "新对话";
              return {
                  key: item.sessionId,
                  label: (
                      <div className="flex items-center justify-between gap-2">
                          <span className="min-w-0 flex-1 truncate">{displayTitle}</span>
                          <button
                              type="button"
                              className="inline-flex size-6 shrink-0 items-center justify-center rounded text-[var(--muted-foreground)] transition hover:bg-[var(--muted)] hover:text-[var(--foreground)]"
                              aria-label={`删除会话 ${deleteTitle}`}
                              title="删除对话"
                              onClick={(event) => {
                                  event.preventDefault();
                                  event.stopPropagation();
                                  void assistant.deleteSession(item.sessionId);
                              }}
                          >
                              <Trash2 className="size-3.5" aria-hidden="true" />
                          </button>
                      </div>
                  ),
                  onClick: () => void assistant.activateSession(item.sessionId),
              };
          })
        : [{ key: "empty", label: "还没有别的对话", disabled: true }];

    const sidePanelEntries = usePluginSlot("canvas.sidePanel");
    const [activeSidePanelId, setActiveSidePanelId] = useState<string>("assistant");
    const activePluginPanel = sidePanelEntries.find((entry) => entry.payload.id === activeSidePanelId);
    const ActivePluginPanelComp = activePluginPanel?.payload.component;

    const content = (
        <div className="canvas-assistant-panel" data-canvas-no-zoom>
            <header className="canvas-assistant-header">
                <div className="canvas-assistant-heading">
                    <h2>qisiTV 创作助手</h2>
                    {assistant.streaming ? (
                        <span className="canvas-assistant-live-badge" aria-hidden="true">
                            <span className="canvas-assistant-live-dot" />
                            工作中
                        </span>
                    ) : null}
                </div>
                <Link to="/skills" className="canvas-assistant-meta" aria-label="打开技能市场和我的投稿">技能</Link>
                <Tooltip title="新对话">
                    <Button type="text" size="small" aria-label="新对话" disabled={assistant.streaming || assistant.sessionBusy} icon={<MessageSquarePlus className="size-4" />} onClick={() => void assistant.startNewSession()} />
                </Tooltip>
                <Dropdown trigger={["click"]} placement="bottomRight" menu={{ items: sessionItems, selectedKeys: assistant.sessionId ? [assistant.sessionId] : [] }}>
                    <Button type="text" size="small" aria-label="历史对话" disabled={assistant.streaming || assistant.sessionBusy} icon={<History className="size-4" />} />
                </Dropdown>
                <Tooltip title="关闭 Agent">
                    <Button type="text" size="small" aria-label="关闭 Agent" icon={<X className="size-4" />} onClick={() => assistant.setOpen(false)} />
                </Tooltip>
            </header>

            {sidePanelEntries.length > 0 ? (
                <div className="flex items-center gap-1 border-b border-[var(--border)] px-3 py-1.5 text-xs">
                    <button
                        type="button"
                        className={`rounded-md px-2 py-1 font-medium ${!activePluginPanel ? "bg-[var(--muted)] text-[var(--foreground)]" : "text-[var(--muted-foreground)]"}`}
                        onClick={() => setActiveSidePanelId("assistant")}
                    >
                        创作助手
                    </button>
                    {sidePanelEntries.map((entry) => (
                        <button
                            key={entry.entryId}
                            type="button"
                            className={`inline-flex items-center gap-1 rounded-md px-2 py-1 font-medium ${activePluginPanel?.entryId === entry.entryId ? "bg-[var(--muted)] text-[var(--foreground)]" : "text-[var(--muted-foreground)]"}`}
                            onClick={() => setActiveSidePanelId(entry.payload.id)}
                        >
                            {entry.payload.icon}
                            <span>{entry.payload.title}</span>
                        </button>
                    ))}
                </div>
            ) : null}

            {ActivePluginPanelComp ? (
                <div className="min-h-0 flex-1 overflow-y-auto p-3">
                    <ActivePluginPanelComp canvasId={assistant.canvasId ?? undefined} selectedNodeIds={selectedNodeIds} />
                </div>
            ) : (
                <>
            {notice ? (
                <div className="canvas-assistant-notice" role="status">
                    <span>{notice.text}</span>
                    {notice.action === "model-settings" ? (
                        <Button size="small" onClick={onOpenModelSettings}>{notice.actionLabel}</Button>
                    ) : notice.action === "retry" ? (
                        <Button size="small" loading={assistant.statusBusy} onClick={() => void assistant.restartHost()}>{notice.actionLabel}</Button>
                    ) : null}
                </div>
            ) : null}

            <div ref={logRef} className="canvas-assistant-log" onScroll={() => { const node = logRef.current; if (node) followLatestRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 48; }}>
                {assistant.historyError ? <div className="canvas-assistant-notice" role="status"><span>{assistant.historyError}</span><Button size="small" onClick={() => void assistant.reloadHistory()}>重新读取</Button></div> : !assistant.historyLoaded && assistant.status?.reason !== "model_not_configured" ? <p className="canvas-assistant-meta" role="status">正在读取对话…</p> : null}
                {assistant.historyLoaded && turnCount === 0 && !assistant.pendingUserText && !assistant.pendingAttachments.length ? (
                    <div className="canvas-assistant-empty">
                        <h3>想在这张画布上做什么？</h3>
                        {ASSISTANT_STARTER_PROMPTS.slice(0, 3).map((prompt, index) => (
                            <button key={prompt} type="button" className="canvas-assistant-starter" onClick={() => setDraft(prompt)}>
                                <span>{["拆分分镜", "完善选中镜头", "整理画布"][index]}</span><ArrowUpRight size={14} aria-hidden="true" />
                            </button>
                        ))}
                    </div>
                ) : null}

                {assistant.turns.map((turn) => (
                    <CanvasAssistantTurnView
                        key={turn.turnId}
                        turn={turn}
                        canvasId={assistant.canvasId}
                        sessionId={assistant.sessionId}
                        status={assistant.turnStatus[turn.turnId]}
                        handledProposals={assistant.handledProposals}
                        proposalFeedback={props.proposalFeedback}
                        runningProposalIds={props.runningProposalIds}
                        generationDisabled={assistant.streaming || assistant.sessionBusy || assistant.awaitingReceipt || !assistant.historyLoaded || Boolean(assistant.historyError)}
                        onLocate={onLocateNodes}
                        onUndo={(turnId) => void assistant.undoTurn(turnId)}
                        onRunProposal={onRunProposal}
                        onRunScriptProposal={(proposal, turnId, alwaysAllow) => void assistant.runScriptProposal(proposal, turnId, alwaysAllow)}
                        runningScriptProposalIds={assistant.runningScriptProposalIds}
                        scriptProposalFeedback={assistant.scriptProposalFeedback}
                        onDismissProposal={assistant.markProposalDismissed}
                        nodes={props.nodes}
                        onCheckResults={!readOnly && inputReady && !assistant.streaming && !assistant.sessionBusy ? prepareResultCheck : undefined}
                        onContinue={!readOnly && inputReady && !assistant.streaming && !assistant.sessionBusy && turn.turnId === assistant.turns.at(-1)?.turnId ? () => setDraft(current => appendAssistantDraft(current, ASSISTANT_CONTINUE_PROMPT)) : undefined}
                        reasoningOpen={assistant.reasoningOpen[turn.turnId]}
                        onReasoningOpenChange={(open) => assistant.setReasoningOpen(turn.turnId, open)}
                    />
                ))}

                <CanvasAssistantPlan plan={assistant.plan} />
                <AssistantPublicationEntry canvasId={assistant.canvasId} turnCount={assistant.turns.length} running={assistant.streaming} />
                {props.continuation?.notice ? <div className="canvas-assistant-card" aria-label="自动继续状态">
                    <span role="status">{props.continuation.notice}</span>
                    <div className="canvas-assistant-card-actions">
                        {props.continuation.pending ? <Button size="small" onClick={() => void props.continuation?.stop()}>停止自动继续</Button> : null}
                        <Button size="small" onClick={props.continuation.refresh}>重新读取</Button>
                    </div>
                </div> : assistant.plan?.items.some(item => item.status !== "done") ? <p className="canvas-assistant-meta">确认过的素材会自动制作并继续原计划；需要新增素材时，会先向你确认。</p> : null}

                {assistant.pendingUserText || assistant.pendingAttachments.length ? (
                    <div className="canvas-assistant-turn">
                        <CanvasAssistantUserMessage text={assistant.pendingUserText || ""} selectedCount={assistant.pendingSelectedNodeIds.length} continuationId={assistant.pendingContinuationId} />
                        <CanvasAssistantAttachments attachments={assistant.pendingAttachments} />
                        {assistant.awaitingReceipt ? <p className="canvas-assistant-meta" role="status">正在读取这次处理的最终结果，已有内容仍然保留。</p> : null}
                        {assistant.pendingSkills.map(skill => <span className="canvas-assistant-chip" key={skill.skillId}>{assistantSkillLabel(skill)}</span>)}
                        {/* 正在生成的思考与下面的正文分开显示，默认折叠。 */}
                        <AssistantReasoning segments={assistant.reasoning} open={assistant.reasoningOpen[ASSISTANT_LIVE_TURN_KEY] === true} onOpenChange={(open) => assistant.setReasoningOpen(ASSISTANT_LIVE_TURN_KEY, open)} />
                        {assistantVisibleReply(assistant.streamed || "") ? <CanvasAssistantReply text={assistant.streamed} /> : null}
                        {assistant.supplements.map((item, index) => <div key={index} className="canvas-assistant-supplement">
                            <CanvasAssistantUserMessage text={item.text} selectedCount={0} />
                            <CanvasAssistantAttachments attachments={item.attachments || []} />
                            <p className="canvas-assistant-meta" role="status">{item.status === "accepted" ? "助手已收到补充要求。" : item.status === "sending" ? "正在发送补充要求…" : "未能确认收到补充要求。请查看最新回复后再决定是否发送。"}</p>
                        </div>)}
                        {assistant.streaming ? (
                            <>
                                <div className="canvas-assistant-working" role="status" aria-live="polite">
                                    <span className="canvas-assistant-working-dots" aria-hidden="true">
                                        <span />
                                        <span />
                                        <span />
                                    </span>
                                    <span className="canvas-assistant-working-text">{assistant.lifecycleNotice || "助手正在处理…"}</span>
                                </div>
                                {slowStreamingHint ? <p className="canvas-assistant-meta" role="status">思考耗时较长，若开启了系统代理或 VPN 请检查网络连通性，也可点击下方停止后重试。</p> : null}
                            </>
                        ) : null}
                    </div>
                ) : null}

                {!assistant.pendingUserText && !assistant.pendingAttachments.length ? assistant.supplements.filter(item => item.status !== "accepted").map((item, index) => <div key={`unconfirmed:${index}`} className="canvas-assistant-supplement">
                    <CanvasAssistantUserMessage text={item.text} selectedCount={0} />
                    <p className="canvas-assistant-meta" role="status">{item.status === "sending" ? "正在确认补充要求是否收到…" : "未能确认收到补充要求。请查看最新回复后再决定是否发送。"}</p>
                </div>) : null}

                {assistant.error ? (
                    <div className="canvas-assistant-card">
                        <span>{assistant.error}</span>
                        <div className="canvas-assistant-card-actions">
                            {assistant.canRetry ? <Button size="small" onClick={assistant.retryLast}>重试</Button> : null}
                            {!assistant.canRetry && !assistant.historyError ? <Button size="small" onClick={() => void assistant.reloadHistory()}>重新读取</Button> : null}
                            <Button size="small" type="text" onClick={assistant.dismissError}>知道了</Button>
                        </div>
                    </div>
                ) : null}
            </div>

            <CanvasAssistantComposer
                value={inputReady ? draft : ""}
                onChange={setDraft}
                onSend={send}
                onStop={() => void assistant.stop()}
                streaming={assistant.streaming}
                permissionMode={assistant.permissionMode}
                permissionLocked={assistant.permissionLocked}
                onPermissionChange={assistant.setPermissionMode}
                disabled={composerDisabled}
                disabledReason={composerReason}
                references={references}
                selectedCount={attachedIds.length}
                selectionAttached={attachedIds.length > 0}
                onDetachSelection={() => { setSelectionAttached(false); setResultSelection(null); }}
                modelBusy={assistant.modelBusy}
                canSupplement={assistant.canSupplement}
                supplementBusy={assistant.supplementBusy}
                hasAttachments={inputReady && attachments.length > 0}
                inputBusy={!draftLoaded || loadedDraftIdentity !== draftIdentity || assistant.awaitingReceipt || uploads.length > 0 || attachments.some(item => Boolean(attachmentRangeError(item)))}
                onFiles={addFiles}
                onOpenReferences={() => { setReferencePickerOpen(value => !value); setSkillsOpen(false); }}
                onOpenSkills={() => { setSkillsOpen(value => !value); setReferencePickerOpen(false); void loadSkills(); }}
                inputContent={<>
                    <CanvasAssistantAttachments attachments={inputReady ? attachments : []} onChange={(index, value) => setAttachments(items => items.map((item, i) => i === index ? value : item))} onRemove={index => setAttachments(items => items.filter((_, i) => i !== index))} />
                    {(inputReady ? uploads : []).map(item => <div key={item.id} className="canvas-assistant-notice" role="status"><span>{item.file.name} · {item.busy ? "正在保存素材…" : item.error}</span>
                        {!item.busy ? <><Button size="small" onClick={() => void upload(item.id, item.file)}>重试上传</Button><Button size="small" onClick={() => setUploads(items => items.filter(value => value.id !== item.id))}>移除</Button></> : null}</div>)}
                    {inputError ? <p className="canvas-assistant-meta" role="status">{inputError}</p> : null}
                    {draftLoaded && loadedDraftIdentity !== draftIdentity ? <Button size="small" onClick={() => setDraftReadAttempt(value => value + 1)}>重新读取草稿</Button> : null}
                    {(inputReady ? selectedSkills : []).map(skill => <span className="canvas-assistant-chip" key={skill.skillId}>技能：{skill.skillName || skill.skillId} · {skill.version || skill.versionId}<button aria-label={`移除技能 ${skill.skillName || skill.skillId}`} onClick={() => setSelectedSkills(items => items.filter(item => item.skillId !== skill.skillId))}><X size={12} /></button></span>)}
                    {skillsOpen && inputReady ? <div className="canvas-assistant-picker" aria-label="已安装技能">{skillsLoading ? <span>正在读取技能…</span> : skillsError ? <><span role="status">{skillsError}</span><Button size="small" onClick={() => void loadSkills()}>重新读取</Button></> : availableSkills.length ? availableSkills.map(skill => <button key={skill.skillId} type="button" aria-pressed={selectedSkills.some(item => item.skillId === skill.skillId)} onClick={() => setSelectedSkills(items => items.some(item => item.skillId === skill.skillId) ? items.filter(item => item.skillId !== skill.skillId) : [...items, { skillId: skill.skillId, versionId: skill.versionId, contentHash: skill.contentHash, skillName: skill.skillName, version: skill.version }])}>{skill.skillName} · {skill.version}</button>) : <span>还没有已安装的技能。</span>}<Button size="small" disabled={readOnly} onClick={() => { setSkillInstallGeneration(inputGeneration.current); setSkillInstallOpen(true); }}>安装技能</Button></div> : null}
                    {referencePickerOpen && inputReady ? <div className="canvas-assistant-picker" aria-label="画布参考素材">{mediaReferences.length ? mediaReferences.map(reference => <button type="button" key={reference.id} onClick={() => { try { if (attachmentCount.current >= 8) throw new Error("一次最多添加 8 份参考素材"); const item = attachmentFromCanvasReference(reference); attachmentCount.current++; setAttachments(items => [...items, item]); setReferencePickerOpen(false); } catch (error) { setInputError(error instanceof Error ? error.message : "无法添加素材"); } }}>{reference.title || reference.label}</button>) : <span className="canvas-assistant-meta">当前画布暂无可用素材</span>}</div> : null}
                </>}
            />
            <SkillInstallModal open={skillInstallOpen} onClose={() => setSkillInstallOpen(false)} onInstalled={skill => {
                if (skillInstallGeneration !== inputGeneration.current) return;
                setSkillInstallOpen(false);
                if (!skill.versionId || !/^[a-f0-9]{64}$/i.test(skill.contentHash)) {
                    setInputError("技能已安装，但没有读到可用版本，请重新读取技能。");
                    void loadSkills();
                    return;
                }
                setSelectedSkills(items => [...items.filter(item => item.skillId !== skill.skillId), { skillId: skill.skillId, versionId: skill.versionId, contentHash: skill.contentHash, skillName: skill.skillName, version: skill.version }]);
                setSkillsOpen(true);
                void loadSkills();
            }} />
                </>
            )}
        </div>
    );

    if (!dockable) {
        return (
            <AppDrawer
                flush
                open={assistant.open}
                placement="right"
                title={null}
                closable={false}
                onClose={() => assistant.setOpen(false)}
                size="min(380px, 92vw)"
                aria-label="qisiTV 创作助手"
            >
                {content}
            </AppDrawer>
        );
    }

    return (
        <aside ref={sidebarRef} className="canvas-assistant-sidebar" aria-label="qisiTV 创作助手" style={{ width: assistant.width, flexBasis: assistant.width }}>
            <button
                type="button"
                className="canvas-assistant-resize"
                aria-label="调整 Agent 宽度"
                onPointerDown={startResize}
                onKeyDown={(event) => {
                    if (event.key === "ArrowLeft") assistant.setWidth(Math.min(ASSISTANT_MAX_WIDTH, assistant.width + 16));
                    if (event.key === "ArrowRight") assistant.setWidth(Math.max(ASSISTANT_MIN_WIDTH, assistant.width - 16));
                }}
            />
            {content}
        </aside>
    );
}
