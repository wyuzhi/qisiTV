import Foundation

@main
struct EngineLaunchRequestTests {
    static func main() {
        let good: [(String, [String])] = [
            ("qisitv://open", ["open"]),
            ("qisitv://skills/install?skillId=my-skill_1&releaseId=v1.2.3", ["open", "--skill-id", "my-skill_1", "--release-id", "v1.2.3"]),
            ("qisitv://skills/install?releaseId=abc&skillId=def", ["open", "--skill-id", "def", "--release-id", "abc"])
        ]
        for (url, expected) in good { precondition(engineLaunchArguments(URL(string: url)!) == expected, url) }
        for url in ["https://cheeser.link", "qisitv://open?url=https://evil.invalid", "qisitv://open/other", "qisitv://user@open", "qisitv://open:1234", "qisitv://open#x", "qisitv://skills/install?skillId=test", "qisitv://skills/install?skillId=a&skillId=b", "qisitv://skills/install?skillId=a&releaseId=b&extra=c", "qisitv://skills/install?skillId=..%2Fsecret&releaseId=v1", "qisitv://skills/install?skillId=a&releaseId=%24%28touch%20x%29", "qisitv://skills/install?skillId=a&releaseId=", "qisitv://skills/install?skillId=a&releaseId=v1%0A"] {
            precondition(engineLaunchArguments(URL(string: url)!) == nil, url)
        }
        print("PASS: restricted engine launch intents")
    }
}
