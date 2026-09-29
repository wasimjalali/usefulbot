import Foundation
public enum TurnActivity { case thinking, working, compacting, tool(String, detail: String? = nil) }
@MainActor enum BrandAssets {
    struct AvatarColor { let fill: String }
    static let root = URL(fileURLWithPath: "/Users/wasimjalali/Desktop/useful-bot/brand")
    static let palette: [String: AvatarColor] = ["gray": AvatarColor(fill: "#D5DDE7")]
}
