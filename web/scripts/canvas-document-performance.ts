import { canvasDocumentMatchesFields } from "../src/lib/canvas/canvas-document-equality";

function stats(samples: number[]) {
    samples.sort((a, b) => a - b);
    return { medianMs: samples[Math.floor(samples.length / 2)], p95Ms: samples[Math.ceil(samples.length * .95) - 1] };
}
const results = [100, 500, 1000].map(count => {
    const nodes = Array.from({ length: count }, (_, i) => ({ id: `n${i}`, title: `Node ${i}`, position: { x: i * 360, y: 0 }, metadata: { prompt: "Fixed storyboard content. ".repeat(160), content: `resource-${i}` } }));
    const before = { nodes, connections: [], chatSessions: [{ id: "chat", messages: [{ content: "Prior assistant context. ".repeat(500) }] }], activeChatId: "chat", canvasAppearance: { mode: "dark" }, backgroundMode: "dots", showImageInfo: false };
    const cases = { unchanged: { ...before, nodes: [...nodes] }, changedLastNode: { ...before, nodes: nodes.map((node, i) => i === count - 1 ? { ...node, title: "Changed" } : node) } };
    return Object.entries(cases).map(([kind, after]) => {
        const oldSamples: number[] = [], nextSamples: number[] = [];
        const old = () => JSON.stringify(before) === JSON.stringify(after);
        const next = () => canvasDocumentMatchesFields(before, after);
        if (old() !== next()) throw new Error("Comparison results differ");
        for (let i = 0; i < 54; i++) {
            const run = (fn: () => boolean, samples: number[]) => { const start = performance.now(); fn(); const duration = performance.now() - start; if (i >= 3) samples.push(duration); };
            if (i % 2) { run(next, nextSamples); run(old, oldSamples); } else { run(old, oldSamples); run(next, nextSamples); }
        }
        return { count, kind, serializedBytes: Buffer.byteLength(JSON.stringify(before)), baseline: stats(oldSamples), candidate: stats(nextSamples) };
    });
}).flat();
console.log(JSON.stringify({ scope: "CPU document comparison only, not frame rate or backend persistence", runtime: Bun.version, samples: 51, warmup: 3, results }, null, 2));
