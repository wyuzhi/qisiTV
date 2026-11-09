import { isTextEditableTarget } from "../backspace-navigation-guard";

const CLIPBOARD_CONTROL_SELECTOR = "[data-canvas-no-zoom], [data-director-workbench], .canvas-node-toolbar, .canvas-node-toolbar-menu, .ant-modal-wrap, .ant-drawer, .ant-popover, .ant-dropdown, .ant-select-dropdown, [role='dialog'], [role='menu']";

export function ownsCanvasClipboard(target: unknown, activeElement: unknown): boolean {
    return ![target, activeElement].some(value => {
        if (isTextEditableTarget(value)) return true;
        const element = value as { closest?: (selector: string) => unknown } | null;
        return Boolean(element?.closest?.(CLIPBOARD_CONTROL_SELECTOR));
    });
}

export function isCanvasNodeClipboardMarker(value: string): boolean {
    const text = value.trim();
    return text.startsWith("open-ai-canvas-nodes:") || text.startsWith("open-ai-canvas-nodes-json:");
}

/** A paste event is a complete snapshot; never mix it with a later system read. */
export async function readCanvasClipboard(event: ClipboardEvent | null | undefined, clipboard: Pick<Clipboard, "read" | "readText"> | undefined): Promise<File | string> {
    if (event) {
        const data = event.clipboardData;
        const image = Array.from(data?.items || [])
            .filter(item => item.kind === "file" && item.type.startsWith("image/"))
            .map(item => item.getAsFile()).find(Boolean)
            || Array.from(data?.files || []).find(file => file.type.startsWith("image/"));
        return image || data?.getData("text/plain") || "";
    }
    if (clipboard?.read) {
        try {
            const items = await clipboard.read();
            const textItem = items.find(item => item.types.includes("text/plain"));
            const text = textItem ? await (await textItem.getType("text/plain")).text() : "";
            if (isCanvasNodeClipboardMarker(text)) return text;
            const image = items.find(item => item.types.some(type => type.startsWith("image/")));
            const type = image?.types.find(type => type.startsWith("image/"));
            if (image && type) return new File([await image.getType(type)], "clipboard-image.png", { type });
            return text;
        } catch {
            // Some webviews allow text access but not ClipboardItem reads.
        }
    }
    return clipboard?.readText ? clipboard.readText() : "";
}
