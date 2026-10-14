import { getActiveUserScope, getActiveUserScopeEpoch } from "./user-scope";

export type CapturedUserScope = { userScope: string; epoch: number };

export function captureUserScope(): CapturedUserScope {
    return { userScope: getActiveUserScope(), epoch: getActiveUserScopeEpoch() };
}

// The epoch also invalidates confirmations after an A → B → A switch.
export function assertUserScope(expected: CapturedUserScope) {
    const current = captureUserScope();
    if (expected.userScope !== current.userScope || expected.epoch !== current.epoch) {
        throw new Error("工作区账号已切换，请关闭后重新操作");
    }
}
