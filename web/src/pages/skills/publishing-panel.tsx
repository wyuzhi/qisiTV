import { Alert, App, Button, Checkbox, Dropdown, Form, Input, Select, Skeleton } from "antd";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router";
import { CircleUserRound, RefreshCw } from "lucide-react";
import type { CollectionHeaderProps } from "@/components/layout/collection-header";
import { AppModal } from "@/components/ui/product/app-modal";
import { getDesktopAppBinding } from "@/services/desktop-runtime";
import { getSkill, listSkills, type Skill } from "@/services/api/skills";
import { disconnectMarketAuthorization, preparePublication, refreshPublication, startMarketAuthorization, submitPublication, uploadPublication, type MarketAuthorization, type MarketSubmission, type PublishPlan, type SkillMetadata, type PublicationTarget } from "@/services/api/skill-market";
import { canSubmitPublication, capabilityOptions, needsPublicationTargetCorrection, publicationStatus, requirementLabel, unsupportedRequirements } from "./market-copy";
import { SkillFileDetails } from "./skill-file-details";
import { skillFailureMessage } from "./skill-feedback";
import { loadPublicationHistory, mergePublications } from "./skill-publications";
import { PublicationDetailContent } from "./publication-detail-content";
import { SkillReleaseMarkdown } from "./market-file-preview";

type PublicationFormValues = Omit<SkillMetadata, "skillId"> & PublicationTarget & { localSkillId: string };
type PublishingPanelProps = {
    planId?: string;
    renderHeader: (controls: Pick<CollectionHeaderProps<string>, "search" | "actions" | "createItems">) => ReactNode;
};

export async function openSkillWebsite(url: string) {
    const binding = getDesktopAppBinding()?.OpenSkillMarketURL;
    if (binding) await binding(url);
    else window.open(url, "_blank", "noopener,noreferrer");
}

