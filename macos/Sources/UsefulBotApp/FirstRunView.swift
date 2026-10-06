import AppKit
import SwiftUI
import UsefulBotCore

// MARK: - Controller

/// The first-run flow: Welcome, Connect a provider, sign in or paste a key,
/// Pick your default model, then the first chat. It shows once (see
/// `FirstRunGate`); the skipped-setup bar reopens it at Connect.
@MainActor
final class FirstRunController: ObservableObject {
    enum Step: Equatable {
        case welcome
        case connect
        case signIn(CatalogPublic)
        case key(CatalogPublic)
        case model

        /// Identity on screen: one page per step and provider.
        var key: String {
            switch self {
            case .welcome: return "welcome"
            case .connect: return "connect"
            case .signIn(let entry): return "signin:\(entry.id)"
            case .key(let entry): return "key:\(entry.id)"
            case .model: return "model"
            }
        }

        var depth: Int {
            switch self {
            case .welcome: return 0
            case .connect: return 1
            case .signIn, .key: return 2
            case .model: return 3
            }
        }
    }

    @Published private(set) var active = false
    @Published private(set) var step: Step = .welcome
    @Published private(set) var decision: FirstRunGate.Decision = .wait
    /// Connections made or picked during this run, in order. The model step
    /// lists these providers' models.
    @Published private(set) var connected: [String] = []
    /// Bumped when a first run lands in its first chat, so the app can run
    /// its entrance.
    @Published private(set) var landedToken = 0
    /// Between finishing and the chat having drawn under the flow.
    @Published private(set) var landing = false
    /// The landing runs the first chat's entrance (a first run), or just
    /// uncovers the chat it was opened over (the skipped-setup bar).
    private(set) var entrance = false
    /// Reopened over the chat and still fading in: the chat stays under it.
    @Published private(set) var opening = false

    let forced: Bool
    private let freshMac: Bool
    private let harnessRun: Bool
    /// Verification only: `--first-run-land <bot name>` lands in that bot
    /// instead of Generalist, so a forced run can end in "Test Bot".
    private let landOverride: String?
    /// Verification only: `--first-run-preview signin-done|signin-expired`
    /// plays the sign-in step's end states without a real device flow;
    /// `no-model` shows the skipped-setup bar on a Mac that has providers.
    let preview: String?

    var previewsNoModel: Bool { preview == "no-model" }
    private let defaults: UserDefaults
    private var landsOnFinish = true

    init(arguments: [String] = ProcessInfo.processInfo.arguments, defaults: UserDefaults = .standard) {
        self.defaults = defaults
        forced = arguments.contains(FirstRunGate.forceArgument)
        landOverride = Self.value(after: "--first-run-land", in: arguments)
        preview = Self.value(after: "--first-run-preview", in: arguments)
        // The provider store, not the service config: a Mac can have a config
        // with no store, but never a connection without one.
        let store = AppVariant.current.stateRoot(home: FileManager.default.homeDirectoryForCurrentUser).appendingPathComponent("providers.json")
        freshMac = !FileManager.default.fileExists(atPath: store.path)
        harnessRun = PerfHarness.shared != nil
        // Decided before the first frame where it can be, so a forced run or
        // a new Mac never shows the launch cover for a frame first.
        apply(decide(connections: nil, failed: false))
    }

    private static func value(after flag: String, in arguments: [String]) -> String? {
        guard let index = arguments.firstIndex(of: flag), arguments.indices.contains(index + 1) else { return nil }
        return arguments[index + 1]
    }

    private var completed: Bool { defaults.bool(forKey: FirstRunGate.completedKey) }

    private func decide(connections: Int?, failed: Bool) -> FirstRunGate.Decision {
        FirstRunGate.decide(
            forced: forced,
            completed: completed,
            freshMac: freshMac,
            harnessRun: harnessRun,
            connections: connections,
            providersFailed: failed
        )
    }

    private func apply(_ next: FirstRunGate.Decision) {
        decision = next
        if next == .show {
            step = .welcome
            landsOnFinish = true
            active = true
        }
    }

    /// Settles a gate that was waiting on the providers. A decided gate stays
    /// decided: an owner who later disconnects everything gets the bar, not
    /// the flow again.
    func evaluate(_ model: AppModel) {
        let connections = model.providersLoaded ? model.providerConnections.count : nil
        if FirstRunGate.marksDone(forced: forced, completed: completed, connections: connections) {
            defaults.set(true, forKey: FirstRunGate.completedKey)
            // An owner from before first run existed has chatted already.
            defaults.set(true, forKey: StarterPrompt.sentKey)
        }
        guard decision == .wait else { return }
        apply(decide(connections: connections, failed: model.providersLoadFailed))
    }

    /// The launch cover stays up while the gate waits on a running app.
    func waiting(_ model: AppModel) -> Bool {
        decision == .wait && model.phase == .ready
    }

    func go(_ next: Step) {
        step = next
    }

    func noteConnected(_ connectionId: String) {
        if !connected.contains(connectionId) { connected.append(connectionId) }
    }

    /// The skipped-setup bar's Connect: the flow again, from Connect, and back
    /// to the same chat after.
    func reopen() {
        guard !active else { return }
        connected = []
        step = .connect
        landsOnFinish = false
        opening = true
        active = true
    }

    func finishOpening() {
        opening = false
    }

    func finish(_ model: AppModel) {
        if FirstRunGate.persistsFinish(forced: forced) {
            defaults.set(true, forKey: FirstRunGate.completedKey)
        }
        let lands = landsOnFinish
        if lands, let id = landingBotId(model.store), id != model.selectedBotId {
            // A forced run shows the chat without storing it as selected.
            model.select(id, persist: FirstRunGate.persistsFinish(forced: forced))
        }
        decision = .skip
        landsOnFinish = false
        // Either way the chat is laid out under the flow before it leaves.
        entrance = lands
        landing = true
        landedToken &+= 1
    }

    /// The chat is on screen under the flow: the flow can go.
    func completeLanding() {
        landing = false
        active = false
    }

    /// Where the first chat opens: the seeded default bot, else the owner's
    /// Generalist, else the first bot on the rail.
    func landingBotId(_ store: ShellStore?) -> String? {
        guard let store else { return nil }
        if let landOverride, let bot = store.bots.first(where: { $0.kind == "bot" && ($0.name == landOverride || $0.id == landOverride) }) {
            return bot.id
        }
        let bots = store.bots.filter { $0.kind == "bot" && !$0.hidden }
        return bots.first { $0.id == Threads.defaultBotId }?.id
            ?? bots.first { $0.name == "Generalist" }?.id
            ?? bots.first?.id
    }
}

