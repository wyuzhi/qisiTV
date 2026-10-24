import Foundation

// Only these first-party intents can become fixed CLI arguments. URLs never
// supply an executable path, arbitrary browser destination, or shell string.
func engineLaunchArguments(_ url: URL) -> [String]? {
    guard let parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
          parts.scheme == "qisitv", parts.user == nil, parts.password == nil,
          parts.port == nil, parts.fragment == nil else { return nil }
    if parts.host == "open", (parts.path.isEmpty || parts.path == "/"), parts.query == nil {
        return ["open"]
    }
    guard parts.host == "skills", parts.path == "/install", let items = parts.queryItems,
          items.count == 2, Set(items.map { $0.name }) == Set(["skillId", "releaseId"]) else { return nil }
    func identifier(_ name: String) -> String? {
        guard let value = items.first(where: { $0.name == name })?.value,
              value.range(of: "\\A[A-Za-z0-9][A-Za-z0-9_.-]{0,127}\\z", options: .regularExpression) != nil else { return nil }
        return value
    }
    guard let skill = identifier("skillId"), let release = identifier("releaseId") else { return nil }
    return ["open", "--skill-id", skill, "--release-id", release]
}
