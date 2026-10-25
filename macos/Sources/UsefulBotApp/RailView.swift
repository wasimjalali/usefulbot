import AppKit
import SwiftUI
import UsefulBotCore

/// The 248pt rail: search and New chat on the traffic lights' band, the logo,
/// three fixed rows (Routines, Library, Connectors), the chats by day and the
/// account row.
struct RailView: View {
    @EnvironmentObject private var model: AppModel

    var onSearch: () -> Void
    var onNewChat: () -> Void
    var onOpenAppSettings: (AppSettingsTab) -> Void
    /// This window is in full screen, where the traffic lights are hidden.
    var fullScreen = false

    @State private var accountOpen = false
    /// The chat whose title is being edited in its row.
    @State private var renamingChatId: String?
    @AppStorage(AppAppearance.storageKey) private var appearance: AppAppearance = .light
    @ObservedObject private var updater = AppUpdater.shared
    /// The footer row (photo and name), in rail space. The account menu opens
    /// just above it.
    @State private var accountDivider: CGRect = .zero
    @State private var accountMenuHeight: CGFloat = 0
    @State private var accountButtonFrame = CGRect.zero

    var body: some View {
        VStack(spacing: 12) {
            // Search and New chat on the traffic lights' band, on its right,
            // sitting a little lower than the lights the way Grok sets them.
            HStack(spacing: 10) {
                Spacer(minLength: 0)
                RoundRailButton(systemImage: "magnifyingglass", label: "Search", help: "Search (⌘K)", action: onSearch)
                    .accessibilityIdentifier("rail-search")
                RoundRailButton(systemImage: "square.and.pencil", label: "New chat", help: "New chat (⌘N)", action: onNewChat)
                    .accessibilityIdentifier("rail-new-chat")
            }
            // Full screen hides the lights, so the band tightens.
            .padding(.top, fullScreen ? 4 : 10)

            HStack {
                UsefulBotLogoView()
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 4)

            fixedRows

            ScrollView {
                chatList
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
        }
        .alert(
            "Delete this chat?",
            isPresented: Binding(
                get: { model.chatPendingDelete != nil },
                set: { if !$0 { model.chatPendingDelete = nil } }
            )
        ) {
            Button("Delete", role: .destructive) {
                if let id = model.chatPendingDelete { model.deleteChat(id) }
                model.chatPendingDelete = nil
            }
            Button("Cancel", role: .cancel) { model.chatPendingDelete = nil }
        } message: {
            Text("This can't be undone.")
        }
    }

    // MARK: - Fixed rows

    private var fixedRows: some View {
        VStack(spacing: 1) {
            RailNavRow(
                icon: "clock",
                title: "Routines",
                selected: model.stage == .routines,
                id: "rail-routines"
            ) {
                model.stage = .routines
            } trailing: {
                let failed = model.failedRoutineCount
                if failed > 0 {
                    Text("\(failed)")
                        .font(.system(size: 11, weight: .semibold).monospacedDigit())
                        .foregroundStyle(Theme.C.danger)
                        .accessibilityLabel("\(failed) failed")
                }
            }
            RailNavRow(
                icon: "photo.on.rectangle",
                title: "Library",
                selected: model.stage == .library,
                id: "rail-library"
            ) {
                model.stage = .library
            } trailing: {
                EmptyView()
            }
            RailNavRow(
                icon: "powerplug",
                title: "Connectors",
                selected: model.stage == .connectors,
                id: "rail-connectors"
            ) {
                model.stage = .connectors
            } trailing: {
                if model.connectorsNeedSignIn {
                    Circle()
                        .fill(Theme.C.warning)
                        .frame(width: 8, height: 8)
                        .accessibilityLabel("A connection needs sign-in")
                }
            }
        }
    }

    // MARK: - Chats

    @ViewBuilder
    private var chatList: some View {
        let groups = ChatEntry.groups(model.chatEntries)
        if groups.isEmpty {
            Text(model.chatsLoaded ? "No chats yet" : "")
                .font(.system(size: 13))
                .foregroundStyle(Theme.C.inkFaint)
                .padding(.horizontal, 10)
                .padding(.top, 8)
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityIdentifier("rail-no-chats")
        } else {
            LazyVStack(alignment: .leading, spacing: 1) {
                ForEach(groups) { group in
                    Text(group.label)
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(Theme.C.inkFaint)
                        .padding(.horizontal, 10)
                        .padding(.top, group.id == groups.first?.id ? 4 : 12)
                        .padding(.bottom, 4)
                    ForEach(group.entries) { entry in
                        ChatRowView(
                            entry: entry,
                            selected: model.stage == .chat && entry.id == model.currentChatId,
                            mark: model.mark(for: entry.id),
                            canDelete: model.canDeleteChat(entry.id),
                            renaming: renamingChatId == entry.id,
                            onSelect: { model.open(entry) },
                            onStartRename: { renamingChatId = entry.id },
                            onRename: { title in
                                renamingChatId = nil
                                if let title { model.renameChat(entry.id, to: title) }
                            },
                            onDelete: { model.chatPendingDelete = entry.id }
                        )
                        .onAppear {
                            // The list loads 60 at a time; the last rows ask for more.
                            if entry.id == model.chatEntries.last?.id { model.loadMoreChats() }
                        }
                    }
                }
            }
        }
    }

    // MARK: - Account

    /// The owner's photo and name, which open the account menu.
    private var operatorRow: some View {
        Button {
            accountOpen.toggle()
            if accountOpen { Task { await model.loadUsage() } }
        } label: {
            HStack(spacing: 10) {
                OperatorAvatarView(initials: model.operatorInitials, size: 30)
                Text(model.operatorName)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(Theme.C.ink)
                    .lineLimit(1)
                    .truncationMode(.tail)
                Spacer(minLength: 0)
                Image(systemName: "chevron.up.chevron.down")
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(Theme.C.inkFaint)
            }
            .padding(.horizontal, 4)
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .pointerOnHover()
        .trackWindowFrame($accountButtonFrame)
        .accessibilityLabel("Account")
        .accessibilityIdentifier("account-row")
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
                label: { option in AnyView(Image(systemName: option.systemImage).font(.system(size: 12))) },
                name: { $0.label }
            )
            .frame(width: 76)
            .accessibilityIdentifier("account-appearance")
        }
        .padding(.leading, 10)
        .padding(.trailing, 8)
        .frame(minHeight: 40)
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

/// One of the three fixed rows: icon, label, an optional mark on the right.
/// The open page lifts off the rail as a small card, like the open chat.
private struct RailNavRow<Trailing: View>: View {
    let icon: String
    let title: String
    let selected: Bool
    let id: String
    let action: () -> Void
    @ViewBuilder var trailing: Trailing

    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 10) {
                Image(systemName: icon)
                    .font(.system(size: 14))
                    .foregroundStyle(Theme.C.inkMuted)
                    .frame(width: 18)
                Text(title)
                    .font(.system(size: 13, weight: selected ? .semibold : .medium))
                    .foregroundStyle(Theme.C.ink)
                    .lineLimit(1)
                Spacer(minLength: 0)
                trailing
            }
            .padding(.horizontal, 10)
            .frame(height: 32)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(selected ? Theme.C.surface : (hovering ? Theme.C.sunken : .clear))
            .clipShape(RoundedRectangle(cornerRadius: DesignTokens.Radius.channel, style: .continuous))
            .shadow(color: Theme.C.shadow.opacity(selected ? 0.06 : 0), radius: 2, x: 0, y: 1)
            .contentShape(RoundedRectangle(cornerRadius: DesignTokens.Radius.channel, style: .continuous))
        }
        .buttonStyle(.plain)
        .pointerOnHover()
        .onHover { hovering = $0 }
        .accessibilityIdentifier(id)
    }
}

