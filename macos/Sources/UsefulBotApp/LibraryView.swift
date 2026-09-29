import AppKit
import ImageIO
import SwiftUI
import UniformTypeIdentifiers
import UsefulBotCore

/// Everything the agents made, as files in the owner's media folder (and the
/// HTML pages they wrote, where they wrote them): a grid
/// newest first, filtered by kind, bot and prompt, and one item at a time
/// with what made it and what can be done with it.
struct LibraryView: View {
    @EnvironmentObject private var model: AppModel
    let onClose: () -> Void

    private enum Filter: String, CaseIterable {
        case all = "All"
        case images = "Images"
        case drawings = "Drawings"
        case pages = "HTML"
    }

    @State private var items: [MediaItem] = []
    @State private var root = ""
    @State private var held = 0
    @State private var loaded = false
    @State private var error: String?
    @State private var search = ""
    @State private var filter: Filter = .all
    @State private var botFilter: String?
    @State private var selected: MediaItem?
    @State private var regenerating: Set<String> = []
    @FocusState private var searchFocused: Bool

    private static let gridHeight: CGFloat = 560

    var body: some View {
        // The shared dialog, with the close button on the title's row rather
        // than a row of its own.
        NativeDialog(maxWidth: 1040, ariaLabel: "Library", closeRow: false, onClose: onClose) {
            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: 12) {
                    if selected != nil {
                        Button {
                            selected = nil
                        } label: {
                            Image(systemName: "chevron.left")
                                .font(.system(size: 13, weight: .medium))
                                .foregroundStyle(Theme.C.ink)
                                .frame(width: 28, height: 28)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .pointerOnHover()
                        .accessibilityLabel("Back to Library")
                    }
                    Text(selected?.displayTitle ?? "Library")
                        .font(.system(size: DesignTokens.FontSize.settingsTitle, weight: .semibold))
                        .foregroundStyle(Theme.C.ink)
                        .lineLimit(1)
                    Spacer(minLength: 0)
                    if selected == nil, !root.isEmpty {
                        NativeButton("Open folder", kind: .secondary, small: true) {
                            let url = URL(fileURLWithPath: root)
                            try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
                            NSWorkspace.shared.open(url)
                        }
                    }
                    NativeIconButton(systemImage: "xmark", size: 32, iconSize: 15, action: onClose)
                        .accessibilityLabel("Close Library")
                        .accessibilityIdentifier("dialog-close")
                }
                .padding(.horizontal, 20)
                .padding(.top, 14)

                if let selected {
                    LibraryDetail(
                        item: selected,
                        regenerating: regenerating.contains(selected.id),
                        onOpenChat: { openChat(selected) },
                        onLocate: { locate(selected) },
                        onRegenerate: { regenerate(selected) },
                        onTrash: { trash(selected) }
                    )
                    // A fresh detail per item: no picture or live page from
                    // the one before carries over.
                    .id(selected.id)
                        .padding(20)
                } else {
                    toolbar
                        .padding(.horizontal, 20)
                        .padding(.top, 16)
                    if let error {
                        Text(error)
                            .font(.system(size: 13))
                            .foregroundStyle(Theme.C.danger)
                            .padding(.horizontal, 20)
                            .padding(.top, 12)
                    }
                    if held > 0 {
                        Text(held == 1
                             ? "1 image could not move into the folder yet. It still shows in its chat."
                             : "\(held) images could not move into the folder yet. They still show in their chats.")
                            .font(.system(size: 13))
                            .foregroundStyle(Theme.C.inkMuted)
                            .padding(.horizontal, 20)
                            .padding(.top, 12)
                    }
                    grid
                        .frame(height: Self.gridHeight)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .task { await load() }
    }

    private var toolbar: some View {
        HStack(spacing: 12) {
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass")
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.C.inkFaint)
                TextField("Search", text: $search)
                    .textFieldStyle(.plain)
                    .font(.system(size: 14))
                    .foregroundStyle(Theme.C.ink)
                    .focused($searchFocused)
                    .accessibilityLabel("Search the Library")
            }
            .padding(.horizontal, 12)
            .frame(minHeight: 36)
            .background(Theme.C.surface)
            .overlay(
                Capsule(style: .continuous)
                    .strokeBorder(searchFocused ? Theme.C.ink : Theme.C.borderStrong, lineWidth: 1)
            )
            .clipShape(Capsule(style: .continuous))
            .frame(maxWidth: 320)

            HStack(spacing: 4) {
                ForEach(Filter.allCases, id: \.self) { option in
                    Button {
                        filter = option
                    } label: {
                        Text(option.rawValue)
                            .font(.system(size: 13, weight: filter == option ? .medium : .regular))
                            .foregroundStyle(filter == option ? Theme.C.ink : Theme.C.inkMuted)
                            .padding(.horizontal, 12)
                            .frame(height: 30)
                            .background(filter == option ? Theme.C.sunken : Color.clear)
                            .clipShape(Capsule(style: .continuous))
                            .contentShape(Capsule(style: .continuous))
                    }
                    .buttonStyle(.plain)
                    .pointerOnHover()
                }
            }

            Spacer(minLength: 0)

            Menu {
                Button("All bots") { botFilter = nil }
                ForEach(botNames, id: \.id) { bot in
                    Button(bot.name) { botFilter = bot.id }
                }
            } label: {
                Text(botNames.first { $0.id == botFilter }?.name ?? "All bots")
                    .font(.system(size: 13))
            }
            .menuStyle(.borderlessButton)
            .fixedSize()
            .accessibilityLabel("Filter by bot")
        }
    }

