import AppKit
import SwiftUI
import UniformTypeIdentifiers
import UsefulBotCore

/// One generated image in the transcript: the picture at chat width, its
/// prompt under it, a compact row when the bytes cannot be fetched. The
/// image is fetched through the signed-in client, so the row never carries a
/// URL into the local service. The file lives in the owner's media folder:
/// when it has moved the row offers Locate, when it is gone for good it
/// offers Regenerate from the saved prompt.
struct GeneratedImageRow: View {
    let imageId: String
    let prompt: String
    /// Set when the picture is one of a run laid out side by side: it shows
    /// as a tile of this height, and its prompt moves to the tooltip and the
    /// context menu.
    var tileHeight: CGFloat?

    private enum Lost { case moved, missing, failed }

    @State private var image: NSImage?
    @State private var lost: Lost?
    @State private var locateError: String?
    @State private var regenerating = false
    @State private var copied = false
    /// A retry bumps this so `.task` runs the fetch again.
    @State private var attempt = 0

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            content
            if !prompt.isEmpty, tileHeight == nil {
                promptLine
            }
        }
        .task(id: attempt) {
            let outcome = await GeneratedImageCache.shared.fetch(imageId)
            locateError = nil
            switch outcome {
            case .image(let loaded):
                image = loaded
                lost = nil
            case .moved:
                lost = .moved
            case .missing:
                lost = .missing
            case .failed:
                lost = .failed
            }
        }
    }

    /// One line of the prompt and a button that copies all of it.
    private var promptLine: some View {
        HStack(spacing: 6) {
            Text(prompt)
                .font(.system(size: 12))
                .foregroundStyle(Theme.C.inkFaint)
                .lineLimit(1)
                .truncationMode(.tail)
            Button {
                copyPrompt()
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
        .frame(maxWidth: 448, alignment: .leading)
    }

    private func copyPrompt() {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(prompt, forType: .string)
        copied = true
        Task {
            try? await Task.sleep(for: .seconds(1.5))
            copied = false
        }
    }

    /// The footprint of a picture not drawn yet: square, at the tile's height
    /// in a run.
    private var placeholderSide: CGFloat { tileHeight ?? 320 }

    @ViewBuilder private var content: some View {
        if regenerating {
            // The footprint the new picture will take, with the work shown.
            RoundedRectangle(cornerRadius: DesignTokens.Radius.md, style: .continuous)
                .fill(Theme.C.sunken)
                .frame(width: placeholderSide, height: placeholderSide)
                .overlay {
                    VStack(spacing: 10) {
                        ProgressView().controlSize(.small)
                        Text("Generating")
                            .font(.system(size: 13))
                            .foregroundStyle(Theme.C.inkMuted)
                    }
                }
        } else if let image, let tileHeight {
            // A tile keeps the picture's shape within bounds, so a run of
            // mixed shapes still reads as one row.
            let aspect = image.size.height > 0 ? image.size.width / image.size.height : 1
            Button {
                open(image)
            } label: {
                Image(nsImage: image)
                    .resizable()
                    .scaledToFill()
                    .frame(width: tileHeight * min(max(aspect, 0.75), 1.6), height: tileHeight)
                    .clipShape(RoundedRectangle(cornerRadius: DesignTokens.Radius.md, style: .continuous))
                    .contentShape(RoundedRectangle(cornerRadius: DesignTokens.Radius.md, style: .continuous))
                    .cardLift(cornerRadius: DesignTokens.Radius.md)
            }
            .buttonStyle(.plain)
            .pointerOnHover()
            .help(prompt)
            .contextMenu {
                if !prompt.isEmpty {
                    Button("Copy Prompt") { copyPrompt() }
                }
            }
            .accessibilityLabel(Text(prompt.isEmpty ? "Generated image" : prompt))
            .accessibilityHint("Opens the image in your viewer")
        } else if let image {
            Button {
                open(image)
            } label: {
                Image(nsImage: image)
                    .resizable()
                    .scaledToFit()
                    .frame(maxWidth: 448, maxHeight: 448)
                    .clipShape(RoundedRectangle(cornerRadius: DesignTokens.Radius.md, style: .continuous))
                    .cardLift(cornerRadius: DesignTokens.Radius.md)
            }
            .buttonStyle(.plain)
            .pointerOnHover()
            .accessibilityLabel(Text(prompt.isEmpty ? "Generated image" : prompt))
            .accessibilityHint("Opens the image in your viewer")
        } else if let lost, let tileHeight {
            // The same words and ways out as the full row, stacked to fit
            // the tile.
            VStack(spacing: 8) {
                Image(systemName: "photo")
                    .font(.system(size: 15))
                    .foregroundStyle(Theme.C.inkMuted)
                Text(locateError ?? (lost == .moved ? "Image moved or deleted" : "Image unavailable"))
                    .font(.system(size: 12))
                    .multilineTextAlignment(.center)
                    .foregroundStyle(locateError == nil ? Theme.C.inkMuted : Theme.C.danger)
                // Stacked: three actions side by side do not fit the tile.
                VStack(spacing: 4) {
                    lostActions(lost)
                }
            }
            .padding(12)
            .frame(width: tileHeight, height: tileHeight)
            .background(Theme.C.sunken)
            .clipShape(RoundedRectangle(cornerRadius: DesignTokens.Radius.md, style: .continuous))
        } else if let lost {
            HStack(spacing: 8) {
                Image(systemName: "photo")
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.C.inkMuted)
                Text(locateError ?? (lost == .moved ? "Image moved or deleted" : "Image unavailable"))
                    .font(.system(size: 13))
                    .foregroundStyle(locateError == nil ? Theme.C.inkMuted : Theme.C.danger)
                Spacer(minLength: 0)
                lostActions(lost)
            }
            .padding(.horizontal, 14)
            .frame(height: 52)
            // The width the picture would have had, not the whole column.
            .frame(maxWidth: 448, alignment: .leading)
        } else {
            // Bytes are still in flight; hold the footprint the image will
            // take so the transcript does not jump when it lands.
            RoundedRectangle(cornerRadius: DesignTokens.Radius.md, style: .continuous)
                .fill(Theme.C.sunken)
                .frame(width: placeholderSide, height: placeholderSide)
        }
    }

    @ViewBuilder private func lostActions(_ lost: Lost) -> some View {
        switch lost {
        case .moved:
            // The server cannot tell moved from deleted: both ways
            // out, and Retry for a file put back where it was.
            rowAction("Retry") { retry() }
            rowAction("Locate") { locate() }
            regenerateAction
        case .missing:
            regenerateAction
        case .failed:
            rowAction("Retry") { retry() }
        }
    }

    @ViewBuilder private var regenerateAction: some View {
        if !prompt.isEmpty {
            rowAction("Regenerate") { regenerate() }
        }
    }

    /// Draw it again here, from the prompt the server kept, under the same
    /// id: the new picture lands in this row.
    private func regenerate() {
        regenerating = true
        locateError = nil
        Task {
            do {
                try await GeneratedImageCache.shared.regenerate(imageId)
                regenerating = false
                lost = nil
                attempt += 1
            } catch {
                regenerating = false
                locateError = GeneratedImageCache.regenerateMessage(error)
            }
        }
    }

    private func retry() {
        Task {
            await GeneratedImageCache.shared.forgetOutcome(imageId)
            lost = nil
            attempt += 1
        }
    }

    private func rowAction(_ title: String, _ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(Theme.C.inkMuted)
        }
        .buttonStyle(.plain)
        .pointerOnHover()
    }

    /// The owner points at where the file went; the index follows it and the
    /// row loads from there.
    private func locate() {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.png, .jpeg, .gif, .webP]
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = false
        panel.message = "Find the moved image"
        guard panel.runModal() == .OK, let url = panel.url else { return }
        Task {
            do {
                try await GeneratedImageCache.shared.relink(imageId, path: url.path)
                locateError = nil
                lost = nil
                attempt += 1
            } catch {
                locateError = "That file could not be used"
            }
        }
    }

    /// Hand the picture to the default viewer: the transcript keeps the
    /// inline copy, a click opens it full size.
    private func open(_ image: NSImage) {
        guard let tiff = image.tiffRepresentation,
              let rep = NSBitmapImageRep(data: tiff),
              let png = rep.representation(using: .png, properties: [:]) else { return }
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("useful-bot-\(imageId).png")
        do {
            try png.write(to: url, options: .atomic)
            NSWorkspace.shared.open(url)
        } catch {
            // The picture stays in the transcript; a failed write just means
            // no separate window.
        }
    }
}

