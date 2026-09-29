import AppKit
import SwiftUI

/// A still picture of an Excalidraw scene, drawn natively from the saved
/// .excalidraw file: instant, where the live view has to load its app first.
/// It covers the shapes the drawings use (rectangles, ellipses, diamonds,
/// arrows, lines, text and shape labels); anything else is skipped.
struct ExcalidrawPreview: View {
    let scene: ExcalidrawScene

    var body: some View {
        Canvas { context, size in
            guard let bounds = scene.bounds, bounds.width > 0 || bounds.height > 0 else { return }
            let pad: CGFloat = 16
            let scale = min(
                (size.width - pad * 2) / max(bounds.width, 1),
                (size.height - pad * 2) / max(bounds.height, 1),
                2
            )
            let offset = CGPoint(
                x: (size.width - bounds.width * scale) / 2 - bounds.minX * scale,
                y: (size.height - bounds.height * scale) / 2 - bounds.minY * scale
            )
            func map(_ p: CGPoint) -> CGPoint { CGPoint(x: p.x * scale + offset.x, y: p.y * scale + offset.y) }
            func mapRect(_ r: CGRect) -> CGRect { CGRect(origin: map(r.origin), size: CGSize(width: r.width * scale, height: r.height * scale)) }
            let line = max(1, 1.6 * min(scale, 1.4))

            for el in scene.elements {
                let stroke = el.stroke
                switch el.kind {
                case .rectangle, .ellipse, .diamond:
                    let rect = mapRect(el.frame)
                    let path: Path
                    switch el.kind {
                    case .ellipse: path = Path(ellipseIn: rect)
                    case .diamond:
                        var p = Path()
                        p.move(to: CGPoint(x: rect.midX, y: rect.minY))
                        p.addLine(to: CGPoint(x: rect.maxX, y: rect.midY))
                        p.addLine(to: CGPoint(x: rect.midX, y: rect.maxY))
                        p.addLine(to: CGPoint(x: rect.minX, y: rect.midY))
                        p.closeSubpath()
                        path = p
                    default:
                        path = Path(roundedRect: rect, cornerRadius: el.rounded ? min(rect.width, rect.height) * 0.12 : 0)
                    }
                    if let fill = el.fill { context.fill(path, with: .color(fill)) }
                    context.stroke(path, with: .color(stroke), lineWidth: line)
                    if let label = el.label, !label.isEmpty {
                        let text = Text(label).font(.system(size: max(7, el.fontSize * scale), design: .rounded)).foregroundColor(stroke)
                        context.draw(text, at: CGPoint(x: rect.midX, y: rect.midY), anchor: .center)
                    }
                case .arrow, .line:
                    guard el.points.count >= 2 else { continue }
                    let pts = el.points.map { map(CGPoint(x: el.frame.minX + $0.x, y: el.frame.minY + $0.y)) }
                    var path = Path()
                    path.move(to: pts[0])
                    for p in pts.dropFirst() { path.addLine(to: p) }
                    context.stroke(path, with: .color(stroke), style: StrokeStyle(lineWidth: line, lineCap: .round, lineJoin: .round))
                    if el.kind == .arrow, let end = pts.last, let before = pts.dropLast().last {
                        let angle = atan2(end.y - before.y, end.x - before.x)
                        let head = max(6, 10 * min(scale, 1.4))
                        var tip = Path()
                        tip.move(to: CGPoint(x: end.x - head * cos(angle - .pi / 7), y: end.y - head * sin(angle - .pi / 7)))
                        tip.addLine(to: end)
                        tip.addLine(to: CGPoint(x: end.x - head * cos(angle + .pi / 7), y: end.y - head * sin(angle + .pi / 7)))
                        context.stroke(tip, with: .color(stroke), style: StrokeStyle(lineWidth: line, lineCap: .round, lineJoin: .round))
                    }
                    if let label = el.label, !label.isEmpty {
                        let mid = pts[pts.count / 2]
                        context.draw(Text(label).font(.system(size: max(7, el.fontSize * scale), design: .rounded)).foregroundColor(stroke), at: mid)
                    }
                case .text:
                    guard let label = el.label, !label.isEmpty else { continue }
                    context.draw(
                        Text(label).font(.system(size: max(7, el.fontSize * scale), design: .rounded)).foregroundColor(stroke),
                        at: map(el.frame.origin),
                        anchor: .topLeading
                    )
                }
            }
        }
        .background(Color.white)
    }
}

/// The parts of a scene the preview draws, parsed once off the main thread.
struct ExcalidrawScene: Sendable {
    enum Kind: Sendable { case rectangle, ellipse, diamond, arrow, line, text }

