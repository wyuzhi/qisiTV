import { afterEach, describe, expect, test } from "bun:test";

import type { DesktopRuntimeBinding, DesktopUpdateState } from "@/services/desktop-runtime";
import { prepareDesktopEditorsForUpdate, registerDesktopUpdatePreparation } from "@/services/desktop-update-preparation";
import {
    createDesktopUpdateController,
    desktopUpdateActionLabel,
    desktopUpdateProgressLabel,
    formatDesktopVersionLabel,
    hasDesktopUpdateBinding,
    parseDesktopUpdateState,
    resetSharedDesktopUpdateController,
    shouldShowDesktopUpdaterControls,
    userFacingDesktopUpdateError,
    type DesktopUpdateSnapshot,
} from "@/services/desktop-update";

afterEach(() => {
    resetSharedDesktopUpdateController();
});

test("an editor save refusal prevents native installation and retries after saving", async () => {
    let unsaved = true;
    const unregister = registerDesktopUpdatePreparation(() => {
        if (unsaved) throw new Error("剪辑内容尚未保存完成。");
    });
    const mock = mockBinding(state({ status: "ready", latestVersion: "v1.5.2" }));
    const controller = createDesktopUpdateController({
        getBinding: () => mock.binding,
        isDesktopRuntime: () => true,
        persistWorkspace: prepareDesktopEditorsForUpdate,
        scheduler: { interval: () => () => {} },
    });
    try {
        await controller.start();
        await controller.install();
        expect(mock.calls.install).toBe(0);
        expect(controller.getSnapshot().state.error).toBe("剪辑内容尚未保存完成。");
        unsaved = false;
        await controller.retry();
        expect(mock.calls.install).toBe(1);
    } finally {
        unregister();
        controller.dispose();
    }
});

test("late progress polling cannot overwrite a completed download", async () => {
    const mock = mockBinding(state({ status: "available", latestVersion: "v1.5.2" }));
    mock.holdDownload();
    let tick: (() => void) | undefined;
    const controller = createDesktopUpdateController({
        getBinding: () => mock.binding,
        isDesktopRuntime: () => true,
        persistWorkspace: async () => {},
        scheduler: {
            interval: (callback) => {
                tick = callback;
                return () => {};
            },
        },
    });
    const unsubscribe = controller.subscribe(() => {});
    try {
        await controller.start();
        const download = controller.download();
        const oldPoll = deferred<DesktopUpdateState>();
        mock.binding.UpdateStatus = () => oldPoll.promise;
        tick!();
        mock.finishDownload(state({ status: "ready", latestVersion: "v1.5.2" }));
        await download;
        oldPoll.resolve(state({ status: "downloading", latestVersion: "v1.5.2" }));
        await Promise.resolve();
        await Promise.resolve();
        expect(controller.getSnapshot().state.status).toBe("ready");
    } finally {
        unsubscribe();
        controller.dispose();
    }
});

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

function state(partial: Partial<DesktopUpdateState> & Pick<DesktopUpdateState, "status">): DesktopUpdateState {
    return {
        currentVersion: "v1.5.1",
        latestVersion: "",
        releaseNotes: "",
        downloadedBytes: 0,
        totalBytes: 0,
        error: "",
        ...partial,
    };
}

function mockBinding(initial: DesktopUpdateState) {
    let current = initial;
    const calls = { status: 0, check: 0, download: 0, install: 0 };
    const downloadGate = deferred<DesktopUpdateState>();
    let useDownloadGate = false;
    const installGate = deferred<void>();
    let useInstallGate = false;
    const binding: DesktopRuntimeBinding = {
        RuntimeConfig: async () => ({ baseURL: "http://127.0.0.1:43123/api", launchToken: "token" }),
        UpdateStatus: async () => {
            calls.status += 1;
            return current;
        },
        CheckForUpdate: async () => {
            calls.check += 1;
            return current;
        },
        DownloadUpdate: async () => {
            calls.download += 1;
            if (useDownloadGate) return downloadGate.promise;
            return current;
        },
        InstallUpdate: async () => {
            calls.install += 1;
            if (useInstallGate) return installGate.promise;
        },
    };
    return {
        binding,
        calls,
        setState: (next: DesktopUpdateState) => {
            current = next;
        },
        holdDownload: () => {
            useDownloadGate = true;
        },
        finishDownload: (next: DesktopUpdateState) => {
            current = next;
            useDownloadGate = false;
            downloadGate.resolve(next);
        },
        failDownload: (error: unknown) => {
            useDownloadGate = false;
            downloadGate.reject(error);
        },
        holdInstall: () => {
            useInstallGate = true;
        },
        finishInstall: () => {
            installGate.resolve();
        },
        failInstall: (error: unknown) => {
            installGate.reject(error);
        },
    };
}

