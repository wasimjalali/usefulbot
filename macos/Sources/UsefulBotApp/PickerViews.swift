import SwiftUI
import UsefulBotCore

/// `new-chat-picker.tsx`: the To: picker shown by the rail's New Bot button.
struct NewChatPickerView: View {
    @EnvironmentObject private var model: AppModel
    let store: ShellStore
    let onClose: () -> Void
    let onCreateBot: () -> Void
    let onCreateGroup: () -> Void
    let onSelectBot: (String) -> Void
    /// Window frame of the rail's New Bot plus button, tolerated as the
    /// picker's toggle trigger.
    var plusTrigger: (() -> CGRect)? = nil

    @State private var query = ""
    @State private var headerFrame = CGRect.zero
    @FocusState private var focused: Bool

    private var bots: [ShellBot] {
        let needle = query.trimmingCharacters(in: .whitespaces).lowercased()
        // Hidden bots and the frozen "Perf ..." fixtures only show when searched for.
        let visible = store.bots.filter { !$0.hidden && !$0.name.hasPrefix("Perf ") }
        guard !needle.isEmpty else { return visible }
        return store.bots.filter { bot in
            "\(bot.name) \(bot.label) \(bot.description) \(bot.lastPreview)"
                .lowercased()
                .contains(needle)
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                Text("To")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(Theme.C.inkMuted)
                ZStack(alignment: .leading) {
                    if query.isEmpty {
                        Text("Search or create bots")
                            .font(.system(size: 15))
                            .foregroundStyle(Theme.C.inkFaint)
                    }
                    TextField("", text: $query)
                        .textFieldStyle(.plain)
                        .font(.system(size: 15))
                        .foregroundStyle(Theme.C.ink)
                        .focused($focused)
                        .onKeyPress(.escape) {
                            onClose()
                            return .handled
                        }
                        .onKeyPress(phases: .down) { press in
                            if press.modifiers.contains(.command), press.key == "1" {
                                onCreateBot()
                                return .handled
                            }
                            if press.modifiers.contains(.command), press.key == "2" {
                                onCreateGroup()
                                return .handled
                            }
                            return .ignored
                        }
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 20)
            .frame(minHeight: DesignTokens.Space.chatHead)
            .overlay(alignment: .bottom) { Hairline() }
            .trackWindowFrame($headerFrame)

            VStack(spacing: 0) {
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        MenuRowButton(action: onCreateBot) {
                            hitRow {
                                Image(systemName: "plus")
                                    .font(.system(size: 14))
                                    .foregroundStyle(Theme.C.ink)
                                Text("New Bot")
                                    .font(.system(size: 13))
                                    .foregroundStyle(Theme.C.ink)
                                Spacer(minLength: 0)
                                kbd("⌘1")
                            }
                        }
                        .accessibilityIdentifier("picker-new-bot")
                        MenuRowButton(action: onCreateGroup) {
                            hitRow {
                                Image(systemName: "person.2")
                                    .font(.system(size: 14))
                                    .foregroundStyle(Theme.C.ink)
                                Text("Create group chat")
                                    .font(.system(size: 13))
                                    .foregroundStyle(Theme.C.ink)
                                Spacer(minLength: 0)
                                kbd("⌘2")
                            }
                        }
                        .accessibilityIdentifier("picker-new-group")
                        ForEach(bots) { bot in
                            MenuRowButton(action: { onSelectBot(bot.id) }) {
                                hitRow {
                                    BotAvatarView(bot: bot, size: 24)
                                    Text(bot.name)
                                        .font(.system(size: 13))
                                        .foregroundStyle(Theme.C.ink)
                                        .lineLimit(1)
                                    Spacer(minLength: 0)
                                    if !bot.label.isEmpty, !sameAsName(bot.label, bot.name) {
                                        BotLabelChip(text: bot.label, fitsFully: true)
                                    }
                                }
                            }
                            .accessibilityIdentifier("picker-bot-\(bot.id)")
                        }
                        if bots.isEmpty {
                            Text("No matching bots.")
                                .font(.system(size: 14))
                                .foregroundStyle(Theme.C.inkMuted)
                                .padding(.horizontal, 12)
                                .padding(.vertical, 12)
                        }
                    }
                    .padding(8)
                }
                .uvScroll()
            }
            .frame(width: 440, alignment: .leading)
            .frame(maxHeight: 420)
            .background(Theme.C.surface)
            .overlay(
                RoundedRectangle(cornerRadius: DesignTokens.Radius.lg, style: .continuous)
                    .strokeBorder(Theme.C.edge, lineWidth: 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: DesignTokens.Radius.lg, style: .continuous))
            .raiseShadow()
            .dismissOnOutsideClick(triggers: { [headerFrame] + (plusTrigger.map { [$0()] } ?? []) }) {
                onClose()
            }
            .padding(.horizontal, 20)
            .padding(.top, 16)
            .frame(maxWidth: .infinity, alignment: .leading)

