import { ApiError } from "@/services/api/request";
import { getMarketAuthorization, listMarketSubmissions, listPublishPlans, type MarketAuthorization, type MarketSubmission, type PublishPlan, type SkillMetadata } from "@/services/api/skill-market";

type PublicationHistory = {
    plans: PublishPlan[];
    submissions: MarketSubmission[];
    authorization?: MarketAuthorization;
    localError?: unknown;
    remoteError?: unknown;
};

export type PublicationRow = {
    key: string;
    metadata: SkillMetadata;
    status: string;
    plan?: PublishPlan;
    submission?: MarketSubmission;
};

export async function loadPublicationHistory(): Promise<PublicationHistory> {
    const [local, authorization] = await Promise.allSettled([listPublishPlans(), getMarketAuthorization()]);
    const history: PublicationHistory = {
        plans: local.status === "fulfilled" ? local.value.items || [] : [],
        submissions: [],
        authorization: authorization.status === "fulfilled" ? authorization.value : undefined,
        localError: local.status === "rejected" ? local.reason : undefined,
        remoteError: authorization.status === "rejected" ? authorization.reason : undefined,
    };
    if (!history.authorization?.connected) return history;
    try {
        history.submissions = (await listMarketSubmissions()).items || [];
    } catch (error) {
        history.remoteError = error;
        if (error instanceof ApiError && (error.status === 401 || error.reason === "publishing_authorization_required")) {
            history.authorization = { ...history.authorization, connected: false };
        }
    }
    return history;
}

export function mergePublications(plans: PublishPlan[], submissions: MarketSubmission[]): PublicationRow[] {
    const remoteIds = new Set(submissions.map(item => item.submissionId));
    const rows: PublicationRow[] = plans.filter(plan => !plan.submissionId || !remoteIds.has(plan.submissionId))
        .map(plan => ({ key: `plan/${plan.planId}`, metadata: plan.metadata, status: plan.status, plan }));
    for (const submission of submissions) {
        const local = plans.find(plan => plan.submissionId === submission.submissionId);
        // An uploaded draft still needs the local file/preview confirmation flow.
        const plan = ["draft", "validated", "ready_to_submit"].includes(submission.status) ? local : undefined;
        rows.push({ key: `submission/${submission.submissionId}`, metadata: plan?.metadata || submission.metadata, status: plan?.status || submission.status, plan, submission });
    }
    return rows.sort((left, right) => {
        const leftTime = Date.parse(left.submission?.updatedAt || left.submission?.createdAt || left.plan?.createdAt || "") || 0;
        const rightTime = Date.parse(right.submission?.updatedAt || right.submission?.createdAt || right.plan?.createdAt || "") || 0;
        return rightTime - leftTime;
    });
}
