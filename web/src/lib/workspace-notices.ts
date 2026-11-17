export type WorkspaceNoticeItem = {
    id: string;
    tone?: "info" | "success" | "warning" | "error";
    title: string;
    onClose: () => void;
};

/** 同一 id 替换，保留其它提示；最多保留最近 3 条，避免堆叠挡内容。 */
export function addWorkspaceNotice<T extends WorkspaceNoticeItem>(items: T[], notice: T, limit = 3): T[] {
    return [...items.filter((item) => item.id !== notice.id), notice].slice(-limit);
}
