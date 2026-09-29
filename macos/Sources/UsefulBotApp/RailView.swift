import AppKit
import SwiftUI
import UsefulBotCore

/// The 248pt rail: logo, search pill,
/// New Bot, pinned cards, sections, unassigned/hidden, account row.
struct RailView: View {
    @EnvironmentObject private var model: AppModel

    var onSearch: () -> Void
    var onNewChat: () -> Void
    var onOpenSettings: (String) -> Void
    var onRenameRequest: (ShellBot) -> Void
    var onDeleteRequest: (ShellBot) -> Void
    var onCreateSection: () -> Void
    var onConnectors: () -> Void
    var onLibrary: () -> Void
    var onOpenAppSettings: (AppSettingsTab) -> Void
    /// Window frame of the New Bot plus button, so overlays outside the rail
    /// can treat clicks on it as the toggle rather than "outside".
    @Binding var newChatTriggerFrame: CGRect
    /// This window is in full screen, where the traffic lights are hidden.
    var fullScreen = false

    @State private var accountOpen = false
    @AppStorage(AppAppearance.storageKey) private var appearance: AppAppearance = .light
    @ObservedObject private var updater = AppUpdater.shared
    /// The footer row (photo and Connectors pill), in rail space. The account
    /// menu opens just above it.
    @State private var accountDivider: CGRect = .zero
    @State private var accountMenuHeight: CGFloat = 0
    @State private var accountButtonFrame = CGRect.zero
    @State private var rowMenuBot: ShellBot?
    @State private var rowMenuAnchor: CGRect = .zero
    @State private var rowMenuTrigger: CGRect = .zero
    @State private var rowMenuPage: RowMenuPage = .root

    var body: some View {
        VStack(spacing: 12) {
            // Search and New Bot on the traffic lights' band, on its right,
            // sitting a little lower than the lights the way Grok sets them.
            HStack(spacing: 10) {
                Spacer(minLength: 0)
                RoundRailButton(systemImage: "magnifyingglass", label: "Search", help: "Search (⌘K)", action: onSearch)
                RoundRailButton(systemImage: "plus", label: "New Bot", help: "New Bot", action: onNewChat)
                    .trackWindowFrame($newChatTriggerFrame)
            }
            // Full screen hides the lights, so the band tightens.
            .padding(.top, fullScreen ? 4 : 10)

            HStack {
                UsefulBotLogoView()
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 4)

            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    if let store = model.store {
                        pinnedSection(store)
                        ForEach(store.sections) { section in
                            sectionBlock(store, section)
                        }
                        unassignedSection(store)
                        hiddenSection(store)
                    }
                }
                .padding(.trailing, 1)
            }
            .uvScroll()