/// One fetch per image id for the life of the process; a failure is not
/// cached, so a flaky fetch is retried the next time the row appears. The
/// cache is small: decoded images are several megabytes each.
actor GeneratedImageCache {
    static let shared = GeneratedImageCache()
    private static let maxEntries = 16
    private var images: [String: NSImage] = [:]
    /// Moved or missing answers, kept a minute so rows scrolling back into
    /// view do not ask the server again each time. Locate clears its id.
    private var lost: [String: (outcome: Outcome, at: Date)] = [:]
    /// Bumped by Locate and Remove: a fetch that started before them must not
    /// write its now-stale answer back into the caches.
    private var generation: [String: Int] = [:]
    private var inFlight: [String: Task<Outcome, Never>] = [:]

    /// One client for every fetch. Each `BackendClient` owns a private cookie
    /// jar, so a fresh client pays a full sign-in; a per-row client would let
    /// scrolling burn through the auth rate limit.
    private static let client = try! BackendClient(base: ServerConfig.resolved().baseURL)

    enum Outcome: Sendable {
        case image(NSImage)
        case moved
        case missing
        case failed
    }

    func fetch(_ id: String) async -> Outcome {
        if let cached = images[id] { return .image(cached) }
        if let known = lost[id], Date().timeIntervalSince(known.at) < 60 { return known.outcome }
        if let running = inFlight[id] { return await running.value }
        let started = generation[id, default: 0]
        let task = Task<Outcome, Never> {
            do {
                switch try await Self.client.imageFetch(id: id) {
                case .loaded(let data):
                    guard let image = NSImage(data: data) else { return .failed }
                    return .image(image)
                case .moved:
                    return .moved
                case .missing:
                    return .missing
                }
            } catch {
                return .failed
            }
        }
        inFlight[id] = task
        let result = await task.value
        if inFlight[id] == task { inFlight[id] = nil }
        guard generation[id, default: 0] == started else { return result }
        switch result {
        case .image(let image):
            if images.count >= Self.maxEntries { images.removeAll() }
            images[id] = image
            lost[id] = nil
        case .moved, .missing:
            lost[id] = (result, Date())
        case .failed:
            break
        }
        return result
    }

    /// A Retry asks the server again rather than the minute-long memory.
    func forgetOutcome(_ id: String) {
        lost[id] = nil
    }

    private func invalidate(_ id: String) {
        images[id] = nil
        lost[id] = nil
        inFlight[id] = nil
        generation[id, default: 0] += 1
    }

    /// A failed Regenerate in words: the server's code when it sent one.
    nonisolated static func regenerateMessage(_ error: Error) -> String {
        if let urlError = error as? URLError, urlError.code == .timedOut {
            return BackendClient.regenerateCopy("timeout")
        }
        if case BackendError.regenerate(let code) = error { return BackendClient.regenerateCopy(code) }
        return (error as? LocalizedError)?.errorDescription ?? "The image couldn't be generated again."
    }

    func regenerate(_ id: String) async throws {
        try await Self.client.regenerateImage(id: id)
        invalidate(id)
    }

    func relink(_ id: String, path: String) async throws {
        try await Self.client.relinkMedia(id: id, path: path)
        invalidate(id)
    }

    /// A page row's item: where its file is and whether it is still there.
    func mediaItem(_ id: String) async throws -> MediaItem? {
        try await Self.client.mediaItem(id: id)
    }

    /// The Library's calls ride the same signed-in client as the rows.
    func mediaList() async throws -> (root: String, items: [MediaItem], held: Int) {
        try await Self.client.mediaList()
    }

    func forget(_ id: String) async throws {
        try await Self.client.forgetMedia(id: id)
        invalidate(id)
    }
}

/// Pictures posted one after another: tiles side by side, wrapping onto a
/// new row when the bubble width runs out, so a set reads as one set.
struct GeneratedImageRun: View {
    let rows: [TranscriptRow]
    let maxWidth: CGFloat

    static let tileHeight: CGFloat = 180

    var body: some View {
        HStack(spacing: 0) {
            WrapHStack(spacing: 8) {
                ForEach(rows) { row in
                    GeneratedImageRow(imageId: row.imageId ?? "", prompt: row.text, tileHeight: Self.tileHeight)
                }
            }
            .frame(maxWidth: maxWidth, alignment: .leading)
            Spacer(minLength: 0)
        }
    }
}
