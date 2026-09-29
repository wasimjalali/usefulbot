// perfrec --pid N --title T --seconds S --out DIR [--min-height H] [--fps 60] [--scale 0.5]
//         [--crop left,top,right,bottom]
//
// Records one window of a process in the background, even when other windows
// cover it, and waits up to 30 s for the window to appear (a cold launch).
//
// Writes, per complete frame:
// - DIR/frames/f<n>_<t>.jpg, the picture;
// - a line "n,t,score" in DIR/scores.csv, where score is the mean absolute
//   grey-level change against the previous frame inside the crop (points cut
//   off each edge), averaged over a 200x150 grid.
// t is the frame's presentation time in CLOCK_UPTIME_RAW nanoseconds: the clock
// the app's perf marks use, so frames and marks line up without conversion.
// An idle window delivers no complete frames, so it writes nothing.
// Prints "recording <windowId> <width> <height>" once capture runs.
import AppKit
import CoreImage
import CoreMedia
import Foundation
import ScreenCaptureKit

_ = NSApplication.shared
var options: [String: String] = [:]
var index = 1
let argv = CommandLine.arguments
while index + 1 < argv.count, argv[index].hasPrefix("--") {
    options[String(argv[index].dropFirst(2))] = argv[index + 1]
    index += 2
}
func fail(_ message: String) -> Never {
    FileHandle.standardError.write("perfrec: \(message)\n".data(using: .utf8)!)
    exit(2)
}
guard let pid = options["pid"].flatMap(Int32.init) else { fail("--pid is required") }
guard let title = options["title"] else { fail("--title is required") }
guard let seconds = options["seconds"].flatMap(Double.init) else { fail("--seconds is required") }
guard let out = options["out"] else { fail("--out is required") }
let minHeight = options["min-height"].flatMap(Double.init) ?? 400
let fps = options["fps"].flatMap(Int32.init) ?? 60
let scale = options["scale"].flatMap(Double.init) ?? 0.5
let crop = (options["crop"] ?? "0,0,0,0").split(separator: ",").compactMap { Double($0) }
guard crop.count == 4 else { fail("--crop takes left,top,right,bottom") }

let outDir = URL(fileURLWithPath: out)
let framesDir = outDir.appendingPathComponent("frames")
try? FileManager.default.createDirectory(at: framesDir, withIntermediateDirectories: true)
FileManager.default.createFile(atPath: outDir.appendingPathComponent("scores.csv").path, contents: nil)
guard let scores = FileHandle(forWritingAtPath: outDir.appendingPathComponent("scores.csv").path) else {
    fail("cannot write scores.csv")
}

final class Sink: NSObject, SCStreamOutput {
    static let gridW = 200, gridH = 150
    let dir: URL
    let scores: FileHandle
    let crop: [Double]
    let scale: Double
    var n = 0
    var previous: [Float]?
    let ctx = CIContext()
    init(dir: URL, scores: FileHandle, crop: [Double], scale: Double) {
        self.dir = dir
        self.scores = scores
        self.crop = crop
        self.scale = scale
    }

    /// Mean grey level of each grid cell inside the crop.
    func grid(_ px: CVPixelBuffer) -> [Float] {
        CVPixelBufferLockBaseAddress(px, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(px, .readOnly) }
        let width = CVPixelBufferGetWidth(px), height = CVPixelBufferGetHeight(px)
        let stride = CVPixelBufferGetBytesPerRow(px)
        let base = CVPixelBufferGetBaseAddress(px)!.assumingMemoryBound(to: UInt8.self)
        let x0 = min(width - 1, Int(crop[0] * scale)), y0 = min(height - 1, Int(crop[1] * scale))
        let x1 = max(x0 + 1, width - Int(crop[2] * scale)), y1 = max(y0 + 1, height - Int(crop[3] * scale))
        var sums = [Float](repeating: 0, count: Self.gridW * Self.gridH)
        var counts = [Float](repeating: 0, count: Self.gridW * Self.gridH)
        for y in y0..<y1 {
            let gy = (y - y0) * Self.gridH / (y1 - y0)
            let row = base + y * stride
            for x in x0..<x1 {
                let gx = (x - x0) * Self.gridW / (x1 - x0)
                let p = row + x * 4  // BGRA
                let grey = 0.114 * Float(p[0]) + 0.587 * Float(p[1]) + 0.299 * Float(p[2])
                sums[gy * Self.gridW + gx] += grey
                counts[gy * Self.gridW + gx] += 1
            }
        }
        for i in 0..<sums.count where counts[i] > 0 { sums[i] /= counts[i] }
        return sums
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sb: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, let px = sb.imageBuffer else { return }
        if let attachments = CMSampleBufferGetSampleAttachmentsArray(sb, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
           let raw = attachments.first?[.status] as? Int, SCFrameStatus(rawValue: raw) != .complete {
            return
        }
        // The host time clock is mach_absolute_time, which is CLOCK_UPTIME_RAW.
        let ns = UInt64(max(0, CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(sb))) * 1_000_000_000)
        let cells = grid(px)
        var score: Float = 255
        if let previous {
            var total: Float = 0
            for i in 0..<cells.count { total += abs(cells[i] - previous[i]) }
            score = total / Float(cells.count)
        }
        previous = cells
        let url = dir.appendingPathComponent(String(format: "f%06d_%llu.jpg", n, ns))
        if let cs = CGColorSpace(name: CGColorSpace.sRGB) {
            try? ctx.writeJPEGRepresentation(of: CIImage(cvPixelBuffer: px), to: url, colorSpace: cs,
                                             options: [kCGImageDestinationLossyCompressionQuality as CIImageRepresentationOption: 0.7])
        }
        scores.write("\(n),\(ns),\(String(format: "%.4f", score))\n".data(using: .utf8)!)
        n += 1
    }
}

func findWindow() async throws -> SCWindow? {
    let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
    return content.windows
        .filter { $0.owningApplication?.processID == pid && $0.title == title && $0.frame.height >= minHeight }
        .max { $0.frame.width * $0.frame.height < $1.frame.width * $1.frame.height }
}

let sem = DispatchSemaphore(value: 0)
Task {
    do {
        var win: SCWindow?
        let deadline = Date().addingTimeInterval(30)
        while win == nil, Date() < deadline {
            win = try await findWindow()
            if win == nil { try await Task.sleep(nanoseconds: 20_000_000) }
        }
        guard let win else { fail("no \"\(title)\" window for pid \(pid)") }
        let cfg = SCStreamConfiguration()
        cfg.width = Int(win.frame.width * scale)
        cfg.height = Int(win.frame.height * scale)
        cfg.pixelFormat = kCVPixelFormatType_32BGRA
        cfg.minimumFrameInterval = CMTime(value: 1, timescale: fps)
        cfg.showsCursor = false
        cfg.queueDepth = 8
        let sink = Sink(dir: framesDir, scores: scores, crop: crop, scale: scale)
        let stream = SCStream(filter: SCContentFilter(desktopIndependentWindow: win), configuration: cfg, delegate: nil)
        try stream.addStreamOutput(sink, type: .screen, sampleHandlerQueue: DispatchQueue(label: "rec"))
        try await stream.startCapture()
        print("recording \(win.windowID) \(Int(win.frame.width)) \(Int(win.frame.height))")
        fflush(stdout)
        try await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
        try await stream.stopCapture()
        print("frames \(sink.n)")
        fflush(stdout)
    } catch {
        fail("\(error)")
    }
    sem.signal()
}
sem.wait()
