import { useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useTaskDetails } from "../../src/hooks/use-task-details";
import localforage from "localforage";
import { isBrowserWorkspace } from "../../src/services/browser-workspace";
import { createModelChannel, useConfigStore } from "../../src/stores/use-config-store";

if (isBrowserWorkspace()) {
    await useConfigStore.persist.rehydrate();
    useConfigStore.setState({ config: { ...useConfigStore.getState().config, channels: [createModelChannel({ id: "details-likeai", name: "LikeAI", apiFormat: "likeai", apiKey: "fixture-only", models: ["fixture-text"] })] } });
    const store = localforage.createInstance({ name: "qisitv-browser", storeName: "likeai_tasks" });
    for (const id of ["a", "b"]) await store.setItem(`guest:${id}`, {
        channelId: "details-likeai", mode: "text", downloaded: false,
        task: { id, projectId: "test-canvas", provider: "likeai", providerRequestId: `provider-${id}`, type: "canvas_text", status: "running", progress: 0, prompt: "fixture", attempts: 1, createdAt: "2026-10-02T00:00:00Z", updatedAt: "2026-10-02T00:00:00Z" },
    });
}

function Harness() {
    const [id, setId] = useState<string>();
    const query = useTaskDetails(id, "test-canvas");
    return <>
        {["a", "b", "local:legacy"].map((value) => <button key={value} onClick={() => setId(value)}>{value}</button>)}
        <button onClick={() => setId(undefined)}>close</button>
        <button onClick={() => window.dispatchEvent(new CustomEvent("canvas:task-cancelled", { detail: { task: { ...query.data?.task, id, status: "cancelled", completedAt: "2026-09-29T15:00:03Z" } } }))}>cancel event</button>
        <pre id="snapshot">{JSON.stringify({ id, data: query.data, loading: query.isLoading, error: query.isError })}</pre>
    </>;
}

createRoot(document.getElementById("root")!).render(<QueryClientProvider client={new QueryClient()}><Harness /></QueryClientProvider>);