    @ViewBuilder private var grid: some View {
        if !loaded {
            Color.clear
        } else if visible.isEmpty {
            VStack {
                Spacer(minLength: 0)
                Text(items.isEmpty ? "Nothing saved yet" : "No matches")
                    .font(.system(size: 14))
                    .foregroundStyle(Theme.C.inkMuted)
                Spacer(minLength: 0)
            }
            .frame(maxWidth: .infinity)
        } else {
            ScrollView {
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 196), spacing: 16)], spacing: 16) {
                    ForEach(visible) { item in
                        Button {
                            selected = item
                        } label: {
                            LibraryTile(item: item)
                        }
                        .buttonStyle(.plain)
                        .pointerOnHover()
                        .accessibilityLabel(Text(item.displayTitle))
                    }
                }
                .padding(.vertical, 20)
                .padding(.leading, 20)
                // With a mouse attached macOS shows legacy scroll bars, whose
                // lane takes width on the right, and the grid sat 16 pt off
                // centre. That lane counts toward the right margin.
                .padding(.trailing, max(4, 20 - Self.scrollerLane))
            }
        }
    }

    private static var scrollerLane: CGFloat {
        NSScroller.preferredScrollerStyle == .legacy
            ? NSScroller.scrollerWidth(for: .regular, scrollerStyle: .legacy) : 0
    }

    private var botNames: [(id: String, name: String)] {
        var seen = Set<String>()
        return items.compactMap { item in
            guard !item.botId.isEmpty, seen.insert(item.botId).inserted else { return nil }
            return (item.botId, item.botName)
        }
    }

    private var visible: [MediaItem] {
        let q = search.trimmingCharacters(in: .whitespaces).lowercased()
        return items.filter { item in
            switch filter {
            case .all: break
            case .images: if item.kind != "image" { return false }
            case .drawings: if item.kind != "drawing" { return false }
            case .pages: if item.kind != "page" { return false }
            }
            if let botFilter, item.botId != botFilter { return false }
            if q.isEmpty { return true }
            return item.title.lowercased().contains(q) || item.prompt.lowercased().contains(q) || item.botName.lowercased().contains(q)
        }
    }

    private func load() async {
        do {
            let listed = try await GeneratedImageCache.shared.mediaList()
            root = listed.root
            items = listed.items
            held = listed.held
            error = nil
        } catch {
            self.error = "The Library could not load"
        }
        loaded = true
    }

    private func openChat(_ item: MediaItem) {
        guard botExists(item.botId) else {
            error = "The bot that made this is no longer here"
            selected = nil
            return
        }
        model.select(item.botId)
        onClose()
    }

    /// Draw it again in place from the prompt the server kept; the item comes
    /// back with its new file.
    private func regenerate(_ item: MediaItem) {
        guard !item.prompt.isEmpty else { return }
        regenerating.insert(item.id)
        Task {
            do {
                try await GeneratedImageCache.shared.regenerate(item.id)
                await load()
                // Only while the owner is still on this item's detail.
                if selected?.id == item.id {
                    selected = items.first { $0.id == item.id }
                }
            } catch {
                self.error = GeneratedImageCache.regenerateMessage(error)
                if selected?.id == item.id { selected = nil }
            }
            regenerating.remove(item.id)
        }
    }

    private func botExists(_ id: String) -> Bool {
        !id.isEmpty && (model.store?.bots.contains { $0.id == id } ?? false)
    }

    /// Point a moved item at where its file went, then show it from there.
    private func locate(_ item: MediaItem) {
        let panel = NSOpenPanel()
        switch item.kind {
        case "drawing": panel.allowedContentTypes = [UTType(filenameExtension: "excalidraw") ?? .json]
        case "page": panel.allowedContentTypes = [.html]
        default: panel.allowedContentTypes = [.png, .jpeg, .gif, .webP]
        }
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = false
        guard panel.runModal() == .OK, let url = panel.url else { return }
        Task {
            do {
                try await GeneratedImageCache.shared.relink(item.id, path: url.path)
                await load()
                selected = items.first { $0.id == item.id }
            } catch {
                self.error = "That file could not be used"
                selected = nil
            }
        }
    }

    /// The file goes to the Trash, where the owner can still get it back;
    /// only then does the Library forget it.
    private func trash(_ item: MediaItem) {
        Task {
            if item.exists {
                do {
                    try FileManager.default.trashItem(at: URL(fileURLWithPath: item.path), resultingItemURL: nil)
                } catch {
                    self.error = "That file could not be moved to the Trash"
                    selected = nil
                    return
                }
            }
            // The file is gone either way: a chat row showing it lets go now.
            NotificationCenter.default.post(name: .mediaItemGone, object: item.id)
            do {
                try await GeneratedImageCache.shared.forget(item.id)
            } catch {
                self.error = item.exists
                    ? "The file is in the Trash, but the Library could not forget it"
                    : "The Library could not remove that item"
            }
            selected = nil
            await load()
        }
    }
}