/// The subscriptions and API-key providers the Connect step leads with. The
/// rows themselves, their names, logos and modes come from the server's
/// catalogue; this only picks the order.
enum FirstRunCatalog {
    static let featuredSubscriptions = ["openai:oauth", "minimax:plan", "opencode-go:plan"]
    static let featuredKeys = ["anthropic:api", "openai:api", "openrouter:api"]

    struct Lists {
        var subscriptions: [CatalogPublic] = []
        var moreSubscriptions: [CatalogPublic] = []
        var keys: [CatalogPublic] = []
        var moreKeys: [CatalogPublic] = []
    }

    static func lists(_ catalog: [CatalogPublic]) -> Lists {
        // Custom stays in Settings; local servers are not API keys.
        let usable = catalog.filter { $0.providerId != "custom" && $0.mode != "local" }
        let subs = usable.filter { $0.kindLabel == "Subscription" }
        let keys = usable.filter { $0.kindLabel == "API" }
        func split(_ rows: [CatalogPublic], _ featured: [String]) -> ([CatalogPublic], [CatalogPublic]) {
            let top = featured.compactMap { id in rows.first { $0.id == id } }
            return (top, rows.filter { !featured.contains($0.id) })
        }
        let (topSubs, restSubs) = split(subs, featuredSubscriptions)
        let (topKeys, restKeys) = split(keys, featuredKeys)
        return Lists(subscriptions: topSubs, moreSubscriptions: restSubs, keys: topKeys, moreKeys: restKeys)
    }
}

// MARK: - Environment

private struct StarterBotKey: EnvironmentKey {
    static let defaultValue: String? = nil
}

private struct ComposerRisenKey: EnvironmentKey {
    static let defaultValue = true
}

private struct ConnectModelKey: EnvironmentKey {
    static let defaultValue: FirstRunController? = nil
}

private struct NoModelPreviewKey: EnvironmentKey {
    static let defaultValue = false
}

extension EnvironmentValues {
    /// The bot whose empty chat shows the starter prompts.
    var starterBotId: String? {
        get { self[StarterBotKey.self] }
        set { self[StarterBotKey.self] = newValue }
    }

    /// False while the entrance into the first chat holds the composer down.
    var composerRisen: Bool {
        get { self[ComposerRisenKey.self] }
        set { self[ComposerRisenKey.self] = newValue }
    }

    /// The skipped-setup bar's Connect reopens this flow. The controller, not
    /// a closure, so the value is the same object on every pass and the chat
    /// isn't redrawn for it.
    var connectModel: FirstRunController? {
        get { self[ConnectModelKey.self] }
        set { self[ConnectModelKey.self] = newValue }
    }

    /// Verification only: show the skipped-setup bar regardless.
    var noModelPreview: Bool {
        get { self[NoModelPreviewKey.self] }
        set { self[NoModelPreviewKey.self] = newValue }
    }
}

// MARK: - Flow

struct FirstRunView: View {
    @EnvironmentObject private var model: AppModel
    @ObservedObject var controller: FirstRunController
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// One visit to a step. Each visit is its own page, so going Back and
    /// picking the same provider again starts clean instead of reusing a page
    /// whose flow was cancelled.
    private struct Layer: Equatable {
        let step: FirstRunController.Step
        let visit: Int
        var key: String { "\(step.key)#\(visit)" }
    }

    /// The pages on screen, bottom to top. During a change the old page stays
    /// under the new one until the new one has drawn, so a page that takes a
    /// few frames to lay out never leaves the stage blank. Welcome is apart.
    @State private var layers: [Layer]
    @State private var visits = 0
    @State private var opacity: [String: Double] = [:]
    @State private var offset: [String: CGFloat] = [:]
    @State private var yOffset: [String: CGFloat] = [:]
    /// Welcome stays mounted through its exit so it can finish fading.
    @State private var welcomeMounted: Bool
    @State private var welcomeLeaving = false
    @State private var pendingDrop: DispatchWorkItem?
    /// True from a step change until its transition has settled.
    @State private var moving = false
    /// Reopened over the chat, the flow fades in once it has drawn; at
    /// launch it is simply there.
    @State private var revealed: Bool

