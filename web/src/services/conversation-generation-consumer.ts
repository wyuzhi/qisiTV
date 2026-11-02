import { attachConversationMessage, type ConversationMessageAttachReceipt } from "@/services/api/operations";
import type { GenerationTask } from "@/services/api/task-center";
import type { StoredCreationConversation } from "@/services/creation-conversation-store";
import { attachMessageEffectKey } from "@/services/generation-task-materializer";

export class ConversationBindProjectionAdoptionError extends Error {
    constructor() {
        super("这次生成结果没能写进对话。请再试一次。");
        this.name = "ConversationBindProjectionAdoptionError";
    }
}

export type AdoptServerConfirmedConversation = (
    conversationId: string,
    document: StoredCreationConversation,
    revision: number,
) => Promise<StoredCreationConversation>;

export type BindBackendConversationMessageRuntime = {
    attachMessage?: typeof attachConversationMessage;
    adoptConfirmedConversation?: AdoptServerConfirmedConversation;
};

export type BoundConversationMessage = {
    receipt: ConversationMessageAttachReceipt;
    conversation?: StoredCreationConversation;
    resultUrls: string[];
    content: string;
    effectKey: string;
};

export async function bindBackendConversationMessageResult(input: {
    conversationId: string;
    messageId: string;
    task: GenerationTask;
    outputIndex?: number;
    signal?: AbortSignal;
    runtime?: BindBackendConversationMessageRuntime;
}): Promise<BoundConversationMessage> {
    if (input.task.status !== "succeeded") throw new Error("只有成功的任务才能绑定到消息");
    const runtime = input.runtime ?? {};
    const outputIndex = input.outputIndex ?? 0;
    const attachMessage = runtime.attachMessage ?? attachConversationMessage;
    const adoptConfirmedConversation = runtime.adoptConfirmedConversation ?? defaultAdoptConfirmedConversation;

    const response = await attachMessage({
        operationId: attachMessageEffectKey(input.task.id, input.messageId, outputIndex),
        conversationId: input.conversationId,
        taskId: input.task.id,
        messageId: input.messageId,
        outputIndex,
        signal: input.signal,
    });

    const receipt = response.result ?? {};
    const effectKey = typeof receipt.effectKey === "string" && receipt.effectKey
        ? receipt.effectKey
        : attachMessageEffectKey(input.task.id, input.messageId, outputIndex);
    if (receipt.bindingStatus === "deleted") {
        return { receipt, resultUrls: [], content: "", effectKey };
    }
    const canonical = canonicalConversationFromReceipt(input.conversationId, receipt);
    const adopted = await adoptConfirmedConversation(input.conversationId, canonical, receipt.revision as number);
    const resultUrls = Array.isArray(receipt.resultUrls) ? receipt.resultUrls.filter((item): item is string => typeof item === "string" && item.trim() !== "") : [];
    const content = typeof receipt.content === "string" ? receipt.content : "";
    return { receipt, conversation: adopted, resultUrls, content, effectKey };
}

async function defaultAdoptConfirmedConversation(
    conversationId: string,
    document: StoredCreationConversation,
    revision: number,
) {
    const { adoptServerConfirmedConversationDocument: adopt } = await import("@/services/creation-conversation-store");
    return adopt(conversationId, document, revision);
}

function canonicalConversationFromReceipt(conversationId: string, receipt: ConversationMessageAttachReceipt): StoredCreationConversation {
    const status = receipt.bindingStatus;
    if (status !== "bound" && status !== "replaced") throw new ConversationBindProjectionAdoptionError();
    if (typeof receipt.revision !== "number" || !Number.isInteger(receipt.revision) || receipt.revision < 1) {
        throw new ConversationBindProjectionAdoptionError();
    }
    const raw = receipt.conversation;
    if (!raw || typeof raw !== "object") throw new ConversationBindProjectionAdoptionError();
    const document = raw as StoredCreationConversation;
    if (typeof document.id !== "string" || !document.id || document.id !== conversationId) {
        throw new ConversationBindProjectionAdoptionError();
    }
    if (!Array.isArray(document.messages)) throw new ConversationBindProjectionAdoptionError();
    return { ...document, id: conversationId };
}