/// One grid cell: a thumbnail read straight from the file, the title and the bot.
private struct LibraryTile: View {
    let item: MediaItem
    @State private var thumbnail: NSImage?
    @State private var scene: ExcalidrawScene?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            // The cell sets the size and the picture fills it: a fill image
            // laid out on its own takes its natural width and spills out of
            // the grid column.
            Theme.C.sunken
                .frame(height: 160)
                .frame(maxWidth: .infinity)
                .overlay {
                    if let thumbnail {
                        Image(nsImage: thumbnail)
                            .resizable()
                            .scaledToFill()
                    } else if let scene {
                        ExcalidrawPreview(scene: scene)
                    } else {
                        Image(systemName: symbol)
                            .font(.system(size: 22))
                            .foregroundStyle(Theme.C.inkFaint)
                    }
                }
                .clipShape(RoundedRectangle(cornerRadius: DesignTokens.Radius.md, style: .continuous))
                // A white drawing on the white dialog still reads as a card.
                .overlay(
                    RoundedRectangle(cornerRadius: DesignTokens.Radius.md, style: .continuous)
                        .strokeBorder(Theme.C.border, lineWidth: 1)
                )
            VStack(alignment: .leading, spacing: 2) {
                Text(item.displayTitle)
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(Theme.C.ink)
                    .lineLimit(1)
                Text(item.exists ? "\(item.botName) · \(LibraryDetail.shortDate(item.createdAt))" : "Moved or deleted")
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.C.inkMuted)
                    .lineLimit(1)
            }
        }
        // The whole tile is the target, gaps included, so the pointer and the
        // click hold from the picture down to the date.
        .contentShape(Rectangle())
        .task(id: item.path) {
            guard item.exists else { return }
            if item.kind == "image" {
                thumbnail = await LibraryThumbnails.shared.thumbnail(path: item.path, maxPixel: 520)
            } else if item.kind == "page" {
                thumbnail = await PageThumbnails.shared.thumbnail(path: item.path)
            } else {
                scene = await ExcalidrawScenes.shared.scene(path: item.path)
            }
        }
    }

    private var symbol: String {
        if !item.exists { return "questionmark.folder" }
        switch item.kind {
        case "drawing": return "scribble.variable"
        case "page": return "globe"
        default: return "photo"
        }
    }
}