    init(controller: FirstRunController) {
        self.controller = controller
        _revealed = State(initialValue: !controller.opening)
        _layers = State(initialValue: controller.step == .welcome ? [] : [Layer(step: controller.step, visit: 0)])
        _welcomeMounted = State(initialValue: controller.step == .welcome)
    }

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: DesignTokens.Radius.stage, style: .continuous)
                .fill(Theme.C.surface)
                .cardLift(cornerRadius: DesignTokens.Radius.stage)
            ZStack {
                if welcomeMounted {
                    WelcomePage(leaving: welcomeLeaving) {
                        controller.go(.connect)
                    }
                    .allowsHitTesting(!welcomeLeaving)
                }
                ForEach(layers, id: \.key) { layer in
                    page(layer.step)
                        .opacity(opacity[layer.key] ?? 1)
                        .offset(x: offset[layer.key] ?? 0, y: yOffset[layer.key] ?? 0)
                        // Not while it is still invisible: a fast second click
                        // landed on the next page before it faded in.
                        .allowsHitTesting(layer == layers.last && !moving)
                        .accessibilityHidden(layer != layers.last)
                }
            }
            .clipShape(RoundedRectangle(cornerRadius: DesignTokens.Radius.stage, style: .continuous))
        }
        // The lights sit in the canvas band above the stage.
        .padding(EdgeInsets(top: WindowChrome.lightsCenterY * 2, leading: DesignTokens.Space.stageMargin,
                            bottom: DesignTokens.Space.stageMargin, trailing: DesignTokens.Space.stageMargin))
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.C.canvas)
        .opacity(revealed ? 1 : 0)
        .onAppear {
            guard !revealed else { return }
            DispatchQueue.main.async {
                withAnimation(Theme.ease(0.26)) { revealed = true }
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { controller.finishOpening() }
            }
        }
        .onChange(of: controller.step) { old, next in
            move(from: old, to: next)
        }
    }

    @ViewBuilder
    private func page(_ step: FirstRunController.Step) -> some View {
        switch step {
        case .welcome:
            EmptyView()
        case .connect:
            ConnectPage(
                onPick: pick,
                onContinue: {
                    model.providerConnections.forEach { controller.noteConnected($0.id) }
                    controller.go(.model)
                },
                onSkip: { controller.finish(model) }
            )
        case .signIn(let entry):
            SignInPage(entry: entry, preview: controller.preview, onBack: {
                Task { await model.cancelOAuth() }
                controller.go(.connect)
            }, onDone: {
                controller.noteConnected(entry.id)
                controller.go(.model)
            })
        case .key(let entry):
            KeyPage(entry: entry, onBack: { controller.go(.connect) }, onDone: {
                controller.noteConnected(entry.id)
                controller.go(.model)
            })
        case .model:
            ModelPage(connected: controller.connected, dryRun: controller.forced || controller.preview != nil, onBack: { controller.go(.connect) }) {
                controller.finish(model)
            }
        }
    }

    private func pick(_ entry: CatalogPublic) {
        // Already connected: nothing to sign in to, straight to its models.
        if entry.connected {
            controller.noteConnected(entry.id)
            controller.go(.model)
        } else if entry.oauth {
            controller.go(.signIn(entry))
        } else {
            controller.go(.key(entry))
        }
    }

    /// Welcome to Connect: all of Welcome fades out in place while the list
    /// fades in and rises 16 pt. Between steps: an overlapping crossfade with a
    /// short slide, forward moving left and Back the other way. Reduced motion
    /// is a plain short crossfade.
    ///
    /// The next page is mounted first, invisible, and the motion starts on
    /// the following run-loop turn, after it has drawn.
    private func move(from old: FirstRunController.Step, to next: FirstRunController.Step) {
        pendingDrop?.cancel()
        moving = true
        let fromWelcome = old == .welcome
        let direction: CGFloat = next.depth < old.depth ? -1 : 1
        visits += 1
        let incoming = Layer(step: next, visit: visits)
        let outgoing = layers.last
        var still = Transaction()
        still.disablesAnimations = true
        withTransaction(still) {
            layers = (outgoing.map { [$0] } ?? []) + [incoming]
            opacity[incoming.key] = 0
            offset[incoming.key] = reduceMotion ? 0 : (fromWelcome ? 0 : 28 * direction)
            yOffset[incoming.key] = reduceMotion || !fromWelcome ? 0 : 16
        }
        DispatchQueue.main.async {
            let curve: Animation = reduceMotion ? .easeOut(duration: 0.2) : Theme.ease(0.32)
            if fromWelcome {
                withAnimation(reduceMotion ? .easeOut(duration: 0.2) : Theme.ease(0.16)) { welcomeLeaving = true }
            } else if let outgoing {
                // Out quickly, then the next page in: at a full-length
                // crossfade the two pages sat half-visible over each other,
                // text on text, for several frames.
                withAnimation(reduceMotion ? .easeOut(duration: 0.2) : Theme.ease(0.15)) {
                    opacity[outgoing.key] = 0
                    if !reduceMotion { offset[outgoing.key] = -20 * direction }
                }
            }
            // The next page waits until the last one is nearly gone. The
            // stage itself stays, so there is never a bare window.
            withAnimation(curve.delay(reduceMotion ? 0 : (fromWelcome ? 0.13 : 0.11))) {
                opacity[incoming.key] = 1
                offset[incoming.key] = 0
                yOffset[incoming.key] = 0
            }
            let drop = DispatchWorkItem {
                layers.removeAll { $0 != incoming }
                opacity = opacity.filter { $0.key == incoming.key }
                offset = offset.filter { $0.key == incoming.key }
                yOffset = yOffset.filter { $0.key == incoming.key }
                if welcomeLeaving { welcomeMounted = false }
                moving = false
            }
            pendingDrop = drop
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5, execute: drop)
            // Clickable again once the new page is mostly in, not only when
            // the old one is dropped: a click at 0.3 s was swallowed.
            let settle = visits
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
                if visits == settle { moving = false }
            }
        }
    }
}

// MARK: - Welcome

private struct WelcomePage: View {
    @EnvironmentObject private var model: AppModel
    let leaving: Bool
    let onStart: () -> Void
    @State private var hop = 0

    private var ready: Bool { model.phase == .ready && model.providersLoaded }

    var body: some View {
        VStack(spacing: 28) {
            BotFaceView(color: "ink", size: 76, hop: hop)
                .frame(width: 112, height: 112)
                .background(Color.black, in: RoundedRectangle(cornerRadius: DesignTokens.Radius.xxl, style: .continuous))
                .accessibilityElement()
                .accessibilityLabel("Useful Bot")
            VStack(spacing: 10) {
                Text("Welcome to Useful Bot")
                    .font(.system(size: 30, weight: .semibold))
                    .tracking(DesignTokens.Tracking.heading * 30)
                    .foregroundStyle(Theme.C.ink)
                Text("Your own team of AI bots, on your computer. Use the AI plan you already pay for.")
                    .font(.system(size: 15))
                    .foregroundStyle(Theme.C.inkMuted)
                    .multilineTextAlignment(.center)
            }
            action
        }
        .padding(.horizontal, 24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        // The whole page leaves together, in place, so no piece of it sits
        // over the next step.
        .opacity(leaving ? 0 : 1)
        .onAppear {
            // One friendly hop once the page has drawn. Reduced motion holds still.
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) { hop += 1 }
        }
    }

    @ViewBuilder
    private var action: some View {
        VStack(spacing: 12) {
            NativeButton(kind: .primary, enabled: ready, action: onStart) {
                Text("Get started").padding(.horizontal, 14)
            }
            .accessibilityIdentifier("first-run-start")
            // One line under the button, and only while it can't be pressed.
            // Its room is kept when it goes, so nothing above it moves.
            ZStack(alignment: .top) {
                Color.clear.frame(height: 36)
                if model.phase == .unavailable {
                    VStack(spacing: 8) {
                        Text(model.threadError ?? model.startingMessage)
                            .font(.system(size: 13))
                            .foregroundStyle(Theme.C.inkMuted)
                            .multilineTextAlignment(.center)
                            .frame(maxWidth: 420)
                        NativeButton("Retry", kind: .secondary, small: true) {
                            Task { await model.retry() }
                        }
                    }
                } else if model.providersLoadFailed && model.phase == .ready {
                    HStack(spacing: 8) {
                        Text("Couldn't load the providers.")
                            .font(.system(size: 13))
                            .foregroundStyle(Theme.C.inkMuted)
                        NativeButton("Retry", kind: .secondary, small: true) {
                            Task { await model.loadProviders() }
                        }
                    }
                } else if !ready {
                    HStack(spacing: 8) {
                        ProgressView().controlSize(.small)
                        Text("Getting ready. This takes a few seconds the first time.")
                            .font(.system(size: 13))
                            .foregroundStyle(Theme.C.inkMuted)
                    }
                    .transition(.opacity)
                }
            }
        }
        .animation(Theme.ease(0.2), value: ready)
        .task(id: model.phase) {
            // Once the services answer, the providers are what Get started waits on.
            if model.phase == .ready && !model.providersLoaded { await model.loadProviders() }
        }
        .task(id: model.providersLoaded) {
            // The Connect list draws about twenty logos read from disk; read
            // them now, while Welcome waits, so the page change does not.
            for entry in model.providerCatalog {
                _ = ProviderMarkImage.load(entry.icon)
                await Task.yield()
            }
        }
    }
}

