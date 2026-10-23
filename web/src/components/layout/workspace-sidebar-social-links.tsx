import { Globe } from "lucide-react";
import Github from "@lobehub/icons/es/Github";

export function WorkspaceSidebarSocialLinks() {
    return <div className="app-workspace-social-links">
        <a className="app-workspace-social-action" href="https://cheeser.link/" target="_blank" rel="noopener noreferrer" aria-label="打开起司主页" title="起司主页"><Globe aria-hidden="true" /></a>
        <a className="app-workspace-social-action" href="https://github.com/wyuzhi/qisiTV" target="_blank" rel="noopener noreferrer" aria-label="打开 qisiTV GitHub 仓库" title="qisiTV 源码"><Github aria-hidden="true" /></a>
    </div>;
}