/// One item: the picture, what made it, and what the owner can do with it.
struct LibraryDetail: View {
    let item: MediaItem
    var regenerating = false
    let onOpenChat: () -> Void
    let onLocate: () -> Void
    let onRegenerate: () -> Void
    let onTrash: () -> Void
    @State private var preview: NSImage?
    @State private var scene: ExcalidrawScene?
    @State private var liveReady = false
    @State private var pageHovering = false

    var body: some View {
        HStack(alignment: .top, spacing: 24) {
            Group {
                if item.kind == "drawing" {
                    // The same live drawing the chat shows, with its own Edit
                    // and Open in Excalidraw: a .excalidraw file has no app
                    // on a Mac to open it. The native picture stands in while
                    // the live page loads, so the drawing shows at once.
                    ZStack {
                        WidgetSlot(widgetId: item.id, onLoaded: {
                            withAnimation(.easeOut(duration: DesignTokens.Motion.overlay)) { liveReady = true }
                        })
                        if !liveReady, let scene {
                            ExcalidrawPreview(scene: scene)
                                .allowsHitTesting(false)
                                .transition(.opacity)
                        }
                    }
                    // Excalidraw's cameras are 4:3 and the live page fits the
                    // camera to the frame's width, so a 4:3 frame shows it all.
                    .frame(width: 640, height: 480)
                    .overlay(
                        RoundedRectangle(cornerRadius: DesignTokens.Radius.md, style: .continuous)
                            .strokeBorder(Theme.C.border, lineWidth: 1)
                    )
                } else if item.kind == "page" {
                    pagePreview
                } else {
                    ZStack {
                        RoundedRectangle(cornerRadius: DesignTokens.Radius.md, style: .continuous)
                            .fill(Theme.C.sunken)
                        if let preview {
                            Image(nsImage: preview)
                                .resizable()
                                .scaledToFit()
                        } else {
                            Image(systemName: "photo")
                                .font(.system(size: 32))
                                .foregroundStyle(Theme.C.inkFaint)
                        }
                    }
                    .frame(width: 520, height: 520)
                }
            }
            .clipShape(RoundedRectangle(cornerRadius: DesignTokens.Radius.md, style: .continuous))

            VStack(alignment: .leading, spacing: 16) {
                let prompt = item.prompt.trimmingCharacters(in: .whitespacesAndNewlines)
                if !prompt.isEmpty {
                    PromptFact(prompt: prompt)
                }
                fact("Bot", item.botName)
                if !item.model.isEmpty {
                    fact("Model", item.model)
                }
                fact("Created", Self.dateText(item.createdAt))
                fact("File", item.exists ? item.path : "Moved or deleted")
                VStack(alignment: .leading, spacing: 8) {
                    if item.exists {
                        HStack(spacing: 8) {
                            // Images open in the default viewer and pages in
                            // the default browser; a drawing opens from its
                            // live view's own buttons.
                            if item.kind == "image" {
                                NativeButton("Open", kind: .primary, small: true) {
                                    NSWorkspace.shared.open(URL(fileURLWithPath: item.path))
                                }
                            } else if item.kind == "page" {
                                NativeButton("Open", kind: .primary, small: true) {
                                    PageOpener.open(URL(fileURLWithPath: item.path))
                                }
                            }
                            NativeButton("Show in Finder", kind: .secondary, small: true) {
                                NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: item.path)])
                            }
                            if item.kind == "image" {
                                NativeButton("Copy", kind: .secondary, small: true) {
                                    // The original file, not the downsampled
                                    // preview, decoded off the main thread.
                                    let url = URL(fileURLWithPath: item.path)
                                    Task {
                                        let data = await Task.detached { try? Data(contentsOf: url) }.value
                                        guard let data, let full = NSImage(data: data) else { return }
                                        NSPasteboard.general.clearContents()
                                        NSPasteboard.general.writeObjects([full, url as NSURL])
                                    }
                                }
                            }
                        }
                    }
                    HStack(spacing: 8) {
                        if !item.exists {
                            NativeButton("Locate", kind: .primary, small: true, action: onLocate)
                            if item.kind == "image", !item.prompt.isEmpty {
                                NativeButton(regenerating ? "Generating" : "Regenerate", kind: .secondary, small: true, enabled: !regenerating, action: onRegenerate)
                            }
                        }
                        if !item.botId.isEmpty {
                            NativeButton("Open chat", kind: .secondary, small: true, action: onOpenChat)
                        }
                        NativeButton(item.exists ? "Move to Trash" : "Remove", kind: .secondary, small: true, action: onTrash)
                    }
                }
                .padding(.top, 4)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .task(id: item.path) {
            guard item.exists else { return }
            if item.kind == "image" {
                preview = await LibraryThumbnails.shared.thumbnail(path: item.path, maxPixel: 1600)
            } else if item.kind == "page" {
                preview = await PageThumbnails.shared.thumbnail(path: item.path)
            } else {
                scene = await ExcalidrawScenes.shared.scene(path: item.path)
            }
        }
    }

    /// The page's picture at the width of a drawing, Open on hover.
    private var pagePreview: some View {
        Button {
            PageOpener.open(URL(fileURLWithPath: item.path))
        } label: {
            ZStack(alignment: .topTrailing) {
                Theme.C.sunken
                    .overlay {
                        if let preview {
                            Image(nsImage: preview)
                                .resizable()
                                .scaledToFill()
                        } else {
                            Image(systemName: "globe")
                                .font(.system(size: 32))
                                .foregroundStyle(Theme.C.inkFaint)
                        }
                    }
                    .frame(width: 640, height: 400, alignment: .top)
                    .clipped()
                if pageHovering, item.exists {
                    PageOpenChip()
                        .padding(12)
                        .transition(.opacity)
                }
            }
            .overlay(
                RoundedRectangle(cornerRadius: DesignTokens.Radius.md, style: .continuous)
                    .strokeBorder(Theme.C.border, lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
        .disabled(!item.exists)
        .pointerOnHover()
        .onHover { inside in
            withAnimation(.easeOut(duration: DesignTokens.Motion.overlay)) { pageHovering = inside }
        }
        .help("Open in your browser")
        .accessibilityLabel(Text(item.displayTitle))
        .accessibilityHint("Opens the page in your browser")
    }

    private func fact(_ label: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label)
                .font(.system(size: 12))
                .foregroundStyle(Theme.C.inkMuted)
            Text(value)
                .font(.system(size: 13))
                .foregroundStyle(Theme.C.ink)
                .lineLimit(8)
                .textSelection(.enabled)
        }
    }

    /// "Sep 19" on a tile: enough to tell an old drawing from a new one.
    static func shortDate(_ iso: String) -> String {
        guard let date = parseDate(iso) else { return "" }
        return date.formatted(.dateTime.month(.abbreviated).day())
    }

    private static func parseDate(_ iso: String) -> Date? {
        let parser = ISO8601DateFormatter()
        parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return parser.date(from: iso)
    }

    private static func dateText(_ iso: String) -> String {
        let parser = ISO8601DateFormatter()
        parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let date = parser.date(from: iso) else { return iso }
        return date.formatted(date: .abbreviated, time: .shortened)
    }
}