// MARK: - Shared pieces

/// One frame for every step: a 520 pt column centred in the stage, scrolling
/// only when the window is shorter than the content.
private struct StepFrame<Content: View>: View {
    @ViewBuilder let content: Content

    var body: some View {
        GeometryReader { geo in
            ScrollView {
                content
                    .frame(width: 520)
                    .padding(.vertical, 40)
                    .frame(maxWidth: .infinity, minHeight: geo.size.height)
            }
            .scrollIndicators(.never)
            .scrollBounceBehavior(.basedOnSize)
        }
    }
}

private struct StepHeader: View {
    var eyebrow: String?
    let title: String
    var detail: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let eyebrow {
                Text(eyebrow)
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.C.inkMuted)
            }
            Text(title)
                .font(.system(size: 26, weight: .semibold))
                .tracking(DesignTokens.Tracking.heading * 26)
                .foregroundStyle(Theme.C.ink)
                .accessibilityAddTraits(.isHeader)
            if let detail {
                Text(detail)
                    .font(.system(size: 14))
                    .lineSpacing(3)
                    .foregroundStyle(Theme.C.inkMuted)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}

/// A provider's logo on a small white tile, the Connect list's leading mark.
private struct ProviderTile: View {
    let icon: String
    let monogram: String
    var size: CGFloat = 32
    var mark: CGFloat = 18

    var body: some View {
        ProviderMark(icon: icon, monogram: monogram, size: mark)
            .frame(width: size, height: size)
            .background(Theme.C.surface, in: RoundedRectangle(cornerRadius: DesignTokens.Radius.sm, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: DesignTokens.Radius.sm, style: .continuous)
                    .strokeBorder(Theme.C.edge, lineWidth: 1)
            )
    }
}

private struct BackLink: View {
    var enabled = true
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 4) {
                Image(systemName: "chevron.left")
                    .font(.system(size: 11, weight: .medium))
                Text("Back")
                    .font(.system(size: 13))
            }
            .foregroundStyle(hovering && enabled ? Theme.C.ink : Theme.C.inkMuted)
            .frame(minHeight: 28)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
        .opacity(enabled ? 1 : 0.45)
        .pointerOnHover()
        .onHover { hovering = $0 }
        .accessibilityIdentifier("first-run-back")
    }
}

/// A row in a sunken group that tones up on hover.
private struct GroupRowButton<Label: View>: View {
    let action: () -> Void
    @ViewBuilder let label: Label
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            label
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(hovering ? Self.hover : Color.clear)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .pointerOnHover()
        .onHover { hovering = $0 }
        .animation(Theme.ease(0.15), value: hovering)
    }

    private static var hover: Color { Theme.adaptive(DesignTokens.Hex.border, DesignTokens.DarkHex.borderStrong) }
}

private struct TextLinkButton: View {
    let title: String
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(.system(size: 13))
                .foregroundStyle(hovering ? Theme.C.ink : Theme.C.inkMuted)
                .underline(hovering)
                .frame(minHeight: 32)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .pointerOnHover()
        .onHover { hovering = $0 }
    }
}

private func siteHost(_ link: String?) -> String? {
    guard let link, let host = URL(string: link)?.host?.lowercased() else { return nil }
    for prefix in ["www.", "auth."] where host.hasPrefix(prefix) {
        return String(host.dropFirst(prefix.count))
    }
    return host
}

// MARK: - Connect

private struct ConnectPage: View {
    @EnvironmentObject private var model: AppModel
    let onPick: (CatalogPublic) -> Void
    let onContinue: () -> Void
    let onSkip: () -> Void

    @State private var subsOpen = false
    @State private var keysOpen = false

    var body: some View {
        let lists = FirstRunCatalog.lists(model.providerCatalog)
        StepFrame {
            VStack(alignment: .leading, spacing: 20) {
                StepHeader(eyebrow: "Step 1 of 2", title: "Connect a provider")
                if model.providerCatalog.isEmpty {
                    loading
                } else {
                    group("Sign in with a subscription", top: lists.subscriptions, more: lists.moreSubscriptions,
                          moreTitle: "More subscriptions", open: $subsOpen, id: "subscriptions")
                    group("Or use an API key", top: lists.keys, more: lists.moreKeys,
                          moreTitle: "More providers", open: $keysOpen, id: "keys")
                }
                if model.providerConnections.isEmpty {
                    HStack {
                        Spacer(minLength: 0)
                        TextLinkButton(title: "Skip for now", action: onSkip)
                            .accessibilityIdentifier("first-run-skip")
                        Spacer(minLength: 0)
                    }
                } else {
                    NativeButton(kind: .primary, action: onContinue) {
                        Text("Continue").frame(maxWidth: .infinity)
                    }
                    .accessibilityIdentifier("first-run-continue")
                }
            }
        }
    }

    @ViewBuilder
    private var loading: some View {
        if model.providersLoadFailed {
            HStack(spacing: 8) {
                Text("Couldn't load the providers.")
                    .font(.system(size: 14))
                    .foregroundStyle(Theme.C.inkMuted)
                NativeButton("Retry", kind: .secondary, small: true) {
                    Task { await model.loadProviders() }
                }
            }
        } else {
            HStack(spacing: 8) {
                ProgressView().controlSize(.small)
                Text("Loading providers.")
                    .font(.system(size: 14))
                    .foregroundStyle(Theme.C.inkMuted)
            }
            .task { await model.loadProviders() }
        }
    }

