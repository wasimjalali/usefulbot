import AppKit
import UserNotifications
import UsefulBotCore

/// Posts "NAME finished" when a bot's turn ends out of sight. The rule for
/// when lives in `TurnNotifyPolicy`; this type only talks to the system.
/// A bare `swift run` has no bundle, and UNUserNotificationCenter traps
/// without one, so every call is a no-op there.
@MainActor
final class TurnNotifier: NSObject, UNUserNotificationCenterDelegate {
    static let shared = TurnNotifier()

    /// Set by the model: open this bot's chat after a notification click.
    var onOpenChat: ((String) -> Void)?

    private var center: UNUserNotificationCenter? {
        Bundle.main.bundleURL.pathExtension == "app" ? UNUserNotificationCenter.current() : nil
    }

    /// Becomes the delegate so a click is heard even on a cold launch.
    func start() {
        center?.delegate = self
    }

    /// Whether the app's window is on screen and the app frontmost.
    var appIsOnScreen: (active: Bool, windowVisible: Bool) {
        (
            NSApp.isActive,
            NSApp.windows.contains { $0.isVisible && !$0.isMiniaturized && $0.canBecomeMain }
        )
    }

    /// Asks the first time, then reports the standing answer.
    func requestAuthorization() async -> Bool {
        guard let center else { return true }
        let settings = await center.notificationSettings()
        switch settings.authorizationStatus {
        case .notDetermined:
            return (try? await center.requestAuthorization(options: [.alert, .sound])) ?? false
        case .denied:
            return false
        default:
            return true
        }
    }

    /// True when the owner has switched Useful Bot's notifications off.
    func isDenied() async -> Bool {
        guard let center else { return false }
        return await center.notificationSettings().authorizationStatus == .denied
    }

    func post(botId: String, botName: String) {
        guard let center else { return }
        let content = UNMutableNotificationContent()
        content.title = "\(botName) finished"
        content.sound = .default
        content.userInfo = ["botId": botId]
        center.add(UNNotificationRequest(identifier: "turn-\(botId)", content: content, trigger: nil))
    }

    func openSystemSettings() {
        let urls = [
            "x-apple.systempreferences:com.apple.Notifications-Settings.extension",
            "x-apple.systempreferences:com.apple.preference.notifications",
        ]
        for string in urls {
            if let url = URL(string: string), NSWorkspace.shared.open(url) { return }
        }
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse
    ) async {
        guard let botId = response.notification.request.content.userInfo["botId"] as? String else { return }
        await MainActor.run {
            NSApp.activate(ignoringOtherApps: true)
            for window in NSApp.windows where window.canBecomeMain {
                if window.isMiniaturized { window.deminiaturize(nil) }
                window.makeKeyAndOrderFront(nil)
            }
            onOpenChat?(botId)
        }
    }

    /// Only posted when the chat is out of sight, so show it even while the
    /// app is frontmost on another chat.
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        [.banner, .sound]
    }
}