/// The prompt's first paragraph, with all of it one click away: a long
/// prompt no longer pushes the facts under it out of sight.
private struct PromptFact: View {
    /// Trimmed: what shows is what the copy button copies.
    let prompt: String
    @State private var showingAll = false
    @State private var truncated = false

    /// Up to the first blank line.
    static func firstParagraph(_ text: String) -> String {
        guard let gap = text.range(of: #"\n\s*\n"#, options: .regularExpression) else { return text }
        return String(text[..<gap.lowerBound])
    }

    var body: some View {
        let lead = Self.firstParagraph(prompt)
        let more = lead != prompt || truncated
        VStack(alignment: .leading, spacing: 4) {
            Text("Prompt")
                .font(.system(size: 12))
                .foregroundStyle(Theme.C.inkMuted)
            // Not selectable here: a click swaps selectable text for an
            // editor that drops the ellipsis. The full prompt selects.
            Text(lead)
                .font(.system(size: 13))
                .foregroundStyle(Theme.C.ink)
                .lineLimit(4)
                .truncationMode(.tail)
                .background {
                    // The paragraph at full height against the four lines
                    // shown, so a narrow column still offers the rest.
                    GeometryReader { shown in
                        Text(lead)
                            .font(.system(size: 13))
                            .fixedSize(horizontal: false, vertical: true)
                            .frame(width: shown.size.width, alignment: .leading)
                            .hidden()
                            .background(GeometryReader { full in
                                Color.clear
                                    .onAppear { truncated = full.size.height > shown.size.height + 1 }
                                    .onChange(of: [full.size.height, shown.size.height]) { _, heights in
                                        truncated = heights[0] > heights[1] + 1
                                    }
                            })
                    }
                }
            HStack(spacing: 4) {
                if more {
                    Button("Show full prompt") { showingAll = true }
                        .buttonStyle(.plain)
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(Theme.C.accent)
                        .pointerOnHover()
                        .popover(isPresented: $showingAll, arrowEdge: .bottom) {
                            FullPrompt(prompt: prompt)
                        }
                }
                CopyPromptButton(prompt: prompt)
            }
        }
    }
}

/// The whole prompt, scrollable and selectable.
private struct FullPrompt: View {
    let prompt: String

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("Prompt")
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.C.inkMuted)
                Spacer()
                CopyPromptButton(prompt: prompt)
            }
            ScrollView {
                Text(prompt)
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.C.ink)
                    .lineSpacing(2)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .padding(16)
        .frame(width: 480, height: 420)
        // Opaque: the default material lets the detail's text show through.
        .presentationBackground(Theme.C.surface)
    }
}