function collect(controller: ReturnType<typeof createDesktopUpdateController>) {
    const snapshots: DesktopUpdateSnapshot[] = [];
    const stop = controller.subscribe((snapshot) => {
        snapshots.push(snapshot);
    });
    return {
        snapshots,
        latest: () => snapshots[snapshots.length - 1],
        stop,
    };
}

describe("desktop update parsing", () => {
    test("reads the frozen JSON contract fields and ignores unknown status", () => {
        expect(
            parseDesktopUpdateState({
                status: "available",
                currentVersion: "v1.5.1",
                latestVersion: "v1.5.2",
                releaseNotes: "修复保存",
                downloadedBytes: "12",
                totalBytes: 40,
                error: "",
            }),
        ).toEqual({
            status: "available",
            currentVersion: "v1.5.1",
            latestVersion: "v1.5.2",
            releaseNotes: "修复保存",
            downloadedBytes: 12,
            totalBytes: 40,
            error: "",
        });
        expect(parseDesktopUpdateState({ status: "nope", error: "boom" }).status).toBe("error");
        expect(formatDesktopVersionLabel("1.5.1")).toBe("v1.5.1");
        expect(desktopUpdateActionLabel("available")).toBe("下载更新");
        expect(desktopUpdateActionLabel("ready")).toBe("安装更新");
        expect(desktopUpdateProgressLabel(state({ status: "downloading", downloadedBytes: 12 * 1024 * 1024, totalBytes: 40 * 1024 * 1024 }))).toBe("12 MB / 40 MB");
        expect(userFacingDesktopUpdateError("Get https://github.com/glanderness/BeefTV/releases/latest/download/desktop-update.json")).toBe("更新没有完成，请再试一次。");
        expect(userFacingDesktopUpdateError("画布没有保存完成，更新没有开始。请稍后再试。")).toBe("画布没有保存完成，更新没有开始。请稍后再试。");
    });

    test("requires the four Wails update methods before treating the binding as live", () => {
        expect(hasDesktopUpdateBinding({ RuntimeConfig: async () => ({ baseURL: "http://127.0.0.1:1/api", launchToken: "x" }) })).toBe(false);
        expect(
            hasDesktopUpdateBinding({
                RuntimeConfig: async () => ({ baseURL: "http://127.0.0.1:1/api", launchToken: "x" }),
                UpdateStatus: async () => state({ status: "idle" }),
                CheckForUpdate: async () => state({ status: "idle" }),
                DownloadUpdate: async () => state({ status: "idle" }),
                InstallUpdate: async () => undefined,
            }),
        ).toBe(true);
    });
});

