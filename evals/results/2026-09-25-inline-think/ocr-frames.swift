import Foundation
import Vision
import AppKit
// usage: ocr <dir> <fromMs> <toMs> ; prints frames whose text contains "think"
let args = CommandLine.arguments
let dir = args[1]; let from = Int(args[2])!; let to = Int(args[3])!
let files = try FileManager.default.contentsOfDirectory(atPath: dir).filter { $0.hasSuffix("ms.jpg") }.sorted()
var checked = 0, hits = 0
for f in files {
    guard let ms = Int(f.split(separator: "_").last!.replacingOccurrences(of: "ms.jpg", with: "")), ms >= from, ms <= to else { continue }
    guard let img = NSImage(contentsOfFile: dir + "/" + f), let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else { continue }
    // Transcript area only (skip the rail), so the rail never matches.
    let w = cg.width, h = cg.height
    guard let crop = cg.cropping(to: CGRect(x: Int(Double(w) * 0.14), y: 0, width: Int(Double(w) * 0.86), height: h)) else { continue }
    let req = VNRecognizeTextRequest(); req.recognitionLevel = .accurate; req.usesLanguageCorrection = false
    try VNImageRequestHandler(cgImage: crop).perform([req])
    let text = (req.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: " | ")
    checked += 1; print("TEXT \(f)\t\(text)")
    let lower = text.lowercased()
    if lower.contains("think>") || lower.contains("<think") || lower.contains("/think") {
        hits += 1; print("HIT \(f): \(text.prefix(400))")
    }
}
print("checked \(checked) frames, hits \(hits)")