    struct Element: Sendable {
        let kind: Kind
        let frame: CGRect
        let points: [CGPoint]
        let fillHex: String?
        let strokeHex: String
        let rounded: Bool
        let label: String?
        let fontSize: CGFloat

        var fill: Color? { fillHex.flatMap(Self.color) }
        var stroke: Color { Self.color(strokeHex) ?? .black }

        static func color(_ hex: String) -> Color? {
            let raw = hex.trimmingCharacters(in: .whitespaces).lowercased()
            if raw == "transparent" || !raw.hasPrefix("#") { return nil }
            var digits = String(raw.dropFirst())
            if digits.count == 3 { digits = digits.map { "\($0)\($0)" }.joined() }
            guard digits.count == 6 || digits.count == 8, let value = UInt64(digits, radix: 16) else { return nil }
            let rgb = digits.count == 8 ? value >> 8 : value
            let alpha = digits.count == 8 ? Double(value & 0xff) / 255 : 1
            return Color(
                .sRGB,
                red: Double((rgb >> 16) & 0xff) / 255,
                green: Double((rgb >> 8) & 0xff) / 255,
                blue: Double(rgb & 0xff) / 255,
                opacity: alpha
            )
        }
    }

    let elements: [Element]

    /// The box every element sits in, in scene units.
    var bounds: CGRect? {
        var box: CGRect?
        for el in elements {
            var rect = el.frame
            if !el.points.isEmpty {
                let xs = el.points.map { el.frame.minX + $0.x }
                let ys = el.points.map { el.frame.minY + $0.y }
                rect = CGRect(x: xs.min()!, y: ys.min()!, width: xs.max()! - xs.min()!, height: ys.max()! - ys.min()!)
            } else if el.kind == .text {
                rect.size = CGSize(width: max(rect.width, CGFloat(el.label?.count ?? 1) * el.fontSize * 0.55), height: max(rect.height, el.fontSize * 1.3))
            }
            box = box.map { $0.union(rect) } ?? rect
        }
        return box
    }

    /// A scene from .excalidraw file bytes, or nil when they are not one.
    init?(data: Data) {
        guard let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let raw = root["elements"] as? [[String: Any]] else { return nil }
        func num(_ any: Any?) -> CGFloat? { (any as? NSNumber).map { CGFloat(truncating: $0) } }
        var parsed: [Element] = []
        for el in raw {
            if el["isDeleted"] as? Bool == true { continue }
            let kind: Kind
            switch el["type"] as? String {
            case "rectangle": kind = .rectangle
            case "ellipse": kind = .ellipse
            case "diamond": kind = .diamond
            case "arrow": kind = .arrow
            case "line": kind = .line
            case "text": kind = .text
            default: continue
            }
            let label = (el["label"] as? [String: Any])?["text"] as? String ?? el["text"] as? String
            let labelSize = num((el["label"] as? [String: Any])?["fontSize"]) ?? num(el["fontSize"]) ?? 20
            let points = (el["points"] as? [[Any]])?.compactMap { pair -> CGPoint? in
                guard pair.count >= 2, let x = num(pair[0]), let y = num(pair[1]) else { return nil }
                return CGPoint(x: x, y: y)
            } ?? []
            parsed.append(Element(
                kind: kind,
                frame: CGRect(x: num(el["x"]) ?? 0, y: num(el["y"]) ?? 0, width: num(el["width"]) ?? 0, height: num(el["height"]) ?? 0),
                points: points,
                fillHex: el["backgroundColor"] as? String,
                strokeHex: el["strokeColor"] as? String ?? "#1e1e1e",
                rounded: el["roundness"] != nil && !(el["roundness"] is NSNull),
                label: label,
                fontSize: labelSize
            ))
        }
        guard !parsed.isEmpty else { return nil }
        elements = parsed
    }
}

/// Parsed scenes by path, so a grid of drawings reads each file once.
actor ExcalidrawScenes {
    static let shared = ExcalidrawScenes()
    private var scenes: [String: (stamp: Double, scene: ExcalidrawScene)] = [:]

    /// Keyed by path and modification time, so a file saved back in place is
    /// read again; a small cap keeps a big Library from holding every scene.
    func scene(path: String) -> ExcalidrawScene? {
        let stamp = (try? FileManager.default.attributesOfItem(atPath: path)[.modificationDate] as? Date)?.timeIntervalSince1970 ?? 0
        if let hit = scenes[path], hit.stamp == stamp { return hit.scene }
        guard let data = FileManager.default.contents(atPath: path), let scene = ExcalidrawScene(data: data) else { return nil }
        if scenes.count >= 64 { scenes.removeAll() }
        scenes[path] = (stamp, scene)
        return scene
    }
}
