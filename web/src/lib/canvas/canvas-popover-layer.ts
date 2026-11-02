// AntD adds a layer for each containing modal. Body portals must clear the
// actual containing modal, including nested or custom-z-index ones.
export function canvasPopoverLayer(anchor: HTMLElement | null): number | string {
    const fallback = "var(--z-dialog-popover)";
    const modal = anchor?.closest<HTMLElement>(".ant-modal-wrap");
    if (!modal || !anchor) return fallback;
    const modalLayer = Number.parseInt(getComputedStyle(modal).zIndex, 10);
    if (!Number.isFinite(modalLayer)) return fallback;
    const baseLayer = Number.parseInt(getComputedStyle(anchor).getPropertyValue("--z-dialog-popover"), 10);
    return Math.max(modalLayer + 1, Number.isFinite(baseLayer) ? baseLayer : 0);
}
