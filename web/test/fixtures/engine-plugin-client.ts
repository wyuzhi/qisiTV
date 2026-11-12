import { approvePluginClient, importEnginePluginClient, pendingClientPermissions } from "@/lib/plugins/engine-plugin-client";
import { configureEngineApiRuntime } from "@/services/api/request";
import { rememberEngineSession } from "@/services/engine-session";

rememberEngineSession({ token: "engine-plugin-transport-synthetic-fixture", sessionId: "plugin-test", expiresAt: new Date(Date.now() + 600_000).toISOString() });
configureEngineApiRuntime();
Object.assign(window, {
    loadClient: async () => Boolean(await importEnginePluginClient("fixture", "Fixture", "1", "1", () => true)),
    allowClient: () => approvePluginClient(pendingClientPermissions()[0]),
    pendingDigest: () => pendingClientPermissions()[0]?.digest,
});