/// One chat: its title on a line, and on the right its state mark or the
/// time it last moved. Hovering shows the row menu (Rename, Delete); a click
/// elsewhere or Escape ends a rename.
private struct ChatRowView: View {
    let entry: ChatEntry
    let selected: Bool
    let mark: ChatMark?
    let canDelete: Bool
    let renaming: Bool
    let onSelect: () -> Void
    let onStartRename: () -> Void
    /// Called with the new title, or nil when the edit is cancelled.
    let onRename: (String?) -> Void
    let onDelete: () -> Void

    @State private var hovering = false
    @State private var draft = ""
    @FocusState private var focused: Bool

    var body: some View {
        Group {
            if renaming {
                renameField
            } else {
                Button(action: onSelect) { rowContent }
                    .buttonStyle(.plain)
                    .pointerOnHover()
                    .accessibilityLabel(entry.title)
                    .accessibilityAddTraits(selected ? .isSelected : [])
                    .accessibilityIdentifier("chat-row")
                    .contextMenu { menuItems }
            }
        }
        .padding(.leading, 10)
        .padding(.trailing, 8)
        .frame(height: DesignTokens.Space.botRow)
        .frame(maxWidth: .infinity, alignment: .leading)
        // The open chat lifts off the rail as a small card; hover is a
        // tone shift only.
        .background(selected ? Theme.C.surface : (hovering ? Theme.C.sunken : .clear))
        .clipShape(RoundedRectangle(cornerRadius: DesignTokens.Radius.channel, style: .continuous))
        .shadow(color: Theme.C.shadow.opacity(selected ? 0.06 : 0), radius: 2, x: 0, y: 1)
        .contentShape(RoundedRectangle(cornerRadius: DesignTokens.Radius.channel, style: .continuous))
        .onHover { hovering = $0 }
    }

