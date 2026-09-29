import Foundation

/// The bot face, read from brand/source/avatar-face.svg so the native heads
/// and the exported avatars are one drawing. Only the shapes that file uses
/// are understood; anything else fails loudly instead of drawing wrong.
public struct BotFaceGeometry: Equatable, Sendable {
    public struct Point: Equatable, Sendable {
        public var x: Double
        public var y: Double
        public init(_ x: Double, _ y: Double) { self.x = x; self.y = y }
    }

    /// Absolute path segments, y down in the SVG's user space.
    public enum Segment: Equatable, Sendable {
        case move(Point)
        case line(Point)
        case quad(Point, Point)
        case cubic(Point, Point, Point)
        case close
    }

    public struct Ellipse: Equatable, Sendable {
        public var center: Point
        public var rx: Double
        public var ry: Double
    }

    public struct Eye: Equatable, Sendable {
        public var ball: Ellipse
        public var highlight: [Segment]
        public var highlightWidth: Double
    }

    public var viewBox: (x: Double, y: Double, width: Double, height: Double) { (vbX, vbY, vbW, vbH) }
    public var headCenter: Point
    public var headRadius: Double
    /// Alpha of the head's hairline edge (the file's stroke-opacity).
    public var edgeOpacity: Double
    public var glasses: [Segment]
    public var mouth: [Segment]
    public var mouthStrokeWidth: Double
    public var tongue: [Segment]
    /// "#RRGGBB"
    public var tongueColor: String
    public var leftEye: Eye
    public var rightEye: Eye

    private var vbX: Double, vbY: Double, vbW: Double, vbH: Double

    public struct Invalid: Error, CustomStringConvertible {
        public let description: String
    }

    public init(svg: Data) throws {
        let reader = Reader()
        let parser = XMLParser(data: svg)
        parser.delegate = reader
        guard parser.parse() else {
            throw Invalid(description: "avatar-face.svg is not valid XML: \(parser.parserError?.localizedDescription ?? "unknown")")
        }
        func one(_ group: String, _ tag: String, id: String? = nil, notId: String? = nil) throws -> [String: String] {
            let found = reader.elements.filter {
                $0.groups.contains(group) && $0.tag == tag
                    && (id == nil || $0.attributes["id"] == id)
                    && (notId == nil || $0.attributes["id"] != notId)
            }
            guard found.count == 1 else {
                throw Invalid(description: "avatar-face.svg: expected one <\(tag)> in #\(group), found \(found.count)")
            }
            return found[0].attributes
        }
        func number(_ attributes: [String: String], _ key: String) throws -> Double {
            guard let raw = attributes[key], let value = Double(raw), value.isFinite else {
                throw Invalid(description: "avatar-face.svg: missing or bad \(key)")
            }
            return value
        }
        func path(_ attributes: [String: String]) throws -> [Segment] {
            guard let d = attributes["d"] else { throw Invalid(description: "avatar-face.svg: path without d") }
            return try Self.parsePath(d)
        }
        func eye(_ group: String) throws -> Eye {
            let ball = try one(group, "ellipse")
            let shine = try one(group, "path")
            return Eye(
                ball: Ellipse(center: Point(try number(ball, "cx"), try number(ball, "cy")),
                              rx: try number(ball, "rx"), ry: try number(ball, "ry")),
                highlight: try path(shine),
                highlightWidth: try number(shine, "stroke-width")
            )
        }

        let box = (reader.viewBox ?? "").split(whereSeparator: { $0 == " " || $0 == "," }).compactMap { Double($0) }
        guard box.count == 4, box[2] > 0, box[3] > 0 else { throw Invalid(description: "avatar-face.svg: bad viewBox") }
        (vbX, vbY, vbW, vbH) = (box[0], box[1], box[2], box[3])

        let head = try one("head", "circle")
        headCenter = Point(try number(head, "cx"), try number(head, "cy"))
        headRadius = try number(head, "r")
        edgeOpacity = try number(head, "stroke-opacity")
        glasses = try path(try one("glasses", "path"))
        let mouthShape = try one("mouth", "path", notId: "tongue")
        mouth = try path(mouthShape)
        mouthStrokeWidth = try number(mouthShape, "stroke-width")
        let tongueShape = try one("mouth", "path", id: "tongue")
        tongue = try path(tongueShape)
        guard let fill = tongueShape["fill"], fill.count == 7, fill.hasPrefix("#"),
              UInt32(fill.dropFirst(), radix: 16) != nil else {
            throw Invalid(description: "avatar-face.svg: tongue needs a #RRGGBB fill")
        }
        tongueColor = fill
        leftEye = try eye("eye-left")
        rightEye = try eye("eye-right")
    }