            operatorRow
        }
        .padding(.horizontal, 12)
        .padding(.bottom, 16)
        .frame(width: DesignTokens.Space.railWidth)
        .frame(maxHeight: .infinity, alignment: .top)
        .background(Theme.C.rail)
        .coordinateSpace(name: "rail")
        .overlay(alignment: .topLeading) {
            if let bot = rowMenuBot {
                RowMenuPopover(
                    bot: bot,
                    page: $rowMenuPage,
                    canDelete: (model.store?.bots.count ?? 0) > 1,
                    onPin: {
                        model.perform(ShellActions.pin(botId: bot.id, pinned: !model.liveBot(bot).pinned))
                        closeRowMenu()
                    },
                    onMove: { sectionId in
                        model.perform(ShellActions.move(botId: bot.id, sectionId: sectionId))
                        closeRowMenu()
                    },
                    onSettings: {
                        closeRowMenu()
                        onOpenSettings(bot.id)
                    },
                    onRename: {
                        closeRowMenu()
                        onRenameRequest(bot)
                    },
                    onHide: {
                        model.perform(ShellActions.hide(botId: bot.id, hidden: !model.liveBot(bot).hidden))
                        closeRowMenu()
                    },
                    onNewSection: {
                        closeRowMenu()
                        onCreateSection()
                    },
                    onDelete: {
                        closeRowMenu()
                        onDeleteRequest(bot)
                    }
                )
                .frame(width: 200)
                .offset(x: max(8, rowMenuAnchor.maxX - 200), y: rowMenuAnchor.maxY + 4)
                .dismissOnOutsideClick(triggers: { [rowMenuTrigger] }) { closeRowMenu() }
            }
        }
        .overlay(alignment: .topLeading) {
            if accountOpen {
                // As wide as the rail less its 12 pt margin on each side, so the
                // menu keeps the same gap from the chat pane as from the window.
                accountPopover
                    .frame(width: DesignTokens.Space.railWidth - 24)
                    .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { accountMenuHeight = $0 }
                    .offset(x: 12, y: accountDivider.minY - accountMenuHeight - 8)
                    // Hidden for the one frame before its height is known.
                    .opacity(accountMenuHeight == 0 ? 0 : 1)
                    .dismissOnOutsideClick(triggers: { [accountButtonFrame] }) { accountOpen = false }
            }
        }
        .onExitCommand {
            accountOpen = false
            closeRowMenu()
        }
    }

    private func closeRowMenu() {
        rowMenuBot = nil
        rowMenuPage = .root
    }

    /// The ellipsis is a toggle: a second click on the same row's trigger
    /// closes the menu rather than re-opening it.
    private func toggleRowMenu(_ bot: ShellBot, frame: CGRect, trigger: CGRect) {
        if rowMenuBot?.id == bot.id {
            closeRowMenu()
            return
        }
        rowMenuAnchor = frame
        rowMenuTrigger = trigger
        rowMenuBot = bot
        rowMenuPage = .root
    }

    // MARK: - Groups

    @ViewBuilder
    private func pinnedSection(_ store: ShellStore) -> some View {
        let pinned = store.pinnedBots
        if !pinned.isEmpty {
            let columns = [GridItem(.flexible(), spacing: 8), GridItem(.flexible(), spacing: 8)]
            LazyVGrid(columns: pinned.count == 1 ? [GridItem(.flexible())] : columns, spacing: 8) {
                ForEach(pinned) { bot in
                    PinnedCardView(
                        bot: bot,
                        tile: pinned.count > 1,
                        selected: bot.id == model.selectedBotId,
                        sectionName: store.sections.first { $0.id == bot.sectionId }?.name,
                        sections: store.sections,
                        canDelete: (model.store?.bots.count ?? 0) > 1,
                        menuOpen: rowMenuBot?.id == bot.id,
                        onSelect: { model.select(bot.id) },
                        onOpenSettings: { onOpenSettings(bot.id) },
                        onRenameRequest: { onRenameRequest(bot) },
                        onDeleteRequest: { onDeleteRequest(bot) },
                        onCreateSection: onCreateSection,
                        onMenu: { frame, trigger in
                            toggleRowMenu(bot, frame: frame, trigger: trigger)
                        }
                    )
                }
            }
        }
    }

    @ViewBuilder
    private func sectionBlock(_ store: ShellStore, _ section: ShellSection) -> some View {
        let bots = store.sectionBots(section.id)
        VStack(alignment: .leading, spacing: 2) {
            SectionHeader(title: section.name, collapsed: section.collapsed) {
                model.toggleSection(section.id)
            }
            if !section.collapsed {
                VStack(spacing: 2) {
                    ForEach(bots) { bot in
                        BotRowView(
                            bot: bot,
                            selected: bot.id == model.selectedBotId,
                            menuOpen: rowMenuBot?.id == bot.id,
                            onSelect: { model.select(bot.id) },
                            onOpenSettings: { onOpenSettings(bot.id) },
                            onRenameRequest: { onRenameRequest(bot) },
                            onDeleteRequest: { onDeleteRequest(bot) },
                            sections: store.sections,
                            canDelete: store.bots.count > 1,
                            onCreateSection: onCreateSection,
                            onMenu: { frame, trigger in
                                    toggleRowMenu(bot, frame: frame, trigger: trigger)
                            }
                        )
                    }
                }
                .padding(.top, 2)
                if bots.isEmpty {
                    Text(emptySectionHint(store, section.id))
                        .font(.system(size: 12))
                        .foregroundStyle(Theme.C.inkFaint)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 4)
                }
            }
        }
    }

    private func emptySectionHint(_ store: ShellStore, _ sectionId: String?) -> String {
        RailCopy.emptySectionHint(
            pinned: store.pinnedBots.filter { $0.sectionId == sectionId }.count,
            hidden: store.hiddenBots.filter { $0.sectionId == sectionId }.count
        )
    }

    @ViewBuilder
    private func unassignedSection(_ store: ShellStore) -> some View {
        let bots = store.sectionBots(nil)
        if !bots.isEmpty {
            // With no sections of the owner's own there is nothing to be
            // unassigned from: a new install showed "Unassigned" over its one
            // bot. The header comes in with the first section.
            let headed = !store.sections.isEmpty
            VStack(alignment: .leading, spacing: 2) {
                if headed {
                    SectionHeader(title: "Unassigned", collapsed: store.collapsedUnassigned) {
                        model.toggleSection("unassigned")
                    }
                }
                if !headed || !store.collapsedUnassigned {
                    VStack(alignment: .leading, spacing: 2) {
                        ForEach(bots) { bot in
                            BotRowView(
                                bot: bot,
                                selected: bot.id == model.selectedBotId,
                                menuOpen: rowMenuBot?.id == bot.id,
                                onSelect: { model.select(bot.id) },
                                onOpenSettings: { onOpenSettings(bot.id) },
                                onRenameRequest: { onRenameRequest(bot) },
                                onDeleteRequest: { onDeleteRequest(bot) },
                                sections: store.sections,
                                canDelete: store.bots.count > 1,
                                onCreateSection: onCreateSection,
                                onMenu: { frame, trigger in
                                    toggleRowMenu(bot, frame: frame, trigger: trigger)
                                }
                            )
                        }
                    }
                    .padding(.top, 2)
                }
            }
        }
    }

    @ViewBuilder
    private func hiddenSection(_ store: ShellStore) -> some View {
        let bots = store.hiddenBots
        if !bots.isEmpty {
            VStack(alignment: .leading, spacing: 2) {
                SectionHeader(title: "Hidden", collapsed: store.collapsedHidden) {
                    model.toggleSection("hidden")
                }
                if !store.collapsedHidden {
                    VStack(spacing: 2) {
                        ForEach(bots) { bot in
                            BotRowView(
                                bot: bot,
                                selected: bot.id == model.selectedBotId,
                                menuOpen: rowMenuBot?.id == bot.id,
                                onSelect: { model.select(bot.id) },
                                onOpenSettings: { onOpenSettings(bot.id) },
                                onRenameRequest: { onRenameRequest(bot) },
                                onDeleteRequest: { onDeleteRequest(bot) },
                                sections: store.sections,
                                canDelete: store.bots.count > 1,
                                onCreateSection: onCreateSection,
                                onMenu: { frame, trigger in
                                    toggleRowMenu(bot, frame: frame, trigger: trigger)
                            }
                            )
                        }
                    }
                    .padding(.top, 2)
                }
            }
        }
    }

    // MARK: - Account

    /// The owner's face, which opens the account menu, beside one wide pill
    /// for Connectors.
    private var operatorRow: some View {
        HStack(spacing: 10) {
            Button {
                accountOpen.toggle()
                if accountOpen { Task { await model.loadUsage() } }
            } label: {
                OperatorAvatarView(initials: model.operatorInitials, size: 36)
                    .contentShape(Circle())
            }
            .buttonStyle(.plain)
            .pointerOnHover()
            .trackWindowFrame($accountButtonFrame)
            .help(model.operatorName)
            .accessibilityLabel("Account")
            .accessibilityIdentifier("account-row")
            FooterPillButton(title: "Connectors", action: onConnectors)
                .accessibilityIdentifier("rail-connectors")
        }
        .background(
            GeometryReader { proxy in
                Color.clear
                    .onAppear { accountDivider = proxy.frame(in: .named("rail")) }
                    .onChange(of: proxy.frame(in: .named("rail"))) { _, next in
                        accountDivider = next
                    }
            }
        )
    }

    private var accountPopover: some View {
        VStack(alignment: .leading, spacing: 2) {
            popItem(icon: "gauge.with.dots.needle.33percent", title: "Token usage", value: usagePercent, chevron: true) {
                accountOpen = false
                onOpenAppSettings(.usage)
            }
            .accessibilityIdentifier("account-usage")
            popItem(icon: "photo.on.rectangle", title: "Library") {
                accountOpen = false
                onLibrary()
            }
            .accessibilityIdentifier("account-library")
            popItem(icon: "server.rack", title: "Providers") {
                accountOpen = false
                onOpenAppSettings(.providers)
            }
            .accessibilityIdentifier("account-providers")
            popItem(icon: "gearshape", title: "Settings") {
                accountOpen = false
                onOpenAppSettings(.general)
            }
            .accessibilityIdentifier("account-settings")
            appearanceRow
            popDivider
            popItem(icon: "bubble.left", title: "Send feedback") {
                accountOpen = false
                onOpenAppSettings(.feedback)
            }
            .accessibilityIdentifier("account-feedback")
            popItem(icon: "envelope", title: "Contact us") {
                accountOpen = false
                NSWorkspace.shared.open(ReleaseLinks.contactMail)
            }
            .accessibilityIdentifier("account-contact")
            popDivider
            HStack(spacing: 8) {
                // Short, so it fits beside "Check for updates" in the menu's
                // width; neither side may wrap.
                Text("v\(AppUpdater.version)")
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.C.inkMuted)
                    .lineLimit(1)
                    .fixedSize()
                    .accessibilityLabel("Useful Bot \(AppUpdater.version)")
                    .accessibilityIdentifier("account-version")
                Spacer(minLength: 0)
                // A dev build has no feed to check.
                if let version = updater.pendingVersion {
                    Button {
                        accountOpen = false
                        updater.updateNow()
                    } label: {
                        Text("Update now")
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundStyle(Theme.C.link)
                            .padding(.horizontal, 10)
                            .padding(.vertical, 4)
                            .background(Theme.C.link.opacity(0.12), in: Capsule())
                    }
                    .buttonStyle(.plain)
                    .lineLimit(1)
                    .fixedSize()
                    .disabled(!updater.canCheckForUpdates)
                    // A plain button doesn't dim custom content on its own.
                    .opacity(updater.canCheckForUpdates ? 1 : 0.5)
                    .pointerOnHover()
                    .accessibilityLabel("Update to \(version)")
                    .accessibilityIdentifier("account-update-now")
                } else if updater.available {
                    Button("Check for updates") {
                        accountOpen = false
                        updater.checkForUpdates()
                    }
                    .buttonStyle(.plain)
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.C.ink)
                    .lineLimit(1)
                    .fixedSize()
                    .disabled(!updater.canCheckForUpdates)
                    .pointerOnHover()
                    .accessibilityIdentifier("account-check-updates")
                }
            }
            .padding(.horizontal, 10)
            .frame(minHeight: 30)
        }
        .padding(6)
        .background(Theme.C.surface)
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .strokeBorder(Theme.C.edge, lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        .popShadow()
    }

    /// System, Light and Dark, switched in place.
    private var appearanceRow: some View {
        // The menu is the rail's width less its margins, so this row has to
        // fit it: one small gap before the switch, not the stack's spacing twice.
        HStack(spacing: 0) {
            HStack(spacing: 10) {
                Image(systemName: "circle.lefthalf.filled")
                    .font(.system(size: 14))
                    .foregroundStyle(Theme.C.ink)
                    .frame(width: 18)
                Text("Appearance")
                    .font(.system(size: 14))
                    .foregroundStyle(Theme.C.ink)
                    .lineLimit(1)
                    .fixedSize()
            }
            Spacer(minLength: 8)
            ToneSegmented(
                items: AppAppearance.allCases,
                selection: $appearance,
                height: 30,
                accessibilityLabel: "Appearance",
                label: { option in AnyView(Image(systemName: Self.appearanceIcon(option)).font(.system(size: 12))) },
                name: { $0.label }
            )
            .frame(width: 76)
            .accessibilityIdentifier("account-appearance")
        }
        .padding(.leading, 10)
        .padding(.trailing, 8)
        .frame(minHeight: 40)
    }

    private static func appearanceIcon(_ option: AppAppearance) -> String {
        switch option {
        case .system: return "desktopcomputer"
        case .light: return "sun.max"
        case .dark: return "moon"
        }
    }

    private var popDivider: some View {
        Hairline()
            .padding(.horizontal, 10)
            .padding(.vertical, 4)
    }

    /// How close today is to a stop: the router caps input, output and
    /// requests separately, so this is the fullest of the three.
    private var usagePercent: String? {
        guard let usage = model.usage else { return nil }
        let shares = [
            (usage.chargedInputTokens, usage.caps.input24h),
            (usage.chargedOutputTokens, usage.caps.output24h),
            (usage.requests, usage.caps.requests24h),
        ].compactMap { used, cap in cap > 0 ? Double(used) / Double(cap) : nil }
        guard let fullest = shares.max() else { return nil }
        return "\(min(100, Int((fullest * 100).rounded())))%"
    }

    private func popItem(
        icon: String,
        title: String,
        value: String? = nil,
        chevron: Bool = false,
        action: @escaping () -> Void
    ) -> some View {
        MenuRowButton(action: action) {
            HStack(spacing: 10) {
                Image(systemName: icon)
                    .font(.system(size: 14))
                    .foregroundStyle(Theme.C.ink)
                    .frame(width: 18)
                Text(title)
                    .font(.system(size: 14))
                    .foregroundStyle(Theme.C.ink)
                Spacer(minLength: 0)
                if let value {
                    Text(value)
                        .font(.system(size: 13).monospacedDigit())
                        .foregroundStyle(Theme.C.inkMuted)
                }
                if chevron {
                    Image(systemName: "chevron.right")
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(Theme.C.inkMuted)
                }
            }
            .padding(.horizontal, 10)
            .frame(minHeight: 34)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

/// The rail footer's wide pill.
private struct FooterPillButton: View {
    let title: String
    let action: () -> Void

    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(.system(size: 14, weight: .medium))
                .foregroundStyle(Theme.C.ink)
                .frame(maxWidth: .infinity)
                .frame(height: 36)
                .background(hovering ? Theme.C.sunken : Theme.C.surface)
                .clipShape(Capsule())
                .overlay(Capsule().strokeBorder(Theme.C.edge, lineWidth: 1))
                .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .pointerOnHover()
        .onHover { hovering = $0 }
    }
}

private struct RoundRailButton: View {
    let systemImage: String
    let label: String
    let help: String
    let action: () -> Void

    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.system(size: 15, weight: .regular))
                .foregroundStyle(Theme.C.ink)
                .frame(width: 34, height: 34)
                .background(hovering ? Theme.C.sunken : Theme.C.surface)
                .clipShape(Circle())
                .overlay(Circle().strokeBorder(Theme.C.edge, lineWidth: 1))
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .pointerOnHover()
        .onHover { hovering = $0 }
        .help(help)
        .accessibilityLabel(label)
    }
}

