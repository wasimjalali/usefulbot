import AppKit
import QuartzCore
import UsefulBotCore

/// The bot face from brand/source/avatar-face.svg, as paths built once.
@MainActor
enum BotFaceArt {
    static let geometry: BotFaceGeometry = {
        let url = BrandAssets.root.appendingPathComponent("source/avatar-face.svg")
        do { return try BotFaceGeometry(svg: Data(contentsOf: url)) }
        catch { preconditionFailure("Cannot load the bot face: \(error)") }
    }()

    static let ink = CGColor(srgbRed: 0x14 / 255.0, green: 0x14 / 255.0, blue: 0x13 / 255.0, alpha: 1)
    static let head: CGPath = {
        let g = geometry, r = g.headRadius
        return CGPath(ellipseIn: CGRect(x: g.headCenter.x - r, y: g.headCenter.y - r, width: 2 * r, height: 2 * r), transform: nil)
    }()
    static let glasses = path(geometry.glasses)
    static let mouth = path(geometry.mouth)
    static let tongue = path(geometry.tongue)
    static let tongueColor = color(geometry.tongueColor)

    static func ball(_ eye: BotFaceGeometry.Eye) -> CGPath {
        let e = eye.ball
        return CGPath(ellipseIn: CGRect(x: e.center.x - e.rx, y: e.center.y - e.ry, width: 2 * e.rx, height: 2 * e.ry), transform: nil)
    }

    static func tint(_ colorId: String) -> CGColor {
        guard let fill = BrandAssets.palette[colorId]?.fill else {
            preconditionFailure("Unknown avatar color \(colorId)")
        }
        return color(fill)
    }

    static func path(_ segments: [BotFaceGeometry.Segment]) -> CGPath {
        let path = CGMutablePath()
        func p(_ point: BotFaceGeometry.Point) -> CGPoint { CGPoint(x: point.x, y: point.y) }
        for segment in segments {
            switch segment {
            case .move(let a): path.move(to: p(a))
            case .line(let a): path.addLine(to: p(a))
            case .quad(let c, let a): path.addQuadCurve(to: p(a), control: p(c))
            case .cubic(let c1, let c2, let a): path.addCurve(to: p(a), control1: p(c1), control2: p(c2))
            case .close: path.closeSubpath()
            }
        }
        return path
    }

    static func color(_ hex: String) -> CGColor {
        guard hex.count == 7, hex.hasPrefix("#"), let value = UInt32(hex.dropFirst(), radix: 16) else {
            preconditionFailure("Bad face color \(hex)")
        }
        return CGColor(
            srgbRed: CGFloat((value >> 16) & 0xFF) / 255,
            green: CGFloat((value >> 8) & 0xFF) / 255,
            blue: CGFloat(value & 0xFF) / 255,
            alpha: 1
        )
    }

    /// Draws the still face into a context whose user space is the SVG's
    /// (y down), with a 1 pt edge at `size` points.
    static func draw(in context: CGContext, tint: CGColor, size: CGFloat) {
        let g = geometry
        context.addPath(head)
        context.setFillColor(tint)
        context.fillPath()
        context.addPath(head)
        context.setStrokeColor(ink.copy(alpha: g.edgeOpacity) ?? ink)
        context.setLineWidth(g.viewBox.width / size)
        context.strokePath()
        context.setFillColor(ink)
        context.addPath(glasses)
        context.fillPath(using: .evenOdd)
        context.addPath(mouth)
        context.fillPath()
        context.addPath(mouth)
        context.setStrokeColor(ink)
        context.setLineWidth(g.mouthStrokeWidth)
        context.setLineJoin(.round)
        context.strokePath()
        context.addPath(tongue)
        context.setFillColor(tongueColor)
        context.fillPath()
        for eye in [g.leftEye, g.rightEye] {
            context.addPath(ball(eye))
            context.setFillColor(ink)
            context.fillPath()
            context.addPath(path(eye.highlight))
            context.setStrokeColor(CGColor(gray: 1, alpha: 1))
            context.setLineWidth(eye.highlightWidth)
            context.setLineCap(.round)
            context.strokePath()
        }
    }