    public static func == (a: Self, b: Self) -> Bool {
        a.vbX == b.vbX && a.vbY == b.vbY && a.vbW == b.vbW && a.vbH == b.vbH
            && a.headCenter == b.headCenter && a.headRadius == b.headRadius && a.edgeOpacity == b.edgeOpacity
            && a.glasses == b.glasses && a.mouth == b.mouth && a.mouthStrokeWidth == b.mouthStrokeWidth
            && a.tongue == b.tongue && a.tongueColor == b.tongueColor
            && a.leftEye == b.leftEye && a.rightEye == b.rightEye
    }

    // MARK: - Path data

    /// Parses SVG path data into absolute segments. Supports M L H V C S Q Z
    /// in both cases; arcs and T are refused.
    public static func parsePath(_ d: String) throws -> [Segment] {
        var tokens: [Token] = []
        var index = d.startIndex
        while index < d.endIndex {
            let char = d[index]
            if char.isLetter {
                tokens.append(.command(char))
                index = d.index(after: index)
            } else if char.isWhitespace || char == "," {
                index = d.index(after: index)
            } else {
                var end = index
                var seenDot = false, seenExp = false
                if d[end] == "-" || d[end] == "+" { end = d.index(after: end) }
                while end < d.endIndex {
                    let c = d[end]
                    if c.isNumber { end = d.index(after: end); continue }
                    if c == ".", !seenDot, !seenExp { seenDot = true; end = d.index(after: end); continue }
                    if (c == "e" || c == "E"), !seenExp {
                        seenExp = true
                        end = d.index(after: end)
                        if end < d.endIndex, d[end] == "-" || d[end] == "+" { end = d.index(after: end) }
                        continue
                    }
                    break
                }
                guard end > index, let value = Double(d[index..<end]), value.isFinite else {
                    throw Invalid(description: "Bad path number near \(d[index...].prefix(12))")
                }
                tokens.append(.number(value))
                index = end
            }
        }

        var segments: [Segment] = []
        var current = Point(0, 0), start = Point(0, 0)
        var lastControl: Point?
        var command: Character?
        var i = 0
        func take() throws -> Double {
            guard i < tokens.count, case .number(let value) = tokens[i] else {
                throw Invalid(description: "Path data ends early after \(command.map(String.init) ?? "start")")
            }
            i += 1
            return value
        }
        while i < tokens.count {
            if case .command(let c) = tokens[i] { command = c; i += 1 }
            guard let cmd = command else { throw Invalid(description: "Path data starts without a command") }
            let relative = cmd.isLowercase
            func point() throws -> Point {
                let x = try take(), y = try take()
                return relative ? Point(current.x + x, current.y + y) : Point(x, y)
            }
            switch cmd.uppercased().first! {
            case "M":
                current = try point(); start = current
                segments.append(.move(current))
                lastControl = nil
                command = relative ? "l" : "L" // Extra pairs after M are lines.
            case "L":
                current = try point()
                segments.append(.line(current)); lastControl = nil
            case "H":
                let x = try take()
                current = Point(relative ? current.x + x : x, current.y)
                segments.append(.line(current)); lastControl = nil
            case "V":
                let y = try take()
                current = Point(current.x, relative ? current.y + y : y)
                segments.append(.line(current)); lastControl = nil
            case "C":
                let c1 = try point(), c2 = try point(), end = try point()
                segments.append(.cubic(c1, c2, end))
                lastControl = c2; current = end
            case "S":
                let c1 = lastControl.map { Point(2 * current.x - $0.x, 2 * current.y - $0.y) } ?? current
                let c2 = try point(), end = try point()
                segments.append(.cubic(c1, c2, end))
                lastControl = c2; current = end
            case "Q":
                let c = try point(), end = try point()
                segments.append(.quad(c, end))
                lastControl = nil; current = end
            case "Z":
                segments.append(.close)
                current = start; lastControl = nil
                command = nil
                // A number straight after Z has no command to belong to.
                if i < tokens.count, case .number = tokens[i] {
                    throw Invalid(description: "Number after Z in path data")
                }
            default:
                throw Invalid(description: "Unsupported path command \(cmd)")
            }
        }
        return segments
    }

    private enum Token { case command(Character), number(Double) }

    private final class Reader: NSObject, XMLParserDelegate {
        struct Element { let groups: [String]; let tag: String; let attributes: [String: String] }
        var elements: [Element] = []
        var viewBox: String?
        private var groups: [String] = []

        func parser(_ parser: XMLParser, didStartElement name: String, namespaceURI: String?,
                    qualifiedName: String?, attributes: [String: String] = [:]) {
            if name == "svg" { viewBox = attributes["viewBox"] }
            if name == "g" {
                groups.append(attributes["id"] ?? "")
            } else {
                elements.append(Element(groups: groups, tag: name, attributes: attributes))
            }
        }

        func parser(_ parser: XMLParser, didEndElement name: String, namespaceURI: String?, qualifiedName: String?) {
            if name == "g" { groups.removeLast() }
        }
    }
}