    private var rowContent: some View {
        HStack(spacing: 8) {
            if entry.isRoutine {
                Image(systemName: "clock")
                    .font(.system(size: 11))
                    .foregroundStyle(Theme.C.inkMuted)
                    .accessibilityLabel("Routine")
            }
            Text(entry.title)
                .font(.system(size: DesignTokens.FontSize.railName, weight: selected ? .semibold : .regular))
                .foregroundStyle(Theme.C.ink)
                .lineLimit(1)
                .truncationMode(.tail)
                .frame(maxWidth: .infinity, alignment: .leading)
            trailing
        }
        .frame(maxHeight: .infinity)
        .contentShape(Rectangle())
    }

    @ViewBuilder
    private var trailing: some View {
        if hovering {
            Menu { menuItems } label: {
                Image(systemName: "ellipsis")
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(Theme.C.inkMuted)
                    .frame(width: 22, height: 22)
                    .contentShape(Rectangle())
            }
            .menuStyle(.borderlessButton)
            .menuIndicator(.hidden)
            .fixedSize()
            .accessibilityLabel("Chat options")
            .accessibilityIdentifier("chat-row-menu")
        } else {
            switch mark {
            case .working:
                // The three-dot loop at 60%, off the shared clock so every
                // working row moves together.
                AgentMark(phase: .thinking, scale: 0.6, arrives: false)
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel("Working")
            case .waiting:
                Circle().fill(Theme.C.warning).frame(width: 8, height: 8)
                    .accessibilityLabel("Waiting on you")
            case .replyReady:
                Circle().fill(Theme.C.ink).frame(width: 8, height: 8)
                    .accessibilityLabel("Reply ready")
            case .failed:
                Circle().fill(Theme.C.danger).frame(width: 8, height: 8)
                    .accessibilityLabel("Failed")
            case nil:
                if let updatedAt = entry.updatedAt {
                    Text(ChatEntry.timeLabel(updatedAt))
                        .font(.system(size: 12).monospacedDigit())
                        .foregroundStyle(Theme.C.inkFaint)
                        .lineLimit(1)
                        .fixedSize()
                }
            }
        }
    }

    @ViewBuilder
    private var menuItems: some View {
        Button("Rename", action: onStartRename)
        Button("Delete", role: .destructive, action: onDelete)
            .disabled(!canDelete)
            .help(canDelete ? "" : "Stop the chat first")
    }

