import type { ReactNode } from "react";
import type { SkillMetadata } from "@/services/api/skill-market";
import { publicationStatus, requirementLabel } from "./market-copy";

export function PublicationDetailContent({ metadata, status, author, notices, children }: {
    metadata: SkillMetadata;
    status: string;
    author?: string;
    notices?: ReactNode;
    children: ReactNode;
}) {
    return <article className="skill-market-preview" tabIndex={0} role="region" aria-label="投稿详情内容">
        <div className="skill-release-overview">
            <dl className="skill-release-metadata">
                <div><dt>版本</dt><dd>{metadata.versionLabel}</dd></div>
                {author ? <div><dt>作者</dt><dd>{author}</dd></div> : null}
                <div><dt>许可</dt><dd>{metadata.license}</dd></div>
                <div><dt>状态</dt><dd>{publicationStatus(status)}</dd></div>
            </dl>
            <p className="skill-release-description">{metadata.description}</p>
        </div>
        {notices ? <div className="skill-publish-notices">{notices}</div> : null}
        <div className="skill-release-sections">
            <section className="skill-release-section">
                <details><summary>使用条件</summary>
                    <p>{(metadata.requirements || []).map(requirementLabel).join("、") || "没有额外工具要求"}</p>
                    {metadata.requirementNotes ? <p>{metadata.requirementNotes}</p> : null}
                </details>
            </section>
            {children}
        </div>
    </article>;
}
