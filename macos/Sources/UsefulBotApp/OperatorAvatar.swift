import AppKit
import ImageIO
import SwiftUI
import UniformTypeIdentifiers
import UsefulBotCore

/// The owner's profile photo. There is no account backend, so the photo
/// lives on this Mac only: a 256px square PNG in the app's Application
/// Support folder. No photo means the initials show, as before.
@MainActor
final class OperatorAvatarStore: ObservableObject {
    static let shared = OperatorAvatarStore()

    @Published private(set) var image: NSImage?
    /// Why the last pick failed, shown under the account row until the next
    /// pick or removal.
    @Published private(set) var error: String?

    private let fileURL: URL = {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return AppVariant.current.appSupportDirectory(support: base)
            .appendingPathComponent("profile-avatar.png")
    }()

    private init() {
        image = NSImage(contentsOf: fileURL)
    }

    /// Opens the image picker and saves the choice.
    func pick() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = false
        panel.allowedContentTypes = [.image]
        panel.prompt = "Use Photo"
        guard panel.runModal() == .OK, let url = panel.url else { return }
        save(from: url)
    }

    func remove() {
        do {
            if FileManager.default.fileExists(atPath: fileURL.path) {
                try FileManager.default.removeItem(at: fileURL)
            }
            image = nil
            error = nil
        } catch {
            self.error = "The photo could not be removed: \(error.localizedDescription)"
        }
    }

    /// Decoding, cropping and writing happen off the main thread: a large
    /// camera photo would otherwise freeze the window after "Use Photo".
    private func save(from url: URL) {
        let target = fileURL
        Task.detached(priority: .userInitiated) {
            let outcome = Self.prepare(url, writingTo: target)
            await MainActor.run {
                switch outcome {
                case .success(let png):
                    self.image = NSImage(data: png)
                    self.error = nil
                case .failure(let failure):
                    self.error = failure.message
                }
            }
        }
    }

    private struct Failure: Error {
        let message: String
    }

    nonisolated private static func prepare(_ url: URL, writingTo target: URL) -> Result<Data, Failure> {
        guard let png = squarePNG(from: url) else {
            return .failure(Failure(message: "That file is not an image this Mac can read."))
        }
        do {
            try FileManager.default.createDirectory(
                at: target.deletingLastPathComponent(),
                withIntermediateDirectories: true
            )
            try png.write(to: target, options: .atomic)
            return .success(png)
        } catch {
            return .failure(Failure(message: "The photo could not be saved: \(error.localizedDescription)"))
        }
    }

    /// Downsamples at decode (EXIF rotation applied, so a portrait phone
    /// photo stays upright), centre-crops to a square and scales to 256px.
    nonisolated private static func squarePNG(from url: URL) -> Data? {
        guard let source = CGImageSourceCreateWithURL(url as CFURL, nil) else { return nil }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: 1024,
        ]
        guard let cg = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary),
              cg.width > 0, cg.height > 0 else { return nil }
        let edge = min(cg.width, cg.height)
        let crop = CGRect(x: (cg.width - edge) / 2, y: (cg.height - edge) / 2, width: edge, height: edge)
        guard let square = cg.cropping(to: crop) else { return nil }
        let pixels = 256
        guard let space = CGColorSpace(name: CGColorSpace.sRGB),
              let context = CGContext(
                data: nil, width: pixels, height: pixels, bitsPerComponent: 8, bytesPerRow: 0,
                space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
              ) else { return nil }
        context.interpolationQuality = .high
        context.draw(square, in: CGRect(x: 0, y: 0, width: pixels, height: pixels))
        guard let scaled = context.makeImage() else { return nil }
        return NSBitmapImageRep(cgImage: scaled).representation(using: .png, properties: [:])
    }
}

/// The owner's avatar: the saved photo, or the initials on a sunken disc.
struct OperatorAvatarView: View {
    let initials: String
    var size: CGFloat = DesignTokens.Control.operatorAvatar
    @ObservedObject private var store = OperatorAvatarStore.shared

    var body: some View {
        Group {
            if let image = store.image {
                Image(nsImage: image)
                    .resizable()
                    .scaledToFill()
            } else {
                Text(initials)
                    .font(.system(size: 10, weight: .bold))
                    .tracking(DesignTokens.Tracking.operatorAvatar * 10)
                    .foregroundStyle(Theme.C.ink)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(Theme.C.sunken)
            }
        }
        .frame(width: size, height: size)
        .clipShape(Circle())
    }
}