    /// Enter saves, Escape cancels, 60 characters.
    private var renameField: some View {
        TextField("Chat name", text: $draft)
            .textFieldStyle(.plain)
            .font(.system(size: DesignTokens.FontSize.railName))
            .foregroundStyle(Theme.C.ink)
            .focused($focused)
            .onSubmit { onRename(draft) }
            .onExitCommand { onRename(nil) }
            .onChange(of: draft) { _, next in
                if next.count > 60 { draft = String(next.prefix(60)) }
            }
            .onChange(of: focused) { _, now in
                if !now { onRename(nil) }
            }
            .onAppear {
                draft = entry.title
                focused = true
            }
            .accessibilityIdentifier("chat-row-rename")
    }
}

/// Four dots chasing round a ring, one turn a second. Now only the loader
/// while a chat's first transcript loads: an agent working is `AgentMark`.
/// Held still when the owner asks for reduced motion.
struct DotsRing: View {
    var size: CGFloat = 14
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var turning = false

    var body: some View {
        let dot = size * 0.26
        let reach = (size - dot) / 2
        ZStack {
            Circle().fill(Theme.C.ink).frame(width: dot, height: dot).offset(y: -reach)
            Circle().fill(Theme.C.ink).frame(width: dot, height: dot).opacity(0.72).offset(x: reach)
            Circle().fill(Theme.C.ink).frame(width: dot, height: dot).opacity(0.45).offset(y: reach)
            Circle().fill(Theme.C.ink).frame(width: dot, height: dot).opacity(0.22).offset(x: -reach)
        }
        .frame(width: size, height: size)
        .rotationEffect(.degrees(turning ? 360 : 0))
        .animation(
            reduceMotion ? nil : .linear(duration: 1).repeatForever(autoreverses: false),
            value: turning
        )
        .onAppear { turning = true }
    }
}

// MARK: - Chat list

/// One row of the sidebar's chat list, from `GET /api/chats`.
struct ChatEntry: Identifiable, Equatable {
    /// The chat id.
    let id: String
    let title: String
    /// What the title was taken from, for search.
    let preview: String
    /// A routine's chat, marked with a clock before its title.
    let isRoutine: Bool
    let updatedAt: Date?

    struct Bucket: Identifiable {
        let id: String
        let label: String
        let entries: [ChatEntry]
    }

    static let newChatTitle = "New chat"

    /// The one-line title: the stored title, else the first message, else
    /// "New chat". Markdown marks go.
    static func title(stored: String, preview: String) -> String {
        let storedText = plain(stored)
        let text = storedText.isEmpty || storedText == "Chat" ? plain(preview) : storedText
        return text.isEmpty ? newChatTitle : text
    }

