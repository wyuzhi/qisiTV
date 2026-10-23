import AppKit

final class EngineLauncher: NSObject, NSApplicationDelegate {
    private var started = false
    private var defaultLaunch: DispatchWorkItem?
    func applicationDidFinishLaunching(_ notification: Notification) {
        // LaunchServices can deliver the opening URL after didFinishLaunching.
        // Give that event priority over the normal Dock/Finder launch intent.
        let fallback = DispatchWorkItem { [weak self] in self?.launch(["open"]) }
        defaultLaunch = fallback
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3, execute: fallback)
    }
    func application(_ application: NSApplication, open urls: [URL]) {
        defaultLaunch?.cancel()
        guard urls.count == 1, let arguments = engineLaunchArguments(urls[0]) else {
            if !started { NSApplication.shared.terminate(nil) }
            return
        }
        launch(arguments)
    }
    func launch(_ arguments: [String]) {
        guard !started else { return }
        started = true
        let task = Process()
        task.executableURL = Bundle.main.executableURL?.deletingLastPathComponent().appendingPathComponent("qisitv-connect")
        task.arguments = arguments
        let errors = Pipe()
        task.standardError = errors
        task.standardOutput = FileHandle.nullDevice
        task.terminationHandler = { process in
            let message = String(data: errors.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
            DispatchQueue.main.async {
                if process.terminationStatus != 0 {
                    let alert = NSAlert()
                    alert.messageText = "qisiTV 本机引擎未能启动"
                    alert.informativeText = message.isEmpty ? "请重新安装完整引擎，或查看本机引擎日志。" : message
                    alert.runModal()
                }
                NSApplication.shared.terminate(nil)
            }
        }
        do { try task.run() }
        catch {
            let alert = NSAlert(); alert.messageText = "安装文件不完整"; alert.informativeText = error.localizedDescription
            alert.runModal(); NSApplication.shared.terminate(nil)
        }
    }
}
@main
struct EngineLauncherMain {
    static func main() {
        let app = NSApplication.shared
        let delegate = EngineLauncher()
        app.delegate = delegate
        app.setActivationPolicy(.accessory)
        app.run()
        withExtendedLifetime(delegate) {}
    }
}
