import SwiftUI
import UsefulBotCore

/// A bot head that can move: the rail, pinned bots and the working row.
/// Idle, it holds still and costs nothing per frame.
struct BotFaceView: View {
    let color: String
    var size: CGFloat
    var pose: BotFacePose = .idle
    /// Bump to play one hop.
    var hop: Int = 0
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        BotFaceLayerView(color: color, pose: pose, hop: hop, reduceMotion: reduceMotion)
            .frame(width: size, height: size)
            .accessibilityHidden(true)
    }
}

/// A still bot head, drawn once per tint and size. Chat rows, pickers and
/// stacks show many of these, so they are images, not layers.
struct BotStillFaceView: View {
    let color: String
    var size: CGFloat

    var body: some View {
        Image(nsImage: BotFaceArt.still(color, size: size))
            .resizable()
            .frame(width: size, height: size)
            .accessibilityHidden(true)
    }
}

private struct BotFaceLayerView: NSViewRepresentable {
    let color: String
    let pose: BotFacePose
    let hop: Int
    let reduceMotion: Bool

    final class Coordinator {
        var hop: Int
        var color: String?
        init(hop: Int) { self.hop = hop }
    }

    func makeCoordinator() -> Coordinator { Coordinator(hop: hop) }

    func makeNSView(context: Context) -> BotFaceNSView {
        let view = BotFaceNSView(frame: .zero)
        update(view, context: context)
        return view
    }

    func updateNSView(_ view: BotFaceNSView, context: Context) {
        update(view, context: context)
    }

    private func update(_ view: BotFaceNSView, context: Context) {
        if context.coordinator.color != color {
            context.coordinator.color = color
            view.setTint(BotFaceArt.tint(color))
        }
        view.apply(pose: pose, reduceMotion: reduceMotion)
        // A counter seen at creation is history (a row scrolled back in);
        // only a bump while on screen plays.
        if hop != context.coordinator.hop {
            context.coordinator.hop = hop
            view.hop()
        }
    }
}

struct UsefulBotLogoView: View {
    var body: some View {
        HStack(spacing: 8) {
            BrandAvatarView(size: 32)
            Text("Useful Bot")
                .font(Theme.font(14, .semibold))
                .tracking(-0.03 * 14)
                .foregroundStyle(Theme.C.ink)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Useful Bot")
    }
}

/// Black belongs to the main brand presentation, never to the color picker.
struct BrandAvatarView: View {
    var size: CGFloat

    var body: some View {
        Image(nsImage: BrandAssets.image("png/mark/useful-bot-128.png"))
            .resizable()
            .interpolation(.high)
            .scaledToFit()
            .frame(width: size, height: size)
            .background(Color.black, in: RoundedRectangle(cornerRadius: Theme.R.avatar(size), style: .continuous))
            .accessibilityHidden(true)
    }
}

struct BotAvatarView: View {
    let bot: ShellBot
    var size: CGFloat = 24

    var body: some View {
        // Shape and image fields are retained on the wire for old saved stores,
        // but are no longer competing visual identities.
        BotStillFaceView(color: BrandAssets.colorID(for: bot), size: size)
    }
}

