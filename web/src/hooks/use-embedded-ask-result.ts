import { useEffect } from "react";

import { createEmbeddedAskResultHandler, isEmbeddedRuntime } from "@/lib/embedded-runtime";

/** 右侧对话处理「问助手」后回传结果：只在 blocked / unavailable 时提示。 */
export function useEmbeddedAskResult(notify: (text: string) => void) {
    useEffect(() => {
        if (!isEmbeddedRuntime()) return;
        const onMessage = createEmbeddedAskResultHandler(notify);
        window.addEventListener("message", onMessage);
        return () => window.removeEventListener("message", onMessage);
    }, [notify]);
}
