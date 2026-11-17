import { App } from "antd";
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";

import { useDirectorSaveCoordinator } from "@/components/canvas/director/use-director-save-coordinator";
import type { DirectorViewportHandle } from "@/components/canvas/director/director-viewport";
import { advanceDirectorPlayhead, snapDirectorTime } from "@/lib/canvas/director/director-animation-semantics";
import { directorAsyncSession } from "@/lib/canvas/director/director-async-session";
import { recordDirectorDiagnostic } from "@/lib/canvas/director/director-diagnostics-recorder";
import { createDirectorTransaction, installDirectorTerminalListeners, type DirectorTransaction } from "@/lib/canvas/director/director-gesture-transaction";
import { touchDirectorScene } from "@/lib/canvas/director/director-scene";
import { describeDirectorSaveStatus, resolveDirectorCloseOutcome, shouldBlockDirectorUnload, shouldOfferDirectorDraftRecovery } from "@/lib/canvas/director/director-save-wiring";
import { shouldReinitializeDirectorSession } from "@/lib/canvas/director/director-session";
import { useDirectorWorkbenchStore } from "@/stores/canvas/use-director-workbench-store";
import type { DirectorScene } from "@/types/director";

export function useDirectorWorkbenchSession({
    open,
    scene,
    projectId,
    onboardingScope,
    viewportRef,
    selectedObjectId,
    selectedBone,
    onResetSelection,
    resetWorkbench,
    onClose,
    onChange,
    onFlush,
    onShouldCaptureCover,
    onCaptureCover,
}: {
    open: boolean;
    scene: DirectorScene | null;
    projectId?: string;
    onboardingScope: string;
    viewportRef: RefObject<DirectorViewportHandle | null>;
    selectedObjectId: string | null;
    selectedBone: string | null;
    onResetSelection: () => void;
    resetWorkbench: () => void;
    onClose: () => void;
    onChange: (scene: DirectorScene) => void;
    onFlush?: () => void | Promise<void>;
    onShouldCaptureCover?: (scene: DirectorScene, shotId: string) => boolean;
    onCaptureCover?: (input: { scene: DirectorScene; shotId: string; beauty: Blob }) => Promise<void>;
}) {
    const { message, modal } = App.useApp();
    const [draft, setDraft] = useState<DirectorScene | null>(null);
    const [history, setHistory] = useState<DirectorScene[]>([]);
    const [future, setFuture] = useState<DirectorScene[]>([]);
    const [retrying, setRetrying] = useState(false);

    const playhead = useDirectorWorkbenchStore((state) => state.playhead);
    const playing = useDirectorWorkbenchStore((state) => state.playing);
    const autoKey = useDirectorWorkbenchStore((state) => state.autoKey);
    const setPlayhead = useDirectorWorkbenchStore((state) => state.setPlayhead);
    const setPlaying = useDirectorWorkbenchStore((state) => state.setPlaying);
    const setAutoKey = useDirectorWorkbenchStore((state) => state.setAutoKey);

    const draftRef = useRef<DirectorScene | null>(null);
    const openRef = useRef(open);
    openRef.current = open;
    const sessionRef = useRef(new AbortController());
    useEffect(() => {
        const controller = new AbortController();
        sessionRef.current = controller;
        openRef.current = open;
        if (!open) controller.abort();
        return () => { controller.abort(); openRef.current = false; };
    }, [open, scene?.id, projectId, onboardingScope]);

    const stagedRef = useRef<DirectorTransaction | null>(null);
    const initializedSceneIdRef = useRef<string | null>(null);
    const onChangeRef = useRef(onChange);
    const onFlushRef = useRef(onFlush);
    useEffect(() => { onChangeRef.current = onChange; onFlushRef.current = onFlush; }, [onChange, onFlush]);

    const closingRef = useRef(false);
    const recoveryPromptedRef = useRef<string | null>(null);

    const saveController = useDirectorSaveCoordinator({
        sceneId: scene?.id ?? null,
        initialScene: scene,
        persistScene: (next) => onChangeRef.current(next),
        flushPersistence: () => onFlushRef.current?.(),
    });
    const saveControllerRef = useRef(saveController);
    saveControllerRef.current = saveController;
    const saveIndicator = describeDirectorSaveStatus(saveController.progress);

    const retrySave = async () => {
        setRetrying(true);
        try {
            if (await saveController.retry()) {
                recordDirectorDiagnostic("DIRECTOR_SAVE_RETRY_RECOVERED", { sceneId: draftRef.current?.id, revision: saveController.progress.revision, userInitiated: true });
                message.success("已保存到项目");
                return;
            }
            const draftStored = Boolean(saveController.restoreCandidate());
            recordDirectorDiagnostic("DIRECTOR_SAVE_RETRY_FAILED", { sceneId: draftRef.current?.id, revision: saveController.progress.revision, draftStored, userInitiated: true });
            if (!draftStored) recordDirectorDiagnostic("DIRECTOR_SAVE_DRAFT_UNAVAILABLE", { sceneId: draftRef.current?.id, revision: saveController.progress.revision });
            if (draftStored) message.error("远端保存失败，本地草稿已保留，可稍后重试");
            else message.error("远端和本地都未保存，请不要关闭导演台并继续重试");
        } finally {
            setRetrying(false);
        }
    };

    const writeDraft = useCallback((next: DirectorScene | null) => {
        draftRef.current = next;
        setDraft(next);
    }, []);

    const mirrorDraft = useCallback(() => {
        const current = draftRef.current;
        if (!current || initializedSceneIdRef.current !== current.id) return;
        onChangeRef.current(current);
    }, []);

    const commitDraft = useCallback(() => {
        const current = draftRef.current;
        if (!current || initializedSceneIdRef.current !== current.id) return;
        saveControllerRef.current?.commitScene(current);
        onChangeRef.current(current);
    }, []);

    const writeAndPublish = useCallback((next: DirectorScene) => {
        writeDraft(next);
        saveControllerRef.current?.commitScene(next);
        onChangeRef.current(next);
    }, [writeDraft]);

    useEffect(() => {
        if (!open || !scene) return;
        if (!shouldReinitializeDirectorSession({ initializedSceneId: initializedSceneIdRef.current, nextSceneId: scene.id })) return;
        const next = structuredClone(scene);
        next.shots = next.shots.map((shot) => ({ ...shot, fps: shot.fps || 24 }));
        stagedRef.current?.end("cancel");
        initializedSceneIdRef.current = scene.id;
        writeDraft(next);
        setHistory([]);
        setFuture([]);
        onResetSelection();
        resetWorkbench();
    }, [onResetSelection, open, resetWorkbench, scene, writeDraft]);

    useEffect(() => {
        if (!open || !scene) return;
        if (recoveryPromptedRef.current === scene.id) return;
        recoveryPromptedRef.current = scene.id;

        const controller = saveControllerRef.current;
        const candidate = controller?.restoreCandidate() ?? null;
        if (!controller || !candidate) return;
        if (!shouldOfferDirectorDraftRecovery({ candidate, authoritativeScene: scene })) return;

        modal.confirm({
            title: "发现未保存的本地草稿",
            content: `这个镜头存在一份比项目更新的本地草稿（修订 ${candidate.revision}）。恢复后会立即写回项目并保存。`,
            okText: "恢复草稿",
            cancelText: "放弃草稿",
            closable: false,
            mask: { closable: false },
            keyboard: false,
            onOk: () => {
                if (!controller.restoreDraft(candidate)) {
                    message.error("草稿恢复失败，已保留当前场景");
                    return;
                }
                writeDraft(candidate.scene);
                message.success("已恢复本地草稿并写回项目");
            },
            onCancel: () => {
                if (controller.discardDraft()) message.success("已放弃本地草稿");
                else message.error("草稿删除失败，下次打开可能仍会提示");
            },
        });
    }, [message, modal, open, scene, writeDraft]);

    const activeShot = draft?.shots?.find((item) => item.id === draft.activeShotId) || draft?.shots?.[0] || null;
    const activeCamera = draft?.cameras?.find((item) => item.id === activeShot?.cameraId) || draft?.cameras?.[0] || null;
    const snappedPlayhead = snapDirectorTime(playhead, activeShot?.fps || 24);

    useEffect(() => {
        if (!playing || !activeShot) return;
        let frame = 0;
        let last = performance.now();
        let pending = 0;
        const frameInterval = 1 / Math.max(1, Math.min(120, activeShot.fps || 24));
        const tick = (now: number) => {
            pending += Math.max(0, (now - last) / 1000);
            last = now;
            if (pending >= frameInterval) {
                const elapsed = Math.floor(pending / frameInterval) * frameInterval;
                pending -= elapsed;
                setPlayhead(advanceDirectorPlayhead(useDirectorWorkbenchStore.getState().playhead, elapsed, activeShot.duration));
            }
            frame = requestAnimationFrame(tick);
        };
        frame = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(frame);
    }, [activeShot, playing, setPlayhead]);

    const commit = useCallback((updater: (current: DirectorScene) => DirectorScene) => {
        stagedRef.current?.end("commit");
        const current = draftRef.current;
        if (!current) return;
        setHistory((items) => [...items.slice(-49), structuredClone(current)]);
        setFuture([]);
        writeAndPublish(touchDirectorScene(updater(current)));
    }, [writeAndPublish]);

    const stagedTransaction = useMemo(() => createDirectorTransaction<DirectorScene>({
        read: () => draftRef.current,
        restore: (snapshot) => writeDraft(snapshot),
        commit: (from) => {
            setHistory((items) => [...items.slice(-49), from]);
            setFuture([]);
            commitDraft();
        },
        setActive: () => undefined,
    }), [commitDraft, writeDraft]);
    stagedRef.current = stagedTransaction;

    const stageGesture = useCallback((updater: (current: DirectorScene) => DirectorScene) => {
        const current = draftRef.current;
        if (!current) return;
        stagedTransaction.begin();
        writeDraft(touchDirectorScene(updater(current)));
    }, [stagedTransaction, writeDraft]);

    const replaceWithoutHistory = useCallback((updater: (current: DirectorScene) => DirectorScene) => {
        const current = draftRef.current;
        if (current) writeAndPublish(touchDirectorScene(updater(current)));
    }, [writeAndPublish]);

    useEffect(() => installDirectorTerminalListeners(stagedTransaction, {
        window,
        document,
        isHidden: () => document.visibilityState === "hidden",
    }), [stagedTransaction]);

    useEffect(() => () => stagedTransaction.end("cancel"), [open, selectedBone, selectedObjectId, stagedTransaction]);

    useEffect(() => {
        const onPageHide = () => {
            if (stagedTransaction.active()) stagedTransaction.end("commit");
            else mirrorDraft();
            void saveControllerRef.current?.handlePageHide();
        };
        const onBeforeUnload = (event: BeforeUnloadEvent) => {
            const controller = saveControllerRef.current;
            if (!controller || !shouldBlockDirectorUnload(controller.progress)) return;
            event.preventDefault();
            event.returnValue = "";
        };
        window.addEventListener("pagehide", onPageHide);
        window.addEventListener("beforeunload", onBeforeUnload);
        return () => {
            window.removeEventListener("pagehide", onPageHide);
            window.removeEventListener("beforeunload", onBeforeUnload);
        };
    }, [mirrorDraft, stagedTransaction]);

    useEffect(() => () => {
        stagedRef.current?.end("cancel");
        mirrorDraft();
    }, [mirrorDraft]);

    const undo = () => {
        const previous = history.at(-1);
        if (!previous || !draft) return;
        setHistory((items) => items.slice(0, -1));
        setFuture((items) => [structuredClone(draft), ...items].slice(0, 50));
        writeAndPublish(previous);
        onResetSelection();
    };
    const redo = () => {
        const next = future[0];
        if (!next || !draft) return;
        setFuture((items) => items.slice(1));
        setHistory((items) => [...items, structuredClone(draft)].slice(-50));
        writeAndPublish(next);
        onResetSelection();
    };

    const closeWorkbench = () => {
        if (closingRef.current) return;
        closingRef.current = true;
        stagedTransaction.end("cancel");
        mirrorDraft();
        void (async () => {
            let decision;
            try {
                decision = resolveDirectorCloseOutcome(await saveController.prepareClose());
            } catch {
                message.error("关闭前的保存检查失败，已留在导演台");
                closingRef.current = false;
                return;
            }

            if (decision.kind === "close") {
                const current = draftRef.current;
                const shot = current?.shots.find((item) => item.id === current.activeShotId) || current?.shots[0];
                if (current && shot && onCaptureCover && onShouldCaptureCover?.(current, shot.id) && viewportRef.current) {
                    const session = directorAsyncSession(sessionRef.current.signal);
                    try {
                        const beauty = await viewportRef.current.capture("beauty");
                        session.assertCurrent();
                        void onCaptureCover({ scene: current, shotId: shot.id, beauty }).catch((error) => {
                            if ((error instanceof DOMException && error.name === "AbortError")) return;
                            message.warning("导演台封面保存失败，下次打开镜头后可重试");
                        });
                    } catch (error) {
                        if ((error instanceof DOMException && error.name === "AbortError")) return;
                        message.warning("导演台截图失败，下次打开镜头后可重试");
                    }
                }
                sessionRef.current.abort();
                onClose();
                return;
            }
            if (decision.kind === "blocked") {
                recordDirectorDiagnostic("DIRECTOR_CLOSE_BLOCKED", { sceneId: draftRef.current?.id, saveOutcome: "stay", revision: saveController.progress.revision, draftStored: saveController.progress.draftStored });
                message.error(decision.message);
                closingRef.current = false;
                return;
            }

            modal.confirm({
                title: "远端保存失败",
                content: decision.message,
                okText: "仍然离开",
                cancelText: "留在导演台",
                closable: false,
                mask: { closable: false },
                keyboard: false,
                onOk: () => { sessionRef.current.abort(); onClose(); },
                onCancel: () => {
                    closingRef.current = false;
                },
            });
        })();
    };

    return {
        draft,
        draftRef,
        activeShot,
        activeCamera,
        history,
        future,
        commit,
        stagedTransaction,
        stageGesture,
        replaceWithoutHistory,
        writeAndPublish,
        undo,
        redo,
        saveIndicator,
        retrying,
        retrySave,
        closeWorkbench,
        sessionRef,
        openRef,
        playhead,
        snappedPlayhead,
        setPlayhead,
        playing,
        setPlaying,
        autoKey,
        setAutoKey,
    };
}

export type DirectorWorkbenchSession = ReturnType<typeof useDirectorWorkbenchSession>;
