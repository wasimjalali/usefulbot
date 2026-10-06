import AppKit
import SwiftUI
import UsefulBotCore

enum CreateKind: Identifiable {
    case bot
    case group

    var id: String {
        switch self {
        case .bot: return "bot"
        case .group: return "group"
        }
    }
}

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

    @State private var pickerOpen = false
    @State private var windowFullScreen = false
    @State private var newChatTrigger = CGRect.zero
    @State private var createKind: CreateKind?
    @State private var createSectionId: String?
    @State private var renameBot: ShellBot?
    @State private var deleteBot: ShellBot?
    @State private var connectorsOpen = false
    @State private var libraryOpen = false

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
        .environment(\.starterBotId, firstRun.landingBotId(model.store))
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
        .animation(.easeOut(duration: DesignTokens.Motion.overlay), value: connectorsOpen)
        .animation(.easeOut(duration: DesignTokens.Motion.overlay), value: libraryOpen)
        .animation(.easeOut(duration: DesignTokens.Motion.overlay), value: model.appSettingsOpen)
        .animation(.easeOut(duration: DesignTokens.Motion.overlay), value: model.instructionsEditorBotId)
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
                        pickerOpen = true
                    },
                    onSelect: { id in
                        model.searchOpen = false
                        model.select(id)
                    },
                    onOpenRecent: { recentId, _ in
                        model.searchOpen = false
                        model.openRecent(recentId)
                    }
                )
                .transition(.opacity)
            }

            if connectorsOpen {
                ConnectorsDialog(onClose: { connectorsOpen = false })
                    .transition(.opacity)
            }

            if libraryOpen {
                LibraryView(onClose: { libraryOpen = false })
                    .transition(.opacity)
            }

            if model.appSettingsOpen {
                AppSettingsView(initialTab: model.appSettingsTab) {
                    model.appSettingsOpen = false
                }
                .transition(.opacity)
            }

            if let botId = model.instructionsEditorBotId {
                InstructionsEditorView(botId: botId) { model.instructionsEditorBotId = nil }
                    .transition(.opacity)
            }

            if let kind = createKind {
                switch kind {
                case .bot:
                    CreateBotDialog(
                        sectionName: model.store?.sections.first { $0.id == createSectionId }?.name,
                        onClose: { createKind = nil },
                        onSubmit: { input, finish in
                            model.createBot(
                                name: input.name,
                                petname: input.name,
                                label: input.label,
                                description: input.description,
                                sectionId: createSectionId
                            ) { error in
                                // The dialog can't be closed while it waits,
                                // but if it is gone anyway the model shows
                                // the failure instead.
                                guard case .bot = createKind else { return false }
                                finish(error)
                                if error == nil {
                                    pickerOpen = false
                                    createKind = nil
                                }
                                return true
                            }
                        }
                    )
                    .transition(.opacity)
                case .group:
                    CreateGroupDialog(
                        bots: model.store?.bots ?? [],
                        onClose: { createKind = nil },
                        onSubmit: { input in
                            model.createGroup(
                                name: input.name,
                                memberIds: input.memberIds,
                                sectionId: createSectionId
                            )
                            pickerOpen = false
                            createKind = nil
                        }
                    )
                    .transition(.opacity)
                }
            }

            if let bot = renameBot {
                PromptDialog(
                    title: "Rename",
                    label: "Name",
                    initial: bot.name,
                    submitLabel: "Rename",
                    onClose: { renameBot = nil },
                    onSubmit: { name in
                        model.rename(botId: bot.id, name: name)
                        renameBot = nil
                    }
                )
                .transition(.opacity)
            }

            if let bot = deleteBot {
                ConfirmDialog(
                    title: "Delete bot",
                    message: deleteMessage(bot),
                    confirmLabel: "Delete",
                    onClose: { deleteBot = nil },
                    onConfirm: {
                        model.delete(botId: bot.id)
                        deleteBot = nil
                    }
                )
                .transition(.opacity)
            }

            if sectionPromptOpen {
                PromptDialog(
                    title: "Create section",
                    label: "Section name",
                    initial: "",
                    submitLabel: "Create section",
                    onClose: { sectionPromptOpen = false },
                    onSubmit: { name in
                        model.createSection(name: name)
                        sectionPromptOpen = false
                    }
                )
                .transition(.opacity)
            }
        }
    }

    private func deleteMessage(_ bot: ShellBot) -> String {
        if bot.isGroup {
            return "Delete \(bot.name)? The group and its roster go away. Member bots stay."
        }
        return "Delete \(bot.name)? This removes the bot, its profile and its transcript. Workspace files stay."
    }

    private var ready: some View {
        HStack(spacing: 0) {
            RailView(
                onSearch: { model.searchOpen = true },
                onNewChat: {
                    pickerOpen.toggle()
                    model.settingsOpen = false
                },
                onOpenSettings: { id in
                    model.select(id)
                    model.settingsOpen = true
                },
                onRenameRequest: { renameBot = $0 },
                onDeleteRequest: { deleteBot = $0 },
                onCreateSection: {
                    createSectionId = nil
                    promptForSection()
                },
                onConnectors: { connectorsOpen = true },
                onLibrary: { libraryOpen = true },
                onOpenAppSettings: { model.openAppSettings($0) },
                newChatTriggerFrame: $newChatTrigger,
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

    @State private var sectionPromptOpen = false

    private func promptForSection() {
        sectionPromptOpen = true
    }

    private var stage: some View {
        ZStack {
            RoundedRectangle(cornerRadius: DesignTokens.Radius.stage, style: .continuous)
                .fill(Theme.C.surface)
                .stageShadow()

            if pickerOpen, let store = model.store {
                NewChatPickerView(
                    store: store,
                    onClose: { pickerOpen = false },
                    onCreateBot: {
                        pickerOpen = false
                        createSectionId = nil
                        createKind = .bot
                    },
                    onCreateGroup: {
                        pickerOpen = false
                        createSectionId = nil
                        createKind = .group
                    },
                    onSelectBot: { id in
                        pickerOpen = false
                        model.startNewChat(botId: id)
                    },
                    plusTrigger: { newChatTrigger }
                )
            } else {
                ChatView(
                    onDeleteRequest: { deleteBot = $0 }
                )
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

struct CreateBotInput {
    var name: String
    var label: String
    var description: String
}

struct CreateGroupInput {
    var name: String
    var memberIds: [String]
}

struct CreateBotDialog: View {
    let sectionName: String?
    let onClose: () -> Void
    /// Calls `finish` with nil once the bot exists, or with the failure copy.
    let onSubmit: (CreateBotInput, @escaping @MainActor (String?) -> Void) -> Void

    @State private var name = ""
    @State private var label = ""
    @State private var description = ""
    @State private var creating = false
    @State private var failure: String?
    @FocusState private var focused: Bool

    var body: some View {
        NativeDialog(maxWidth: DesignTokens.Control.dialogFormWidth, ariaLabel: "Create bot", onClose: { if !creating { onClose() } }) {
            VStack(alignment: .leading, spacing: 0) {
                Text("Create bot")
                    .font(.system(size: DesignTokens.FontSize.dialogTitle, weight: .semibold))
                    .foregroundStyle(Theme.C.ink)
                Text("\(sectionName.map { "Added to \($0). " } ?? "Lands in Unassigned until you move it. ")Leave the name blank-ish if you want the bot to ask what it should be: you can confirm the real name in chat.")
                    .font(.system(size: DesignTokens.FontSize.dialogBody))
                    .lineSpacing(4)
                    .foregroundStyle(Theme.C.inkMuted)
                    .padding(.top, 4)
                VStack(alignment: .leading, spacing: 12) {
                    FieldShell(label: "Name") {
                        TextField("", text: $name)
                            .nativeField(focused: focused)
                            .focused($focused)
                    }
                    FieldShell(label: "Label") {
                        TextField("CEO, research, home", text: $label)
                            .nativeField(focused: false)
                    }
                    FieldShell(label: "Description") {
                        TextEditor(text: $description)
                            .font(.system(size: DesignTokens.FontSize.fieldInput))
                            .foregroundStyle(Theme.C.ink)
                            .scrollContentBackground(.hidden)
                            .padding(.horizontal, 8)
                            .padding(.vertical, 6)
                            // Capped: an uncapped TextEditor takes every point the
                            // window offers and pushes the dialog to its edges.
                            .frame(minHeight: 96, maxHeight: 200)
                            .background(Theme.C.surface)
                            .overlay(
                                RoundedRectangle(cornerRadius: DesignTokens.Radius.field, style: .continuous)
                                    .strokeBorder(Theme.C.borderStrong, lineWidth: 1)
                            )
                            .clipShape(RoundedRectangle(cornerRadius: DesignTokens.Radius.field, style: .continuous))
                        switch InstructionsLimit.footer(for: description) {
                        case .none:
                            EmptyView()
                        case .near(let text):
                            Text(text)
                                .font(.system(size: 12))
                                .foregroundStyle(Theme.C.inkMuted)
                                .monospacedDigit()
                        case .over(let text):
                            Text(text)
                                .font(.system(size: 12))
                                .foregroundStyle(Theme.C.danger)
                                .monospacedDigit()
                        }
                    }
                }
                .padding(.top, 16)
                if let failure {
                    Text(failure)
                        .font(.system(size: 13))
                        .foregroundStyle(Theme.C.danger)
                        .padding(.top, 12)
                }
                HStack(spacing: 8) {
                    Spacer(minLength: 0)
                    NativeButton("Cancel", kind: .secondary, small: true, enabled: !creating, action: onClose)
                    NativeButton(
                        "Create bot",
                        kind: .primary,
                        small: true,
                        enabled: !trimmedName.isEmpty && InstructionsLimit.canSave(description) && !creating
                    ) {
                        creating = true
                        failure = nil
                        onSubmit(CreateBotInput(
                            name: trimmedName,
                            label: label.trimmingCharacters(in: .whitespacesAndNewlines),
                            description: description.trimmingCharacters(in: .whitespacesAndNewlines)
                        )) { error in
                            creating = false
                            failure = error
                        }
                    }
                }
                .padding(.top, 20)
            }
            .padding(.horizontal, 20)
            .padding(.bottom, 20)
        }
        .onAppear { focused = true }
    }

    private var trimmedName: String {
        name.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

struct CreateGroupDialog: View {
    let bots: [ShellBot]
    let onClose: () -> Void
    let onSubmit: (CreateGroupInput) -> Void

    @State private var name = ""
    @State private var memberIds: [String] = []
    @FocusState private var focused: Bool

    private var candidates: [ShellBot] {
        bots.filter { $0.kind == "bot" && !$0.hidden && $0.id != Threads.defaultBotId }
    }

    var body: some View {
        NativeDialog(maxWidth: DesignTokens.Control.dialogFormWidth, ariaLabel: "Create group chat", onClose: onClose) {
            VStack(alignment: .leading, spacing: 0) {
                Text("Create group chat")
                    .font(.system(size: DesignTokens.FontSize.dialogTitle, weight: .semibold))
                    .foregroundStyle(Theme.C.ink)
                Text("Pick 2 to 6 bots. Untargeted messages go to Useful Bot as orchestrator; @name directs one member.")
                    .font(.system(size: DesignTokens.FontSize.dialogBody))
                    .lineSpacing(4)
                    .foregroundStyle(Theme.C.inkMuted)
                    .padding(.top, 4)
                FieldShell(label: "Name") {
                    TextField("", text: $name)
                        .nativeField(focused: focused)
                        .focused($focused)
                }
                .padding(.top, 16)
                VStack(alignment: .leading, spacing: 8) {
                    Text("Members \(memberIds.count)/\(Threads.groupMaxMembers)")
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(Theme.C.inkMuted)
                    ScrollView {
                        VStack(alignment: .leading, spacing: 2) {
                            if candidates.isEmpty {
                                Text("Create a second bot first, then this group can hold both.")
                                    .font(.system(size: 13))
                                    .foregroundStyle(Theme.C.inkMuted)
                                    .padding(.horizontal, 4)
                            }
                            ForEach(candidates) { bot in
                                let checked = memberIds.contains(bot.id)
                                let disabled = !checked && memberIds.count >= Threads.groupMaxMembers
                                Button {
                                    toggle(bot.id)
                                } label: {
                                    HStack(spacing: 8) {
                                        Image(systemName: checked ? "checkmark.square.fill" : "square")
                                            .font(.system(size: 13))
                                            .foregroundStyle(checked ? Theme.C.accent : Theme.C.inkFaint)
                                        Text(bot.name)
                                            .font(.system(size: 14))
                                            .foregroundStyle(Theme.C.ink)
                                            .lineLimit(1)
                                        Spacer(minLength: 0)
                                    }
                                    .padding(.horizontal, 10)
                                    .padding(.vertical, 6)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .contentShape(Rectangle())
                                    .opacity(disabled ? 0.55 : 1)
                                }
                                .buttonStyle(.plain)
                                .disabled(disabled)
                                .pointerOnHover()
                            }
                        }
                    }
                    .uvScroll()
                    .frame(maxHeight: 160)
                }
                .padding(.top, 16)
                HStack(spacing: 8) {
                    Spacer(minLength: 0)
                    NativeButton("Cancel", kind: .secondary, small: true, action: onClose)
                    NativeButton(
                        "Create group",
                        kind: .primary,
                        small: true,
                        enabled: !trimmedName.isEmpty && memberIds.count >= Threads.groupMinMembers
                    ) {
                        onSubmit(CreateGroupInput(name: trimmedName, memberIds: memberIds))
                    }
                }
                .padding(.top, 20)
            }
            .padding(.horizontal, 20)
            .padding(.bottom, 20)
        }
        .onAppear { focused = true }
    }

    private var trimmedName: String {
        name.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func toggle(_ id: String) {
        if memberIds.contains(id) {
            memberIds.removeAll { $0 == id }
            return
        }
        guard memberIds.count < Threads.groupMaxMembers else { return }
        memberIds.append(id)
    }
}

/// What one added tile opens inside the Connectors dialog: who it is, how it
/// is doing, what the owner can do with it and the tools it offers.
private struct ConnectorDetailPage: View {
    @EnvironmentObject private var model: AppModel
    let tile: ConnectorTile
    let search: String
    /// Back to the Connectors list; also closes the page once the item is gone.
    let onBack: () -> Void

    @State private var confirming = false
    @State private var appTools: [DirectConnectionTool]?
    @State private var toolsFailed = false

    private var busy: Bool {
        switch tile.source {
        case .app(let row): return model.connectorBusy == row.slug
        case .server(let row): return model.directConnectionBusy.contains(row.id)
        }
    }

    private var kindLine: String {
        switch tile.source {
        case .app: return "App"
        case .server(let row): return "\(row.host) \u{00B7} \(row.kind.label)"
        }
    }

    private var tools: [DirectConnectionTool]? {
        switch tile.source {
        case .app: return appTools
        case .server(let row): return row.tools
        }
    }

    /// A server shows its tools only once they are known: ready, or listed as none.
    private var showsTools: Bool {
        switch tile.source {
        case .app: return true
        case .server(let row):
            switch row.state {
            case .ready, .zeroTools: return true
            default: return false
            }
        }
    }

    private var errorMessage: String? {
        if case .server(let row) = tile.source, !row.state.isChecking, let message = row.lastError?.message, !message.isEmpty {
            return message
        }
        return nil
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button(action: onBack) {
                HStack(spacing: 4) {
                    Image(systemName: "chevron.left")
                        .font(.system(size: 12, weight: .semibold))
                    Text("Connectors")
                        .font(.system(size: 13, weight: .medium))
                }
                .foregroundStyle(Theme.C.inkMuted)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Back to Connectors")
            .padding(.horizontal, 28)
            HStack(spacing: 12) {
                AppLogo(name: tile.name, url: tile.logoURL, size: 26, data: tile.iconData)
                    .frame(width: 40, height: 40)
                    .background(Theme.C.surface)
                    .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                    .overlay(
                        RoundedRectangle(cornerRadius: 10, style: .continuous)
                            .strokeBorder(Theme.C.edge, lineWidth: 1)
                    )
                VStack(alignment: .leading, spacing: 2) {
                    Text(tile.name)
                        .font(.system(size: DesignTokens.FontSize.dialogTitle, weight: .semibold))
                        .foregroundStyle(Theme.C.ink)
                        .lineLimit(1)
                    Text(kindLine)
                        .font(.system(size: 12))
                        .foregroundStyle(Theme.C.inkMuted)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 28)
            .padding(.top, 14)
            HStack(spacing: 6) {
                if tile.mark == .checking { ProgressView().controlSize(.small) }
                Text(tile.status)
                    .font(.system(size: 13))
                    .foregroundStyle(tile.mark == .added || tile.mark == .checking ? Theme.C.inkMuted : Theme.C.warning)
            }
            .padding(.horizontal, 28)
            .padding(.top, 14)
            if let errorMessage {
                Text(errorMessage)
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.C.inkMuted)
                    .padding(.horizontal, 28)
                    .padding(.top, 4)
            }
            actions
                .padding(.horizontal, 28)
                .padding(.top, 16)
            // A failed Disconnect or Remove shows here, where the owner pressed it.
            if let actionError = tile.source.isApp ? model.connectorsError : model.directConnectionsError {
                Text(actionError)
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.C.danger)
                    .padding(.horizontal, 28)
                    .padding(.top, 8)
            }
            if showsTools {
                toolsSection
                    .padding(.horizontal, 28)
                    .padding(.top, 20)
                    .padding(.bottom, 16)
            }
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .task {
            // An error left from the list page is not about this tile.
            if tile.source.isApp { model.connectorsError = nil } else { model.directConnectionsError = nil }
            if case .app(let row) = tile.source {
                if let list = await model.connectorTools(row) { appTools = list } else { toolsFailed = true }
            }
        }
    }

    @ViewBuilder
    private var toolsSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let tools {
                if tools.isEmpty {
                    Text("No tools")
                        .font(.system(size: 13))
                        .foregroundStyle(Theme.C.inkMuted)
                } else {
                    Text(tools.count == 1 ? "1 tool" : "\(tools.count) tools")
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(Theme.C.inkMuted)
                    ScrollView {
                        LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 10, alignment: .top), count: 3), spacing: 10) {
                            ForEach(Array(tools.enumerated()), id: \.offset) { _, tool in
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(tool.name)
                                        .font(.system(size: 13, weight: .medium))
                                        .foregroundStyle(Theme.C.ink)
                                        .lineLimit(1)
                                        .truncationMode(.tail)
                                    if let description = tool.description, !description.isEmpty {
                                        Text(description)
                                            .font(.system(size: 12))
                                            .foregroundStyle(Theme.C.inkMuted)
                                            .lineLimit(2)
                                            .truncationMode(.tail)
                                    }
                                }
                                .padding(10)
                                .frame(maxWidth: .infinity, alignment: .topLeading)
                                .background(Theme.C.sunken)
                                .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                            }
                        }
                        .padding(.vertical, 2)
                    }
                    .uvScroll()
                }
            } else if toolsFailed {
                Text("Couldn't load the tools.")
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.C.danger)
            } else {
                ProgressView().controlSize(.small)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private var actions: some View {
        HStack(spacing: 8) {
            if confirming {
                Text("Disconnect \(tile.name)?")
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.C.ink)
                NativeButton("Disconnect", kind: .danger, small: true, enabled: !busy, action: confirm)
                NativeButton("Cancel", kind: .secondary, small: true) { confirming = false }
            } else {
                switch tile.source {
                case .app(let row):
                    NativeButton("Disconnect", kind: .ghost, small: true, enabled: !busy && row.accountId != nil) { confirming = true }
                case .server(let row):
                    if row.canReconnect {
                        NativeButton(
                            "Reconnect",
                            kind: row.reconnectProminent ? .primary : .secondary,
                            small: true,
                            enabled: !busy
                        ) { Task { await model.reconnectDirectConnection(row) } }
                    }
                    NativeButton("Refresh", kind: .secondary, small: true, enabled: !busy) {
                        Task { await model.refreshDirectConnection(row) }
                    }
                    if row.canRemove {
                        NativeButton("Disconnect", kind: .ghost, small: true, enabled: !busy) { confirming = true }
                    }
                }
            }
            Spacer(minLength: 0)
        }
    }

    private func confirm() {
        confirming = false
        switch tile.source {
        case .app(let row):
            Task {
                // A failed disconnect leaves the app added; the dialog stays and the error shows behind it.
                if await model.disconnectConnector(row, search: search) { onBack() }
            }
        case .server(let row):
            Task {
                await model.removeDirectConnection(row)
                if !model.directConnections.contains(where: { $0.id == row.id }) { onBack() }
            }
        }
    }
}

private extension ConnectorTile.Source {
    var isApp: Bool {
        if case .app = self { return true }
        return false
    }
}

private struct ConnectorsPageHeightKey: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = nextValue() }
}

struct ConnectorsDialog: View {
    @EnvironmentObject private var model: AppModel
    let onClose: () -> Void

    @State private var search = ""
    @State private var selectedTile: String?
    /// The list page's height with the catalogue showing; the detail page keeps it.
    @State private var pageHeight: CGFloat?
    private static let fallbackPageHeight: CGFloat = 600
    @State private var keyDraft = ""
    /// What the owner has typed into the own-app form, by field name. Cleared
    /// when the form closes; it never outlives the dialog.
    @State private var ownAppDraft: [String: String] = [:]
    /// The catalogue scrolls inside a fixed height, so the dialog keeps one
    /// size while a search narrows or widens the list.
    private static let listHeight: CGFloat = 470
    @FocusState private var keyFocused: Bool
    @FocusState private var searchFocused: Bool
    @FocusState private var ownAppFocused: String?

    /// Every added item in one list: the connected apps and every direct server.
    private var addedTiles: [ConnectorTile] {
        ConnectorTile.merge(apps: model.connectors?.toolkits ?? [], servers: model.directConnections)
    }

    private var selectedTileValue: ConnectorTile? {
        guard let selectedTile else { return nil }
        return addedTiles.first { $0.id == selectedTile }
    }

    var body: some View {
        connectorsPanel
        .onChange(of: selectedTile) { _, value in
            // Back from a detail page lands on the search field again.
            guard value == nil, model.connectors?.hasKey == true else { return }
            Task { @MainActor in searchFocused = true }
        }
        .onChange(of: addedTiles.map(\.id)) { _, ids in
            if let selectedTile, !ids.contains(selectedTile) { self.selectedTile = nil }
        }
    }

    private var connectorsPanel: some View {
        NativeDialog(maxWidth: 760, ariaLabel: "Connectors", onClose: close, onEscape: {
            // Esc on a detail page goes back to the list; on the list it closes.
            if selectedTile != nil { selectedTile = nil } else { close() }
        }) {
            if let tile = selectedTileValue {
                ConnectorDetailPage(tile: tile, search: search, onBack: { selectedTile = nil })
                    .id(tile.id)
                    // The page keeps the list's height, measured once the catalogue has shown.
                    .frame(height: pageHeight ?? Self.fallbackPageHeight, alignment: .top)
            } else {
                listPage
            }
        }
        .task {
            async let direct: Void = model.loadDirectConnections()
            await model.loadConnectors()
            await direct
        }
        .onChange(of: search) { _, value in
            model.connectorSearch = value
            Task {
                try? await Task.sleep(for: .milliseconds(150))
                guard value == search else { return }
                await model.loadConnectors(search: value, quiet: true)
            }
        }
        .onChange(of: model.connectors?.hasKey) { _, hasKey in
            if hasKey == true { searchFocused = true } else { keyFocused = true }
        }
        // Field names repeat across apps (client_id, client_secret), so a
        // draft typed for one app must not prefill the next app's form.
        .onChange(of: model.connectorOwnApp?.toolkit) { _, _ in ownAppDraft = [:] }
    }

    private var listPage: some View {
            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: 10) {
                    Text("Connectors")
                        .font(.system(size: 20, weight: .semibold))
                        .foregroundStyle(Theme.C.ink)
                    Spacer(minLength: 0)
                    addedSummary
                }
                .padding(.horizontal, 28)
                .padding(.top, 4)
                if let error = model.directConnectionsError {
                    HStack(spacing: 12) {
                        Text(error)
                            .font(.system(size: 13))
                            .foregroundStyle(Theme.C.danger)
                        NativeButton("Retry", kind: .secondary, small: true) {
                            Task { await model.loadDirectConnections() }
                        }
                        Spacer(minLength: 0)
                    }
                    .padding(.horizontal, 28)
                    .padding(.top, 12)
                }
                if let payload = model.connectors {
                    if payload.hasKey {
                        catalogue(payload)
                    } else {
                        if !model.directConnections.isEmpty {
                            catalogueSection("Added", addedTiles)
                                .padding(.horizontal, 28)
                                .padding(.top, 20)
                        }
                        keyForm
                    }
                } else {
                    skeletonRows
                        .padding(.horizontal, 20)
                        .padding(.vertical, 20)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                GeometryReader { proxy in
                    Color.clear.preference(key: ConnectorsPageHeightKey.self, value: proxy.size.height)
                }
            )
            .onPreferenceChange(ConnectorsPageHeightKey.self) { height in
                if model.connectors?.hasKey == true, model.connectorOwnApp == nil, height > 0 { pageHeight = height }
            }
    }

    private func close() {
        model.stopConnectorPoll()
        model.stopDirectConnectionPoll()
        model.dismissOwnApp()
        ownAppDraft = [:]
        onClose()
    }

    // MARK: - No key

    private var keyForm: some View {
        VStack(alignment: .leading, spacing: 16) {
            FieldShell(label: "Composio API key", error: model.connectorsError) {
                SecureField("Paste key", text: $keyDraft)
                    .nativeField(focused: keyFocused)
                    .focused($keyFocused)
                    .accessibilityLabel("Composio API key")
                    .onSubmit(saveKey)
            }
            HStack(spacing: 12) {
                NativeButton("Save key", kind: .primary, enabled: canSaveKey, action: saveKey)
                Link("Get a key at composio.dev", destination: URL(string: "https://platform.composio.dev")!)
                    .font(.system(size: 14))
                    .foregroundStyle(Theme.C.inkMuted)
                    .underline()
                    .pointerOnHover()
                Spacer(minLength: 0)
            }
        }
        .padding(.horizontal, 28)
        .padding(.top, 16)
        .padding(.bottom, 24)
        .onAppear { keyFocused = true }
    }

    private var canSaveKey: Bool {
        model.connectorBusy != "key" && !keyDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private func saveKey() {
        guard canSaveKey else { return }
        let key = keyDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        Task {
            await model.saveConnectorsKey(key)
            if model.connectorsError == nil { keyDraft = "" }
        }
    }

    // MARK: - Catalogue

    /// The apps already added, as a row of overlapping logos and a count.
    @ViewBuilder
    private var addedSummary: some View {
        let added = addedTiles
        // A search narrows the list it counts, so the count waits for it to clear.
        if !added.isEmpty, search.trimmingCharacters(in: .whitespaces).isEmpty {
            HStack(spacing: 8) {
                HStack(spacing: -6) {
                    ForEach(added.prefix(4)) { row in
                        AppLogo(name: row.name, url: row.logoURL, size: 22, data: row.iconData)
                            .background(Theme.C.surface, in: RoundedRectangle(cornerRadius: DesignTokens.Radius.sm, style: .continuous))
                            .overlay(
                                RoundedRectangle(cornerRadius: DesignTokens.Radius.sm, style: .continuous)
                                    .strokeBorder(Theme.C.surface, lineWidth: 1.5)
                            )
                    }
                }
                Text("\(added.count) added")
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.C.inkMuted)
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("\(added.count) added")
        }
    }

    private func catalogue(_ payload: ConnectorsPayload) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass")
                    .font(.system(size: 14, weight: .regular))
                    .foregroundStyle(Theme.C.inkFaint)
                TextField("Search apps", text: $search)
                    .textFieldStyle(.plain)
                    .font(.system(size: 14))
                    .foregroundStyle(Theme.C.ink)
                    .focused($searchFocused)
                    .accessibilityLabel("Search apps")
            }
            .padding(.horizontal, 14)
            .frame(height: 38)
            .background(Theme.C.sunken)
            .overlay(
                Capsule(style: .continuous)
                    .strokeBorder(searchFocused ? Theme.C.borderStrong : Theme.C.edge, lineWidth: 1)
            )
            .clipShape(Capsule(style: .continuous))
            .padding(.horizontal, 24)
            .padding(.top, 16)
            if let error = model.connectorsError {
                HStack(spacing: 12) {
                    Text(error)
                        .font(.system(size: 14))
                        .foregroundStyle(Theme.C.danger)
                    NativeButton("Retry", kind: .secondary, small: true) {
                        Task { await model.loadConnectors(search: search) }
                    }
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, 28)
                .padding(.top, 12)
            }
            ScrollViewReader { proxy in
                ScrollView {
                    catalogueList(payload)
                        .padding(.horizontal, 28)
                        .padding(.bottom, 16)
                }
                .uvScroll()
                // The own-app form opens at the top of the list; the owner may
                // have pressed Add far below it.
                .onChange(of: model.connectorOwnApp?.toolkit) { _, toolkit in
                    guard toolkit != nil else { return }
                    withAnimation(.easeOut(duration: DesignTokens.Motion.fast)) {
                        proxy.scrollTo("own-app-form", anchor: .top)
                    }
                }
            }
            // A failed load with nothing to list leaves only the error line.
            .frame(height: payload.toolkits.isEmpty && model.connectorsError != nil && addedTiles.isEmpty ? 0 : Self.listHeight)
            keyFooter(payload)
        }
    }

    /// Which Composio key the catalogue runs on, and the way to take it out.
    private func keyFooter(_ payload: ConnectorsPayload) -> some View {
        HStack(spacing: 8) {
            Text("Composio key ·…\(payload.last4 ?? "")")
                .font(.system(size: 12))
                .foregroundStyle(Theme.C.inkMuted)
                .lineLimit(1)
            Spacer(minLength: 0)
            NativeButton("Remove key", kind: .ghost, small: true, enabled: model.connectorBusy != "key") {
                Task {
                    await model.removeConnectorsKey()
                    search = ""
                }
            }
        }
        .padding(.horizontal, 28)
        .padding(.vertical, 12)
        .overlay(alignment: .top) { Hairline() }
    }

    private static let columns = [
        GridItem(.flexible(), spacing: 32, alignment: .leading),
        GridItem(.flexible(), spacing: 32, alignment: .leading),
    ]

    @ViewBuilder
    private func catalogueList(_ payload: ConnectorsPayload) -> some View {
        let query = search.trimmingCharacters(in: .whitespaces)
        if payload.toolkits.isEmpty && model.connectorsError != nil {
            if !addedTiles.isEmpty && query.isEmpty {
                catalogueSection("Added", addedTiles)
                    .padding(.top, 20)
            }
        } else if payload.toolkits.isEmpty {
            Text(query.isEmpty ? "No apps to show." : "No apps match \u{201C}\(query)\u{201D}.")
                .font(.system(size: 14))
                .foregroundStyle(Theme.C.inkMuted)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 40)
        } else {
            VStack(alignment: .leading, spacing: 24) {
                // The own-app form needs the full width, so it opens above
                // the grid rather than under its row.
                if let form = model.connectorOwnApp,
                   let row = payload.toolkits.first(where: { $0.slug == form.toolkit }) {
                    ownAppCard(row, form)
                }
                let rest = payload.toolkits.filter { !$0.connected }
                if !query.isEmpty {
                    catalogueSection("Results", payload.toolkits.map(rowTile))
                } else {
                    if !addedTiles.isEmpty { catalogueSection("Added", addedTiles) }
                    if !rest.isEmpty { catalogueSection("All apps", rest.map(rowTile)) }
                }
                if let next = payload.nextOffset, next > 0 {
                    HStack {
                        Spacer(minLength: 0)
                        NativeButton(
                            model.connectorMoreBusy ? "Loading" : "Show more (\(max(payload.total - payload.toolkits.count, 0)) left)",
                            kind: .secondary,
                            small: true,
                            enabled: !model.connectorMoreBusy
                        ) {
                            Task { await model.loadMoreConnectors(search: search) }
                        }
                        Spacer(minLength: 0)
                    }
                }
            }
            .padding(.top, 20)
        }
    }

    /// A catalogue row as a tile: an added app is a tile of the Added grid,
    /// any other is an app with an Add button.
    private func rowTile(_ row: ConnectorToolkit) -> ConnectorTile {
        ConnectorTile(app: row)
    }

    private func catalogueSection(_ title: String, _ tiles: [ConnectorTile]) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(title)
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(Theme.C.ink)
            LazyVGrid(columns: Self.columns, alignment: .leading, spacing: 18) {
                ForEach(tiles) { tile in
                    switch tile.source {
                    case .app(let row) where !row.connected:
                        connectorTile(row)
                    default:
                        addedTile(tile)
                    }
                }
            }
        }
    }

    private func tileLogo(_ name: String, url: String?, data: Data?) -> some View {
        AppLogo(name: name, url: url, size: 26, data: data)
            .frame(width: 40, height: 40)
            .background(Theme.C.surface)
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .strokeBorder(Theme.C.edge, lineWidth: 1)
            )
    }

    /// An added app or server. The whole tile opens its detail view.
    private func addedTile(_ tile: ConnectorTile) -> some View {
        var removing = false
        if case .app(let row) = tile.source { removing = model.connectorBusy == row.slug }
        let open = { selectedTile = tile.id }
        return HStack(spacing: 12) {
            tileLogo(tile.name, url: tile.logoURL, data: tile.iconData)
            VStack(alignment: .leading, spacing: 2) {
                Text(tile.name)
                    .font(.system(size: 14, weight: .medium))
                    .foregroundStyle(Theme.C.ink)
                    .lineLimit(1)
                Text(tile.status)
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.C.inkMuted)
                    .lineLimit(1)
            }
            Spacer(minLength: 8)
            switch tile.mark {
            case .added:
                HStack(spacing: 4) {
                    if !removing {
                        Image(systemName: "checkmark")
                            .font(.system(size: 11, weight: .medium))
                    }
                    Text(removing ? "Removing" : "Added")
                        .font(.system(size: 13))
                }
                .foregroundStyle(Theme.C.inkMuted)
            case .checking:
                ProgressView().controlSize(.small)
            case .warning(let label):
                Text(label)
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.C.warning)
            }
        }
        .frame(minHeight: 48)
        .contentShape(Rectangle())
        .onTapGesture(perform: open)
        .pointerOnHover()
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isButton)
        .accessibilityAction(.default, open)
        .accessibilityIdentifier("connector-tile-\(tile.id)")
    }

    private func connectorTile(_ row: ConnectorToolkit) -> some View {
        let pending = model.connectorPending == row.slug
        let busy = model.connectorBusy == row.slug
        let formOpen = model.connectorOwnApp?.toolkit == row.slug
        return HStack(spacing: 12) {
            tileLogo(row.name, url: row.logo, data: nil)
            VStack(alignment: .leading, spacing: 2) {
                Text(row.name)
                    .font(.system(size: 14, weight: .medium))
                    .foregroundStyle(Theme.C.ink)
                    .lineLimit(1)
                Text(statusCopy(row, pending: pending))
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.C.inkMuted)
                    .lineLimit(1)
            }
            Spacer(minLength: 8)
            if !formOpen {
                AddPillButton(title: pending ? "Adding" : "Add", enabled: !busy && model.connectorPending == nil) {
                    Task { await model.connectConnector(row, search: search) }
                }
                .accessibilityLabel("Add \(row.name)")
            }
        }
        .frame(minHeight: 48)
    }

    private func ownAppCard(_ row: ConnectorToolkit, _ form: OwnAppForm) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 10) {
                AppLogo(name: row.name, url: row.logo, size: 24)
                Text(row.name)
                    .font(.system(size: 14, weight: .medium))
                    .foregroundStyle(Theme.C.ink)
            }
            ownAppForm(row, form)
        }
        .padding(16)
        .background(Theme.C.sunken)
        .clipShape(RoundedRectangle(cornerRadius: DesignTokens.Radius.settingsGroup, style: .continuous))
        .id("own-app-form")
    }

    /// The owner's own OAuth app for a connector Composio has no app for.
    /// The one line of help is there because the redirect URI has to be
    /// registered with the provider before the sign-in can come back.
    private func ownAppForm(_ row: ConnectorToolkit, _ form: OwnAppForm) -> some View {
        let busy = model.connectorBusy == row.slug
        return VStack(alignment: .leading, spacing: 12) {
            Text("Composio has no \(row.name) app of its own. Create one in the \(row.name) developer portal with this redirect URI, then paste its details here.")
                .font(.system(size: 13))
                .foregroundStyle(Theme.C.inkMuted)
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 8) {
                Text(form.redirectUri)
                    .font(.system(size: 12, design: .monospaced))
                    .foregroundStyle(Theme.C.ink)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .textSelection(.enabled)
                NativeButton("Copy", kind: .secondary, small: true) {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(form.redirectUri, forType: .string)
                }
                Spacer(minLength: 0)
            }
            ForEach(form.fields) { field in
                FieldShell(label: field.label) {
                    let text = Binding(
                        get: { ownAppDraft[field.name] ?? "" },
                        set: { ownAppDraft[field.name] = $0 }
                    )
                    if field.secret {
                        SecureField("", text: text)
                            .nativeField(focused: ownAppFocused == field.name)
                            .focused($ownAppFocused, equals: field.name)
                            .accessibilityLabel(field.label)
                    } else {
                        TextField("", text: text)
                            .nativeField(focused: ownAppFocused == field.name)
                            .focused($ownAppFocused, equals: field.name)
                            .accessibilityLabel(field.label)
                    }
                }
            }
            HStack(spacing: 12) {
                NativeButton(busy ? "Connecting" : "Connect", kind: .primary, small: true, enabled: !busy && ownAppComplete(form)) {
                    submitOwnApp(row, form)
                }
                NativeButton("Cancel", kind: .secondary, small: true, enabled: !busy) {
                    model.dismissOwnApp()
                    ownAppDraft = [:]
                }
                Spacer(minLength: 0)
            }
        }
        .onAppear { ownAppFocused = form.fields.first?.name }
    }

    private func ownAppComplete(_ form: OwnAppForm) -> Bool {
        form.fields.allSatisfy { !(ownAppDraft[$0.name] ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    }

    private func submitOwnApp(_ row: ConnectorToolkit, _ form: OwnAppForm) {
        // The busy flag is set inside the task, so a second click before the
        // first hop is refused here rather than sent twice.
        guard ownAppComplete(form), model.connectorBusy == nil else { return }
        var credentials: [String: String] = [:]
        for field in form.fields {
            credentials[field.name] = (ownAppDraft[field.name] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        }
        Task {
            await model.connectOwnApp(row, credentials: credentials)
            if model.connectorOwnApp == nil { ownAppDraft = [:] }
        }
    }

    private func statusCopy(_ row: ConnectorToolkit, pending: Bool) -> String {
        if row.connected { return "Ready to use" }
        if pending { return "Waiting for approval in the browser" }
        if model.connectorTimedOut == row.slug { return "Still not connected. Try again." }
        if row.noAuth { return "No sign-in needed" }
        if row.ownApp { return "Needs your own app" }
        return "Not connected"
    }

    private var skeletonRows: some View {
        VStack(spacing: 0) {
            ForEach(0..<4, id: \.self) { index in
                HStack(spacing: 12) {
                    RoundedRectangle(cornerRadius: DesignTokens.Radius.sm, style: .continuous)
                        .fill(Theme.C.border)
                        .frame(width: 28, height: 28)
                    RoundedRectangle(cornerRadius: DesignTokens.Radius.xs, style: .continuous)
                        .fill(Theme.C.border)
                        .frame(width: 112, height: 14)
                    Spacer(minLength: 0)
                    RoundedRectangle(cornerRadius: DesignTokens.Radius.sm, style: .continuous)
                        .fill(Theme.C.border)
                        .frame(width: 80, height: 32)
                }
                .frame(minHeight: 52)
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .overlay(alignment: .bottom) {
                    if index < 3 { Hairline() }
                }
            }
        }
        .background(Theme.C.canvas)
        .overlay(
            RoundedRectangle(cornerRadius: DesignTokens.Radius.settingsGroup, style: .continuous)
                .strokeBorder(Theme.C.edge, lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: DesignTokens.Radius.settingsGroup, style: .continuous))
        .accessibilityLabel("Loading connectors")
    }
}

/// Grok's small grey "Add" capsule.
private struct AddPillButton: View {
    let title: String
    var enabled = true
    let action: () -> Void

    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(Theme.C.ink)
                .padding(.horizontal, 14)
                .frame(height: 30)
                .background(hovering && enabled ? Theme.C.border : Theme.C.sunken)
                .clipShape(Capsule())
                .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
        .opacity(enabled ? 1 : 0.6)
        .pointerOnHover()
        .onHover { hovering = $0 }
    }
}
