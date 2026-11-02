export function shouldApplyProjectSettingsMutation(input: {
    mountedProjectId: string;
    liveProjectId: string;
    mounted: boolean;
}) {
    if (!input.mounted) return false;
    return input.mountedProjectId === input.liveProjectId;
}