/// Copies the whole prompt, the same icon the chat's image row uses.
private struct CopyPromptButton: View {
    let prompt: String
    @State private var copied = false

    var body: some View {
        Button {
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(prompt, forType: .string)
            copied = true
            Task {
                try? await Task.sleep(for: .seconds(1.5))
                copied = false
            }
        } label: {
            Image(systemName: copied ? "checkmark" : "doc.on.doc")
                .font(.system(size: 11))
                .foregroundStyle(Theme.C.inkMuted)
                .frame(width: 22, height: 22)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .pointerOnHover()
        .help("Copy prompt")
        .accessibilityLabel(copied ? "Prompt copied" : "Copy prompt")
    }
}

/// Downsampled thumbnails read straight from disk, so a grid of multi-MB
/// images decodes only what it shows.
actor LibraryThumbnails {
    static let shared = LibraryThumbnails()
    private let cache = NSCache<NSString, NSImage>()

    func thumbnail(path: String, maxPixel: Int) async -> NSImage? {
        // Keyed by the file's modification time too: a file replaced at the
        // same path gets a fresh picture.
        let stamp = (try? FileManager.default.attributesOfItem(atPath: path)[.modificationDate] as? Date)?.timeIntervalSince1970 ?? 0
        let key = "\(maxPixel):\(stamp):\(path)" as NSString
        if let hit = cache.object(forKey: key) { return hit }
        let url = URL(fileURLWithPath: path) as CFURL
        guard let source = CGImageSourceCreateWithURL(url, nil),
              let cgImage = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                  kCGImageSourceCreateThumbnailFromImageAlways: true,
                  kCGImageSourceCreateThumbnailWithTransform: true,
                  kCGImageSourceThumbnailMaxPixelSize: maxPixel,
              ] as CFDictionary) else { return nil }
        let image = NSImage(cgImage: cgImage, size: NSSize(width: cgImage.width, height: cgImage.height))
        cache.setObject(image, forKey: key)
        return image
    }
}

