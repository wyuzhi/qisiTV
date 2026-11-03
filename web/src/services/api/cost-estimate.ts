import { executeWorkspaceOperation } from "@/services/api/operations";

/** 后端按 BeefTV 官方算力价格目录算出的单项费用；amount 为 null 表示暂无价格，text 写明原因。 */
export type CostEstimate = {
    amount: number | null;
    approx?: boolean;
    basis: string;
    text: string;
    /** 先扣、出账后结算的金额，不计入合计。 */
    reserve?: number;
};

export type CostSummary = {
    amount: number;
    priced: number;
    unknown: number;
    approx?: boolean;
    text: string;
};

export type CostEstimateTarget = {
    modelKey: string;
    kind: "image" | "video" | "audio";
    parameters?: Record<string, string>;
    referenceImages?: number;
    referenceVideos?: number;
    text?: string;
};

export type GenerationCostEstimate = {
    items: CostEstimate[];
    summary: CostSummary;
};

/** 只读估算：不联网、不扣费、不建任务。 */
export async function estimateGenerationCost(targets: CostEstimateTarget[], signal?: AbortSignal) {
    const response = await executeWorkspaceOperation<GenerationCostEstimate>("generation.estimate", { params: { targets } }, signal);
    return response.result;
}
