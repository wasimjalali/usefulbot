import AppKit
import SwiftUI
import UsefulBotCore

@main
struct UsefulBotDesktopApp: App {
    @StateObject private var model = AppModel()
    @StateObject private var updater = AppUpdater.shared
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    init() {
        // Before anything reads state or starts a service.
        LaunchCheck.runOrQuit()
        // The Dock icon, set before the first window rather than when it
        // appears. Until then the Dock shows whatever Launch Services holds
        // for this bundle id, and a stale registration showed the old icon.
        NSApplication.shared.applicationIconImage = BrandAssets.image("app/macos/UsefulBot.icns")
    }

    var body: some Scene {
        WindowGroup(AppVariant.current.displayName) {
            RootView()
                .environmentObject(model)
                .task { await model.start() }
                .frame(minWidth: 900, minHeight: 600)
        }
        .windowStyle(.hiddenTitleBar)
        .defaultSize(width: 1180, height: 780)
        .commands {
            CommandGroup(after: .appInfo) {
                CheckForUpdatesButton(updater: updater)
            }
            // One window, so New Window gives way to New chat on ⌘N.
            CommandGroup(replacing: .newItem) {
                Button("New chat") {
                    model.newChatOrFocusComposer()
                }
                .keyboardShortcut("n", modifiers: .command)

                Button("Search") {
                    model.searchOpen.toggle()
                }
                .keyboardShortcut("k", modifiers: .command)

                Button("Reload chat") {
                    Task { await model.reloadThread() }
                }
                .keyboardShortcut("r", modifiers: .command)

                Button("Stop") {
                    model.cancel()
                }
                .keyboardShortcut(".", modifiers: .command)
                .disabled(!model.pending)

                Button("Previous chat") {
                    model.openAdjacentChat(-1)
                }
                .keyboardShortcut(.upArrow, modifiers: .command)
                .disabled(!model.chatSwitchKeysEnabled)

                Button("Next chat") {
                    model.openAdjacentChat(1)
                }
                .keyboardShortcut(.downArrow, modifiers: .command)
                .disabled(!model.chatSwitchKeysEnabled)

                Button("Delete chat") {
                    model.requestDeleteCurrentChat()
                }
                .keyboardShortcut(.delete, modifiers: .command)
                .disabled(!model.canDeleteCurrentChat)
            }
        }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    /// Before the first window, so the services never start from a copy that
    /// is about to move (MoveToApplications).
    @MainActor
    func applicationWillFinishLaunching(_ notification: Notification) {
        MoveToApplications.offerIfNeeded()
    }
}
