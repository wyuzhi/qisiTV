import { afterEach, expect, test } from "bun:test";
import { apiClient } from "../src/services/api/request";
import type { MarketSubmission, PublishPlan, SkillMetadata } from "../src/services/api/skill-market";
import { loadPublicationHistory, mergePublications } from "../src/pages/skills/skill-publications";

const metadata: SkillMetadata = { name: "历史技能", description: "文字工作流", versionLabel: "1.0.0", license: "MIT", sourceUrl: "", requirements: [], showcase: [] };
const local: PublishPlan = { planId: "local-plan", skillId: "local-skill", versionId: "local-version", archiveSha256: "hash", instruction: "body", metadata, files: [], status: "awaiting_submit_confirmation", submissionId: "remote-one", createdAt: "2026-10-01T00:00:00Z" };
const remote: MarketSubmission = { submissionId: "remote-one", metadata, status: "published", createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-03T00:00:00Z" };
const originalAdapter = apiClient.defaults.adapter;
afterEach(() => { apiClient.defaults.adapter = originalAdapter; });

function respond(connected: boolean, failure?: { route: string; code?: number }) {
    const requests: string[] = [];
    apiClient.defaults.adapter = async config => {
        const route = config.url!.split("/").at(-1)!;
        requests.push(route);
        const failed = failure?.route === route;
        const data = route === "authorization" ? { connected } : { items: route === "publish-plans" ? [local] : [remote] };
        return { config, status: 200, statusText: "OK", headers: {}, data: failed ? { code: failure.code || 503, reason: failure.code === 401 ? "publishing_authorization_required" : "market_unavailable", msg: "投稿服务暂不可用" } : { code: 0, data, msg: "ok" } };
    };
    return requests;
}

test("connected history reads both local plans and account submissions", async () => {
    const requests = respond(true);
    const history = await loadPublicationHistory();
    expect(requests).toContain("submissions");
    expect(history.plans).toEqual([local]);
    expect(history.submissions).toEqual([remote]);
    expect(history.remoteError).toBeUndefined();
});

test("disconnected history retains local plans without requesting private submissions", async () => {
    const requests = respond(false);
    const history = await loadPublicationHistory();
    expect(requests).not.toContain("submissions");
    expect(history.authorization?.connected).toBe(false);
    expect(history.plans).toEqual([local]);
    expect(history.submissions).toEqual([]);
});

test("cloud failure is reported independently while local plans remain available", async () => {
    respond(true, { route: "submissions" });
    const history = await loadPublicationHistory();
    expect(history.plans).toEqual([local]);
    expect(history.remoteError).toMatchObject({ message: "投稿服务暂不可用" });
    expect(history.localError).toBeUndefined();
});

test("local failure does not hide account submissions", async () => {
    respond(true, { route: "publish-plans" });
    const history = await loadPublicationHistory();
    expect(history.plans).toEqual([]);
    expect(history.submissions).toEqual([remote]);
    expect(history.localError).toBeInstanceOf(Error);
    expect(history.remoteError).toBeUndefined();
});

test("expired cloud authorization returns a disconnected state with local plans intact", async () => {
    respond(true, { route: "submissions", code: 401 });
    const history = await loadPublicationHistory();
    expect(history.authorization?.connected).toBe(false);
    expect(history.plans).toEqual([local]);
    expect(history.submissions).toEqual([]);
    expect(history.remoteError).toBeInstanceOf(Error);
});

test("account-only submissions and local-only drafts all appear once, newest first", () => {
    const draft = { ...local, submissionId: undefined, createdAt: "2026-10-02T00:00:00Z" };
    const rows = mergePublications([draft], [remote, { ...remote, submissionId: "remote-two", status: "submitted" }]);
    expect(rows.map(row => row.key)).toEqual(["submission/remote-one", "submission/remote-two", "plan/local-plan"]);
    expect(rows).toHaveLength(3);
});

test("matching submission IDs use current cloud status without creating duplicate rows", () => {
    const rows = mergePublications([local], [remote]);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("published");
    expect(rows[0].submission).toEqual(remote);
    expect(rows[0].plan).toBeUndefined();
    expect(local.status).toBe("awaiting_submit_confirmation");
});

test("an uploaded local draft keeps its explicit confirmation flow", () => {
    const rows = mergePublications([local], [{ ...remote, status: "ready_to_submit" }]);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("awaiting_submit_confirmation");
    expect(rows[0].plan).toEqual(local);
});