    private func group(
        _ title: String,
        top: [CatalogPublic],
        more: [CatalogPublic],
        moreTitle: String,
        open: Binding<Bool>,
        id: String
    ) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title)
                .font(.system(size: 13))
                .foregroundStyle(Theme.C.inkMuted)
                .padding(.leading, 4)
            VStack(spacing: 0) {
                ForEach(Array(top.enumerated()), id: \.element.id) { index, entry in
                    featuredRow(entry)
                        .overlay(alignment: .top) { if index > 0 { Hairline() } }
                }
                if !more.isEmpty {
                    GroupRowButton(action: {
                        withAnimation(Theme.ease(0.3)) { open.wrappedValue.toggle() }
                    }) {
                        HStack(spacing: 12) {
                            Text(moreTitle)
                                .font(.system(size: 14))
                                .foregroundStyle(Theme.C.ink)
                            Spacer(minLength: 0)
                            Text(open.wrappedValue ? "Hide" : "\(more.count) more")
                                .font(.system(size: 12))
                                .foregroundStyle(Theme.C.inkMuted)
                            Image(systemName: "chevron.down")
                                .font(.system(size: 10, weight: .medium))
                                .foregroundStyle(Theme.C.inkMuted)
                                .rotationEffect(.degrees(open.wrappedValue ? 180 : 0))
                        }
                        .padding(.horizontal, 14)
                        .frame(minHeight: 44)
                    }
                    .overlay(alignment: .top) { Hairline() }
                    .accessibilityIdentifier("first-run-more-\(id)")
                    .accessibilityValue(open.wrappedValue ? "Expanded" : "Collapsed")
                    if open.wrappedValue {
                        moreGrid(more)
                    }
                }
            }
            .background(Theme.C.sunken)
            .clipShape(RoundedRectangle(cornerRadius: DesignTokens.Radius.md, style: .continuous))
        }
    }

    private func featuredRow(_ entry: CatalogPublic) -> some View {
        GroupRowButton(action: { onPick(entry) }) {
            HStack(spacing: 12) {
                ProviderTile(icon: entry.icon, monogram: entry.monogram)
                VStack(alignment: .leading, spacing: 2) {
                    Text(entry.label)
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(Theme.C.ink)
                        .lineLimit(1)
                    Text(entry.hint)
                        .font(.system(size: 12))
                        .foregroundStyle(Theme.C.inkMuted)
                        .lineLimit(1)
                }
                Spacer(minLength: 8)
                if entry.connected {
                    connectedLabel
                } else {
                    Text(entry.oauth ? "Sign in" : "Add key")
                        .font(.system(size: 13))
                        .foregroundStyle(Theme.C.inkMuted)
                }
                Image(systemName: "chevron.right")
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(Theme.C.inkFaint)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
        }
        .accessibilityIdentifier("first-run-provider-\(entry.id)")
    }

    private var connectedLabel: some View {
        HStack(spacing: 4) {
            Image(systemName: "checkmark")
                .font(.system(size: 11, weight: .semibold))
            Text("Connected")
                .font(.system(size: 13))
        }
        .foregroundStyle(Theme.C.success)
    }

    /// Two columns of compact rows. They open with the group's height and
    /// fade in one after another, 20 ms apart.
    private func moreGrid(_ rows: [CatalogPublic]) -> some View {
        let pairs = stride(from: 0, to: rows.count, by: 2).map { Array(rows[$0..<min($0 + 2, rows.count)]) }
        return VStack(alignment: .leading, spacing: 2) {
            ForEach(Array(pairs.enumerated()), id: \.offset) { rowIndex, pair in
                HStack(spacing: 16) {
                    ForEach(Array(pair.enumerated()), id: \.element.id) { column, entry in
                        compactRow(entry)
                            .transition(.opacity.animation(Theme.ease(0.26).delay(Double(rowIndex * 2 + column) * 0.02)))
                    }
                    if pair.count == 1 { Spacer(minLength: 0).frame(maxWidth: .infinity) }
                }
            }
        }
        .padding(EdgeInsets(top: 2, leading: 8, bottom: 10, trailing: 8))
    }

    private func compactRow(_ entry: CatalogPublic) -> some View {
        MenuRowButton(action: { onPick(entry) }) {
            HStack(spacing: 8) {
                ProviderMark(icon: entry.icon, monogram: entry.monogram, size: 16)
                Text(entry.label)
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.C.ink)
                    .lineLimit(1)
                if entry.connected {
                    Image(systemName: "checkmark")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(Theme.C.success)
                        .accessibilityLabel("Connected")
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 6)
            .frame(minHeight: 34)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(maxWidth: .infinity)
        .accessibilityIdentifier("first-run-provider-\(entry.id)")
    }
}

// MARK: - Sign in

private struct SignInPage: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let entry: CatalogPublic
    let preview: String?
    let onBack: () -> Void
    let onDone: () -> Void

    @State private var completionsAtStart = 0
    @State private var signedIn = false
    @State private var continueShown = false
    @State private var copied = false
    /// Verification only: the preview's own code and end state.
    @State private var previewExpired = false
    /// The code and page stay on screen after the flow clears on success.
    @State private var lastCode: String?
    @State private var lastLink: String?

    private var previewing: Bool { preview == "signin-done" || preview == "signin-expired" }

    private var pending: OAuthPending? {
        guard let pending = model.oauth, pending.providerId == entry.providerId else { return nil }
        return pending
    }

    /// ChatGPT signs in through the browser, no code. Before the start answer
    /// arrives the provider id decides, so the page never flashes a code card.
    private var isBrowserFlow: Bool {
        if let pending { return pending.flow == "browser" }
        return entry.providerId == "openai"
    }

    private var code: String? {
        if previewing { return "K7QD-M2XP" }
        return pending?.userCode ?? (signedIn ? lastCode : nil)
    }

    private var link: String? {
        if previewing { return "https://auth.openai.com/api/accounts/authorize" }
        if let pending { return pending.verificationUrlComplete ?? pending.verificationUrl }
        return signedIn ? lastLink : nil
    }

    private var host: String {
        siteHost(link) ?? "the sign-in page"
    }

    private var ended: String? {
        if previewing {
            guard previewExpired else { return nil }
            return isBrowserFlow ? "The sign-in expired before it finished." : "The code expired before sign-in finished."
        }
        guard model.oauthDone, let error = model.oauthError else { return nil }
        if error.localizedCaseInsensitiveContains("expired") {
            return isBrowserFlow ? "The sign-in expired before it finished." : "The code expired before sign-in finished."
        }
        return error
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 24) {
            BackLink(action: onBack)
            VStack(alignment: .leading, spacing: 12) {
                HStack(spacing: 12) {
                    ProviderTile(icon: entry.icon, monogram: entry.monogram, size: 40, mark: 22)
                    Text("Sign in to \(entry.label)")
                        .font(.system(size: 26, weight: .semibold))
                        .tracking(DesignTokens.Tracking.heading * 26)
                        .foregroundStyle(Theme.C.ink)
                        .accessibilityAddTraits(.isHeader)
                }
                Text(isBrowserFlow
                     ? "Continue with ChatGPT to sign in and approve Useful Bot in your browser. Useful Bot never sees your password."
                     : "Your browser opens \(host). Sign in there and enter this code. Useful Bot never sees your password.")
                    .font(.system(size: 14))
                    .lineSpacing(3)
                    .foregroundStyle(Theme.C.inkMuted)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if isBrowserFlow {
                browserCard
            } else {
                codeCard
            }
            status
        }
        .stepFrame()
        .onAppear(perform: start)
        .onChange(of: model.oauthCompletions) { _, count in
            guard count > completionsAtStart else { return }
            succeed()
        }
        .onChange(of: pending) { _, next in
            guard let next else { return }
            lastCode = next.userCode
            lastLink = next.verificationUrlComplete ?? next.verificationUrl
        }
    }

    private func start() {
        completionsAtStart = model.oauthCompletions
        if previewing {
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.6) {
                if preview == "signin-done" { succeed() } else { withAnimation(Theme.ease(0.25)) { previewExpired = true } }
            }
            return
        }
        if model.oauth?.providerId != entry.providerId || model.oauthDone {
            Task { await model.startOAuth(providerId: entry.providerId, label: entry.label) }
        }
    }

    private func restart(newAccount: Bool = false, clientId: String? = nil) {
        if previewing {
            previewExpired = false
            start()
            return
        }
        if newAccount || clientId != nil {
            Task { await model.startOAuth(providerId: entry.providerId, label: entry.label, newAccount: newAccount, clientId: clientId) }
        } else {
            Task { await model.retryOAuth(providerId: entry.providerId, label: entry.label) }
        }
    }

    /// The spinner morphs into a check, then Continue fades in.
    private func succeed() {
        withAnimation(reduceMotion ? .easeOut(duration: 0.2) : Theme.ease(0.34)) { signedIn = true }
        DispatchQueue.main.asyncAfter(deadline: .now() + (reduceMotion ? 0.1 : 0.3)) {
            withAnimation(Theme.ease(0.26)) { continueShown = true }
        }
    }

    private var browserCard: some View {
        VStack(spacing: 14) {
            ContinueWithChatGPTButton(enabled: link != nil && !signedIn && ended == nil) {
                if !previewing, let link, let url = URL(string: link) { NSWorkspace.shared.open(url) }
            }
            if let pending, !signedIn, ended == nil, pending.account != nil || pending.reusesSaved {
                if let account = pending.account {
                    Text("Continues as \(account).")
                        .font(.system(size: 13))
                        .foregroundStyle(Theme.C.inkMuted)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                UseDifferentAccountControl(
                    accounts: pending.accounts, currentClientId: pending.clientId,
                    onPick: { restart(clientId: $0) },
                    onAddNew: { restart(newAccount: true) }
                )
            }
        }
        .padding(22)
        .frame(maxWidth: .infinity)
        .background(Theme.C.sunken, in: RoundedRectangle(cornerRadius: DesignTokens.Radius.md, style: .continuous))
        .opacity(signedIn ? 0.6 : 1)
    }

    private var codeCard: some View {
        VStack(spacing: 14) {
            Group {
                if let code {
                    Text(code)
                        .font(.system(size: 34, weight: .semibold, design: .monospaced))
                        .tracking(0.12 * 34)
                        .foregroundStyle(Theme.C.ink)
                        .textSelection(.enabled)
                        .accessibilityLabel("Code \(code)")
                } else {
                    ProgressView().controlSize(.small)
                        .accessibilityLabel("Getting a code")
                }
            }
            .frame(height: 44)
            HStack(spacing: 10) {
                NativeButton(copied ? "Copied" : "Copy code", kind: .secondary, enabled: code != nil) {
                    guard let code else { return }
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(code, forType: .string)
                    copied = true
                    DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { copied = false }
                }
                .accessibilityIdentifier("first-run-copy-code")
                NativeButton("Open \(host)", kind: .primary, enabled: link != nil && !signedIn) {
                    if !previewing, let link, let url = URL(string: link) { NSWorkspace.shared.open(url) }
                }
                .accessibilityIdentifier("first-run-open-site")
            }
        }
        .padding(22)
        .frame(maxWidth: .infinity)
        .background(Theme.C.sunken, in: RoundedRectangle(cornerRadius: DesignTokens.Radius.md, style: .continuous))
        .opacity(signedIn ? 0.6 : 1)
    }

    @ViewBuilder
    private var status: some View {
        if let ended {
            HStack(spacing: 12) {
                Text(ended)
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.C.danger)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
                if model.oauthOffersNewAccount, isBrowserFlow {
                    UseDifferentAccountControl(
                        accounts: pending?.accounts ?? [], currentClientId: pending?.clientId, afterError: true, kind: .secondary,
                        onPick: { restart(clientId: $0) },
                        onAddNew: { restart(newAccount: true) }
                    )
                } else {
                    NativeButton(isBrowserFlow ? "Try again" : "Get a new code", kind: .secondary, small: true) { restart() }
                        .accessibilityIdentifier("first-run-new-code")
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .background(Theme.C.dangerSoft, in: RoundedRectangle(cornerRadius: DesignTokens.Radius.md, style: .continuous))
            .transition(.opacity)
        } else if (isBrowserFlow ? link == nil : code == nil), !previewing, let error = model.providersError {
            HStack(spacing: 12) {
                Text(error)
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.C.danger)
                Spacer(minLength: 0)
                NativeButton("Try again", kind: .secondary, small: true) { restart() }
            }
        } else {
            VStack(alignment: .leading, spacing: 16) {
                HStack(spacing: 10) {
                    ZStack {
                        ProgressView()
                            .controlSize(.small)
                            .scaleEffect(signedIn ? 0.4 : 1)
                            .opacity(signedIn ? 0 : 1)
                        Image(systemName: "checkmark.circle.fill")
                            .font(.system(size: 18))
                            .foregroundStyle(Theme.C.success)
                            .scaleEffect(signedIn ? 1 : 0.4)
                            .opacity(signedIn ? 1 : 0)
                    }
                    .frame(width: 20, height: 20)
                    Text(isBrowserFlow ? "Waiting for the browser" : "Waiting for you to finish in the browser")
                        .font(.system(size: 13))
                        .foregroundStyle(Theme.C.inkMuted)
                        .opacity(signedIn ? 0 : 1)
                    if let error = model.oauthError, !signedIn, !previewing {
                        // A hiccup that keeps polling; the flow is still live.
                        Text(error)
                            .font(.system(size: 12))
                            .foregroundStyle(Theme.C.inkFaint)
                    }
                }
                NativeButton(kind: .primary, enabled: continueShown, action: onDone) {
                    Text("Signed in. Continue").frame(maxWidth: .infinity)
                }
                .opacity(continueShown ? 1 : 0)
                .offset(y: continueShown || reduceMotion ? 0 : 6)
                .accessibilityHidden(!continueShown)
                .accessibilityIdentifier("first-run-signed-in")
            }
        }
    }
}

