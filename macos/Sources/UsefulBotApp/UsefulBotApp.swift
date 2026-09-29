import AppKit
import SwiftUI
import UsefulBotCore

@main
struct UsefulBotDesktopApp: App {
    @StateObject private var model = AppModel()
    @StateObject private var updater = AppUpdater.shared

    init() {
        // The Dock icon, set before the first window rather than when it
        // appears. Until then the Dock shows whatever Launch Services holds
        // for this bundle id, and a stale registration showed the old icon.
        NSApplication.shared.applicationIconImage = BrandAssets.image("app/macos/UsefulBot.icns")
    }

    var body: some Scene {
        WindowGroup("Useful Bot") {
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
            CommandGroup(after: .newItem) {
                Button("Search") {
                    model.searchOpen.toggle()
                }
                .keyboardShortcut("k", modifiers: .command)

                Button("Reload Thread") {
                    Task { await model.reloadThread() }
                }
                .keyboardShortcut("r", modifiers: .command)
            }
        }
    }
}
