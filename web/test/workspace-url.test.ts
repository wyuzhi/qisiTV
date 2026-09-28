import { expect, test } from "bun:test";
import { workspaceRouteLocation, workspaceRouteUrl } from "../src/lib/workspace-url";

test("static workspace links preserve the hosted subdirectory and replace the hash route", () => {
    const href = "https://cheeser.link/qisitv/?source=site#/canvas/old";
    expect(workspaceRouteUrl("/canvas/new", href, true)).toBe("https://cheeser.link/qisitv/#/canvas/new");
    expect(workspaceRouteUrl("/settings?section=channels", href, true)).toBe("https://cheeser.link/qisitv/#/settings?section=channels");
});

test("bootstrap and settings use route search parameters inside the browser hash", () => {
    expect(workspaceRouteLocation(new URL("https://cheeser.link/qisitv/?source=site#/settings?section=channels"), true)).toEqual({ pathname: "/settings", search: "?section=channels" });
    expect(workspaceRouteLocation(new URL("https://cheeser.link/qisitv/"), true)).toEqual({ pathname: "/", search: "" });
});

test("desktop workspace preserves history routing", () => {
    expect(workspaceRouteUrl("/canvas/new", "http://127.0.0.1:3000/canvas/old", false)).toBe("http://127.0.0.1:3000/canvas/new");
    expect(workspaceRouteLocation(new URL("http://127.0.0.1:3000/settings?section=channels"), false)).toEqual({ pathname: "/settings", search: "?section=channels" });
});