export function SkillPublishingPanel({ planId, renderHeader }: PublishingPanelProps) {
    const { message } = App.useApp();
    const [params, setParams] = useSearchParams();
    const [plans, setPlans] = useState<PublishPlan[]>([]);
    const [submissions, setSubmissions] = useState<MarketSubmission[]>([]);
    const [revision, setRevision] = useState(0);
    const [remoteError, setRemoteError] = useState("");
    const [query, setQuery] = useState("");
    const [selected, setSelected] = useState("");
    const [skills, setSkills] = useState<Skill[]>([]);
    const [auth, setAuth] = useState<MarketAuthorization>({});
    const [busy, setBusy] = useState(false);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const [confirmed, setConfirmed] = useState(false);
    const [authorizationRequired, setAuthorizationRequired] = useState(false);
    const [creating, setCreating] = useState(false);
    const [preparingFrom, setPreparingFrom] = useState<PublishPlan | null>(null);
    const [form] = Form.useForm<PublicationFormValues>();
    const formRequirements = Form.useWatch("requirements", form) || [];
    const publicationTarget = Form.useWatch("publicationTarget", form);
    const publications = mergePublications(plans, submissions);
    const selectedPlan = plans.find(item => item.planId === selected);
    const currentRow = publications.find(item => item.key === selected || item.plan?.planId === selected || (selectedPlan?.submissionId && item.submission?.submissionId === selectedPlan.submissionId));
    const current = currentRow?.plan;
    const currentSubmission = current ? undefined : currentRow?.submission;
    const keyword = query.trim().toLocaleLowerCase();
    const visiblePublications = publications.filter(item => `${item.metadata.name} ${item.metadata.description} ${publicationStatus(item.status)}`.toLocaleLowerCase().includes(keyword));
    const website = auth.websiteUrl || "https://beeftv.app/skills";
    const replace = (next: PublishPlan) => { setPlans(items => [next, ...items.filter(item => item.planId !== next.planId)]); setSelected(next.planId); setConfirmed(false); setParams({ tab: "publish", planId: next.planId }); };
    const reload = useCallback(() => setRevision(value => value + 1), []);
    useEffect(() => {
        let stale = false;
        setLoading(true); setError("");
        void Promise.allSettled([loadPublicationHistory(), listSkills({ scope: "created", pageSize: 100 })]).then(([history, installed]) => {
            if (stale) return;
            if (history.status === "fulfilled") {
                const value = history.value;
                if (!value.localError) setPlans(value.plans);
                else setError(skillFailureMessage(value.localError, "本机草稿读取失败", "请刷新后重试。"));
                if (value.authorization) {
                    const authorization = value.authorization;
                    setAuth(previous => ({ ...authorization, ...(authorization.pending ? { userCode: previous.userCode, verificationUrl: previous.verificationUrl } : {}) }));
                }
                if (!value.remoteError || value.authorization?.connected === false) setSubmissions(value.submissions);
                setRemoteError(value.remoteError ? skillFailureMessage(value.remoteError, "历史投稿同步失败", "请检查账号连接后刷新重试。") : "");
            } else setError(skillFailureMessage(history.reason, "投稿记录读取失败", "请刷新后重试。"));
            if (installed.status === "fulfilled") setSkills(installed.value.skills);
            else setError(skillFailureMessage(installed.reason, "本机技能读取失败", "新建投稿前请刷新重试。"));
            setLoading(false);
        });
        return () => { stale = true; };
    }, [revision]);
    useEffect(() => { setSelected(planId || ""); }, [planId]);
    useEffect(() => {
        if (creating) return;
        window.addEventListener("focus", reload);
        return () => window.removeEventListener("focus", reload);
    }, [creating, reload]);
    useEffect(() => {
        const localSkillId = params.get("skillId");
        if (localSkillId) {
            const skill = skills.find(item => item.skillId === localSkillId);
            form.setFieldsValue({ localSkillId, name: skill?.skillName, description: skill?.description, versionLabel: skill?.version || "1.0.0", publicationTarget: skill?.marketRelease || skill?.originalSkillId ? undefined : "new" });
            setCreating(true);
        }
    }, [params, form, skills]);
    useEffect(() => { setConfirmed(false); setAuthorizationRequired(false); }, [selected, current?.preview?.previewDigest]);
    const run = async (work: () => Promise<unknown>) => {
        setBusy(true); setError("");
        try { await work(); } catch (e) { setError(skillFailureMessage(e, "投稿操作未完成", "请保留草稿，检查连接或提示中的使用条件后重试。")); } finally { setBusy(false); }
    };
    const makePlan = async (values: PublicationFormValues) => {
        const skill = skills.find(item => item.skillId === values.localSkillId);
        if (!skill) return;
        if (preparingFrom && skill.skillId === preparingFrom.skillId && skill.versionId !== preparingFrom.versionId) {
            setError("本机技能已更新，原稿仍保留。请从“我的技能”检查当前文件后重新准备投稿。");
            return;
        }
        await run(async () => {
            const { localSkillId, publicationTarget, marketSkillId, ...fields } = values;
            const metadata = { ...preparingFrom?.metadata, ...fields, name: fields.name || skill.skillName, description: fields.description || skill.description, requirements: fields.requirements || [], showcase: preparingFrom?.metadata.showcase || [] };
            // The selected publication target owns the cloud ID; never reuse a
            // legacy metadata ID as an implicit update destination.
            delete metadata.skillId;
            replace(await preparePublication(localSkillId, metadata, { publicationTarget, marketSkillId: publicationTarget === "existing" ? marketSkillId : undefined }, preparingFrom?.planId));
            setPreparingFrom(null);
            setCreating(false); message.success("已准备本机草稿，请检查文件后确认上传");
        });
    };
    const selectSkill = (id: string) => {
        const skill = skills.find(item => item.skillId === id);
        if (skill) form.setFieldsValue({ name: skill.skillName, description: skill.description, versionLabel: skill.version || "1.0.0", publicationTarget: skill.marketRelease || skill.originalSkillId ? undefined : "new", marketSkillId: undefined });
    };
    const reprepare = (plan: PublishPlan) => run(async () => {
        const { skill } = await getSkill(plan.skillId);
        if (skill.versionId !== plan.versionId) throw new Error("本机技能已更新，原稿仍保留。请从“我的技能”检查当前文件后重新准备投稿。");
        setSkills(items => [skill, ...items.filter(item => item.skillId !== skill.skillId)]);
        form.resetFields();
        form.setFieldsValue({ ...plan.metadata, requirements: [...plan.metadata.requirements], localSkillId: plan.skillId, publicationTarget: undefined, marketSkillId: plan.marketSkillId || plan.metadata.skillId });
        setPreparingFrom(plan); setConfirmed(false); setCreating(true);
    });
    const newDraft = () => { setPreparingFrom(null); setSelected(""); setError(""); setParams({ tab: "publish" }); setCreating(true); form.resetFields(); };
    const closeForm = () => { setCreating(false); if (params.has("skillId")) setParams({ tab: "publish" }); };
    const connectAuthorization = () => run(async () => {
        const value = await startMarketAuthorization(); setAuth(value);
        if (value.verificationUrl) await openSkillWebsite(value.verificationUrl);
    });
    return <>
        {renderHeader({
            search: { value: query, onChange: setQuery, placeholder: "搜索投稿" },
            createItems: [{ key: "publish", label: "新建投稿", onClick: newDraft }],
            actions: <>
                <button type="button" className="assets-header-compact-button" aria-label="刷新投稿" title="刷新投稿" disabled={loading || busy} aria-busy={loading} onClick={() => void reload()}><RefreshCw className={loading ? "size-4 animate-spin" : "size-4"} /></button>
                <Dropdown trigger={["click"]} menu={{ items: [
                    { key: "status", label: auth.connected ? "账号已连接" : "账号未连接", disabled: true },
                    { key: "authorization", label: "检查连接状态", onClick: reload },
                    { key: "website", label: "在官网查看投稿", onClick: () => void run(() => openSkillWebsite(`${website}/mine`)) },
                    ...(auth.connected ? [{ type: "divider" as const }, { key: "disconnect", label: "断开账号", onClick: () => void run(async () => { await disconnectMarketAuthorization(); setAuth({ connected: false }); setSubmissions([]); }) }] : []),
                ] }}><button type="button" className="assets-header-compact-button" aria-label="投稿账号与更多操作" title="投稿账号与更多操作" disabled={busy}><CircleUserRound className="size-4" /></button></Dropdown>
            </>,
        })}
        <section className="skill-market-content" aria-label="技能投稿">
        {!loading && remoteError ? <Alert type="warning" showIcon title={remoteError} className="my-4" action={<Button size="small" onClick={reload}>重试</Button>} /> : null}
        {!loading && auth.connected === false && !auth.userCode && !remoteError ? <Alert type="info" showIcon title="连接投稿账号后同步历史投稿" className="my-4" action={<Button size="small" loading={busy} onClick={() => void connectAuthorization()}>连接账号</Button>} /> : null}
        {auth.userCode && !auth.connected ? <div className="skill-publish-authorization"><span>在官网核对确认码 <strong>{auth.userCode}</strong>，授权后返回。</span><Button size="small" disabled={busy || loading} onClick={reload}>我已授权</Button></div> : null}
        {error && !creating && !current && !currentSubmission ? <Alert type="error" showIcon title={error} className="mb-4" /> : null}
        {loading ? <Skeleton active paragraph={{ rows: 6 }} /> : null}
        <AppModal scrollBody open={creating} title={preparingFrom ? "修改投稿" : "新建投稿"} onCancel={closeForm} footer={null} width={720}>
        {error ? <Alert type="error" showIcon title={error} className="mb-4" /> : null}
        <p className="skill-publish-intro">先准备本机草稿，核对文件后再确认上传和送审。</p>
        <Form form={form} layout="vertical" className="skill-publish-form workspace-form" onFinish={makePlan} scrollToFirstError={{ focus: true, block: "center" }} initialValues={{ versionLabel: "1.0.0", requirements: [], sourceUrl: "", publicationTarget: "new" }}>
            {preparingFrom ? <Alert type="info" title="沿用原稿的文件与版本。修改后生成新的本机草稿，原稿继续保留；请重新检查并确认上传。" className="mb-4" /> : null}
            <Form.Item name="localSkillId" label="选择本机技能" rules={[{ required: true, message: "请选择一个技能" }]}><Select disabled={Boolean(preparingFrom)} onChange={selectSkill} options={skills.filter(skill => skill.sourceType !== "market").map(skill => ({ value: skill.skillId, label: skill.skillName }))} /></Form.Item>
            <Form.Item name="publicationTarget" label="投稿目标" rules={[{ required: true, message: "请明确选择这次投稿的目标" }]} extra="改写他人的技能请选择新技能，并填写来源链接。"><Select options={[{ value: "new", label: "发布新技能" }, { value: "existing", label: "为我的市场技能发布新版本" }]} /></Form.Item>
            {publicationTarget === "existing" ? <Form.Item name="marketSkillId" label="已有市场技能编号" extra="在官网打开自己已发布的技能，从页面链接中复制技能编号。请勿填写本机技能编号。" rules={[{ required: true, message: "请填写你已发布的市场技能编号" }, { validator: (_, value) => value === form.getFieldValue("localSkillId") ? Promise.reject(new Error("这是本机技能编号；首次投稿请选择发布新技能。")) : Promise.resolve() }]}><Input /></Form.Item> : null}
            <Form.Item name="name" label="公开名称" rules={[{ required: true, message: "请填写公开名称" }]}><Input maxLength={80} /></Form.Item>
            <Form.Item name="description" label="技能简介" rules={[{ required: true, message: "请说明输入、输出和使用场景" }]}><Input.TextArea rows={3} maxLength={1024} /></Form.Item>
            <div className="grid gap-x-4 sm:grid-cols-2"><Form.Item name="versionLabel" label="版本" rules={[{ required: true, message: "请填写版本" }]}><Input maxLength={64} /></Form.Item><Form.Item name="license" label="许可证" rules={[{ required: true, message: "请选择你有权采用的许可证" }]}><Select options={["MIT", "Apache-2.0", "CC-BY-4.0", "CC-BY-SA-4.0", "CC0-1.0"].map(value => ({ value, label: value }))} /></Form.Item></div>
            <Form.Item name="sourceUrl" label="来源链接（改写他人内容时请填写）" rules={[{ type: "url", message: "请填写完整链接" }]}><Input /></Form.Item>
            <Form.Item name="requirements" label="必需工具与理解能力" extra="纯文字技能留空。请移除任何未确认的选项；具体使用条件写在下方。" rules={[{ validator: (_, value: string[] = []) => unsupportedRequirements(value).length ? Promise.reject(new Error("请移除未确认的能力；纯文字技能留空即可。")) : Promise.resolve() }]}><Select mode="multiple" allowClear options={[...capabilityOptions, ...unsupportedRequirements(formRequirements).map(value => ({ value, label: requirementLabel(value) }))]} /></Form.Item>
            <Form.Item name="requirementNotes" label="模型、素材和费用说明"><Input.TextArea rows={3} maxLength={1000} placeholder="例如：使用图片理解模型核对参考图，生成视频时按所选模型计费。" /></Form.Item>
            <p className="skill-publish-note">请确认内容已试用，不含密钥、私人素材或无权分享的内容。</p><div className="skill-market-actions"><Button type="primary" loading={busy} onClick={() => form.submit()}>准备文件预览</Button><Button onClick={closeForm}>取消</Button></div>
        </Form>
        </AppModal>
        {!loading ? visiblePublications.length ? <div className="skill-publish-drafts">
            {visiblePublications.map(item => <article className="workspace-list-row" key={item.key}>
                <div className="workspace-list-copy"><h2><button type="button" className="workspace-item-title" onClick={() => setSelected(item.plan?.planId || item.key)}>{item.metadata.name}</button></h2></div>
                <div className="workspace-list-controls"><span className="skill-market-state">{publicationStatus(item.status)}</span><Button size="small" onClick={() => setSelected(item.plan?.planId || item.key)}>查看详情</Button></div>
            </article>)}
        </div> : !error && !remoteError ? <p className="skill-market-empty">{keyword ? "没有匹配的投稿" : auth.connected ? "还没有投稿，可从右上角新建。" : "本机暂无投稿草稿。"}</p> : null : null}
        <AppModal flush scrollBody className="skill-release-dialog" wrapClassName="skill-release-wrap" open={Boolean(currentSubmission) && !creating} title={currentSubmission?.metadata.name || "投稿详情"} onCancel={() => { setSelected(""); setParams({ tab: "publish" }); }} footer={currentSubmission ? <div className="skill-publish-footer">{error ? <Alert type="error" showIcon title={error} /> : null}<Button onClick={() => void run(() => openSkillWebsite(`${website}/submissions/${encodeURIComponent(currentSubmission.submissionId)}`))}>在官网查看稿件</Button></div> : null} width="min(760px, calc(100vw - 32px))">
            {currentSubmission ? <PublicationDetailContent key={currentSubmission.submissionId} metadata={currentSubmission.metadata} status={currentSubmission.status} notices={currentSubmission.reviewReason ? <Alert type="info" title="审核意见" description={currentSubmission.reviewReason} /> : null}>
                <section className="skill-release-section"><SkillFileDetails files={currentSubmission.files || []} info={[{ label: "投稿编号", value: currentSubmission.submissionId }]} /></section>
            </PublicationDetailContent> : null}
        </AppModal>
        <AppModal flush scrollBody className="skill-release-dialog" wrapClassName="skill-release-wrap" open={Boolean(current) && !creating} title={current?.metadata.name || "投稿详情"} onCancel={() => { setSelected(""); setParams({ tab: "publish" }); }} width="min(760px, calc(100vw - 32px))" footer={current ? <div className="skill-publish-footer">
                {authorizationRequired && !auth.connected ? <Alert type="warning" showIcon title="请先关闭详情并连接投稿账号。" /> : null}
                {current.status === "awaiting_upload_confirmation" || current.status === "uploading" ? <Checkbox checked={confirmed} onChange={e => setConfirmed(e.target.checked)}>我已核对文件和分享权限，确认上传为私有草稿。</Checkbox> : null}
                {current.status === "awaiting_submit_confirmation" ? <Checkbox checked={confirmed} onChange={e => setConfirmed(e.target.checked)}>我已确认公开这份 skill，提交审核</Checkbox> : null}
                {current.status === "rejected" ? <p>请在官网按审核意见修改，保存后回到这里刷新预览，再次确认送审。</p> : null}
                <div className="skill-market-actions">
                    {!current.submissionId && current.status === "awaiting_upload_confirmation" ? <Button disabled={busy} onClick={() => void reprepare(current)}>修改信息并重新准备</Button> : null}
                    {current.submissionId ? <><Button loading={busy} onClick={() => void run(async () => replace(await refreshPublication(current.planId)))}>刷新预览与审核状态</Button><Button onClick={() => void run(() => openSkillWebsite(`${website}/submissions/${encodeURIComponent(current.submissionId!)}`))}>在官网修改稿件</Button></> : null}
                    {current.status === "awaiting_upload_confirmation" || current.status === "uploading" ? <Button type="primary" disabled={!confirmed || !auth.connected || needsPublicationTargetCorrection(current) || unsupportedRequirements(current.metadata.requirements).length > 0} loading={busy} onClick={() => void run(async () => { replace(await uploadPublication(current)); message.success("私有草稿已上传，请核对预览后再送审"); })}>确认上传私有草稿</Button> : null}
                    {current.status === "awaiting_submit_confirmation" ? <Button type="primary" disabled={!canSubmitPublication(current, confirmed)} loading={busy} onClick={() => {
                        if (!auth.connected) { setAuthorizationRequired(true); return; }
                        void run(async () => { replace(await submitPublication(current)); message.success("已送审，可在官网查看结果和修改意见"); });
                    }}>确认送审</Button> : null}
                </div>
            </div> : null}>
            {current ? <PublicationDetailContent key={current.planId} metadata={current.metadata} status={current.status} author={current.preview?.author} notices={<>
                {error ? <Alert type="error" showIcon title={error} /> : null}
                {needsPublicationTargetCorrection(current) ? <Alert type="warning" title="请修改信息并明确选择投稿目标，再重新准备。原稿和文件会继续保留。" /> : null}
                {unsupportedRequirements(current.metadata.requirements).length ? <Alert type="warning" title="这份草稿包含未确认的使用条件，请修改信息后重新准备。纯文字技能无需额外理解能力。" /> : null}
                {current.preview?.warnings?.map(value => <Alert key={value} type="warning" title={value} />)}
                {current.reviewReason ? <Alert type="info" title="审核意见" description={current.reviewReason} /> : null}
            </>}>
                <section className="skill-release-section"><details><summary>投稿信息</summary>
                    <p>投稿目标为{current.publicationTarget === "existing" ? "已有市场技能的新版本" : needsPublicationTargetCorrection(current) ? "需要确认" : "发布新技能"}</p>
                    {current.metadata.sourceUrl ? <p>来源链接 {current.metadata.sourceUrl}</p> : null}
                </details></section>
                {current.instruction ? <section className="skill-release-section"><details className="skill-release-instructions"><summary>使用说明</summary><SkillReleaseMarkdown content={current.instruction} /></details></section> : null}
                <section className="skill-release-section"><SkillFileDetails files={current.files} info={[{ label: "压缩包 SHA-256", value: current.archiveSha256 }, { label: "本机草稿编号", value: current.planId }, { label: "本机技能编号", value: current.skillId }, { label: "本机版本编号", value: current.versionId }, { label: "市场技能编号", value: current.marketSkillId }, { label: "投稿编号", value: current.submissionId }, { label: "预览摘要", value: current.preview?.previewDigest }]} /></section>
            </PublicationDetailContent> : null}
        </AppModal>
        </section>
    </>;
}
