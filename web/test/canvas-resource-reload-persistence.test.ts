import { expect, test } from "bun:test";

function runScenario<T>(scenario: string): Promise<T> {
    return new Promise((resolve, reject) => {
        const worker = new Worker(new URL("./helpers/generation-storage-consistency.worker.ts", import.meta.url).href, { type: "module" });
        worker.onmessage = (event) => {
            worker.terminate();
            if (event.data.ok) resolve(event.data.result);
            else reject(new Error(event.data.error));
        };
        worker.onerror = (event) => {
            worker.terminate();
            reject(event.error ?? new Error(event.message));
        };
        worker.postMessage(scenario);
    });
}

test("a node edited while the recovered result awaits folder persistence is not replaced by the older snapshot", async () => {
    const result = await runScenario<{ error: string; editorTitle: string; editorX: number; storedTitle: string; storedX: number; folderWrites: number }>("reload-edit-during-folder-save");
    expect(result.error).toContain("画布或节点已改变");
    expect(result.editorTitle).toBe("edited while saving");
    expect(result.editorX).toBe(900);
    expect(result.storedTitle).toBe("edited while saving");
    expect(result.storedX).toBe(900);
    expect(result.folderWrites).toBe(1);
});

test("the original result can finish when its own folder acknowledgement advances the revision", async () => {
    const result = await runScenario<{ content: string; status: string; revision: number; folderWrites: number }>("reload-folder-revision");
    expect(result.content).toStartWith("blob:");
    expect(result.status).toBe("success");
    expect(result.revision).toBe(2);
    expect(result.folderWrites).toBe(1);
});

test("a failed folder acknowledgement keeps recovery available and retries the same materialized result", async () => {
    const result = await runScenario<{ error: string; recoverableAfterFailure: boolean; editorRecoverableAfterFailure: boolean; content: string; status: string; finalRecoverable: boolean; folderWrites: number; taskId: string }>("reload-folder-failure-retry");
    expect(result.error).toContain("folder permission denied");
    expect(result.recoverableAfterFailure).toBe(true);
    expect(result.editorRecoverableAfterFailure).toBe(true);
    expect(result.content).toStartWith("blob:");
    expect(result.status).toBe("success");
    expect(result.finalRecoverable).toBe(false);
    expect(result.taskId).toBe("reload-original-task");
    expect(result.folderWrites).toBe(3);
});