            Spacer(minLength: 0)
        }
        .onAppear { focused = true }
        .onExitCommand(perform: onClose)
        // Picking a bot in the rail while the picker is open closes it.
        .onChange(of: model.selectTick) { _, _ in onClose() }
    }

    private func hitRow<Content: View>(@ViewBuilder content: () -> Content) -> some View {
        HStack(spacing: 10) {
            content()
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .frame(minHeight: 40)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func kbd(_ value: String) -> some View {
        Text(value)
            .font(.system(size: DesignTokens.FontSize.kbd, weight: .semibold))
            .tracking(0.02 * DesignTokens.FontSize.kbd)
            .foregroundStyle(Theme.C.inkFaint)
            .padding(.horizontal, 6)
            .padding(.vertical, 1)
            .background(Theme.C.sunken)
            .overlay(
                RoundedRectangle(cornerRadius: DesignTokens.Radius.xs, style: .continuous)
                    .strokeBorder(Theme.C.edge, lineWidth: 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: DesignTokens.Radius.xs, style: .continuous))
    }
}

/// `chat-search-dialog.tsx`: the ⌘K palette with tabs and keyboard navigation.
struct SearchPaletteView: View {
    @EnvironmentObject private var model: AppModel

    let onClose: () -> Void
    let onNewChat: () -> Void
    let onSelect: (String) -> Void
    let onOpenRecent: (_ recentId: String, _ sessionId: String?) -> Void

    @State private var query = ""
    @State private var tab: SearchTab = .all
    @State private var active = 0
    @FocusState private var focused: Bool

    // Only tabs `hits` can actually fill; a tab with no data source would
    // never return a row and would always read "Nothing in X yet."
    enum SearchTab: String, CaseIterable {
        case all, messages, bots, groups

        var label: String {
            switch self {
            case .all: return "All"
            case .messages: return "Messages"
            case .bots: return "Bots"
            case .groups: return "Groups"
            }
        }
    }

    enum Hit: Identifiable {
        case newChat
        case recent(ShellRecent, ShellBot?)
        case bot(ShellBot)

        var id: String {
            switch self {
            case .newChat: return "new-chat"
            case .recent(let recent, _): return "recent-\(recent.id)"
            case .bot(let bot): return "bot-\(bot.id)"
            }
        }
    }

    private var hits: [Hit] {
        guard let store = model.store else { return [] }
        let needle = query.trimmingCharacters(in: .whitespaces).lowercased()
        var results: [Hit] = []
        if tab == .all { results.append(.newChat) }

        if tab == .all || tab == .messages {
            let recents = store.recents.filter { recent in
                guard !needle.isEmpty else { return true }
                let bot = store.bots.first { $0.id == recent.botId }
                return "\(recent.title) \(recent.preview) \(bot?.name ?? "") \(bot?.label ?? "")"
                    .lowercased()
                    .contains(needle)
            }
            // The same message from the same bot shows once, newest first.
            var seen = Set<String>()
            let unique = recents.sorted { $0.updatedAt > $1.updatedAt }.filter { recent in
                seen.insert("\(recent.botId)|\(Self.recentText(recent))").inserted
            }
            for recent in (needle.isEmpty ? Array(unique.prefix(8)) : unique) {
                results.append(.recent(recent, store.bots.first { $0.id == recent.botId }))
            }
        }

        if tab == .all || tab == .bots || tab == .groups {
            let bots = store.bots.filter { bot in
                if tab == .bots && bot.kind != "bot" { return false }
                if tab == .groups && bot.kind != "group" { return false }
                guard !needle.isEmpty else { return !bot.hidden }
                return "\(bot.name) \(bot.label) \(bot.description) \(bot.lastPreview)"
                    .lowercased()
                    .contains(needle)
            }
            results.append(contentsOf: bots.map { .bot($0) })
        }
        return results
    }

    private func heading(for index: Int) -> String? {
        guard tab == .all else { return nil }
        let hit = hits[index]
        let previous = index > 0 ? hits[index - 1] : nil
        if case .recent = hit {
            if case .recent = previous { return nil }
            return "Recents"
        }
        if case .bot = hit {
            if case .bot = previous { return nil }
            return "Bots"
        }
        return nil
    }

    var body: some View {
        ZStack(alignment: .top) {
            Theme.C.overlay
                .ignoresSafeArea()
                .onTapGesture(perform: onClose)

            VStack(spacing: 0) {
                HStack(spacing: 10) {
                    Image(systemName: "magnifyingglass")
                        .font(.system(size: 15))
                        .foregroundStyle(Theme.C.inkFaint)
                    ZStack(alignment: .leading) {
                        if query.isEmpty {
                            Text("Search")
                                .font(.system(size: 15))
                                .foregroundStyle(Theme.C.inkFaint)
                        }
                        TextField("", text: $query)
                            .textFieldStyle(.plain)
                            .font(.system(size: 15))
                            .foregroundStyle(Theme.C.ink)
                            .focused($focused)
                        .onKeyPress(.escape) {
                            onClose()
                            return .handled
                        }
                        .onKeyPress(.downArrow) {
                                active = (active + 1) % max(hits.count, 1)
                                return .handled
                            }
                            .onKeyPress(.upArrow) {
                                active = (active - 1 + hits.count) % max(hits.count, 1)
                                return .handled
                            }
                            .onKeyPress(.return) {
                                run(hits.indices.contains(active) ? hits[active] : nil)
                                return .handled
                            }
                    }
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, 16)
                .frame(minHeight: 52)
                .overlay(alignment: .bottom) { Hairline() }

                tabs
                results
            }
            .frame(maxWidth: 560)
            .background(Theme.C.surface)
            .overlay(
                RoundedRectangle(cornerRadius: DesignTokens.Radius.lg, style: .continuous)
                    .strokeBorder(Theme.C.edge, lineWidth: 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: DesignTokens.Radius.lg, style: .continuous))
            .popShadow()
            .padding(.top, 140)
            .padding(.horizontal, 16)
        }
        .onAppear {
            focused = true
            active = 0
        }
        .onExitCommand {
            if query.isEmpty {
                onClose()
            } else {
                query = ""
            }
        }
        .onChange(of: query) { _, _ in active = 0 }
        .onChange(of: tab) { _, _ in active = 0 }
    }

    private var tabs: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 0) {
                ForEach(SearchTab.allCases, id: \.self) { item in
                    Button {
                        tab = item
                    } label: {
                        Text(item.label)
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundStyle(tab == item ? Theme.C.ink : Theme.C.inkMuted)
                            .padding(.horizontal, 10)
                            .padding(.top, 10)
                            .padding(.bottom, 8)
                            .overlay(alignment: .bottom) {
                                Rectangle()
                                    .fill(tab == item ? Theme.C.ink : .clear)
                                    .frame(height: 2)
                            }
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .pointerOnHover()
                }
            }
            .padding(.horizontal, 8)
        }
        .overlay(alignment: .bottom) { Hairline() }
    }

    private var results: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(hits.enumerated()), id: \.element.id) { index, hit in
                        VStack(alignment: .leading, spacing: 0) {
                            if let heading = heading(for: index) {
                                Text(heading)
                                    .font(.system(size: 12, weight: .semibold))
                                    .foregroundStyle(Theme.C.inkFaint)
                                    .padding(.horizontal, 10)
                                    .padding(.top, 8)
                                    .padding(.bottom, 4)
                            }
                            MenuRowButton(action: { run(hit) }) {
                                hitRow(hit)
                                    .background(active == index ? Theme.C.sunken : .clear)
                            }
                            .accessibilityIdentifier("palette-\(hit.id)")
                            .id(index)
                            .onHover { inside in
                                if inside { active = index }
                            }
                        }
                    }
                    if hits.isEmpty {
                        Text(emptyCopy)
                            .font(.system(size: 14))
                            .foregroundStyle(Theme.C.inkMuted)
                            .padding(.horizontal, 12)
                            .padding(.vertical, 12)
                    }
                }
                .padding(8)
            }
            .uvScroll()
            .frame(maxHeight: 420)
            .onChange(of: active) {
                withAnimation(.easeOut(duration: 0.12)) { proxy.scrollTo(active, anchor: .center) }
            }
        }
    }

    private var emptyCopy: String {
        tab == .all
            ? "No matching chats or bots."
            : "Nothing in \(tab.label) yet."
    }

    @ViewBuilder
    private func hitRow(_ hit: Hit) -> some View {
        HStack(spacing: 10) {
            switch hit {
            case .newChat:
                Image(systemName: "plus.bubble")
                    .font(.system(size: 14))
                    .foregroundStyle(Theme.C.ink)
                Text("New Bot")
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.C.ink)
            case .recent(let recent, let bot):
                if let bot {
                    BotAvatarView(bot: model.liveBot(bot), size: 24)
                } else {
                    Image(systemName: "bubble.left")
                        .font(.system(size: 14))
                        .foregroundStyle(Theme.C.ink)
                }
                VStack(alignment: .leading, spacing: 0) {
                    Text(Self.recentText(recent))
                        .font(.system(size: 13))
                        .foregroundStyle(Theme.C.ink)
                        .lineLimit(1)
                    Text([bot?.name, Self.relativeTime(recent.updatedAt)].compactMap { $0 }.joined(separator: " · "))
                        .font(.system(size: 11))
                        .foregroundStyle(Theme.C.inkMuted)
                        .lineLimit(1)
                }
            case .bot(let bot):
                BotAvatarView(bot: bot, size: 24)
                Text(bot.name)
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.C.ink)
                    .lineLimit(1)
                Spacer(minLength: 0)
                if !bot.label.isEmpty, !sameAsName(bot.label, bot.name) {
                    BotLabelChip(text: bot.label, fitsFully: true)
                }
                if bot.hidden {
                    Text("HIDDEN")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(Theme.C.inkMuted)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 1)
                        .background(Theme.C.sunken)
                        .clipShape(RoundedRectangle(cornerRadius: DesignTokens.Radius.xs, style: .continuous))
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .frame(minHeight: 40)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// The message as plain text: markdown marks stripped, whitespace folded.
    /// A recent as one plain line. Only markdown's own marks go: links keep
    /// their text, code ticks and paired emphasis drop their marks, and a
    /// heading or quote marker goes at the start of a line. "C#", "issue #42"
    /// and "clear_history" stay as written.
    private static func recentText(_ recent: ShellRecent) -> String {
        let raw = AppModel.previewText(recent.title.isEmpty || recent.title == "Chat" ? recent.preview : recent.title)
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

    private static let plainISO = ISO8601DateFormatter()
    private static let fractionalISO: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
    private static let relative: RelativeDateTimeFormatter = {
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .abbreviated
        return formatter
    }()

    private static func relativeTime(_ iso: String) -> String? {
        guard let date = fractionalISO.date(from: iso) ?? plainISO.date(from: iso) else { return nil }
        return relative.localizedString(for: date, relativeTo: Date())
    }

    private func run(_ hit: Hit?) {
        guard let hit else { return }
        switch hit {
        case .newChat:
            onNewChat()
        case .recent(let recent, _):
            onOpenRecent(recent.id, recent.sessionId)
        case .bot(let bot):
            onSelect(bot.id)
        }
    }
}

/// True when a role label only repeats the bot's name ("Generalist" under
/// "Generalist"), ignoring case, spaces and punctuation.
func sameAsName(_ label: String, _ name: String) -> Bool {
    func fold(_ value: String) -> String {
        value.lowercased().filter { $0.isLetter || $0.isNumber }
    }
    return fold(label) == fold(name)
}
