import AppKit
import UsefulBotCore

/// Runs first thing at launch. If this bundle's variant and its own id or
/// executable disagree (a dev plist under the daily id, say), it says so and
/// quits before any service starts or any state is read: such a build would
/// share Launch Services, Keychain and defaults with the wrong app.
enum LaunchCheck {
    @MainActor
    static func runOrQuit() {
        let bundle = Bundle.main
        let problem: String
        do {
            let variant = try AppVariant.resolve(infoDictionary: bundle.infoDictionary)
            try variant.validateIdentity(
                bundleIdentifier: bundle.bundleIdentifier,
                executableName: bundle.executableURL?.lastPathComponent,
                isAppBundle: bundle.bundleURL.pathExtension == "app"
            )
            return
        } catch {
            problem = String(describing: error)
        }
        NSLog("Useful Bot: refusing to start: %@", problem)
        let app = NSApplication.shared
        app.setActivationPolicy(.regular)
        app.activate()
        let alert = NSAlert()
        alert.alertStyle = .critical
        alert.messageText = "This build is set up wrong"
        alert.informativeText = "\(problem)\n\nIt won't run, so it can't touch another Useful Bot's data. Rebuild it with npm run build:app or npm run build:dev-app."
        alert.addButton(withTitle: "Quit")
        alert.runModal()
        exit(1)
    }
}
