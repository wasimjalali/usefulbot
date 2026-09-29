import AppKit
import QuartzCore
MainActor.assumeIsolated {
let app = NSApplication.shared
app.setActivationPolicy(.prohibited)
let window = NSWindow(contentRect: NSRect(x: -3000, y: -3000, width: 100, height: 100), styleMask: [.borderless], backing: .buffered, defer: false)
let face = BotFaceNSView(frame: NSRect(x: 0, y: 0, width: 36, height: 36))
window.contentView = NSView(frame: NSRect(x: 0, y: 0, width: 100, height: 100))
window.contentView!.addSubview(face)
window.orderFrontRegardless()
face.setTint(BotFaceArt.tint("gray"))
face.layout()
var log: [String] = []
func sample(_ tag: String) {
    guard let canvas = face.layer?.sublayers?.first, let body = canvas.sublayers?.first,
          let eyes = body.sublayers?.last else { return }
    let b = body.presentation()?.transform ?? body.transform
    let e = eyes.presentation()?.transform ?? eyes.transform
    let eye = eyes.sublayers!.first!.presentation()?.transform ?? eyes.sublayers!.first!.transform
    log.append(String(format: "%@ eyes %.3f %.3f body %.3f turn %.4f sx %.3f sy %.3f blink %.3f", tag, e.m41, e.m42, b.m42, atan2(b.m12, b.m11), b.m11, b.m22, eye.m22))
}
let script: [(Double, BotFacePose)] = [(0, .thinking), (1.0, .idle)]
let start = Date()
for (at, pose) in script {
    Timer.scheduledTimer(withTimeInterval: at, repeats: false) { _ in MainActor.assumeIsolated { face.apply(pose: pose, reduceMotion: false); log.append("-- \(pose)") } }
}
Timer.scheduledTimer(withTimeInterval: 1.0 / 60, repeats: true) { _ in MainActor.assumeIsolated { sample(String(format: "%.3f", Date().timeIntervalSince(start))) } }
Timer.scheduledTimer(withTimeInterval: 1.5, repeats: false) { _ in MainActor.assumeIsolated { face.hop(); log.append("-- hop") } }
Timer.scheduledTimer(withTimeInterval: 2.8, repeats: false) { _ in MainActor.assumeIsolated { face.apply(pose: .thinking, reduceMotion: true); log.append("-- reduced thinking") } }
Timer.scheduledTimer(withTimeInterval: 3.4, repeats: false) { _ in MainActor.assumeIsolated { face.hop(); log.append("-- reduced hop") } }
Timer.scheduledTimer(withTimeInterval: 4.5, repeats: false) { _ in MainActor.assumeIsolated { print(log.joined(separator: "\n")); exit(0) } }
app.run()
}
