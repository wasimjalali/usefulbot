import SwiftUI
import UsefulBotCore

/// `chat-search-dialog.tsx`: the ⌘K palette with tabs and keyboard navigation.
struct SearchPaletteView: View {
    @EnvironmentObject private var model: AppModel

    let onClose: () -> Void
    let onNewChat: () -> Void
    let onOpen: (ChatEntry) -> Void
    let onOpenMessage: (ChatSearchHit) -> Void
    let onOpenRoutine: (String) -> Void
    let onOpenLibrary: (String) -> Void
    let onOpenSettings: () -> Void
    let onOpenConnectors: () -> Void
    let onOpenUsage: () -> Void

    @State private var query = ""
    @State private var tab: SearchTab = .all
    @State private var active = 0
    @State private var media: [MediaItem] = []
    @State private var mediaFailed = false
    /// Message-text hits from the engine, for the current query.
    @State private var textHits: [ChatSearchHit] = []
    @State private var textSearch: Task<Void, Never>?
    @State private var escapeMonitor: Any?
    @FocusState private var focused: Bool

    enum SearchTab: String, CaseIterable {
        case all, chats, library, routines

        var label: String {
            switch self {
            case .all: return "All"
            case .chats: return "Chats"
            case .library: return "Library"
            case .routines: return "Routines"
            }
        }
    }

    enum Command: String, CaseIterable {
        case newChat, settings, connectors, usage

        var title: String {
            switch self {
            case .newChat: return "New chat"
            case .settings: return "Open settings"
            case .connectors: return "Connectors"
            case .usage: return "Token usage"
            }
        }

        var icon: String {
            switch self {
            case .newChat: return "square.and.pencil"
            case .settings: return "gearshape"
            case .connectors: return "powerplug"
            case .usage: return "gauge.with.dots.needle.33percent"
            }
        }

        var shortcut: String? { self == .newChat ? "⌘N" : nil }
    }

    enum Hit: Identifiable {
        case chat(ChatEntry)
        case message(ChatSearchHit)
        case media(MediaItem)
        case routine(Routine)
        case command(Command)

        var id: String {
            switch self {
            case .chat(let entry): return "chat-\(entry.id)"
            case .message(let hit): return "message-\(hit.id)"
            case .media(let item): return "media-\(item.id)"
            case .routine(let routine): return "routine-\(routine.id)"
            case .command(let command): return "command-\(command.rawValue)"
            }
        }

        var section: String {
            switch self {
            case .chat, .message: return "Chats"
            case .media: return "Library"
            case .routine: return "Routines"
            case .command: return "Commands"
            }
        }
    }

    private var hits: [Hit] {
        let needle = query.trimmingCharacters(in: .whitespaces).lowercased()
        var results: [Hit] = []

        if tab == .all || tab == .chats {
            let entries = model.chatEntries.filter { entry in
                needle.isEmpty || "\(entry.title) \(entry.preview)".lowercased().contains(needle)
            }
            let shown = tab == .all && needle.isEmpty ? Array(entries.prefix(8)) : entries
            results.append(contentsOf: shown.map(Hit.chat))
            // Words inside chats, found by the engine; a chat whose title
            // already matched is not listed twice for the same row.
            results.append(contentsOf: textHits.map(Hit.message))
        }

        if tab == .library || (tab == .all && !needle.isEmpty) {
            let items = media.filter { needle.isEmpty || $0.displayTitle.lowercased().contains(needle) }
            results.append(contentsOf: items.map(Hit.media))
        }

        if tab == .routines || (tab == .all && !needle.isEmpty) {
            let routines = model.routines.filter { needle.isEmpty || $0.name.lowercased().contains(needle) }
            results.append(contentsOf: routines.map(Hit.routine))
        }

        if tab == .all {
            let commands = Command.allCases.filter { needle.isEmpty || $0.title.lowercased().contains(needle) }
            results.append(contentsOf: commands.map(Hit.command))
        }
        return results
    }

    private func heading(for index: Int, in hits: [Hit]) -> String? {
        guard tab == .all else { return nil }
        let hit = hits[index]
        if index > 0, hits[index - 1].section == hit.section { return nil }
        return hit.section
    }

