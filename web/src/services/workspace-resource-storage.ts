import { isLocalRuntimeMode, isNativeDesktopRuntime } from "@/lib/runtime-mode";
import { isBrowserWorkspace } from "@/services/browser-workspace";

/**
 * Resource storage policy for the two local runtimes:
 * - native desktop: Go resource service is the durable local store;
 * - browser local: IndexedDB is the durable local store.
 * Hosted mode always attempts the remote resource API first.
 */
export function usesBrowserLocalResourceStore() {
    if (isBrowserWorkspace()) return true;
    return isLocalRuntimeMode() && !isNativeDesktopRuntime();
}

export function usesNativeLocalResourceStore() {
    if (isBrowserWorkspace()) return false;
    return isLocalRuntimeMode() && isNativeDesktopRuntime();
}
