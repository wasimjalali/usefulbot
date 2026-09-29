// Draws the DMG window's background: the Useful canvas, a quiet arrow from
// the app to Applications and one line of instruction. scripts/release-mac.mjs
// runs it at 1x and 2x (dmgbuild combines background.png and background@2x.png
// into one HiDPI image), so the picture always matches the layout in
// macos/dmg/settings.py.
//
//   swift macos/dmg/background.swift <out.png> <scale> <Inter-SemiBold.ttf>
import CoreGraphics
import CoreText
import Foundation
import ImageIO
import UniformTypeIdentifiers

// Keep in step with settings.py: window width and the two icon centres. The
// picture runs taller than the window's content (about 400 points under the
// title bar), so a taller title bar or a rounding in Finder never shows an
// unpainted strip at the bottom.
let width: CGFloat = 660
let height: CGFloat = 440
let appCenter = CGPoint(x: 170, y: 180)
let applicationsCenter = CGPoint(x: 490, y: 180)
let iconSize: CGFloat = 128

let args = CommandLine.arguments
guard args.count == 4, let scale = Double(args[2]), scale >= 1 else {
    FileHandle.standardError.write("usage: background.swift <out.png> <scale> <font.ttf>\n".data(using: .utf8)!)
    exit(2)
}
let fontURL = URL(fileURLWithPath: args[3])
var registerError: Unmanaged<CFError>?
guard CTFontManagerRegisterFontsForURL(fontURL as CFURL, .process, &registerError) else {
    FileHandle.standardError.write("cannot load \(fontURL.path)\n".data(using: .utf8)!)
    exit(1)
}

func rgb(_ hex: UInt32) -> CGColor {
    CGColor(
        srgbRed: CGFloat((hex >> 16) & 0xff) / 255,
        green: CGFloat((hex >> 8) & 0xff) / 255,
        blue: CGFloat(hex & 0xff) / 255,
        alpha: 1
    )
}

let pixelsWide = Int(width * scale)
let pixelsHigh = Int(height * scale)
guard let context = CGContext(
    data: nil, width: pixelsWide, height: pixelsHigh, bitsPerComponent: 8, bytesPerRow: 0,
    space: CGColorSpace(name: CGColorSpace.sRGB)!,
    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
) else { exit(1) }
// Finder places icons from the top left; draw in the same coordinates.
context.scaleBy(x: scale, y: scale)
context.translateBy(x: 0, y: height)
context.scaleBy(x: 1, y: -1)

// brand/tokens.css --ub-surface-shade.
context.setFillColor(rgb(0xF5F5F5))
context.fill(CGRect(x: 0, y: 0, width: width, height: height))

// The arrow sits in the gap between the two icons, clear of both.
let gap: CGFloat = 36
let startX = appCenter.x + iconSize / 2 + gap
let endX = applicationsCenter.x - iconSize / 2 - gap
let y = appCenter.y
context.setStrokeColor(rgb(0xA3A3A3))
context.setLineWidth(2)
context.setLineCap(.round)
context.setLineJoin(.round)
context.move(to: CGPoint(x: startX, y: y))
context.addLine(to: CGPoint(x: endX, y: y))
context.move(to: CGPoint(x: endX - 9, y: y - 9))
context.addLine(to: CGPoint(x: endX, y: y))
context.addLine(to: CGPoint(x: endX - 9, y: y + 9))
context.strokePath()

// One line under the icon labels, centred.
let font = CTFontCreateWithName("Inter-SemiBold" as CFString, 13, nil)
guard (CTFontCopyPostScriptName(font) as String) == "Inter-SemiBold" else {
    FileHandle.standardError.write("Inter-SemiBold did not load\n".data(using: .utf8)!)
    exit(1)
}
let text = NSAttributedString(string: "Drag Useful Bot to Applications", attributes: [
    NSAttributedString.Key(kCTFontAttributeName as String): font,
    NSAttributedString.Key(kCTForegroundColorAttributeName as String): rgb(0x5C5C5C),
])
let line = CTLineCreateWithAttributedString(text)
let bounds = CTLineGetBoundsWithOptions(line, .useOpticalBounds)
context.saveGState()
// Text draws upright only in an unflipped space.
context.translateBy(x: (width - bounds.width) / 2 - bounds.minX, y: 330)
context.scaleBy(x: 1, y: -1)
context.textPosition = .zero
CTLineDraw(line, context)
context.restoreGState()

guard let image = context.makeImage(),
      let dest = CGImageDestinationCreateWithURL(URL(fileURLWithPath: args[1]) as CFURL, UTType.png.identifier as CFString, 1, nil)
else { exit(1) }
// The DPI tells Finder the 2x image is the same size in points.
CGImageDestinationAddImage(dest, image, [
    kCGImagePropertyDPIWidth: 72 * scale,
    kCGImagePropertyDPIHeight: 72 * scale,
] as CFDictionary)
guard CGImageDestinationFinalize(dest) else { exit(1) }
