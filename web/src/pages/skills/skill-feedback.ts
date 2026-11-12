export function skillFailureMessage(error: unknown, operation: string, nextStep: string) {
    const reason = error instanceof Error ? error.message.trim().replace(/[。；;]+$/, "") : "";
    return `${operation}：${reason || "未返回具体原因"}。${nextStep}`;
}