extension MediaItem {
    /// A short title for the grid. The stored title is the prompt cut into a
    /// file name (colons lost), so images get a fresh one from the prompt:
    /// its first clause without filler words or aspect ratios, about 40
    /// characters at a word boundary. Pages and drawings keep their own.
    var displayTitle: String {
        guard kind == "image" else { return title }
        // Worked out once per prompt: the grid asks on every layout pass.
        if let cached = Self.titleCache.object(forKey: prompt as NSString) { return cached as String }
        let made = Self.makeTitle(prompt: prompt, fallback: title)
        Self.titleCache.setObject(made as NSString, forKey: prompt as NSString)
        return made
    }

    private static let titleCache = NSCache<NSString, NSString>()

    private static func makeTitle(prompt: String, fallback title: String) -> String {
        let line = prompt.split(whereSeparator: \.isNewline).first.map(String.init) ?? ""
        var text = line.trimmingCharacters(in: .whitespaces)
        func strip(_ pattern: String) {
            text = text.replacingOccurrences(of: pattern, with: "", options: [.regularExpression, .caseInsensitive])
        }
        strip(#"\b(16|9|4|3|21|2|1)\s*[: ]\s*(9|16|3|4|5|1|2)\b(?=\s|$)"#)
        strip(#"\b(aspect ratio|photorealistic)\b"#)
        text = text.replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
        var previous = ""
        while previous != text {
            previous = text
            strip(#"^\s*(please\s+)?(create|generate|make|design|draw|produce|render)\s+(me\s+)?"#)
            strip(#"^\s*(a|an|the|completed|finished|final|professional)\s+"#)
        }
        // First clause: up to a sentence end, comma or semicolon (colons stay).
        if let end = text.range(of: #"[.,;!?](\s|$)|\s[-\u2013\u2014]\s"#, options: .regularExpression) {
            text = String(text[..<end.lowerBound])
        }
        text = text.trimmingCharacters(in: .whitespaces)
        if text.count > 40 {
            let cut = String(text.prefix(40))
            text = (cut.lastIndex(of: " ").map { String(cut[..<$0]) } ?? cut)
        }
        text = text.trimmingCharacters(in: CharacterSet(charactersIn: " ,;:-"))
        // A cut that lands after "for an" or "with the" reads as broken off.
        let dangling: Set<String> = ["a", "an", "the", "for", "of", "with", "and", "or", "to", "in", "on", "at", "by", "from"]
        var words = text.split(separator: " ")
        while words.count > 1, let last = words.last, dangling.contains(last.lowercased()) { words.removeLast() }
        text = words.joined(separator: " ")
        guard let first = text.first else { return title }
        return first.uppercased() + text.dropFirst()
    }
}