    var body: some View {
        let hits = hits
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
                results(hits)
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
        .task {
            // The Library has no copy in the model; read it when the palette opens.
            do {
                media = try await GeneratedImageCache.shared.mediaList().items
            } catch {
                mediaFailed = true
            }
        }
        // Esc closes the palette wherever the window's first responder is.
        // A key handler on the field or `onExitCommand` here only sees Esc
        // while the field holds focus, and the composer's text view can keep
        // it: Esc then went to the composer and the palette stayed open.
        .onAppear {
            guard escapeMonitor == nil else { return }
            escapeMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { event in
                guard event.keyCode == 53, NSApp.modalWindow == nil else { return event }
                // Esc during an input method's composition cancels that first.
                if let editor = event.window?.firstResponder as? NSTextView, editor.hasMarkedText() { return event }
                onClose()
                return nil
            }
        }
        .onDisappear {
            if let escapeMonitor { NSEvent.removeMonitor(escapeMonitor) }
            escapeMonitor = nil
        }
        .onChange(of: query) { _, next in
            active = 0
            searchText(next)
        }
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

    private func results(_ hits: [Hit]) -> some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(hits.enumerated()), id: \.element.id) { index, hit in
                        VStack(alignment: .leading, spacing: 0) {
                            if let heading = heading(for: index, in: hits) {
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
                    // Library hits are missing, not absent: say so quietly.
                    if mediaFailed, tab == .all || tab == .library {
                        Text("Couldn't load the library")
                            .font(.system(size: 13))
                            .foregroundStyle(Theme.C.inkFaint)
                            .padding(.horizontal, 12)
                            .padding(.vertical, 8)
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
        let searching = !query.trimmingCharacters(in: .whitespaces).isEmpty
        return searching || tab == .all ? "No matches." : "Nothing in \(tab.label) yet."
    }

    @ViewBuilder
    private func hitRow(_ hit: Hit) -> some View {
        HStack(spacing: 10) {
            switch hit {
            case .chat(let entry):
                icon("bubble.left")
                VStack(alignment: .leading, spacing: 0) {
                    Text(entry.title)
                        .font(.system(size: 13))
                        .foregroundStyle(Theme.C.ink)
                        .lineLimit(1)
                    // The title is the preview with its markdown marks gone, and
                    // may be clipped: a preview that starts with it adds nothing.
                    let previewLine = ChatEntry.plain(entry.preview)
                    let titleText = entry.title.trimmingCharacters(in: CharacterSet(charactersIn: "… "))
                    if !previewLine.isEmpty, !previewLine.hasPrefix(titleText) {
                        Text(previewLine)
                            .font(.system(size: 11))
                            .foregroundStyle(Theme.C.inkMuted)
                            .lineLimit(1)
                    }
                }
                Spacer(minLength: 0)
                if let updatedAt = entry.updatedAt {
                    Text(ChatEntry.timeLabel(updatedAt))
                        .font(.system(size: 11).monospacedDigit())
                        .foregroundStyle(Theme.C.inkFaint)
                }
            case .message(let hit):
                icon("text.bubble")
                VStack(alignment: .leading, spacing: 0) {
                    Text(ChatEntry.plain(hit.snippet))
                        .font(.system(size: 13))
                        .foregroundStyle(Theme.C.ink)
                        .lineLimit(1)
                    Text(ChatEntry.plain(hit.title))
                        .font(.system(size: 11))
                        .foregroundStyle(Theme.C.inkMuted)
                        .lineLimit(1)
                }
                Spacer(minLength: 0)
                if let at = hit.at {
                    Text(ChatEntry.timeLabel(at))
                        .font(.system(size: 11).monospacedDigit())
                        .foregroundStyle(Theme.C.inkFaint)
                }
            case .media(let item):
                icon(Self.mediaIcon(item.kind))
                VStack(alignment: .leading, spacing: 0) {
                    Text(item.displayTitle)
                        .font(.system(size: 13))
                        .foregroundStyle(Theme.C.ink)
                        .lineLimit(1)
                    Text(Self.mediaKind(item.kind))
                        .font(.system(size: 11))
                        .foregroundStyle(Theme.C.inkMuted)
                }
                Spacer(minLength: 0)
            case .routine(let routine):
                icon("clock")
                VStack(alignment: .leading, spacing: 0) {
                    Text(routine.name)
                        .font(.system(size: 13))
                        .foregroundStyle(Theme.C.ink)
                        .lineLimit(1)
                    Text(routine.active ? RoutineCopy.scheduleLine(routine.schedules) : "Paused")
                        .font(.system(size: 11))
                        .foregroundStyle(Theme.C.inkMuted)
                        .lineLimit(1)
                }
                Spacer(minLength: 0)
            case .command(let command):
                icon(command.icon)
                Text(command.title)
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.C.ink)
                Spacer(minLength: 0)
                if let shortcut = command.shortcut {
                    Text(shortcut)
                        .font(.system(size: 11))
                        .foregroundStyle(Theme.C.inkFaint)
                }
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .frame(minHeight: 40)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func icon(_ name: String) -> some View {
        Image(systemName: name)
            .font(.system(size: 14))
            .foregroundStyle(Theme.C.ink)
            .frame(width: 20)
    }

    private static func mediaIcon(_ kind: String) -> String {
        switch kind {
        case "drawing": return "scribble.variable"
        case "page": return "globe"
        default: return "photo"
        }
    }

    private static func mediaKind(_ kind: String) -> String {
        switch kind {
        case "drawing": return "Drawing"
        case "page": return "Page"
        default: return "Image"
        }
    }

    /// Looks inside the chats once the owner pauses typing.
    private func searchText(_ text: String) {
        textSearch?.cancel()
        let needle = text.trimmingCharacters(in: .whitespaces)
        guard needle.count >= 2 else {
            textHits = []
            return
        }
        textSearch = Task { @MainActor in
            try? await Task.sleep(nanoseconds: 250_000_000)
            guard !Task.isCancelled else { return }
            let found = await model.searchChatText(needle)
            guard !Task.isCancelled else { return }
            textHits = found
        }
    }

    private func run(_ hit: Hit?) {
        guard let hit else { return }
        switch hit {
        case .chat(let entry): onOpen(entry)
        case .message(let hit): onOpenMessage(hit)
        case .media(let item): onOpenLibrary(item.id)
        case .routine(let routine): onOpenRoutine(routine.id)
        case .command(let command):
            switch command {
            case .newChat: onNewChat()
            case .settings: onOpenSettings()
            case .connectors: onOpenConnectors()
            case .usage: onOpenUsage()
            }
        }
    }
}
