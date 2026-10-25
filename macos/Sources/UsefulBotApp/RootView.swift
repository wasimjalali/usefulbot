import AppKit
import SwiftUI
import UsefulBotCore

struct RootView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @AppStorage(AppAppearance.storageKey) private var appearance: AppAppearance = .light
    @State private var launchFinished = false
    @StateObject private var firstRun = FirstRunController()
    /// The entrance into the first chat: the rail slides in, the stage lifts
    /// in, the composer rises. True is at rest.
    @State private var railIn = true
    @State private var stageIn = true
    @State private var composerIn = true

    @State private var windowFullScreen = false

    /// The launch view covers the wait for the local services and nothing
    /// more: once they answer, the app shows, even mid-animation. Holding it
    /// for the animation's full length made every warm launch 2.8 s slower.
    private var showingLaunch: Bool {
        !launchFinished && model.phase == .starting && !reduceMotion
    }

    var body: some View {
        ZStack {
            // Landing, the chat is laid out under the flow first; the flow
            // leaves once it has drawn, so the change never shows a stall.
            if !firstRun.active || firstRun.landing || firstRun.opening {
                if showingLaunch || firstRun.waiting(model) {
                VStack(spacing: 16) {
                    BrandMotionView(size: 168, repeating: false)
                    Image(nsImage: BrandAssets.image("svg/useful-bot-wordmark.svg"))
                        .resizable().scaledToFit().frame(width: 168, height: 39)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(Color.black)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("Starting Useful Bot")
                .accessibilityIdentifier("brand-launch")
                } else {
                    // Into the first chat the rail, stage and composer bring
                    // themselves in; the app only fades when the flow opens over it.
                    applicationContent
                        .transition(.asymmetric(insertion: .identity, removal: .opacity))
                }
            }
            if firstRun.active {
                // It fades itself in once drawn; see FirstRunView.
                FirstRunView(controller: firstRun)
                    .transition(.asymmetric(insertion: .identity, removal: .opacity))
                    .zIndex(1)
            }
            if model.showChatGptPlanWelcome {
                ChatGptPlanWelcomeDialog(onClose: { model.showChatGptPlanWelcome = false })
                    .transition(.opacity)
                    .zIndex(2)
            }
        }
        .animation(Theme.ease(0.3), value: firstRun.active)
        .animation(.easeOut(duration: DesignTokens.Motion.overlay), value: model.showChatGptPlanWelcome)
        .environment(\.connectModel, firstRun)
        .environment(\.noModelPreview, firstRun.previewsNoModel)
        .onChange(of: model.phase) { _, phase in
            // The gate waits on the providers; ask for them the moment the
            // services answer rather than after the first chat's replay.
            if phase == .ready, firstRun.decision == .wait { Task { await model.loadProviders() } }
            firstRun.evaluate(model)
        }
        .onChange(of: model.providersLoaded) { _, _ in firstRun.evaluate(model) }
        .onChange(of: model.providersLoadFailed) { _, _ in firstRun.evaluate(model) }
        .onChange(of: model.providerConnections.count) { _, _ in firstRun.evaluate(model) }
        .onChange(of: firstRun.landedToken) { _, _ in enterFirstChat() }
        .background(Theme.C.canvas)
        // The title bar is hidden and the lights sit on the header row, so
        // the content starts at the window's top edge, not under a band.
        .ignoresSafeArea(.container, edges: .top)
        .background(WindowChrome(fullScreen: $windowFullScreen))
        .onChange(of: appearance) { _, next in
            // Light and dark trade places over a quarter second rather than
            // in one frame. The fade runs on each window's root layer, so it
            // costs the app nothing per frame.
            if !reduceMotion {
                for window in NSApp.windows where window.isVisible {
                    guard let layer = window.contentView?.superview?.layer ?? window.contentView?.layer else { continue }
                    let fade = CATransition()
                    fade.type = .fade
                    fade.duration = DesignTokens.Motion.appearance
                    fade.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
                    layer.add(fade, forKey: "appearance")
                }
            }
            NSApp.appearance = next.nsAppearance
        }
        .onAppear {
            NSApp.appearance = appearance.nsAppearance
            ThinScrollbar.install()
            InputModality.shared.install()
        }
        .task(id: reduceMotion) {
            guard !reduceMotion else { launchFinished = true; return }
            // The local server starts in parallel; this only owns the launch view.
            do { try await Task.sleep(for: .seconds(BrandAssets.motion.duration)) }
            catch { return }
            launchFinished = true
        }
        .animation(.easeOut(duration: DesignTokens.Motion.overlay), value: model.searchOpen)
        .animation(.easeOut(duration: DesignTokens.Motion.overlay), value: model.appSettingsOpen)
    }

    /// Into the first chat: the rail slides in from the left, the stage lifts
    /// in, the composer rises. Reduced motion keeps only the fades.
    private func enterFirstChat() {
        guard firstRun.entrance else {
            DispatchQueue.main.async {
                withAnimation(Theme.ease(0.2)) { firstRun.completeLanding() }
            }
            return
        }
        var still = Transaction()
        still.disablesAnimations = true
        withTransaction(still) {
            railIn = false
            stageIn = false
            composerIn = false
        }
        DispatchQueue.main.async {
            // The chat has drawn under the flow by now. The flow fades while
            // the chat comes in under it: waiting for the flow to clear first
            // left a bare grey window for a moment, the one frame of the first
            // run that looked like nothing was there.
            withAnimation(Theme.ease(0.25)) { firstRun.completeLanding() }
            withAnimation(Theme.ease(0.4).delay(0.04)) { railIn = true }
            withAnimation(Theme.ease(0.4).delay(0.08)) { stageIn = true }
            withAnimation(Theme.ease(0.4).delay(0.16)) { composerIn = true }
        }
    }

    private var applicationContent: some View {
        ZStack {
            switch model.phase {
            case .ready:
                ready
            case .starting, .unavailable:
                starting
            }

            if model.searchOpen {
                SearchPaletteView(
                    onClose: { model.searchOpen = false },
                    onNewChat: {
                        model.searchOpen = false
                        model.newChatOrFocusComposer()
                    },
                    onOpen: { entry in
                        model.searchOpen = false
                        model.open(entry)
                    },
                    onOpenMessage: { hit in
                        model.searchOpen = false
                        model.openChat(hit.chatId, highlight: hit.rowId)
                    },
                    onOpenRoutine: { id in
                        model.searchOpen = false
                        model.showRoutine(id)
                    },
                    onOpenLibrary: { id in
                        model.searchOpen = false
                        model.libraryFocusId = id
                        model.stage = .library
                    },
                    onOpenSettings: {
                        model.searchOpen = false
                        model.openAppSettings(.general)
                    },
                    onOpenConnectors: {
                        model.searchOpen = false
                        model.stage = .connectors
                    },
                    onOpenUsage: {
                        model.searchOpen = false
                        model.openAppSettings(.usage)
                    }
                )
                .transition(.opacity)
            }

            if model.appSettingsOpen {
                AppSettingsView(initialTab: model.appSettingsTab) {
                    model.appSettingsOpen = false
                }
                .transition(.opacity)
            }

        }
    }

    private var ready: some View {
        HStack(spacing: 0) {
            RailView(
                onSearch: { model.searchOpen.toggle() },
                onNewChat: { model.newChatOrFocusComposer() },
                onOpenAppSettings: { model.openAppSettings($0) },
                fullScreen: windowFullScreen
            )
            .offset(x: railIn || reduceMotion ? 0 : -40)
            .opacity(railIn ? 1 : 0)

            stage
                .scaleEffect(stageIn || reduceMotion ? 1 : 0.985)
                .offset(y: stageIn || reduceMotion ? 0 : 12)
                .opacity(stageIn ? 1 : 0)
                .environment(\.composerRisen, composerIn)
                .padding(EdgeInsets(
                    top: DesignTokens.Space.stageMargin,
                    leading: 0,
                    bottom: DesignTokens.Space.stageMargin,
                    trailing: DesignTokens.Space.stageMargin
                ))
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.C.canvas)
    }

    private var stage: some View {
        ZStack {
            RoundedRectangle(cornerRadius: DesignTokens.Radius.stage, style: .continuous)
                .fill(Theme.C.surface)
                .stageShadow()

            switch model.stage {
            case .chat: ChatView()
            case .routines: RoutinesPage()
            case .library: LibraryView()
            case .connectors: ConnectorsPage()
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: DesignTokens.Radius.stage, style: .continuous))
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var starting: some View {
        VStack(spacing: 12) {
            if model.phase == .starting {
                BrandMotionView(size: 72)
            } else {
                BotStillFaceView(color: "ink", size: 72)
            }
            Text(model.startingMessage)
                .font(.system(size: 14))
                .foregroundStyle(Theme.C.inkMuted)
            if let error = model.threadError {
                Text(error)
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.C.inkMuted)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 360)
            }
            if model.phase == .unavailable {
                NativeButton("Retry", kind: .secondary, small: true) {
                    Task { await model.retry() }
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.C.canvas)
    }
}

// MARK: - Dialogs

struct NativeDialog<Content: View>: View {
    let maxWidth: CGFloat
    let ariaLabel: String
    /// Off for a dialog whose own header row carries the close button.
    var closeRow = true
    let onClose: () -> Void
    /// Esc, when it should do something other than close (a page that goes back first).
    var onEscape: (() -> Void)? = nil
    @ViewBuilder var content: Content

    var body: some View {
        ZStack {
            Theme.C.overlay
                .ignoresSafeArea()
                .onTapGesture(perform: onClose)
            VStack(spacing: 0) {
                if closeRow {
                    HStack {
                        Spacer(minLength: 0)
                        NativeIconButton(systemImage: "xmark", size: 32, iconSize: 15, action: onClose)
                            .accessibilityLabel("Close \(ariaLabel)")
                            .accessibilityIdentifier("dialog-close")
                    }
                    .padding(8)
                }
                content
            }
            .frame(maxWidth: maxWidth)
            .background(Theme.C.surface)
            .overlay(
                RoundedRectangle(cornerRadius: DesignTokens.Radius.dialog, style: .continuous)
                    .strokeBorder(Theme.C.edge, lineWidth: 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: DesignTokens.Radius.dialog, style: .continuous))
            .popShadow()
            // Never flush with the window's edges when the window is narrow.
            .padding(.horizontal, 24)
        }
        .onExitCommand(perform: onEscape ?? onClose)
    }
}

struct ConfirmDialog: View {
    let title: String
    let message: String
    var confirmLabel: String = "Delete"
    var danger = true
    let onClose: () -> Void
    let onConfirm: () -> Void

    var body: some View {
        NativeDialog(maxWidth: DesignTokens.Control.dialogConfirmWidth, ariaLabel: title, onClose: onClose) {
            VStack(alignment: .leading, spacing: 0) {
                Text(title)
                    .font(.system(size: DesignTokens.FontSize.dialogTitle, weight: .semibold))
                    .foregroundStyle(Theme.C.ink)
                Text(message)
                    .font(.system(size: DesignTokens.FontSize.dialogBody))
                    .lineSpacing(6)
                    .foregroundStyle(Theme.C.inkMuted)
                    .padding(.top, 8)
                HStack(spacing: 8) {
                    Spacer(minLength: 0)
                    NativeButton("Cancel", kind: .secondary, small: true, action: onClose)
                        .accessibilityIdentifier("dialog-cancel")
                    NativeButton(confirmLabel, kind: danger ? .danger : .primary, small: true, action: onConfirm)
                        .accessibilityIdentifier("dialog-confirm")
                }
                .padding(.top, 20)
            }
            .padding(.horizontal, 20)
            .padding(.bottom, 20)
        }
    }
}

/// Shown once after the first ChatGPT sign-in, in first run or the Providers pane.
struct ChatGptPlanWelcomeDialog: View {
    let onClose: () -> Void

    var body: some View {
        NativeDialog(maxWidth: DesignTokens.Control.dialogConfirmWidth, ariaLabel: "ChatGPT plan", closeRow: false, onClose: onClose) {
            VStack(alignment: .leading, spacing: 0) {
                ProviderMark(icon: "openai", monogram: "C", size: 22)
                    .frame(width: 40, height: 40)
                    .background(Theme.C.surface, in: RoundedRectangle(cornerRadius: DesignTokens.Radius.sm, style: .continuous))
                    .overlay(
                        RoundedRectangle(cornerRadius: DesignTokens.Radius.sm, style: .continuous)
                            .strokeBorder(Theme.C.edge, lineWidth: 1)
                    )
                    .padding(.top, 20)
                Text("You're using your ChatGPT plan")
                    .font(.system(size: DesignTokens.FontSize.dialogTitle, weight: .semibold))
                    .foregroundStyle(Theme.C.ink)
                    .padding(.top, 14)
                Text("Eligible requests in Useful Bot use your ChatGPT plan. You can manage usage in ChatGPT settings.")
                    .font(.system(size: DesignTokens.FontSize.dialogBody))
                    .lineSpacing(6)
                    .foregroundStyle(Theme.C.inkMuted)
                    .padding(.top, 8)
                HStack(spacing: 8) {
                    Spacer(minLength: 0)
                    NativeButton("Manage usage", kind: .secondary, small: true) {
                        if let url = URL(string: "https://chatgpt.com/settings/usage") {
                            NSWorkspace.shared.open(url)
                        }
                    }
                    .accessibilityIdentifier("chatgpt-welcome-manage-usage")
                    NativeButton("Got it", kind: .primary, small: true, action: onClose)
                        .accessibilityIdentifier("chatgpt-welcome-got-it")
                }
                .padding(.top, 20)
            }
            .padding(.horizontal, 20)
            .padding(.bottom, 20)
        }
    }
}

struct PromptDialog: View {
    let title: String
    let label: String
    var initial = ""
    var placeholder = ""
    var submitLabel = "Save"
    let onClose: () -> Void
    let onSubmit: (String) -> Void

    @State private var value = ""
    @FocusState private var focused: Bool

    var body: some View {
        NativeDialog(maxWidth: DesignTokens.Control.dialogConfirmWidth, ariaLabel: title, onClose: onClose) {
            VStack(alignment: .leading, spacing: 0) {
                Text(title)
                    .font(.system(size: DesignTokens.FontSize.dialogTitle, weight: .semibold))
                    .foregroundStyle(Theme.C.ink)
                FieldShell(label: label) {
                    TextField(placeholder, text: $value)
                        .nativeField(focused: focused)
                        .focused($focused)
                        .onSubmit(submit)
                }
                .padding(.top, 16)
                HStack(spacing: 8) {
                    Spacer(minLength: 0)
                    NativeButton("Cancel", kind: .secondary, small: true, action: onClose)
                    NativeButton(submitLabel, kind: .primary, small: true, enabled: !trimmed.isEmpty, action: submit)
                }
                .padding(.top, 20)
            }
            .padding(.horizontal, 20)
            .padding(.bottom, 20)
        }
        .onAppear {
            value = initial
            focused = true
        }
    }

    private var trimmed: String {
        value.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func submit() {
        guard !trimmed.isEmpty else { return }
        onSubmit(trimmed)
    }
}