// MARK: - Paste a key

private struct KeyPage: View {
    @EnvironmentObject private var model: AppModel
    let entry: CatalogPublic
    let onBack: () -> Void
    let onDone: () -> Void

    @State private var key = ""
    @State private var values: [String: String] = [:]
    @FocusState private var focused: Bool
    /// Set in the same call that sends, so a second Return before the view
    /// redraws can't send a second key, and cleared only by the answer.
    private final class Submission {
        var inFlight = false
        var left = false
    }
    @State private var submission = Submission()
    @State private var submitting = false

    private var checking: Bool { submitting || model.providerBusy == entry.id }
    private var canConnect: Bool {
        !checking && model.providerBusy == nil && !key.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 24) {
            // No Back while the key is out: the answer would land on a page
            // the owner has already left.
            BackLink(enabled: !checking, action: onBack)
            VStack(alignment: .leading, spacing: 12) {
                HStack(spacing: 12) {
                    ProviderTile(icon: entry.icon, monogram: entry.monogram, size: 40, mark: 22)
                    Text("Connect \(entry.label)")
                        .font(.system(size: 26, weight: .semibold))
                        .tracking(DesignTokens.Tracking.heading * 26)
                        .foregroundStyle(Theme.C.ink)
                        .accessibilityAddTraits(.isHeader)
                }
                if !entry.hint.isEmpty {
                    Text(entry.hint)
                        .font(.system(size: 14))
                        .foregroundStyle(Theme.C.inkMuted)
                }
            }
            VStack(alignment: .leading, spacing: 8) {
                Text("API key")
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.C.inkMuted)
                    .padding(.leading, 4)
                SecureField("Paste the key", text: $key)
                    .textFieldStyle(.plain)
                    .font(.system(size: 14, design: .monospaced))
                    .foregroundStyle(Theme.C.ink)
                    .padding(.horizontal, 14)
                    .frame(height: 44)
                    .background(Theme.C.sunken, in: RoundedRectangle(cornerRadius: DesignTokens.Radius.md, style: .continuous))
                    .overlay(
                        RoundedRectangle(cornerRadius: DesignTokens.Radius.md, style: .continuous)
                            .strokeBorder(fieldEdge, lineWidth: model.connectError != nil ? 1.5 : 1)
                    )
                    .focused($focused)
                    .onSubmit(connect)
                    .disabled(checking)
                    .accessibilityLabel("API key")
                    .accessibilityIdentifier("first-run-key-field")
                if let error = model.connectError {
                    Text(error)
                        .font(.system(size: 13))
                        .foregroundStyle(Theme.C.danger)
                        .padding(.leading, 4)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("first-run-key-error")
                }
                ForEach(entry.fields ?? [], id: \.id) { field in
                    FieldShell(label: field.label) {
                        TextField(field.placeholder, text: Binding(
                            get: { values[field.id] ?? "" },
                            set: { values[field.id] = $0 }
                        ))
                        .nativeField(focused: false)
                    }
                    .padding(.top, 4)
                }
                if let keyUrl = entry.keyUrl, let url = URL(string: keyUrl), let host = siteHost(keyUrl) {
                    TextLinkButton(title: "Get a key at \(host)") { NSWorkspace.shared.open(url) }
                }
            }
            NativeButton(kind: checking ? .secondary : .primary, enabled: canConnect, action: connect) {
                Text(checking ? "Checking the key…" : "Connect").frame(maxWidth: .infinity)
            }
            .accessibilityIdentifier("first-run-connect-key")
        }
        .stepFrame()
        .onAppear {
            model.clearConnectError()
            focused = true
        }
        .onDisappear { submission.left = true }
        .onChange(of: key) { _, _ in
            if model.connectError != nil { model.clearConnectError() }
        }
    }

    private var fieldEdge: Color {
        if model.connectError != nil { return Theme.C.danger }
        return focused ? Theme.C.borderStrong : Theme.C.edge
    }

    private func connect() {
        guard canConnect, !submission.inFlight else { return }
        submission.inFlight = true
        submitting = true
        let trimmed = key.trimmingCharacters(in: .whitespacesAndNewlines)
        var fields: [String: String] = [:]
        for field in entry.fields ?? [] {
            let value = (values[field.id] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            if !value.isEmpty { fields[field.id] = value }
        }
        Task {
            await model.connectProvider(
                providerId: entry.providerId,
                mode: entry.mode,
                key: trimmed,
                fields: fields.isEmpty ? nil : fields,
                label: entry.label
            )
            submission.inFlight = false
            submitting = false
            // A page already left (the flow closed under it) doesn't navigate.
            if model.connectError == nil, !submission.left {
                key = ""
                onDone()
            }
        }
    }
}

