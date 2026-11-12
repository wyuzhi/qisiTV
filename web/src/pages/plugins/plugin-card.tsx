import type { PluginCardProps } from "@/lib/plugins/plugin-types";

export function PluginCard({ name, description, sourceLabel, status, onOpen, openLabel, actions, children, "data-testid": testId }: PluginCardProps) {
    return (
        <section className="product-collection-card plugin-card library-card-surface" data-testid={testId}>
            <button type="button" className="plugin-card-main" aria-label={openLabel || `查看${name}详情`} onClick={onOpen}>
                <div className="plugin-card-heading">
                    <div className="min-w-0 flex-1">
                        <div className="plugin-card-title-row"><h3>{name}</h3></div>
                        <div className="plugin-card-labels"><span className="plugin-source-label">{sourceLabel}</span></div>
                    </div>
                </div>
                <p className="plugin-card-description">{description}</p>
            </button>
            <div className="plugin-card-actions">
                <span role="status" className="plugin-enabled-label">{status}</span>
                {actions}
            </div>
            {children}
        </section>
    );
}
