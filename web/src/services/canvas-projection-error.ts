import { peekCanvasOperationJournal } from "@/services/canvas-operation-journal";

/** The native repository accepted a commit, but its local projection has not
 * completed. Callers must retry projection rather than submit a new operation. */
export class CanvasProjectionError extends Error {
    override cause?: unknown;
    canvasId: string;
    confirmedRevision: number;
    projectionIdentity: string | null;

    constructor(message: string, options: { cause?: unknown; canvasId: string; confirmedRevision: number; projectionIdentity?: string | null }) {
        super(message);
        this.name = "CanvasProjectionError";
        this.cause = options.cause;
        this.canvasId = options.canvasId;
        this.confirmedRevision = options.confirmedRevision;
        this.projectionIdentity = options.projectionIdentity ?? null;
    }
}

export function incompleteCanvasProjection(id: string, scope: string, identity: string | null | undefined, cause: unknown) {
    const journal = peekCanvasOperationJournal(id, scope);
    return new CanvasProjectionError("服务端已保存，本地画布还没写完。请重试这次回写，不要重新生成。", {
        cause,
        canvasId: id,
        confirmedRevision: journal?.confirmedRevision ?? 0,
        projectionIdentity: identity ?? journal?.pendingProjection?.identity ?? null,
    });
}
