import { ArrowRight, Plus, RefreshCw } from "lucide-react";
import { Link, useNavigate } from "react-router";
import type { CanvasLibrarySummary } from "@/services/api/workspace-data";
import { ProjectPreview } from "@/components/canvas/canvas-project-card";
import { qisitvCapabilityItems } from "./home-data";
function formatDate(value: string) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "刚刚更新";
    return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" }).format(date).replaceAll("/", "-");
}

export function HomeDashboard({ projects, loading, error, onRetry }: { projects: CanvasLibrarySummary[]; loading: boolean; error: boolean; onRetry: () => void }) {
    const navigate = useNavigate();
    return (
        <main className="qisitv-home" aria-label="qisiTV 首页">
            <section className="qisitv-home-hero" aria-label="新建画布">
                <span className="qisitv-home-dot-base" aria-hidden />
                <span className="qisitv-home-dot-flow" aria-hidden />
                <span className="qisitv-home-dot-flow qisitv-home-dot-flow-delay" aria-hidden />
                <button type="button" className="qisitv-home-create" onClick={() => navigate("/canvas?mode=new")}>
                    <span className="qisitv-home-create-icon"><Plus /></span>
                    <span className="qisitv-home-create-title">新建画布创作</span>
                </button>
            </section>

            <nav className="qisitv-capabilities" aria-label="创作能力">
                {qisitvCapabilityItems.map(({ id, label, detail, to, icon: Icon, disabled }) => (
                    disabled ? (
                        <span key={id} className="qisitv-capability is-disabled" aria-disabled="true" title={`${label}：${detail}`}>
                            <span className="qisitv-capability-icon"><Icon /></span>
                            <strong>{label}</strong>
                        </span>
                    ) : (
                        <Link key={id} to={to} className="qisitv-capability">
                            <span className="qisitv-capability-icon"><Icon /></span>
                            <strong>{label}</strong>
                        </Link>
                    )
                ))}
            </nav>

            <section className="qisitv-home-section qisitv-recents">
                <header className="qisitv-section-heading"><h2>最近项目</h2><Link to="/project">查看全部 <ArrowRight /></Link></header>
                {error ? (
                    <button className="qisitv-home-error" type="button" onClick={onRetry}><RefreshCw />画布读取失败，点击重试</button>
                ) : (
                    <div className="qisitv-recent-grid">
                        {loading ? Array.from({ length: 4 }, (_, index) => <div className="qisitv-recent-card is-loading" key={index} />) : projects.length ? projects.map((project) => {
                            return <Link to={`/canvas/${project.id}`} className="qisitv-recent-card" key={project.id}>
                                <span className="qisitv-recent-preview"><ProjectPreview project={{ id: project.id, nodes: project.previewNodes }} emptyVariant="libtv" /></span>
                                <span className="qisitv-recent-copy"><strong>{project.title || "未命名"}</strong><small>{formatDate(project.updatedAt)}</small></span>
                                <ArrowRight className="qisitv-recent-arrow" />
                            </Link>;
                        }) : <button type="button" className="qisitv-recent-card is-empty" onClick={() => navigate("/canvas?mode=new")}><span className="qisitv-recent-preview"><Plus /></span><span className="qisitv-recent-copy"><strong>创建第一个画布</strong><small>让灵感有一个开始的地方</small></span></button>}
                    </div>
                )}
            </section>
        </main>
    );
}