    private static var stills: [String: NSImage] = [:]

    /// A still face as a bitmap at 2x, drawn once per tint and size. Chat
    /// rows and pickers show many faces, so they get an image, not layers.
    static func still(_ colorId: String, size: CGFloat) -> NSImage {
        let key = "\(colorId)@\(size)"
        if let image = stills[key] { return image }
        let pixels = Int((size * 2).rounded(.up))
        guard pixels > 0,
              let space = CGColorSpace(name: CGColorSpace.sRGB),
              let context = CGContext(data: nil, width: pixels, height: pixels, bitsPerComponent: 8, bytesPerRow: 0,
                                      space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
        else { preconditionFailure("Cannot draw a \(size) pt bot face") }
        let box = geometry.viewBox
        let scale = CGFloat(pixels) / box.width
        // Flip to the SVG's y-down space.
        context.translateBy(x: 0, y: CGFloat(pixels))
        context.scaleBy(x: scale, y: -scale)
        context.translateBy(x: -box.x, y: -box.y)
        draw(in: context, tint: tint(colorId), size: size)
        guard let cg = context.makeImage() else { preconditionFailure("Cannot draw a \(size) pt bot face") }
        let image = NSImage(cgImage: cg, size: NSSize(width: size, height: size))
        stills[key] = image
        return image
    }
}

/// A face that can move: vector layers, animated by Core Animation so the
/// loops run on the render server at the display's rate. Every layer is
/// sized in points and its path scaled to fit: a layer drawn big and scaled
/// down would still be backed at its big size.
final class BotFaceNSView: NSView {
    private let canvas = CALayer()
    private let body = CALayer()
    private let headLayer = CAShapeLayer()
    private let glasses = CAShapeLayer()
    private let mouth = CAShapeLayer()
    private let tongue = CAShapeLayer()
    private let eyes = CALayer()
    private let eyeLayers = [CALayer(), CALayer()]
    private let balls = [CAShapeLayer(), CAShapeLayer()]
    private let shines = [CAShapeLayer(), CAShapeLayer()]

    private(set) var pose: BotFacePose = .idle
    private var reduceMotion = false
    private var configured = false
    /// Points per face unit at the current size; 0 until laid out.
    private var unit: CGFloat = 0