// MARK: - Model

private struct ModelPage: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let connected: [String]
    /// A forced or preview run: Start never writes the owner's default model.
    let dryRun: Bool
    let onBack: () -> Void
    let onFinish: () -> Void

    @Namespace private var selection
    @State private var picked: String?
    @State private var expanded: Set<String> = []
    @State private var saving = false
    @State private var error: String?
    @State private var waitedOut = false
    @State private var pageHeight: CGFloat = 760

    private struct ModelGroup: Identifiable {
        let id: String
        let label: String
        let icon: String
        let monogram: String
        var options: [RoleModelOption]
    }

    private static func key(_ option: RoleModelOption) -> String { "\(option.connectionId)::\(option.id)" }

    /// Every connected provider, the ones connected in this run first.
    private var scope: [String] {
        let live = model.providerConnections.map(\.id)
        let fromRun = connected.filter { live.contains($0) }
        return fromRun + live.filter { !fromRun.contains($0) }
    }

    /// The current default when it is one of the shown models; otherwise the
    /// first group's everyday model from the catalogue, then its first row.
    /// Each group already leads with that pick (see `groups`).
    private var suggested: String? {
        let all = groups.flatMap(\.options)
        if let role = model.defaultRole, let conn = role.connectionId,
           let match = all.first(where: { $0.connectionId == conn && $0.id == role.modelId }) {
            return Self.key(match)
        }
        return groups.first?.options.first.map(Self.key)
    }

    /// The model a group leads with: the current default when it lives in
    /// this connection, else the catalogue's everyday model for it.
    private func lead(for connectionId: String) -> String? {
        if let role = model.defaultRole, role.connectionId == connectionId, !role.modelId.isEmpty {
            return role.modelId
        }
        return model.providerConnections.first { $0.id == connectionId }?.defaultModelId
    }

    private var groups: [ModelGroup] {
        let options = model.defaultRole?.models ?? []
        return scope.compactMap { id -> ModelGroup? in
            var rows = options.filter { $0.connectionId == id }
            guard !rows.isEmpty else { return nil }
            // The group's pick leads it, so the collapsed list shows it.
            if let lead = lead(for: id),
               let index = rows.firstIndex(where: { $0.id == lead }), index > 0 {
                rows.insert(rows.remove(at: index), at: 0)
            }
            let connection = model.providerConnections.first { $0.id == id }
            return ModelGroup(id: id, label: connection?.label ?? rows[0].connectionLabel,
                         icon: connection?.icon ?? rows[0].icon, monogram: connection?.monogram ?? "?", options: rows)
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 22) {
            BackLink(action: onBack)
            StepHeader(
                eyebrow: "Step 2 of 2",
                title: "Pick your default model",
                detail: "Every bot starts with this one. You can switch per chat anytime."
            )
            if groups.isEmpty {
                empty
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        ForEach(groups) { group in
                            groupView(group)
                        }
                    }
                    .padding(.vertical, 2)
                }
                .uvScroll()
                // As tall as the stage allows. A fixed 420 pt hid a third
                // provider below the fold with no scroller to say so.
                .frame(maxHeight: max(180, pageHeight - 380))
                .fixedSize(horizontal: false, vertical: true)
            }
            if let error {
                Text(error)
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.C.danger)
            }
            NativeButton(kind: .primary, enabled: !saving && (picked != nil || waitedOut), action: start) {
                Text(saving ? "Saving" : "Start using Useful Bot").frame(maxWidth: .infinity)
            }
            .accessibilityIdentifier("first-run-finish")
        }
        .stepFrame()
        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { pageHeight = $0 }
        .onAppear { if picked == nil { picked = suggested } }
        .onChange(of: suggested) { _, next in if picked == nil { picked = next } }
        .task {
            // A list that has not landed yet is asked for again a few times.
            for _ in 0..<8 where groups.isEmpty {
                await model.loadProviders()
                if !groups.isEmpty { return }
                // Leaving the page cancels the task: stop asking.
                do { try await Task.sleep(for: .milliseconds(1500)) } catch { return }
            }
            if groups.isEmpty { waitedOut = true }
        }
    }

    @ViewBuilder
    private var empty: some View {
        if waitedOut {
            Text("No models are listed yet. You can pick one later in Settings.")
                .font(.system(size: 14))
                .foregroundStyle(Theme.C.inkMuted)
        } else {
            HStack(spacing: 8) {
                ProgressView().controlSize(.small)
                Text("Loading models.")
                    .font(.system(size: 14))
                    .foregroundStyle(Theme.C.inkMuted)
            }
        }
    }

    private func groupView(_ group: ModelGroup) -> some View {
        let open = expanded.contains(group.id)
        let suggestedKey = suggested
        let rest = Array(group.options.dropFirst(3))
        return VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                ProviderMark(icon: group.icon, monogram: group.monogram, size: 14)
                Text(group.label)
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.C.inkMuted)
            }
            .padding(.leading, 4)
            VStack(spacing: 0) {
                ForEach(group.options.prefix(3), id: \.id) { option in
                    modelRow(option, suggested: suggestedKey)
                }
                // The rest open as one block, so the group's height and the
                // rows' fade run together; the rows fade 20 ms apart.
                if open {
                    VStack(spacing: 0) {
                        ForEach(Array(rest.enumerated()), id: \.element.id) { index, option in
                            modelRow(option, suggested: suggestedKey)
                                // Capped, so a list of hundreds doesn't trail in for seconds.
                                .transition(.opacity.animation(Theme.ease(0.26).delay(Double(min(index, 10)) * 0.02)))
                        }
                    }
                }
                if group.options.count > 3 {
                    Button {
                        withAnimation(Theme.ease(0.3)) {
                            if open { expanded.remove(group.id) } else { expanded.insert(group.id) }
                        }
                    } label: {
                        Text(open ? "Show fewer" : "Show all \(group.options.count) models")
                            .font(.system(size: 13))
                            .foregroundStyle(Theme.C.inkMuted)
                            .padding(.horizontal, 12)
                            .frame(minHeight: 36)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .pointerOnHover()
                    .accessibilityIdentifier("first-run-show-all-\(group.id)")
                }
            }
            .background(alignment: .topLeading) {
                // One card under all the rows that glides to the picked
                // one, so it never passes over a row's label.
                if let picked, group.options.contains(where: { Self.key($0) == picked }) {
                    RoundedRectangle(cornerRadius: DesignTokens.Radius.sm, style: .continuous)
                        // Lighter than the sunken group in both appearances.
                        .fill(Theme.adaptive(DesignTokens.Hex.surface, "#3A3A3A"))
                        .cardLift(cornerRadius: DesignTokens.Radius.sm)
                        .matchedGeometryEffect(id: picked, in: selection, isSource: false)
                }
            }
            .padding(2)
            .background(Theme.C.sunken, in: RoundedRectangle(cornerRadius: DesignTokens.Radius.md, style: .continuous))
        }
    }

    private func modelRow(_ option: RoleModelOption, suggested: String?) -> some View {
        let key = Self.key(option)
        let on = picked == key
        return Button {
            withAnimation(reduceMotion ? nil : Theme.ease(0.3)) { picked = key }
        } label: {
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(option.label)
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(Theme.C.ink)
                        .lineLimit(1)
                    if key == suggested {
                        Text("Suggested")
                            .font(.system(size: 12))
                            .foregroundStyle(Theme.C.inkMuted)
                    }
                }
                Spacer(minLength: 0)
                ZStack {
                    Circle().strokeBorder(on ? Theme.C.accent : Theme.C.inkFaint, lineWidth: on ? 5 : 1.5)
                    if on { Circle().fill(Theme.C.accentInk).frame(width: 8, height: 8) }
                }
                .frame(width: 18, height: 18)
            }
            .padding(.horizontal, 12)
            .frame(minHeight: 44)
            .background { Color.clear.matchedGeometryEffect(id: key, in: selection, isSource: true) }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .pointerOnHover()
        .accessibilityAddTraits(on ? [.isSelected] : [])
        .accessibilityIdentifier("first-run-model-\(option.id)")
    }

    private func start() {
        guard !saving else { return }
        let options = groups.flatMap(\.options)
        guard !dryRun, let picked, let option = options.first(where: { Self.key($0) == picked }) else {
            onFinish()
            return
        }
        // Already the default: nothing to write.
        if let role = model.defaultRole, role.connectionId == option.connectionId, role.modelId == option.id {
            onFinish()
            return
        }
        saving = true
        error = nil
        Task {
            await model.saveDefaultModel(connectionId: option.connectionId, modelId: option.id, effort: nil)
            saving = false
            if let failed = model.providersError {
                error = failed
            } else {
                onFinish()
            }
        }
    }
}

private extension View {
    /// Wraps a step's content in the shared frame.
    func stepFrame() -> some View { StepFrame { self } }
}
