import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const pagesDir = join(import.meta.dir, "../src/pages");

function sourceFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) return sourceFiles(path);
        return /\.tsx$/.test(entry.name) ? [path] : [];
    });
}

// 「滚轮操作」只是一个 prop：页面里任何一块画布漏传，用户切换后那块画布仍按「自动」走。
test("页面里每一块 InfiniteCanvas 都接收滚轮操作设置", () => {
    const usages = sourceFiles(pagesDir).flatMap((file) => {
        const source = readFileSync(file, "utf8");
        return [...source.matchAll(/<InfiniteCanvas\b([\s\S]*?)>/g)].map((match) => ({ file, props: match[1] }));
    });
    expect(usages.length).toBeGreaterThanOrEqual(2);
    for (const usage of usages) expect({ file: usage.file, passesWheelBehavior: /\bwheelBehavior=/.test(usage.props) }).toEqual({ file: usage.file, passesWheelBehavior: true });
});