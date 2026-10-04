import AppKit
import SwiftUI
import UsefulBotCore

/// Bundles copy these assets from brand/. swift run reads the same source tree.
@MainActor
enum BrandAssets {
    struct AvatarColor: Decodable {
        let label: String
        let fill: String
        var legacy: Bool? = nil
    }

    static let root: URL = {
        if Bundle.main.bundleURL.pathExtension == "app" {
            return Bundle.main.bundleURL.appendingPathComponent("Contents/Resources/Brand", isDirectory: true)
        }
        return URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("brand", isDirectory: true)
    }()

    static let palette: [String: AvatarColor] = decode("source/avatar-palette.json")
    static let motion: BrandMotion = {
        let timing: BrandMotion = decode("source/motion.json")
        do { try timing.validate() }
        catch { preconditionFailure("Invalid brand motion timing: \(error)") }
        return timing
    }()
    private static var images: [String: NSImage] = [:]
    private static var layers: [String: NSImage] = [:]

    static func image(_ path: String) -> NSImage {
        if let image = images[path] { return image }
        guard let image = NSImage(contentsOf: root.appendingPathComponent(path)) else {
            preconditionFailure("Missing brand asset: \(path). Rebuild with npm run brand:build and macos/build-app.sh.")
        }
        image.isTemplate = false
        // The brand PNGs, the icns included, carry 25 dpi metadata, which
        // made a 1024 px bitmap 2,949 pt to AppKit. The app icon's snapshot
        // was 5,898 px at 2x, 278 MB, taken again on every icon refresh. A
        // brand bitmap is a 2x asset. The SVGs carry their own sizes.
        let bitmaps = image.representations.compactMap { $0 as? NSBitmapImageRep }
        if !bitmaps.isEmpty, bitmaps.count == image.representations.count {
            image.size = NSSize(
                width: CGFloat(bitmaps.map(\.pixelsWide).max()!) / 2,
                height: CGFloat(bitmaps.map(\.pixelsHigh).max()!) / 2
            )
        }
        images[path] = image
        return image
    }

    /// A motion layer at the size it is drawn, rasterised once per size.
    /// The animation composites five layers 30 times a second, so each one
    /// is a bitmap of `size` points at 2x and no bigger.
    static func motionLayer(_ name: String, size: CGFloat) -> NSImage {
        let key = "\(name)@\(size)"
        if let layer = layers[key] { return layer }
        let source = image("motion/native/\(name).png")
        let pixels = Int((size * 2).rounded(.up))
        guard let rep = NSBitmapImageRep(
            bitmapDataPlanes: nil, pixelsWide: pixels, pixelsHigh: pixels, bitsPerSample: 8,
            samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
            bytesPerRow: 0, bitsPerPixel: 0
        ) else { preconditionFailure("Cannot allocate a \(pixels) px layer for \(name)") }
        rep.size = NSSize(width: size, height: size)
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
        NSGraphicsContext.current?.imageInterpolation = .high
        source.draw(in: NSRect(x: 0, y: 0, width: size, height: size))
        NSGraphicsContext.restoreGraphicsState()
        let layer = NSImage(size: rep.size)
        layer.addRepresentation(rep)
        layers[key] = layer
        return layer
    }

    static func colorID(for bot: ShellBot) -> String {
        FacePalette.displayColor(for: bot)
    }

    private static func decode<T: Decodable>(_ path: String) -> T {
        do { return try JSONDecoder().decode(T.self, from: Data(contentsOf: root.appendingPathComponent(path))) }
        catch { preconditionFailure("Cannot load brand asset \(path): \(error)") }
    }
}

struct BrandMotionView: View {
    var size: CGFloat
    var color = "ink"
    var repeating = true
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase
    @State private var started = Date()
    @State private var finished = false

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 30, paused: reduceMotion || finished || scenePhase != .active)) { context in
            BrandMotionFrameView(
                frame: finished ? BrandMotion.Frame() : BrandAssets.motion.frame(at: context.date.timeIntervalSince(started), repeating: repeating, reducedMotion: reduceMotion),
                size: size,
                color: color
            )
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
        .task {
            started = Date()
            guard !repeating else { return }
            // Sleep can only fail through cancellation when this view leaves.
            do { try await Task.sleep(for: .seconds(BrandAssets.motion.duration)) }
            catch { return }
            finished = true
        }
    }

}

/// One frame of the mascot. A view that already runs a timeline draws this
/// directly instead of nesting a second one inside `BrandMotionView`.
struct BrandMotionFrameView: View {
    var frame: BrandMotion.Frame
    var size: CGFloat
    var color = "ink"

    private var tint: Color { Theme.color(BrandAssets.palette[color]!.fill) }

    var body: some View {
        ZStack {
            // The head alone since the logo became the circle face: no body
            // or arms to squash or wave, only the float and the blink.
            layer("head").colorMultiply(tint)
            layer("mouth")
            layer("glasses")
            layer("eye-left").scaleEffect(x: 1, y: frame.blink, anchor: UnitPoint(x: 384.378 / 1024, y: 531.080 / 1024))
            layer("eye-right").scaleEffect(x: 1, y: frame.blink, anchor: UnitPoint(x: 640.085 / 1024, y: 531.080 / 1024))
        }
        .offset(y: frame.float * size / 1024)
    }

    private func layer(_ name: String) -> some View {
        Image(nsImage: BrandAssets.motionLayer(name, size: size))
            .resizable().interpolation(.high).scaledToFit()
            .frame(width: size, height: size)
    }
}