    /// A message as plain text: only markdown's own marks go. Links keep
    /// their text, code ticks and paired emphasis drop their marks, and a
    /// heading or quote marker goes at the start of a line. "C#", "issue #42"
    /// and "clear_history" stay as written.
    static func plain(_ raw: String) -> String {
        var text = raw.replacingOccurrences(of: "\\[([^\\]]*)\\]\\([^)]*\\)", with: "$1", options: .regularExpression)
        text = text.replacingOccurrences(of: "(?m)^\\s*(#{1,6}\\s+|>\\s)", with: "", options: .regularExpression)
        text = text.replacingOccurrences(of: "`+", with: "", options: .regularExpression)
        for mark in ["\\*\\*", "__", "\\*", "_", "~~"] {
            text = text.replacingOccurrences(
                of: "(?<![A-Za-z0-9])\(mark)(?=\\S)(.+?)(?<=\\S)\(mark)(?![A-Za-z0-9])",
                with: "$1",
                options: .regularExpression
            )
        }
        text = text.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
        return text.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Today, Yesterday, Previous 7 days, Previous 30 days, then a group per
    /// month ("September", "August 2025" when not this year), newest first.
    static func groups(_ entries: [ChatEntry], now: Date = Date(), calendar: Calendar = .current) -> [Bucket] {
        let today = calendar.startOfDay(for: now)
        func day(_ offset: Int) -> Date { calendar.date(byAdding: .day, value: offset, to: today) ?? today }
        let yesterday = day(-1)
        let week = day(-7)
        let month = day(-30)
        let monthFormat = DateFormatter()
        monthFormat.calendar = calendar
        monthFormat.timeZone = calendar.timeZone
        monthFormat.setLocalizedDateFormatFromTemplate("MMMM")
        let yearFormat = DateFormatter()
        yearFormat.calendar = calendar
        yearFormat.timeZone = calendar.timeZone
        yearFormat.setLocalizedDateFormatFromTemplate("MMMM yyyy")
        let thisYear = calendar.component(.year, from: now)

        var out: [Bucket] = []
        var currentKey = ""
        var currentLabel = ""
        var bucket: [ChatEntry] = []
        func flush() {
            if !bucket.isEmpty { out.append(Bucket(id: currentKey, label: currentLabel, entries: bucket)) }
            bucket = []
        }
        for entry in entries.sorted(by: { ($0.updatedAt ?? .distantPast) > ($1.updatedAt ?? .distantPast) }) {
            let key: String
            let label: String
            if let date = entry.updatedAt {
                if date >= today { (key, label) = ("today", "Today") }
                else if date >= yesterday { (key, label) = ("yesterday", "Yesterday") }
                else if date >= week { (key, label) = ("week", "Previous 7 days") }
                else if date >= month { (key, label) = ("month", "Previous 30 days") }
                else {
                    let year = calendar.component(.year, from: date)
                    (key, label) = (
                        "m-\(year)-\(calendar.component(.month, from: date))",
                        year == thisYear ? monthFormat.string(from: date) : yearFormat.string(from: date)
                    )
                }
            } else {
                (key, label) = ("earlier", "Earlier")
            }
            if key != currentKey {
                flush()
                currentKey = key
                currentLabel = label
            }
            bucket.append(entry)
        }
        flush()
        return out
    }

    /// "now", "2m", "3h", "Tue" within a week, else "Oct 3".
    static func timeLabel(_ date: Date, now: Date = Date(), calendar: Calendar = .current) -> String {
        let seconds = max(0, now.timeIntervalSince(date))
        if seconds < 60 { return "now" }
        if seconds < 3600 { return "\(Int(seconds / 60))m" }
        if seconds < 86_400 { return "\(Int(seconds / 3600))h" }
        let formatter = DateFormatter()
        formatter.calendar = calendar
        formatter.timeZone = calendar.timeZone
        if seconds < 7 * 86_400 {
            formatter.setLocalizedDateFormatFromTemplate("EEE")
        } else {
            formatter.setLocalizedDateFormatFromTemplate("MMM d")
        }
        return formatter.string(from: date)
    }
}

extension AppModel {
    /// The sidebar's rows, newest first.
    var chatEntries: [ChatEntry] {
        chats.map { chat in
            ChatEntry(
                id: chat.chatId,
                title: ChatEntry.title(stored: chat.title, preview: chat.preview),
                preview: ChatEntry.plain(chat.preview),
                isRoutine: chat.routineId != nil,
                updatedAt: chat.updatedAt
            )
        }
    }

    /// The chat an approval was raised in, when it is not the open one and
    /// the list holds it.
    func otherChat(for item: ApprovalItem) -> ChatEntry? {
        guard let chatId = item.chatId, !chatId.isEmpty, chatId != currentChatId else { return nil }
        return chatEntries.first { $0.id == chatId }
    }

    /// An approval raised in a chat that is not open and not in the list: the
    /// card says "From another chat" with no title and no Open chat link.
    func approvalFromUnlistedChat(_ item: ApprovalItem) -> Bool {
        guard let chatId = item.chatId, !chatId.isEmpty, chatId != currentChatId else { return false }
        return otherChat(for: item) == nil
    }

    /// Open a chat from the sidebar.
    func open(_ entry: ChatEntry) {
        openChat(entry.id)
    }
}
