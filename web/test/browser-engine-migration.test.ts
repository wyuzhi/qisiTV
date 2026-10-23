import { expect, test } from "bun:test";
import { assertBrowserManifestWritable, createBrowserFolderMigration, type EngineFolderImport, type EngineFolderStatus } from "../src/services/browser-engine-migration";
import type { ProjectDirectoryHandle } from "../src/services/browser-project-folder";

const manifestName = "project.qisitv.json";
const original = { format: "qisitv-project", formatVersion: 1, revision: 4, project: { id: "canvas-one", title: "原项目", nodes: [], connections: [] }, media: {} };
function fixture() {
    let manifest = JSON.stringify(original);
    let permission: PermissionState = "granted";
    const file = { kind: "file" as const, name: manifestName, getFile: async () => new File([manifest], manifestName), createWritable: async () => { throw new Error("browser migration must never write source files"); } };
    const directory: ProjectDirectoryHandle = { kind: "directory", name: "original-folder", getFileHandle: async (name) => { if (name !== manifestName) throw new Error(name); return file; }, getDirectoryHandle: async () => { throw new Error("no child"); }, values: async function* () { yield file; }, queryPermission: async () => permission, requestPermission: async () => permission };
    const root: ProjectDirectoryHandle = { ...directory, name: "projects", getFileHandle: async () => ({ ...file, getFile: async () => new File([JSON.stringify({ workspaceId: "workspace-one" })], ".qisitv-engine-owner.json") }), getDirectoryHandle: async (name) => { if (name !== directory.name) throw new Error("wrong directory"); return directory; }, values: async function* () { yield directory; } };
    const locks: string[] = [];
    let capturedScope = "";
    let receipts: unknown[] = [{ task: { id: "browser-task-one", projectId: "canvas-one", status: "succeeded", providerRequestId: "provider-one", inputJson: JSON.stringify({ prompt: "keep", apiKey: "private" }) }, apiKey: "private" }];
    const migrate = createBrowserFolderMigration({ root: async () => root, receipts: async (scope) => { capturedScope = scope; return receipts; }, lock: async (name, action) => { locks.push(name); return action(); } });
    const response: EngineFolderStatus = { canvasId: "canvas-one", directory: "original-folder", workspaceId: "workspace-one", state: "ready", pending: false, revision: 4, exportedRevision: 4, legacyReceipts: 1 };
    let request: EngineFolderImport | undefined;
    const send = async (value: EngineFolderImport) => {
        request = value;
        manifest = JSON.stringify({ ...original, formatVersion: 2, engineAuthority: { kind: "local-engine", canvasId: "canvas-one", workspaceId: "workspace-one" } });
        return response;
    };
    const input = { canvasId: "canvas-one", directoryName: "original-folder", scope: "old-browser-guest", send };
    return { migrate, input, response, locks, request: () => request, scope: () => capturedScope, read: () => manifest, setManifest: (value: unknown) => { manifest = JSON.stringify(value); }, setPermission: (value: PermissionState) => { permission = value; }, setReceipts: (value: unknown[]) => { receipts = value; } };
}

test("migration preserves original directory and old scope, sanitizes receipts, and verifies actual v2 disk authority", async () => {
    const f = fixture();
    expect(await f.migrate(f.input)).toEqual(f.response);
    expect(f.locks).toEqual(["qisitv:project-folder:canvas-one"]);
    expect(f.scope()).toBe("old-browser-guest");
    expect(f.request()?.expectedManifestSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(f.request()?.receiptsComplete).toBe(true);
    expect(JSON.stringify(f.request()?.receipts)).not.toContain("private");
    expect(JSON.stringify(f.request()?.receipts)).toContain("provider-one");
    expect(() => assertBrowserManifestWritable(JSON.parse(f.read()))).toThrow("引擎接管");
});

test("successful HTTP response is insufficient without projected original folder", async () => {
    const f = fixture();
    await expect(f.migrate({ ...f.input, send: async () => f.response })).rejects.toThrow("未确认迁移成功");
    expect(JSON.parse(f.read())).toEqual(original);
});

test("pending engine projection must remain visibly incomplete", async () => {
    const f = fixture();
    await expect(f.migrate({ ...f.input, send: async () => ({ ...f.response, pending: true, state: "pending" }) })).rejects.toThrow("尚未确认");
});

test("active task, mismatched project, and revoked folder permission fail before sending", async () => {
    const f = fixture();
    f.setReceipts([{ task: { id: "browser-running", projectId: "canvas-one", status: "running" } }]);
    await expect(f.migrate(f.input)).rejects.toThrow("仍有生成任务");
    expect(f.request()).toBeUndefined();
    f.setReceipts([{ task: { id: "browser-running", projectId: "another-project", status: "failed" } }]);
    await expect(f.migrate(f.input)).rejects.toThrow("任务身份不完整");
    f.setPermission("denied");
    await expect(f.migrate(f.input)).rejects.toThrow("重新授权");
    expect(JSON.parse(f.read())).toEqual(original);
});

test("already adopted project never falls back to old browser writer", async () => {
    const f = fixture();
    f.setManifest({ ...original, formatVersion: 2, engineAuthority: { kind: "local-engine", workspaceId: "workspace-one", canvasId: "canvas-one" } });
    await expect(f.migrate(f.input)).rejects.toThrow("引擎接管");
    expect(f.request()).toBeUndefined();
});

test("lost engine response leaves browser source intact and is never treated as saved", async () => {
    const f = fixture();
    await expect(f.migrate({ ...f.input, send: async () => { throw new Error("connection interrupted"); } })).rejects.toThrow("connection interrupted");
    expect(JSON.parse(f.read())).toEqual(original);
});
