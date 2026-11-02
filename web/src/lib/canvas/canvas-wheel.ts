type WheelInput = Pick<WheelEvent, "deltaX" | "deltaY" | "deltaMode" | "ctrlKey" | "metaKey" | "shiftKey">;

/**
 * 滚轮行为：自动沿用旧启发式，其余固定为缩放或平移。
 * 各平台/驱动的滚轮步长并不一致（同一份软件在不同电脑上会一个平移一个缩放），
 * 所以用户需要能自行固定，而不是只能依赖猜测。
 */
export type CanvasWheelBehavior = "auto" | "zoom" | "pan";

export function parseCanvasWheelBehavior(value: string | null | undefined): CanvasWheelBehavior {
    return value === "zoom" || value === "pan" ? value : "auto";
}

export function canvasWheelIntent(
    event: WheelInput,
    previous: { intent: "pan" | "zoom"; at: number } | null,
    now: number,
    behavior: CanvasWheelBehavior = "auto",
): "pan" | "zoom" {
    // 触控板捏合（浏览器转成 ctrl/meta + wheel）无论设置如何都是缩放，
    // Shift 与横向手势保持平移，免得固定缩放后拖不动画布。
    if (event.ctrlKey || event.metaKey) return "zoom";
    if (event.shiftKey || Math.abs(event.deltaX) > 0) return "pan";
    if (behavior === "zoom" || behavior === "pan") return behavior;
    if (previous && now - previous.at < 200) return previous.intent;
    const magnitude = Math.abs(event.deltaY);
    // 行模式（Firefox 等）默认按缩放处理；像素模式里 60/80/100/120 这类整十步长通常来自滚轮，
    // 小步长（触控板）按平移处理。
    return event.deltaMode !== 0 || (magnitude >= 40 && magnitude % 20 === 0) ? "zoom" : "pan";
}
