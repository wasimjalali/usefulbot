import SwiftUI
import UsefulBotCore

/// The stacked member faces from the Grok Bot reference: overlapping bot heads
/// on opaque chips so the overlap stays legible, plus a "+N" overflow chip.
/// Groups use it in the rail, the chat header and the cross-bot meta strips.
struct AvatarStackView: View {
    let bots: [ShellBot]
    var size: CGFloat = 24
    var maxVisible: Int = 3
    var overlap: CGFloat = 0.3

    private var visible: [ShellBot] { Array(bots.prefix(max(1, maxVisible))) }
    private var overflow: Int { max(0, bots.count - visible.count) }

    var body: some View {
        HStack(spacing: -size * overlap) {
            ForEach(Array(visible.enumerated()), id: \.element.id) { index, bot in
                chip {
                    BotStillFaceView(color: BrandAssets.colorID(for: bot), size: size * 0.84)
                }
                .zIndex(Double(index))
            }
            if overflow > 0 {
                chip(fill: Theme.C.sunken) {
                    Text("+\(overflow)")
                        .font(.system(size: max(9, (size * 0.38).rounded()), weight: .semibold))
                        .monospacedDigit()
                        .foregroundStyle(Theme.C.inkMuted)
                }
                .zIndex(Double(visible.count + 1))
            }
        }
        .fixedSize()
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(label)
    }

    private func chip<Content: View>(
        fill: Color = Theme.C.surface,
        @ViewBuilder content: () -> Content
    ) -> some View {
        content()
            .frame(width: size, height: size)
            .background(Circle().fill(fill))
            .overlay(Circle().strokeBorder(Theme.C.edge, lineWidth: 1))
            .clipShape(Circle())
    }

    private var label: String {
        switch bots.count {
        case 0: return "No members"
        case 1: return bots[0].name
        case 2, 3: return bots.map(\.name).joined(separator: ", ")
        default:
            let named = bots.prefix(3).map(\.name).joined(separator: ", ")
            return "\(named), and \(bots.count - 3) more"
        }
    }
}

/// Resolve a group's member ids against the live store, in member order.
func groupMemberBots(_ bot: ShellBot, store: ShellStore?) -> [ShellBot] {
    guard bot.isGroup, let store else { return [] }
    return bot.memberIds.compactMap { id in store.bots.first { $0.id == id } }
}