private struct AccountAnchorKey: PreferenceKey {
    static var defaultValue: CGRect = .zero
    static func reduce(value: inout CGRect, nextValue: () -> CGRect) {
        value = nextValue()
    }
}

/// Which panel the row menu shows: the actions or the section picker.
enum RowMenuPage {
    case root
    case sections
}

/// The on-brand replacement for the system `Menu` on a bot row: the same
/// white card, hairline border and sunken hover as every other popover.
struct RowMenuPopover: View {
    let bot: ShellBot
    @Binding var page: RowMenuPage
    var canDelete = true
    let onPin: () -> Void
    let onMove: (String?) -> Void
    let onSettings: () -> Void
    let onRename: () -> Void
    let onHide: () -> Void
    let onNewSection: () -> Void
    let onDelete: () -> Void

    @EnvironmentObject private var model: AppModel

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            switch page {
            case .root:
                item(icon: bot.pinned ? "pin.slash" : "pin", title: bot.pinned ? "Unpin" : "Pin", action: onPin)
                item(icon: "folder", title: "Move to section", action: { page = .sections })
                item(icon: "gearshape", title: "Settings", action: onSettings)
                item(icon: "pencil", title: "Rename", action: onRename)
                item(icon: bot.hidden ? "eye" : "eye.slash", title: bot.hidden ? "Unhide" : "Hide", action: onHide)
                Divider()
                    .overlay(Theme.C.border)
                    .padding(.vertical, 2)
                item(icon: "trash", title: "Delete", danger: true, action: onDelete)
                    .disabled(!canDelete)
            case .sections:
                item(icon: "chevron.left", title: "Move to section", action: { page = .root })
                Divider()
                    .overlay(Theme.C.border)
                    .padding(.vertical, 2)
                item(icon: "tray", title: "Unassigned", action: { onMove(nil) })
                ForEach(model.store?.sections ?? []) { section in
                    item(icon: "folder", title: section.name, action: { onMove(section.id) })
                }
                Divider()
                    .overlay(Theme.C.border)
                    .padding(.vertical, 2)
                item(icon: "plus", title: "New section", action: onNewSection)
            }
        }
        .padding(6)
        .background(Theme.C.surface)
        .overlay(
            RoundedRectangle(cornerRadius: DesignTokens.Radius.settingsGroup, style: .continuous)
                .strokeBorder(Theme.C.edge, lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: DesignTokens.Radius.settingsGroup, style: .continuous))
        .popShadow()
    }

    private func item(
        icon: String,
        title: String,
        danger: Bool = false,
        action: @escaping () -> Void
    ) -> some View {
        MenuRowButton(action: action) {
            HStack(spacing: 8) {
                Image(systemName: icon)
                    .font(.system(size: 13))
                    .foregroundStyle(danger ? Theme.C.danger : Theme.C.ink)
                    .frame(width: 16)
                Text(title)
                    .font(.system(size: 13))
                    .foregroundStyle(danger ? Theme.C.danger : Theme.C.ink)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 10)
            .frame(minHeight: 32)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

// MARK: - Rows

/// The right-click menu behind both a rail row and a pinned card: one
/// definition, so the two can never drift apart. Flags come from the live
/// store rather than the rendered row, because a racing echo can leave that
/// snapshot a beat behind and an inverted stale value would undo the tap.
@MainActor
@ViewBuilder
private func rowContextMenu(
    bot: ShellBot,
    model: AppModel,
    sections: [ShellSection],
    canDelete: Bool,
    onOpenSettings: @escaping () -> Void,
    onRenameRequest: @escaping () -> Void,
    onDeleteRequest: @escaping () -> Void,
    onCreateSection: @escaping () -> Void
) -> some View {
    let live = model.liveBot(bot)
    Button(live.pinned ? "Unpin" : "Pin") {
        model.perform(ShellActions.pin(botId: bot.id, pinned: !model.liveBot(bot).pinned))
    }
    Menu("Move to section") {
        Button("Unassigned") {
            model.perform(ShellActions.move(botId: bot.id, sectionId: nil))
        }
        ForEach(sections) { section in
            Button(section.name) {
                model.perform(ShellActions.move(botId: bot.id, sectionId: section.id))
            }
        }
        Divider()
        Button("New section", action: onCreateSection)
    }
    Button("Settings", action: onOpenSettings)
    Button("Rename", action: onRenameRequest)
    Button(live.hidden ? "Unhide" : "Hide") {
        model.perform(ShellActions.hide(botId: bot.id, hidden: !model.liveBot(bot).hidden))
    }
    Divider()
    Button("Delete", role: .destructive, action: onDeleteRequest)
        .disabled(!canDelete)
}

extension AppModel {
    /// The uppercase line under a bot's name: what it is doing while it works,
    /// "REPLY READY" when an answer is waiting, else the given fallback.
    func railSubtitle(_ bot: ShellBot, fallback: String) -> String? {
        if isWorking(bot.id) {
            return (railActivity(bot.id) ?? .thinking).label.uppercased()
        }
        if replyReady.contains(bot.id) { return "REPLY READY" }
        if fallback.isEmpty || sameAsName(fallback, bot.name) { return nil }
        return fallback.uppercased()
    }
}

/// A bot's head in the rail: the animated face, posed for what the bot is
/// doing and hopping when a reply lands.
private struct RailFaceView: View {
    let bot: ShellBot
    let size: CGFloat
    @EnvironmentObject private var model: AppModel

    var body: some View {
        let working = model.isWorking(bot.id)
        // One view whether or not the bot works: swapping branches would
        // rebuild the face in the same update that bumps its hop, and the
        // hop would never play.
        BotFaceView(
            color: BrandAssets.colorID(for: bot),
            size: size,
            pose: working ? BotFacePose(activity: model.railActivity(bot.id) ?? .thinking) : .idle,
            hop: model.railHops[bot.id] ?? 0
        )
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(working ? "\(bot.name) is working" : "")
        .accessibilityHidden(!working)
    }
}

private struct BotRowView: View {
    let bot: ShellBot
    let selected: Bool
    var menuOpen = false
    let onSelect: () -> Void
    let onOpenSettings: () -> Void
    let onRenameRequest: () -> Void
    let onDeleteRequest: () -> Void
    let sections: [ShellSection]
    let canDelete: Bool
    let onCreateSection: () -> Void
    let onMenu: (CGRect, CGRect) -> Void

    @EnvironmentObject private var model: AppModel
    @State private var hovering = false

    private var members: [ShellBot] {
        groupMemberBots(bot, store: model.store)
    }

    var body: some View {
        Button(action: onSelect) {
            HStack(spacing: 8) {
                if bot.isGroup, !members.isEmpty {
                    AvatarStackView(bots: members, size: 26, maxVisible: 3)
                } else {
                    RailFaceView(bot: bot, size: 36)
                }
                VStack(alignment: .leading, spacing: 1) {
                    HStack(spacing: 6) {
                        Text(bot.name)
                            .font(.system(size: DesignTokens.FontSize.railName, weight: .semibold))
                            .foregroundStyle(Theme.C.ink)
                            .lineLimit(1)
                            .truncationMode(.tail)
                        // The stacked faces already say "group"; the icon only
                        // returns when the roster cannot be resolved.
                        if bot.isGroup, members.isEmpty {
                            Image(systemName: "person.2")
                                .font(.system(size: 11))
                                .foregroundStyle(Theme.C.inkFaint)
                                .fixedSize()
                        }
                    }
                    // The label lives under the name; the row stays clean, so
                    // no preview and no timestamp.
                    if let subtitle = model.railSubtitle(bot, fallback: bot.label) {
                        Text(subtitle)
                            .font(.system(size: DesignTokens.FontSize.railLabel, weight: .regular))
                            .tracking(DesignTokens.Tracking.label * DesignTokens.FontSize.railLabel)
                            .foregroundStyle(Theme.C.inkFaint)
                            .lineLimit(1)
                            .truncationMode(.tail)
                    }
                }
                Spacer(minLength: 0)
            }
            .padding(.leading, 8)
            .padding(.trailing, 28)
            .padding(.vertical, 6)
            // The web's 36pt row is a floor, not the height: the 36pt avatar
            // plus this padding lands at 48.
            .frame(minHeight: DesignTokens.Space.botRow)
            .frame(maxWidth: .infinity, alignment: .leading)
            // The open chat lifts off the rail as a small card; hover is a
            // tone shift only.
            .background(selected ? Theme.C.surface : (hovering ? Theme.C.sunken : .clear))
            .clipShape(RoundedRectangle(cornerRadius: DesignTokens.Radius.channel, style: .continuous))
            .shadow(color: Theme.C.shadow.opacity(selected ? 0.06 : 0), radius: 2, x: 0, y: 1)
            .contentShape(RoundedRectangle(cornerRadius: DesignTokens.Radius.channel, style: .continuous))
        }
        .buttonStyle(.plain)
        .pointerOnHover()
        .onHover { hovering = $0 }
        .overlay(alignment: .trailing) {
            // Hover-only like the web rail: the pointer is already over the row
            // when the control appears, and an open menu keeps it pinned.
            RowActionsOverlay(
                label: "Actions for \(bot.name)",
                rowHovering: hovering,
                menuOpen: menuOpen,
                onTap: onMenu
            )
            .padding(.trailing, 2)
        }
        .contextMenu {
            rowContextMenu(
                bot: bot,
                model: model,
                sections: sections,
                canDelete: canDelete,
                onOpenSettings: onOpenSettings,
                onRenameRequest: onRenameRequest,
                onDeleteRequest: onDeleteRequest,
                onCreateSection: onCreateSection
            )
        }
    }
}

/// Keeps the ellipsis on screen long enough to be clicked.
///
/// The row and the button have separate tracking areas, so the pointer leaves
/// one before it enters the other and the control used to vanish mid-travel.
/// Visibility is the union of both hovers plus the open menu, and a short grace
/// period covers the gap between them.
private struct RowActionsOverlay: View {
    let label: String
    let rowHovering: Bool
    let menuOpen: Bool
    let onTap: (CGRect, CGRect) -> Void

    @State private var state = RowActionsVisibility()
    @State private var visible = false
    @State private var hideTask: Task<Void, Never>?

    var body: some View {
        RowActionsButton(
            label: label,
            visible: visible,
            onHoverChange: { inside in
                state.controlHovering = inside
                refresh()
            },
            onTap: onTap
        )
        .onAppear {
            state.rowHovering = rowHovering
            state.menuOpen = menuOpen
            refresh()
        }
        .onChange(of: rowHovering) { _, next in
            state.rowHovering = next
            refresh()
        }
        .onChange(of: menuOpen) { _, next in
            state.menuOpen = next
            refresh()
        }
        .onDisappear { hideTask?.cancel() }
    }

    private func refresh() {
        hideTask?.cancel()
        hideTask = nil
        if state.isEngaged {
            visible = true
            return
        }
        guard visible else { return }
        hideTask = Task { @MainActor in
            try? await Task.sleep(nanoseconds: UInt64(RowActionsVisibility.hideGrace * 1_000_000_000))
            guard !Task.isCancelled else { return }
            visible = false
        }
    }
}

/// The rail's ellipsis affordance: invisible at rest, revealed on hover, and
/// kept on screen while its popover is open.
private struct RowActionsButton: View {
    let label: String
    let visible: Bool
    let onHoverChange: (Bool) -> Void
    let onTap: (CGRect, CGRect) -> Void

    @State private var hovering = false
    @State private var frame: CGRect = .zero
    @State private var windowFrame: CGRect = .zero

    var body: some View {
        Button {
            onTap(frame, windowFrame)
        } label: {
            Image(systemName: "ellipsis")
                .font(.system(size: 12, weight: .regular))
                .foregroundStyle(Theme.C.inkMuted)
                .frame(width: 24, height: 24)
                .background(hovering ? Theme.C.accentSoft : .clear)
                .clipShape(RoundedRectangle(cornerRadius: DesignTokens.Radius.sm, style: .continuous))
                // The pill stays 24pt, but the target around it is the full row
                // height, so an approach that is a few points off still lands.
                .frame(width: 30, height: DesignTokens.Space.botRow)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .pointerOnHover()
        .onHover { inside in
            hovering = inside
            onHoverChange(inside)
        }
        .opacity(visible ? 1 : 0)
        // Fade, but take the hidden control out of the click and VoiceOver
        // order too; the row's context menu stays as the keyboard path.
        .allowsHitTesting(visible)
        .accessibilityHidden(!visible)
        .accessibilityLabel(label)
        .background(
            GeometryReader { proxy in
                Color.clear
                    .onAppear { frame = proxy.frame(in: .named("rail")) }
                    .onChange(of: proxy.frame(in: .named("rail"))) { _, next in
                        frame = next
                    }
            }
        )
        .trackWindowFrame($windowFrame)
        .fixedSize()
    }
}

private struct PinnedCardView: View {
    let bot: ShellBot
    var tile = false
    let selected: Bool
    var sectionName: String?
    var sections: [ShellSection] = []
    var canDelete = true
    var menuOpen = false
    let onSelect: () -> Void
    let onOpenSettings: () -> Void
    let onRenameRequest: () -> Void
    let onDeleteRequest: () -> Void
    let onCreateSection: () -> Void
    let onMenu: (CGRect, CGRect) -> Void

    @EnvironmentObject private var model: AppModel
    @State private var hovering = false

    private var members: [ShellBot] {
        groupMemberBots(bot, store: model.store)
    }

    /// "Finance · Senior bookkeeper": the section a pinned bot came from stays
    /// visible on the card, so pinning never hides where it belongs.
    private var badge: String {
        [sectionName, bot.label.isEmpty || sameAsName(bot.label, bot.name) ? nil : bot.label]
            .compactMap { $0 }
            .joined(separator: " · ")
            .uppercased()
    }

    private var shape: RoundedRectangle {
        RoundedRectangle(cornerRadius: DesignTokens.Radius.md, style: .continuous)
    }

    private var nameText: some View {
        Text(bot.name)
            .font(.system(size: DesignTokens.FontSize.railName, weight: .semibold))
            .foregroundStyle(Theme.C.ink)
            .lineLimit(1)
            .truncationMode(.tail)
    }

    private var badgeText: some View {
        Text(model.railSubtitle(bot, fallback: badge) ?? "")
            .font(.system(size: DesignTokens.FontSize.railLabel, weight: .regular))
            .tracking(DesignTokens.Tracking.label * DesignTokens.FontSize.railLabel)
            .foregroundStyle(Theme.C.inkFaint)
            .lineLimit(1)
            .truncationMode(.tail)
    }

    @ViewBuilder
    private var head: some View {
        if bot.isGroup, !members.isEmpty {
            AvatarStackView(bots: members, size: 46, maxVisible: 2)
        } else {
            RailFaceView(bot: bot, size: 48)
        }
    }

    var body: some View {
        Button(action: onSelect) {
            Group {
                if tile {
                    VStack(spacing: 4) {
                        head
                        nameText
                        if model.railSubtitle(bot, fallback: badge) != nil {
                            badgeText
                        }
                    }
                    .multilineTextAlignment(.center)
                    .padding(.top, 14)
                    .padding(.horizontal, 8)
                    .padding(.bottom, 10)
                    .frame(maxWidth: .infinity)
                } else {
                    HStack(spacing: 10) {
                        head
                        VStack(alignment: .leading, spacing: 1) {
                            nameText
                            if model.railSubtitle(bot, fallback: badge) != nil {
                                badgeText
                            }
                        }
                        Spacer(minLength: 0)
                    }
                    .padding(DesignTokens.Space.pinnedCardPadding)
                    .padding(.trailing, 22)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            // The same states as a rail row: white only while its chat is open,
            // a light wash on hover, nothing otherwise.
            .background(selected ? Theme.C.surface : (hovering ? Theme.C.sunken : .clear))
            .clipShape(shape)
            .shadow(color: Theme.C.shadow.opacity(selected ? 0.06 : 0), radius: 2, x: 0, y: 1)
            .contentShape(shape)
        }
        .buttonStyle(.plain)
        .pointerOnHover()
        .onHover { hovering = $0 }
        .overlay(alignment: tile ? .topTrailing : .trailing) {
            RowActionsOverlay(
                label: "Actions for \(bot.name)",
                rowHovering: hovering,
                menuOpen: menuOpen,
                onTap: onMenu
            )
            .padding(.trailing, 6)
            .padding(.top, tile ? 6 : 0)
        }
        .contextMenu {
            rowContextMenu(
                bot: bot,
                model: model,
                sections: sections,
                canDelete: canDelete,
                onOpenSettings: onOpenSettings,
                onRenameRequest: onRenameRequest,
                onDeleteRequest: onDeleteRequest,
                onCreateSection: onCreateSection
            )
        }
    }
}

