import AppKit
import SwiftUI
import UsefulBotCore

/// The owner's own pictures, kept on this Mac after they are sent. A stored
/// turn keeps only an image's name, so without a local copy a sent bubble
/// had nothing to draw after a relaunch or a replay, and showed the name.
enum SentImageStore {
    static let directory: URL = {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return base.appendingPathComponent("Useful Bot", isDirectory: true)
            .appendingPathComponent("Sent Images", isDirectory: true)
    }()

    /// Where a sent image named `name` lives, in its bot's own folder. The
    /// name comes from a stored turn, so only its last path component is used.
    static func url(for name: String, botId: String) -> URL {
        directory
            .appendingPathComponent(URL(fileURLWithPath: botId).lastPathComponent, isDirectory: true)
            .appendingPathComponent(URL(fileURLWithPath: name).lastPathComponent)
    }

    /// Gives a just-attached image its content name. Nothing is written yet:
    /// a picture attached and then removed never reaches the disk.
    static func named(_ attachment: Attachment) -> Attachment {
        guard attachment.isImage, let dataUrl = attachment.dataUrl,
              let data = Attachments.bytes(ofDataURL: dataUrl) else { return attachment }
        var named = attachment
        named.name = Attachments.contentName(attachment.name, data: data)
        return named
    }

    /// Keeps the pictures of a message being sent, off the main thread. One
    /// that cannot be kept still sends; its bubble just shows a plain tile.
    static func keep(_ images: [Attachment], botId: String) {
        let items = images.compactMap { image -> (URL, String)? in
            guard image.isImage, let dataUrl = image.dataUrl else { return nil }
            // In memory at once, so the bubble drawn right after this send
            // has its picture before the file lands. Attachments are capped
            // at 1 MB each, so the decode here is small.
            if let data = Attachments.bytes(ofDataURL: dataUrl), let picture = NSImage(data: data) {
                cache.setObject(picture, forKey: "\(botId)/\(image.name)" as NSString)
            }
            return (url(for: image.name, botId: botId), dataUrl)
        }
        guard !items.isEmpty else { return }
        Task.detached(priority: .utility) {
            for (target, dataUrl) in items where !FileManager.default.fileExists(atPath: target.path) {
                guard let data = Attachments.bytes(ofDataURL: dataUrl) else { continue }
                do {
                    try FileManager.default.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
                    try data.write(to: target, options: .atomic)
                } catch {
                    NSLog("Useful Bot: could not keep sent image: \(error.localizedDescription)")
                }
            }
        }
    }

    /// A deleted bot's pictures go with it.
    static func forget(botId: String) {
        let folder = directory.appendingPathComponent(URL(fileURLWithPath: botId).lastPathComponent, isDirectory: true)
        try? FileManager.default.removeItem(at: folder)
    }

    fileprivate static let cache: NSCache<NSString, NSImage> = {
        let cache = NSCache<NSString, NSImage>()
        cache.countLimit = 64
        return cache
    }()
}

/// One sent picture: read off disk once, off the main thread, and drawn at
/// the size the bubble gives it. A picture this Mac no longer has shows a
/// plain tile, never its name or path.
struct SentImageView: View {
    let name: String
    let botId: String
    let side: CGFloat
    /// One picture on its own keeps its shape inside a `side` box; several
    /// share square tiles.
    var keepsShape = false

    @State private var image: NSImage?
    @State private var missing = false

    private func fitted(_ image: NSImage) -> CGSize {
        let size = image.size
        guard size.width > 0, size.height > 0 else { return CGSize(width: side, height: side) }
        let scale = min(side / size.width, side / size.height, 1)
        return CGSize(width: size.width * scale, height: size.height * scale)
    }

    var body: some View {
        Group {
            if let image, keepsShape {
                Image(nsImage: image)
                    .resizable()
                    .aspectRatio(contentMode: .fit)
                    .frame(width: fitted(image).width, height: fitted(image).height)
            } else if let image {
                Image(nsImage: image)
                    .resizable()
                    .scaledToFill()
                    .frame(width: side, height: side)
            } else {
                ZStack {
                    Theme.C.sunken
                    if missing {
                        Image(systemName: "photo")
                            .font(.system(size: side * 0.28, weight: .regular))
                            .foregroundStyle(Theme.C.inkFaint)
                    }
                }
                .frame(width: side, height: side)
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: DesignTokens.Radius.md, style: .continuous))
        .contentShape(Rectangle())
        .onTapGesture {
            let url = SentImageStore.url(for: name, botId: botId)
            if FileManager.default.fileExists(atPath: url.path) { NSWorkspace.shared.open(url) }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Image")
        .accessibilityAddTraits(.isImage)
        .task(id: name) {
            let key = "\(botId)/\(name)" as NSString
            if let cached = SentImageStore.cache.object(forKey: key) {
                image = cached
                return
            }
            // Kept per bot; the first builds of this store kept them flat.
            let perBot = SentImageStore.url(for: name, botId: botId)
            let flat = SentImageStore.directory.appendingPathComponent(URL(fileURLWithPath: name).lastPathComponent)
            let url = FileManager.default.fileExists(atPath: perBot.path) ? perBot : flat
            let loaded = await Task.detached(priority: .userInitiated) { NSImage(contentsOf: url) }.value
            if let loaded {
                SentImageStore.cache.setObject(loaded, forKey: key)
                image = loaded
            } else {
                missing = true
            }
        }
    }
}

/// An attached picture in the composer, drawn from its own bytes before
/// anything is kept on disk.
struct AttachmentPreview: View {
    let file: Attachment
    let side: CGFloat
    @State private var image: NSImage?

    var body: some View {
        ZStack {
            Theme.C.sunken
            if let image {
                Image(nsImage: image).resizable().scaledToFill()
            }
        }
        .frame(width: side, height: side)
        .clipShape(RoundedRectangle(cornerRadius: DesignTokens.Radius.md, style: .continuous))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Image")
        .accessibilityAddTraits(.isImage)
        .task(id: file.id) {
            guard let dataUrl = file.dataUrl else { return }
            image = await Task.detached(priority: .userInitiated) {
                Attachments.bytes(ofDataURL: dataUrl).flatMap(NSImage.init(data:))
            }.value
        }
    }
}