describe("desktop update controller", () => {
    test("available download ready restart waits for workspace persist", async () => {
        const available = state({
            status: "available",
            latestVersion: "v1.5.2",
            releaseNotes: "画布保存更稳",
        });
        const mock = mockBinding(available);
        const persist = deferred<void>();
        let persistCalls = 0;
        let ticks: Array<() => void> = [];
        const controller = createDesktopUpdateController({
            getBinding: () => mock.binding,
            isDesktopRuntime: () => true,
            persistWorkspace: async () => {
                persistCalls += 1;
                return persist.promise;
            },
            fallbackVersion: "v1.5.1",
            scheduler: {
                interval: (tick) => {
                    ticks.push(tick);
                    return () => {
                        ticks = ticks.filter((item) => item !== tick);
                    };
                },
            },
        });
        const view = collect(controller);

        await controller.start();
        expect(mock.calls.check).toBe(1);
        expect(view.latest().state.status).toBe("available");
        expect(shouldShowDesktopUpdaterControls(view.latest()!)).toBe(true);

        mock.holdDownload();
        const downloading = state({
            status: "downloading",
            latestVersion: "v1.5.2",
            downloadedBytes: 8 * 1024 * 1024,
            totalBytes: 40 * 1024 * 1024,
        });
        mock.setState(downloading);
        const downloadPromise = controller.download();
        expect(view.latest().state.status).toBe("downloading");
        mock.setState({ ...downloading, downloadedBytes: 24 * 1024 * 1024 });
        ticks[0]!();
        await Promise.resolve();
        await Promise.resolve();
        expect(view.latest().state.downloadedBytes).toBe(24 * 1024 * 1024);

        const ready = state({ status: "ready", latestVersion: "v1.5.2", releaseNotes: "画布保存更稳" });
        mock.finishDownload(ready);
        await downloadPromise;
        expect(view.latest().state.status).toBe("ready");
        expect(mock.calls.download).toBe(1);

        mock.holdInstall();
        const installPromise = controller.install();
        await Promise.resolve();
        expect(persistCalls).toBe(1);
        expect(mock.calls.install).toBe(0);
        expect(view.latest().persistBusy).toBe(true);

        persist.resolve();
        await Promise.resolve();
        await Promise.resolve();
        expect(mock.calls.install).toBe(1);
        expect(view.latest().state.status).toBe("installing");
        mock.finishInstall();
        await installPromise;
        expect(view.latest().state.status).toBe("installing");
        view.stop();
    });

    test("download failure can retry without a second startup check", async () => {
        const available = state({ status: "available", latestVersion: "v1.5.2" });
        const mock = mockBinding(available);
        const controller = createDesktopUpdateController({
            getBinding: () => mock.binding,
            isDesktopRuntime: () => true,
            persistWorkspace: async () => undefined,
            fallbackVersion: "v1.5.1",
            scheduler: { interval: () => () => {} },
        });
        const view = collect(controller);
        await controller.start();

        mock.holdDownload();
        const first = controller.download();
        await Promise.resolve();
        mock.failDownload(new Error("disk full"));
        await first;
        expect(view.latest().state.status).toBe("error");
        expect(userFacingDesktopUpdateError(view.latest().state.error)).toBe("更新没有完成，请再试一次。");

        mock.setState(state({ status: "ready", latestVersion: "v1.5.2" }));
        await controller.retry();
        expect(mock.calls.check).toBe(1);
        expect(mock.calls.download).toBe(2);
        expect(view.latest().state.status).toBe("ready");
        view.stop();
    });

    test("install is not called when canvas persist fails", async () => {
        const mock = mockBinding(state({ status: "ready", latestVersion: "v1.5.2" }));
        const controller = createDesktopUpdateController({
            getBinding: () => mock.binding,
            isDesktopRuntime: () => true,
            persistWorkspace: async () => {
                throw new Error("indexeddb locked");
            },
            fallbackVersion: "v1.5.1",
            scheduler: { interval: () => () => {} },
        });
        const view = collect(controller);
        await controller.start();
        await controller.install();
        expect(mock.calls.install).toBe(0);
        expect(view.latest().state.status).toBe("error");
        expect(view.latest().state.error).toBe("内容没有保存完成，更新没有开始。请稍后再试。");
        view.stop();
    });

    test("browser and disabled runtimes never call CheckForUpdate", async () => {
        const mock = mockBinding(state({ status: "idle" }));
        const browser = createDesktopUpdateController({
            getBinding: () => mock.binding,
            isDesktopRuntime: () => false,
            persistWorkspace: async () => undefined,
            fallbackVersion: "v1.5.1",
            scheduler: { interval: () => () => {} },
        });
        const browserView = collect(browser);
        await browser.start();
        await browser.download();
        await browser.install();
        expect(mock.calls.check).toBe(0);
        expect(mock.calls.download).toBe(0);
        expect(mock.calls.install).toBe(0);
        expect(browserView.latest().runtime).toBe("browser");
        expect(shouldShowDesktopUpdaterControls(browserView.latest()!)).toBe(false);
        expect(browserView.latest().state.currentVersion).toBe("v1.5.1");
        browserView.stop();

        const disabled = mockBinding(state({ status: "disabled", currentVersion: "v1.5.1" }));
        const desktopDisabled = createDesktopUpdateController({
            getBinding: () => disabled.binding,
            isDesktopRuntime: () => true,
            persistWorkspace: async () => undefined,
            fallbackVersion: "v1.5.1",
            scheduler: { interval: () => () => {} },
        });
        const disabledView = collect(desktopDisabled);
        await desktopDisabled.start();
        expect(disabled.calls.check).toBe(0);
        expect(disabledView.latest().state.status).toBe("disabled");
        expect(shouldShowDesktopUpdaterControls(disabledView.latest()!)).toBe(false);
        disabledView.stop();
    });

    test("startup CheckForUpdate runs once across remounts and unmount cancels polling", async () => {
        const idle = state({ status: "idle" });
        const mock = mockBinding(idle);
        const checkGate = deferred<DesktopUpdateState>();
        mock.binding.CheckForUpdate = async () => {
            mock.calls.check += 1;
            return checkGate.promise;
        };
        let ticks: Array<() => void> = [];
        const controller = createDesktopUpdateController({
            getBinding: () => mock.binding,
            isDesktopRuntime: () => true,
            persistWorkspace: async () => undefined,
            fallbackVersion: "v1.5.1",
            scheduler: {
                interval: (tick) => {
                    ticks.push(tick);
                    return () => {
                        ticks = ticks.filter((item) => item !== tick);
                    };
                },
            },
        });

        const first = collect(controller);
        const startFirst = controller.start();
        const second = collect(controller);
        void controller.start();
        await Promise.resolve();
        await Promise.resolve();
        expect(mock.calls.check).toBe(1);

        first.stop();
        checkGate.resolve(state({ status: "available", latestVersion: "v1.5.2" }));
        await startFirst;
        expect(second.latest().state.status).toBe("available");
        expect(mock.calls.check).toBe(1);

        mock.holdDownload();
        mock.setState(state({ status: "downloading", latestVersion: "v1.5.2", downloadedBytes: 1, totalBytes: 10 }));
        void controller.download();
        expect(ticks.length).toBe(1);
        const statusBeforeUnmount = mock.calls.status;
        second.stop();
        expect(ticks.length).toBe(0);
        expect(mock.calls.status).toBe(statusBeforeUnmount);

        const third = collect(controller);
        expect(mock.calls.check).toBe(1);
        expect(third.latest().state.status).toBe("downloading");
        expect(ticks.length).toBe(1);
        third.stop();
    });

    test("startup check failures keep the installed version and expose a working retry", async () => {
        const mock = mockBinding(state({ status: "idle", currentVersion: "v1.5.1" }));
        mock.binding.CheckForUpdate = async () => {
            mock.calls.check += 1;
            throw new Error("https://github.com/glanderness/BeefTV/releases/latest/download/desktop-update.json");
        };
        const controller = createDesktopUpdateController({
            getBinding: () => mock.binding,
            isDesktopRuntime: () => true,
            persistWorkspace: async () => undefined,
            fallbackVersion: "v1.5.1",
            scheduler: { interval: () => () => {} },
        });
        const view = collect(controller);
        await controller.start();
        expect(view.latest().state.status).toBe("error");
        expect(userFacingDesktopUpdateError(view.latest().state.error)).toBe("更新没有完成，请再试一次。");
        expect(view.latest().state.currentVersion).toBe("v1.5.1");
        expect(shouldShowDesktopUpdaterControls(view.latest()!)).toBe(true);
        mock.binding.CheckForUpdate = async () => {
            mock.calls.check += 1;
            return state({ status: "available", latestVersion: "v1.5.5" });
        };
        await controller.retry();
        expect(mock.calls.check).toBe(2);
        expect(view.latest().state.status).toBe("available");
        view.stop();
    });

    test("an up-to-date desktop can manually check again after a new release", async () => {
        const mock = mockBinding(state({ status: "idle", currentVersion: "v1.5.4", latestVersion: "v1.5.4" }));
        const controller = createDesktopUpdateController({ getBinding: () => mock.binding, isDesktopRuntime: () => true, scheduler: { interval: () => () => {} } });
        await controller.start();
        expect(shouldShowDesktopUpdaterControls(controller.getSnapshot())).toBe(true);
        expect(desktopUpdateActionLabel("idle")).toBe("检查更新");
        const successfulCheck = mock.binding.CheckForUpdate!;
        mock.binding.CheckForUpdate = async () => {
            mock.calls.check += 1;
            throw new Error("无法检查更新");
        };
        await controller.retry();
        expect(controller.getSnapshot().state.status).toBe("error");
        expect(controller.getSnapshot().state.latestVersion).toBe("v1.5.4");
        mock.binding.CheckForUpdate = successfulCheck;
        mock.setState(state({ status: "available", latestVersion: "v1.5.5" }));
        await controller.retry();
        expect(mock.calls.check).toBe(3);
        expect(mock.calls.download).toBe(0);
        expect(controller.getSnapshot().state.status).toBe("available");
        controller.dispose();
    });
});