    override init(frame: NSRect) {
        super.init(frame: frame)
        let root = CALayer()
        layer = root
        wantsLayer = true
        canvas.isGeometryFlipped = true
        headLayer.strokeColor = BotFaceArt.ink.copy(alpha: BotFaceArt.geometry.edgeOpacity)
        glasses.fillColor = BotFaceArt.ink
        glasses.fillRule = .evenOdd
        mouth.fillColor = BotFaceArt.ink
        mouth.strokeColor = BotFaceArt.ink
        mouth.lineJoin = .round
        tongue.fillColor = BotFaceArt.tongueColor
        for (eye, (ball, shine)) in zip(eyeLayers, zip(balls, shines)) {
            ball.fillColor = BotFaceArt.ink
            shine.fillColor = nil
            shine.strokeColor = CGColor(gray: 1, alpha: 1)
            shine.lineCap = .round
            eye.addSublayer(ball)
            eye.addSublayer(shine)
            eyes.addSublayer(eye)
        }
        for part in [headLayer, glasses, mouth, tongue, eyes] { body.addSublayer(part) }
        canvas.addSublayer(body)
        root.addSublayer(canvas)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    override func setFrameSize(_ newSize: NSSize) {
        super.setFrameSize(newSize)
        needsLayout = true
    }

    override func layout() {
        super.layout()
        let side = min(bounds.width, bounds.height)
        guard side > 0 else { return }
        let g = BotFaceArt.geometry, box = g.viewBox
        let k = side / box.width
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        canvas.frame = CGRect(x: (bounds.width - side) / 2, y: (bounds.height - side) / 2, width: side, height: side)
        guard k != unit else { CATransaction.commit(); return }
        unit = k
        var t = CGAffineTransform(scaleX: k, y: k).translatedBy(x: -box.x, y: -box.y)
        func point(_ p: BotFaceGeometry.Point) -> CGPoint { CGPoint(x: (p.x - box.x) * k, y: (p.y - box.y) * k) }
        let full = CGRect(x: 0, y: 0, width: side, height: side)
        func place(_ layer: CALayer, anchor: CGPoint? = nil) {
            layer.bounds = full
            let a = anchor ?? CGPoint(x: side / 2, y: side / 2)
            layer.anchorPoint = CGPoint(x: a.x / side, y: a.y / side)
            layer.position = a
        }
        // Tilts and hops turn on the bottom of the head.
        place(body, anchor: point(BotFaceGeometry.Point(g.headCenter.x, g.headCenter.y + g.headRadius)))
        for layer in [headLayer, glasses, mouth, tongue, eyes] as [CALayer] { place(layer) }
        headLayer.path = BotFaceArt.head.copy(using: &t)
        headLayer.lineWidth = 1
        glasses.path = BotFaceArt.glasses.copy(using: &t)
        mouth.path = BotFaceArt.mouth.copy(using: &t)
        mouth.lineWidth = g.mouthStrokeWidth * k
        tongue.path = BotFaceArt.tongue.copy(using: &t)
        for (index, eye) in [g.leftEye, g.rightEye].enumerated() {
            // Blinks squash each eye about its own centre.
            place(eyeLayers[index], anchor: point(eye.ball.center))
            place(balls[index])
            place(shines[index])
            balls[index].path = BotFaceArt.ball(eye).copy(using: &t)
            shines[index].path = BotFaceArt.path(eye.highlight).copy(using: &t)
            shines[index].lineWidth = eye.highlightWidth * k
        }
        CATransaction.commit()
        // Loop offsets are in points, so the first size and every new one
        // (re)start the loop.
        reinstall()
    }

    override func viewDidChangeBackingProperties() {
        super.viewDidChangeBackingProperties()
        let scale = window?.backingScaleFactor ?? 2
        func walk(_ layer: CALayer) {
            layer.contentsScale = scale
            layer.sublayers?.forEach(walk)
        }
        walk(canvas)
    }

    func setTint(_ color: CGColor) {
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        headLayer.fillColor = color
        CATransaction.commit()
    }

    private func reinstall() {
        let current = pose
        configured = false
        apply(pose: current, reduceMotion: reduceMotion)
    }

    /// Switches the loop, easing the eyes and head from where they are now
    /// into the new pose so a change of activity never jumps.
    func apply(pose next: BotFacePose, reduceMotion reduce: Bool) {
        guard !configured || next != pose || reduce != reduceMotion else { return }
        // Before layout there is no size to move in; layout installs it.
        guard unit > 0 else { pose = next; reduceMotion = reduce; return }
        // Where the face is on screen right now, read off the live matrices.
        let eyesNow = eyes.presentation()?.transform ?? eyes.transform
        let bodyNow = body.presentation()?.transform ?? body.transform
        let from = (
            eyesX: eyesNow.m41,
            eyesY: eyesNow.m42,
            bodyY: bodyNow.m42,
            turn: atan2(bodyNow.m12, bodyNow.m11)
        )
        let blend = configured && !reduce
        // A hop still in flight is already on the body; blending from it
        // would lift the head twice.
        let hopping = body.animationKeys()?.contains { $0.hasPrefix("hop.") } ?? false
        configured = true
        pose = next
        reduceMotion = reduce
        for layer in [body, eyes] + eyeLayers {
            // Reduce motion also stops a hop that is playing.
            for key in layer.animationKeys() ?? []
            where key.hasPrefix("pose.") || key.hasPrefix("blend.") || (reduce && key.hasPrefix("hop.")) {
                layer.removeAnimation(forKey: key)
            }
        }
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        body.transform = CATransform3DIdentity
        if reduce {
            let still = BotFaceMotion.stillEyes(for: next)
            eyes.transform = CATransform3DMakeTranslation(still.x * unit, still.y * unit, 0)
            CATransaction.commit()
            return
        }
        eyes.transform = CATransform3DIdentity
        CATransaction.commit()

        let tracks = BotFaceMotion.tracks(for: next)
        for (index, track) in tracks.enumerated() {
            let animation = Self.animation(track, repeating: true, unit: unit)
            target(track.part).forEach { $0.add(animation, forKey: "pose.\(index)") }
        }
        guard blend else { return }
        func start(_ part: BotFaceMotion.Part, _ property: BotFaceMotion.Property) -> CGFloat {
            CGFloat(tracks.first { $0.part == part && $0.property == property }?.values.first ?? 0) * unit
        }
        let blends: [(CALayer, String, CGFloat)] = [
            (eyes, "transform.translation.x", from.eyesX - start(.eyes, .translateX)),
            (eyes, "transform.translation.y", from.eyesY - start(.eyes, .translateY)),
            (body, "transform.translation.y", hopping ? 0 : from.bodyY - start(.body, .translateY)),
            // Turns are in radians, not scaled by the face's size.
            // The hop never turns the head, so a tilt always eases.
            (body, "transform.rotation.z", from.turn - (unit > 0 ? start(.body, .rotation) / unit : 0)),
        ]
        for (layer, keyPath, offset) in blends where abs(offset) > 0.001 {
            let animation = CABasicAnimation(keyPath: keyPath)
            animation.fromValue = offset
            animation.toValue = 0
            animation.isAdditive = true
            animation.duration = 0.25
            animation.timingFunction = CAMediaTimingFunction(name: .easeOut)
            layer.add(animation, forKey: "blend.\(keyPath)")
        }
    }

    /// One hop. Skipped when motion is reduced.
    func hop() {
        guard !reduceMotion, unit > 0 else { return }
        for (index, track) in BotFaceMotion.hop.enumerated() {
            let animation = Self.animation(track, repeating: false, unit: unit)
            target(track.part).forEach { $0.add(animation, forKey: "hop.\(index)") }
        }
    }

    private func target(_ part: BotFaceMotion.Part) -> [CALayer] {
        switch part {
        case .body: return [body]
        case .eyes: return [eyes]
        case .eye: return eyeLayers
        }
    }

    private static func animation(_ track: BotFaceMotion.Track, repeating: Bool, unit: CGFloat) -> CAKeyframeAnimation {
        let keyPath: String
        switch track.property {
        case .translateX: keyPath = "transform.translation.x"
        case .translateY: keyPath = "transform.translation.y"
        case .rotation: keyPath = "transform.rotation.z"
        case .scaleX: keyPath = "transform.scale.x"
        case .scaleY: keyPath = "transform.scale.y"
        }
        // Moves and turns are additive offsets from rest, so a hop can play on
        // top of a loop. Scales are absolute: an additive scale adds its value
        // to the resting 1, which drew every eye at double height.
        let animation = CAKeyframeAnimation(keyPath: keyPath)
        let moves = track.property == .translateX || track.property == .translateY
        animation.values = track.values.map { moves ? $0 * unit : $0 }
        animation.keyTimes = track.keyTimes.map { NSNumber(value: $0) }
        animation.timingFunctions = Array(repeating: CAMediaTimingFunction(name: .easeInEaseOut), count: max(1, track.values.count - 1))
        animation.duration = track.duration
        animation.isAdditive = track.property != .scaleX && track.property != .scaleY
        animation.repeatCount = repeating ? .infinity : 1
        animation.isRemovedOnCompletion = !repeating
        animation.fillMode = .removed
        return animation
    }
}

