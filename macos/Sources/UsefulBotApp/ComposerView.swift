import AppKit
import SwiftUI
import UniformTypeIdentifiers
import UsefulBotCore

/// The chat composer: one rounded
/// container with a plus affordance on the left, a growing field, the
/// model/effort chip and a circular send (or stop) button on the right.
struct ComposerView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.noModelPreview) private var noModelPreview

    /// The same input cap `chat-composer.tsx` puts on its textarea. Nothing
    /// clips a turn once it is sent.
    static let maxDraftLength = Attachments.messageMax

    /// A chip label, clipped to what fits beside its chevron. Nil in, nil out,
    /// so a chip with nothing selected keeps its own placeholder word.
    static func chipLabel(_ name: String?, max: Int = 18) -> String? {
        guard let name, !name.isEmpty else { return nil }
        return name.count <= max ? name : String(name.prefix(max - 1)) + "…"
    }

    let bot: ShellBot
    var onOpenProviders: () -> Void

    @State private var plusOpen = false
    @State private var modeOpen = false
    @State private var showFolderImporter = false
    @State private var dropTargeted = false
    @State private var projectOpen = false
    @State private var permissionOpen = false
    @State private var plusButtonFrame = CGRect.zero
    @State private var modeChipFrame = CGRect.zero
    @State private var projectChipFrame = CGRect.zero
    @State private var permissionChipFrame = CGRect.zero
    @State private var focused = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Both, and in that order: a folder that would not attach and a
            // permission that would not apply are separate failures, and a
            // published error nothing renders is the same as no error at all.
            if let error = model.attachError ?? model.workspaceError {
                Text(error)
                    .font(.system(size: DesignTokens.FontSize.attachError))
                    .foregroundStyle(Theme.C.danger)
                    .padding(.horizontal, 2)
                    .padding(.bottom, 8)
            }
            field
            contextRow
        }
        .padding(.top, DesignTokens.Space.composerTop)
        .padding(.bottom, DesignTokens.Space.composerBottom)
        // One `fileImporter` per view: SwiftUI keeps only the last presentation
        // modifier of a kind on a view, so a second importer here for files
        // never opened. Files go through `NSOpenPanel` directly (`pickFiles`).
        .fileImporter(
            isPresented: $showFolderImporter,
            allowedContentTypes: [.folder],
            allowsMultipleSelection: false
        ) { result in
            switch result {
            case .success(let urls):
                if let url = urls.first {
                    model.setWorkspaceFolder(url)
                }
            case .failure: model.workspaceError = "That folder could not be read."
            }
        }
        .onExitCommand {
            plusOpen = false
            modeOpen = false
            projectOpen = false
            permissionOpen = false
        }
        .onChange(of: bot.id) { _, _ in
            // The menus belong to the bot they opened for.
            plusOpen = false
            modeOpen = false
            projectOpen = false
            permissionOpen = false
        }
    }

    private var placeholder: String {
        if replying != nil { return "Reply…" }
        if model.pendingRequests.contains(where: { !$0.options.isEmpty }) { return "Your message waits until you answer the card" }
        return bot.isGroup ? "Message this group. @name to direct one bot" : "Message \(bot.name)"
    }

    /// The reply chip belongs to the chat it was started in.
    private var replying: ReplyQuote? {
        model.replyQuotes[bot.id]
    }

    /// Whether `Attachments.formatMessage` would come back non-empty, without
    /// building it: every attachment adds a named part, so only an empty
    /// draft with no files formats to nothing. This runs on every body pass,
    /// and formatting scanned each attached file's text for fences.
    private var canSend: Bool {
        // The preview bar blocks the keyboard too: a verification run never sends.
        guard !model.noModelConnected, !noModelPreview else { return false }
        return !model.attachments.isEmpty
            || !model.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private var workspace: BotWorkspace? { bot.workspace }

    /// Only per-message files stack above the field. The working folder is a
    /// setting of the conversation, and the project chip under the field is
    /// where it shows; a second chip inside the field said the same thing.
    private var stacked: Bool { !model.attachments.isEmpty || replying != nil }

    private var field: some View {
        VStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 8) {
                if let replying { replyChip(replying) }
                if !model.attachments.isEmpty { attachmentsRow }
                HStack(alignment: .bottom, spacing: 8) {
                    plusButton
                    input
                    Spacer(minLength: 0)
                    sendButton.padding(.bottom, 2)
                }
            }
            .padding(.horizontal, 10)
            .padding(.top, stacked ? 10 : 8)
            .padding(.bottom, 8)
            // A 2% fall from the top edge: enough to read as a raised field,
            // not enough to read as a gradient.
            .background(
                LinearGradient(
                    colors: [Theme.C.bubbleBot, Theme.C.bubbleBot.opacity(0.98)],
                    startPoint: .top,
                    endPoint: .bottom
                )
                .background(Theme.C.sunken)
            )
            .overlay(
                RoundedRectangle(
                    cornerRadius: stacked || focused ? DesignTokens.Radius.composerExpanded : 26,
                    style: .continuous
                )
                // The caret is thin and the placeholder greys out either way,
                // so the edge is what tells you the field is live. A file
                // held over it lights the edge in the accent: the drop lands
                // as an attachment.
                .strokeBorder(
                    dropTargeted ? Theme.C.accentStrong : (focused ? Theme.C.borderStrong : Theme.C.edge),
                    lineWidth: 1
                )
            )
            // Drops on the chips, the padding or the buttons; the text view
            // catches the ones over the field itself and forwards them the
            // same way.
            .onDrop(of: [.fileURL], isTargeted: $dropTargeted) { providers in
                DroppedFiles.urls(from: providers) { urls in
                    // A drop this view claimed has to end in something: an
                    // attachment, or a line saying why not.
                    if urls.isEmpty {
                        model.attachError = "That file could not be read."
                    } else {
                        model.addAttachments(urls)
                    }
                }
                return true
            }
            .clipShape(
                RoundedRectangle(
                    cornerRadius: stacked || focused ? DesignTokens.Radius.composerExpanded : 26,
                    style: .continuous
                )
            )
            .raiseShadow()
            .animation(.easeOut(duration: DesignTokens.Motion.fast), value: stacked)
            // The corner radius also tracks focus, and without this the shape
            // snapped the instant the field took the caret. Clicking into the
            // composer is the most common interaction in the app; it should
            // ease like everything else.
            .animation(.easeOut(duration: DesignTokens.Motion.fast), value: focused)
            // `.composer-plus-menu` sits at the leading edge, above the field.
            .overlay(alignment: .topLeading) {
                if plusOpen {
                    VStack(spacing: 0) {
                        PlusMenu(
                            onAttach: {
                                plusOpen = false
                                pickFiles()
                            },
                            onAttachFolder: {
                                plusOpen = false
                                showFolderImporter = true
                            }
                        )
                        .fixedSize()
                        .dismissOnOutsideClick(triggers: { [plusButtonFrame] }) { plusOpen = false }
                        Spacer(minLength: 8)
                    }
                    .frame(height: 0, alignment: .bottom)
                    .transition(.opacity)
                }
            }
            // `.composer-mode-card` opens above the chip at the trailing edge.
            .overlay(alignment: .topTrailing) {
                if modeOpen, let composer = model.composer {
                    VStack(spacing: 0) {
                        ComposerModeMenu(
                            composer: composer,
                            onClose: { modeOpen = false },
                            onOpenProviders: {
                                modeOpen = false
                                onOpenProviders()
                            },
                            onSave: { patch in
                                // A model pick keeps the menu open so its
                                // effort can be picked next.
                                if patch.modelId == nil { modeOpen = false }
                                Task {
                                    await model.saveComposer(
                                        modelId: patch.modelId,
                                        effort: patch.effort,
                                        speed: patch.speed
                                    )
                                }
                            }
                        )
                        .fixedSize()
                        .dismissOnOutsideClick(triggers: { [modeChipFrame] }) { modeOpen = false }
                        Spacer(minLength: 8)
                    }
                    .frame(height: 0, alignment: .bottom)
                    .padding(.trailing, 44)
                    .transition(.opacity)
                }
            }
            .animation(.easeOut(duration: DesignTokens.Motion.fast), value: plusOpen)
            .animation(.easeOut(duration: DesignTokens.Motion.fast), value: modeOpen)
            // `.composer-project-card` opens above the leading edge.
            .overlay(alignment: .topLeading) {
                if projectOpen {
                    VStack(spacing: 0) {
                        ProjectMenu(
                            projects: model.workspaceProjects,
                            currentPath: workspace?.path,
                            onPick: { path in
                                projectOpen = false
                                model.setWorkspaceFolder(URL(fileURLWithPath: path))
                            },
                            onNew: {
                                projectOpen = false
                                showFolderImporter = true
                            },
                            onDetach: {
                                projectOpen = false
                                model.clearWorkspaceFolder()
                            },
                            onRemove: { id in
                                model.removeWorkspaceProject(id: id)
                            }
                        )
                        .fixedSize()
                        .dismissOnOutsideClick(triggers: { [projectChipFrame] }) { projectOpen = false }
                        Spacer(minLength: 8)
                    }
                    .frame(height: 0, alignment: .bottom)
                    .transition(.opacity)
                }
            }
            // `.composer-permission-card` opens beside it, above the composer.
            .overlay(alignment: .topLeading) {
                if permissionOpen {
                    VStack(spacing: 0) {
                        PermissionMenu(
                            permission: bot.permission,
                            onPermission: { id in
                                model.setWorkspacePermission(id)
                                permissionOpen = false
                            }
                        )
                        .fixedSize()
                        .dismissOnOutsideClick(triggers: { [permissionChipFrame] }) { permissionOpen = false }
                        Spacer(minLength: 8)
                    }
                    .frame(height: 0, alignment: .bottom)
                    .padding(.leading, 132)
                    .transition(.opacity)
                }
            }
        }
    }

    /// The chip row under the composer: working folder, permission, and the
    /// model/effort chip the reference layout keeps under the field.
    private var contextRow: some View {
        HStack(spacing: 10) {
            projectChip
            permissionChip
            Spacer(minLength: 0)
            modeChip
        }
        .padding(.top, 6)
        .padding(.horizontal, 2)
    }

    private var input: some View {
        ZStack(alignment: .topLeading) {
            // Stays until the first character, with the caret before it, the
            // way Messages and Claude do it. Hidden on focus, a chat that
            // opened with the field focused showed an empty box that named
            // nobody.
            if model.draft.isEmpty {
                Text(placeholder)
                    .font(.system(size: DesignTokens.FontSize.chatBody))
                    .foregroundStyle(Theme.C.inkFaint)
                    .padding(.top, 7)
                    // Starts just past the caret, which sits at the text
                    // view's line padding (5 pt): level with it, the caret
                    // struck through the first letter.
                    .padding(.leading, 7)
                    .allowsHitTesting(false)
            }
            ComposerTextView(
                text: $model.draft,
                writeToken: model.draftWriteToken,
                returnSends: true,
                canSend: { canSend },
                pending: { model.pending },
                onSend: { send() },
                onFocusChange: { focused = $0 },
                onDropFiles: { model.addAttachments($0) },
                focusToken: model.composerFocusToken
            )
            .accessibilityLabel(placeholder)
        }
        .frame(minHeight: DesignTokens.Control.composerInput, alignment: .leading)
    }

    private var plusButton: some View {
        Button {
            modeOpen = false
            projectOpen = false
            permissionOpen = false
            plusOpen.toggle()
        } label: {
            Image(systemName: "plus")
                .font(.system(size: 15, weight: .regular))
                .foregroundStyle(Theme.C.inkMuted)
                .frame(width: DesignTokens.Control.composerButton, height: DesignTokens.Control.composerButton)
                .background(Theme.C.sunken)
                .clipShape(Circle())
        }
        .buttonStyle(PlusButtonStyle())
        .pointerOnHover()
        .trackWindowFrame($plusButtonFrame)
        .accessibilityLabel("Attach files or a folder")
    }

    private var projectChip: some View {
        Button {
            plusOpen = false
            permissionOpen = false
            modeOpen = false
            if !projectOpen {
                Task { await model.loadWorkspaceProjects() }
            }
            projectOpen.toggle()
        } label: {
            HStack(spacing: 4) {
                // A real symbol name: the drive icon this used was misspelt
                // and never drew, which left the chip as bare text.
                Image(systemName: workspace == nil ? "folder" : "folder.fill")
                    .font(.system(size: 12))
                // Clipped by characters rather than held in a fixed-width
                // frame: a frame wide enough for a long name leaves a short
                // one stranded from its chevron, which is what this chip did.
                Text(ComposerView.chipLabel(workspace?.folderName) ?? "Project")
                    .lineLimit(1)
                Image(systemName: "chevron.down")
                    .font(.system(size: 11, weight: .regular))
            }
            .font(.system(size: DesignTokens.FontSize.modeChip, weight: .medium))
            .foregroundStyle(Theme.C.inkMuted)
            .frame(height: DesignTokens.Control.composerInput)
        }
        .buttonStyle(ModeChipStyle())
        .pointerOnHover()
        .trackWindowFrame($projectChipFrame)
        .accessibilityLabel("Working folder for this conversation")
    }

    private var permissionChip: some View {
        Button {
            plusOpen = false
            projectOpen = false
            modeOpen = false
            permissionOpen.toggle()
        } label: {
            HStack(spacing: 4) {
                Image(systemName: permissionIcon(bot.permission))
                    .font(.system(size: 12))
                Text(bot.permissionLabel)
                    .lineLimit(1)
                Image(systemName: "chevron.down")
                    .font(.system(size: 11, weight: .regular))
            }
            .font(.system(size: DesignTokens.FontSize.modeChip, weight: .medium))
            .foregroundStyle(bot.isFullAccess ? Theme.C.accentStrong : Theme.C.inkMuted)
            .frame(height: DesignTokens.Control.composerInput)
        }
        .buttonStyle(ModeChipStyle())
        .pointerOnHover()
        .trackWindowFrame($permissionChipFrame)
        .accessibilityLabel("What the bot may do on this Mac")
    }

    private func permissionIcon(_ permission: String) -> String {
        PermissionMenu.options.first { $0.id == permission }?.icon ?? "bolt.shield"
    }

    private var modeChip: some View {
        Button {
            plusOpen = false
            projectOpen = false
            permissionOpen = false
            modeOpen.toggle()
        } label: {
            // The model by name, then its effort, like the Providers page chip.
            HStack(spacing: 4) {
                // A model that is gone stays named, struck through and muted:
                // the chip never swaps in another model on its own. With no
                // model named at all (nothing connected) it is a plain "Model".
                let unavailable = model.composer?.available == false
                    && ComposerView.chipLabel(model.composer?.modelLabel, max: 24) != nil
                Text(ComposerView.chipLabel(model.composer?.modelLabel, max: 24) ?? "Model")
                    .strikethrough(unavailable)
                    .foregroundStyle(unavailable ? Theme.C.inkMuted : Theme.C.ink)
                    .lineLimit(1)
                if let meta = model.composer?.chipMeta {
                    Text(meta)
                        .lineLimit(1)
                }
                Image(systemName: "chevron.down")
                    .font(.system(size: 11, weight: .regular))
            }
            .font(.system(size: DesignTokens.FontSize.modeChip, weight: .medium))
            .foregroundStyle(Theme.C.inkMuted)
            .frame(height: DesignTokens.Control.composerInput)
        }
        .buttonStyle(ModeChipStyle())
        .pointerOnHover()
        .trackWindowFrame($modeChipFrame)
        .accessibilityLabel("Effort, speed, and model")
    }

    @ViewBuilder
    private var sendButton: some View {
        // Stop while the bot works, and while only sub-agents run and there is
        // nothing typed to send.
        if model.pending || (model.subagentsRunning && !canSend) {
            Button(action: model.cancel) {
                ZStack {
                    Circle().fill(Theme.C.brand)
                        .frame(width: DesignTokens.Control.composerButton, height: DesignTokens.Control.composerButton)
                    RoundedRectangle(cornerRadius: 1.5)
                        .strokeBorder(Theme.C.brandInk, lineWidth: 1.6)
                        .frame(width: 10, height: 10)
                }
            }
            .buttonStyle(.plain)
            .pointerOnHover()
            .accessibilityLabel("Stop")
        } else {
            Button(action: send) {
                ZStack {
                    Circle()
                        .fill(canSend ? Theme.C.brand : Theme.C.sunken)
                        .overlay(
                            Circle().fill(LinearGradient(
                                colors: [Theme.C.white.opacity(canSend ? 0.14 : 0), .clear],
                                startPoint: .top,
                                endPoint: .bottom
                            ))
                        )
                        .frame(width: DesignTokens.Control.composerButton, height: DesignTokens.Control.composerButton)
                        .shadow(color: Theme.C.shadow.opacity(canSend ? 0.18 : 0), radius: 3, x: 0, y: 1)
                    Image(systemName: "arrow.up")
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(canSend ? Theme.C.brandInk : Theme.C.inkFaint)
                }
            }
            .buttonStyle(.plain)
            .disabled(!canSend)
            .pointerOnHover()
            .accessibilityLabel("Send")
        }
    }

    @ViewBuilder
    private var attachmentsRow: some View {
        // Chips wrap like the transcript's search chips; a plain row clipped
        // once three or more files were attached.
        WrapHStack(spacing: 8) {
            ForEach(model.attachments) { file in
                if file.isImage {
                    imageChip(file)
                } else {
                    fileChip(file)
                }
            }
        }
        .padding(.horizontal, 4)
        .padding(.top, 2)
    }

    /// An attached picture as a small preview, its remove button on the corner.
    private func imageChip(_ file: Attachment) -> some View {
        AttachmentPreview(file: file, side: 56)
            .overlay(alignment: .topTrailing) {
                Button {
                    model.removeAttachment(id: file.id)
                } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 9, weight: .bold))
                        .foregroundStyle(.white)
                        .frame(width: 20, height: 20)
                        .background(Circle().fill(Color.black.opacity(0.6)))
                        // A larger target than the circle it draws.
                        .padding(4)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Remove \(file.name)")
            }
    }

    private func fileChip(_ file: Attachment) -> some View {
                HStack(spacing: 6) {
                    Text(file.name)
                        .font(.system(size: 12))
                        .foregroundStyle(Theme.C.ink)
                        .lineLimit(1)
                        .frame(maxWidth: 180, alignment: .leading)
                    Button {
                        model.removeAttachment(id: file.id)
                    } label: {
                        Image(systemName: "xmark")
                            .font(.system(size: 9, weight: .medium))
                            .foregroundStyle(Theme.C.inkMuted)
                            .frame(width: 20, height: 20)
                    }
                    .buttonStyle(.plain)
                }
                .padding(.leading, 10)
                .padding(.trailing, 6)
                .frame(height: 28)
                .background(Theme.C.sunken)
                .clipShape(Capsule())
    }

    /// The message being replied to: an arrow, its opening words, and a way
    /// to drop it.
    private func replyChip(_ quote: ReplyQuote) -> some View {
        HStack(spacing: 6) {
            Image(systemName: "arrowshape.turn.up.left")
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(Theme.C.inkMuted)
            Text(ReplyQuote.preview(quote.text))
                .font(.system(size: 12))
                .foregroundStyle(Theme.C.ink)
                .lineLimit(1)
                .truncationMode(.tail)
                .frame(maxWidth: 360, alignment: .leading)
            Button {
                model.replyQuotes[quote.botId] = nil
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 9, weight: .medium))
                    .foregroundStyle(Theme.C.inkMuted)
                    .frame(width: 20, height: 20)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .pointerOnHover()
            .accessibilityLabel("Cancel reply")
        }
        .padding(.leading, 10)
        .padding(.trailing, 6)
        .frame(height: 28)
        .background(Theme.C.sunken)
        .clipShape(Capsule())
        .padding(.horizontal, 4)
        .padding(.top, 2)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Replying to a message")
    }

    /// The native open panel, for files. Not `fileImporter`: see `body`.
    private func pickFiles() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = true
        panel.message = "Add files to this message"
        let handler: (NSApplication.ModalResponse) -> Void = { response in
            guard response == .OK else { return }
            model.addAttachments(panel.urls)
        }
        if let window = NSApp.keyWindow {
            panel.beginSheetModal(for: window, completionHandler: handler)
        } else {
            panel.begin(completionHandler: handler)
        }
    }

    private func send() {
        guard canSend, !model.pending else { return }
        // The folder is not mentioned in the message. The grant travels by
        // session: the tools resolve their root and permission from it, and
        // the instructions already tell the model what a granted folder means.
        // Restating it here put a long absolute path in every bubble the owner
        // sends, to tell the agent something it already knew. The chip under
        // the composer is where the owner sees which folder is attached.
        let formatted = Attachments.formatMessage(model.draft, files: model.attachments)
        let message = replying?.wrap(formatted, group: bot.isGroup) ?? formatted
        modeOpen = false
        // The model clears the composer once the turn is accepted, so a send
        // that fails before that keeps the draft.
        model.send(message)
    }
}

/// File URLs out of a drop's item providers, delivered once on the main actor.
/// The completion always fires, with an empty list when nothing loaded, so
/// the caller can say so instead of swallowing the drop.
enum DroppedFiles {
    static func urls(from providers: [NSItemProvider], completion: @escaping @MainActor ([URL]) -> Void) {
        let candidates = providers.filter { $0.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) }
        guard !candidates.isEmpty else {
            Task { @MainActor in completion([]) }
            return
        }
        let group = DispatchGroup()
        let lock = NSLock()
        var urls: [URL?] = Array(repeating: nil, count: candidates.count)
        for (index, provider) in candidates.enumerated() {
            group.enter()
            provider.loadDataRepresentation(forTypeIdentifier: UTType.fileURL.identifier) { data, _ in
                defer { group.leave() }
                guard let data, let url = URL(dataRepresentation: data, relativeTo: nil), url.isFileURL else { return }
                lock.lock()
                urls[index] = url
                lock.unlock()
            }
        }
        group.notify(queue: .main) {
            let found = urls.compactMap { $0 }
            Task { @MainActor in completion(found) }
        }
    }
}

/// `@State` inside a `ButtonStyle` has no view identity to hang off, so the
/// hover flag these used to keep there was shared and went stale: the plus and
/// the chip would stay lit after the pointer left, or light up a beat late.
/// The flag belongs to a real view, which is what these wrappers are.
private struct HoverBox<Content: View>: View {
    @ViewBuilder var content: (Bool) -> Content

    @State private var hovering = false

    var body: some View {
        content(hovering)
            .animation(.easeOut(duration: DesignTokens.Motion.fast), value: hovering)
            .onHover { hovering = $0 }
    }
}

private struct PlusButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        HoverBox { hovering in
            configuration.label
                .background(hovering ? Theme.C.borderStrong : Theme.C.sunken)
                .clipShape(Circle())
                .opacity(configuration.isPressed ? 0.75 : 1)
        }
    }
}

private struct ModeChipStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        HoverBox { hovering in
            configuration.label
                .foregroundStyle(hovering ? Theme.C.ink : Theme.C.inkMuted)
                .opacity(configuration.isPressed ? 0.75 : 1)
        }
    }
}

/// `.composer-plus-menu`: photos and files, or a folder. Connectors live in
/// one place, the rail's button beside the owner's photo. Rows match the
/// permission menu beside it: an icon and one line each.
private struct PlusMenu: View {
    let onAttach: () -> Void
    let onAttachFolder: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            item(icon: "paperclip", title: "Photos and files", action: onAttach)
            item(icon: "folder", title: "Folder", action: onAttachFolder)
        }
        .padding(.vertical, 6)
        .frame(width: 248)
        .background(Theme.C.surface)
        .overlay(
            RoundedRectangle(cornerRadius: DesignTokens.Radius.lg, style: .continuous)
                .strokeBorder(Theme.C.edge, lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: DesignTokens.Radius.lg, style: .continuous))
        .popShadow()
    }

    private func item(icon: String, title: String, action: @escaping () -> Void) -> some View {
        MenuRowButton(action: action) {
            HStack(spacing: 10) {
                Image(systemName: icon)
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.C.inkMuted)
                    .frame(width: 18)
                Text(title)
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.C.ink)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 12)
            .frame(height: 36)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

/// `.composer-project-card`: the folder recents plus New project.
private struct ProjectMenu: View {
    let projects: [ProjectEntry]
    let currentPath: String?
    let onPick: (_ path: String) -> Void
    let onNew: () -> Void
    let onDetach: () -> Void
    let onRemove: (_ id: String) -> Void

    var body: some View {
        VStack(spacing: 0) {
            Text("Projects")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(Theme.C.inkFaint)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 12)
                .padding(.top, 10)
                .padding(.bottom, 6)
            ScrollView {
                VStack(spacing: 0) {
                    if projects.isEmpty {
                        Text("Folders you work in show up here")
                            .font(.system(size: 12))
                            .foregroundStyle(Theme.C.inkFaint)
                            .padding(.horizontal, 12)
                            .padding(.bottom, 8)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    ForEach(projects) { project in
                        ProjectRow(
                            project: project,
                            isCurrent: project.path == currentPath,
                            onPick: { onPick(project.path) },
                            onRemove: { onRemove(project.id) }
                        )
                    }
                }
            }
            .frame(maxHeight: 260)
            Rectangle()
                .fill(Theme.C.border)
                .frame(height: 1)
            MenuRowButton(action: onNew) {
                HStack(spacing: 8) {
                    Image(systemName: "plus")
                        .font(.system(size: 13))
                        .foregroundStyle(Theme.C.inkMuted)
                    Text("New project")
                        .font(.system(size: 13))
                        .foregroundStyle(Theme.C.ink)
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, 12)
                .frame(height: 36)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            // The × that detached the folder lived on the chip inside the
            // field; with that chip gone, this is where a folder is let go.
            if currentPath != nil {
                MenuRowButton(action: onDetach) {
                    HStack(spacing: 8) {
                        Image(systemName: "xmark")
                            .font(.system(size: 13))
                            .foregroundStyle(Theme.C.inkMuted)
                        Text("Detach folder")
                            .font(.system(size: 13))
                            .foregroundStyle(Theme.C.ink)
                        Spacer(minLength: 0)
                    }
                    .padding(.horizontal, 12)
                    .frame(height: 36)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
        .frame(width: 248)
        .background(Theme.C.surface)
        .overlay(
            RoundedRectangle(cornerRadius: DesignTokens.Radius.lg, style: .continuous)
                .strokeBorder(Theme.C.edge, lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: DesignTokens.Radius.lg, style: .continuous))
        .popShadow()
    }
}

/// One recent folder. The row picks; the × that appears on hover forgets it.
/// Removing an attached folder only drops it from recents: the grant itself is
/// let go through "Detach folder" below.
private struct ProjectRow: View {
    let project: ProjectEntry
    let isCurrent: Bool
    let onPick: () -> Void
    let onRemove: () -> Void

    @State private var hovering = false
    @State private var removeArmed = false
    @State private var hoverStamp = 0

    var body: some View {
        MenuRowButton(action: onPick) {
            HStack(spacing: 8) {
                Image(systemName: "folder")
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.C.inkMuted)
                Text(project.name)
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.C.ink)
                    .lineLimit(1)
                Spacer(minLength: 0)
                if isCurrent, !removeArmed {
                    Image(systemName: "checkmark")
                        .font(.system(size: 12))
                        .foregroundStyle(Theme.C.inkMuted)
                }
            }
            .padding(.horizontal, 12)
            .frame(height: 36)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        // The × sits above the pick button rather than inside its label, and
        // it only exists once the pointer has settled on the row: a removal
        // slides the next row under the resting cursor, and an armed-but-
        // unseen × there would eat a press aimed at the row just removed.
        // While hidden, the trailing strip swallows presses so a near-miss on
        // the × zone cannot pick the folder underneath.
        .overlay(alignment: .trailing) {
            if removeArmed {
                Button(action: onRemove) {
                    Image(systemName: "xmark")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(Theme.C.inkMuted)
                        .frame(width: 22, height: 22)
                        .background(Theme.C.sunken, in: Circle())
                }
                .buttonStyle(.plain)
                .frame(width: 34, height: 36)
                .contentShape(Rectangle())
                .pointerOnHover()
                .help("Remove from list")
                .accessibilityLabel("Remove from list")
                .transition(.opacity)
            } else {
                Color.clear
                    .frame(width: 34, height: 36)
                    .contentShape(Rectangle())
                    .onTapGesture {}
            }
        }
        .onHover { over in
            hovering = over
            hoverStamp += 1
            let stamp = hoverStamp
            if over {
                Task { @MainActor in
                    try? await Task.sleep(for: .milliseconds(200))
                    if hovering, stamp == hoverStamp { removeArmed = true }
                }
            } else {
                removeArmed = false
            }
        }
        .animation(.easeOut(duration: 0.12), value: removeArmed)
    }
}

/// `.composer-permission-card`: what the bot may do on this Mac.
private struct PermissionMenu: View {
    let permission: String
    let onPermission: (_ id: String) -> Void

    static let options: [(id: String, label: String, icon: String)] = [
        ("read_only", "Read only", "book"),
        ("auto", "Auto", "bolt.shield"),
        ("full_access", "Full access", "checkmark.shield"),
    ]

    var body: some View {
        VStack(spacing: 0) {
            Text("Permission")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(Theme.C.inkFaint)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 12)
                .padding(.top, 10)
                .padding(.bottom, 4)
            ForEach(Self.options, id: \.id) { option in
                MenuRowButton(action: { onPermission(option.id) }) {
                    HStack(spacing: 8) {
                        Image(systemName: option.icon)
                            .font(.system(size: 13))
                            .foregroundStyle(Theme.C.inkMuted)
                            .frame(width: 18)
                        Text(option.label)
                            .font(.system(size: 13))
                            .foregroundStyle(Theme.C.ink)
                        Spacer(minLength: 0)
                        if permission == option.id {
                            Image(systemName: "checkmark")
                                .font(.system(size: 12))
                                .foregroundStyle(Theme.C.inkMuted)
                        }
                    }
                    .padding(.horizontal, 12)
                    .frame(height: 36)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
        .padding(.bottom, 6)
        .frame(width: 248)
        .background(Theme.C.surface)
        .overlay(
            RoundedRectangle(cornerRadius: DesignTokens.Radius.lg, style: .continuous)
                .strokeBorder(Theme.C.edge, lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: DesignTokens.Radius.lg, style: .continuous))
        .popShadow()
    }
}

/// A menu-style row with the sunken hover the web uses on pop items.
struct MenuRowButton<Label: View>: View {
    let action: () -> Void
    @ViewBuilder var label: Label

    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            label
                .background(hovering ? Theme.C.sunken : .clear)
                .clipShape(RoundedRectangle(cornerRadius: DesignTokens.Radius.channel, style: .continuous))
                .contentShape(RoundedRectangle(cornerRadius: DesignTokens.Radius.channel, style: .continuous))
        }
        .buttonStyle(.plain)
        .pointerOnHover()
        .onHover { hovering = $0 }
    }
}

/// `.composer-mode-card` plus its flyout, anchored above the chip.
private struct ComposerModeMenu: View {
    let composer: ComposerState
    let onClose: () -> Void
    let onOpenProviders: () -> Void
    let onSave: (_ patch: ComposerPatch) -> Void

    @State private var flyout: Flyout?
    @State private var hoverTask: Task<Void, Never>?
    /// A model pick is saving; the effort list opens once the saved state
    /// (and that model's efforts) comes back.
    @State private var pendingModel = false

    enum Flyout {
        case effort
        case model
    }

    /// Hover delay before the flyout opens; instant pops read as flicker.
    private static let hoverDelay: Duration = .milliseconds(500)

    var body: some View {
        HStack(alignment: .bottom, spacing: 6) {
            if flyout != nil {
                flyoutCard
            }
            card
        }
        // The flyout persists on purpose: it opened because the pointer
        // hovered a row, and it only leaves when a selection is made, the
        // menu closes, or the pointer hovers the other row.
        .onHover { hovering in
            if !hovering { hoverTask?.cancel() }
        }
        .onChange(of: composer) { _, next in
            guard pendingModel else { return }
            pendingModel = false
            flyout = next.efforts.isEmpty ? nil : .effort
        }
    }

    /// Picking a model moves straight to its effort list, since efforts
    /// differ per model. A pick of the current model has nothing to save.
    private func pickModel(_ patch: ComposerPatch?) {
        hoverTask?.cancel()
        guard let patch else {
            flyout = composer.efforts.isEmpty ? nil : .effort
            return
        }
        pendingModel = true
        onSave(patch)
    }

    /// Open the flyout after the hover settles. Hover only opens; it never
    /// switches an open flyout. The pointer crosses the Effort row on its way
    /// up to the model search, and a switch there swapped the model list out
    /// from under it. Switching takes a click on the row.
    private func hover(_ target: Flyout) {
        hoverTask?.cancel()
        guard flyout == nil else { return }
        // A plain Task body runs off the main actor; the flyout is SwiftUI
        // state and must be written on the main thread.
        hoverTask = Task { @MainActor in
            try? await Task.sleep(for: Self.hoverDelay)
            guard !Task.isCancelled else { return }
            flyout = target
        }
    }

    private var card: some View {
        VStack(spacing: 0) {
            if composer.speeds.contains(where: { $0.id == "fast" }) {
                // The web renders the track as a span inside the row button, so
                // the row itself is the only hit target.
                MenuRowButton(action: { onSave(ComposerPatch(speed: composer.speed == "fast" ? "standard" : "fast")) }) {
                    HStack {
                        Text("Fast")
                            .font(.system(size: 13))
                        Spacer(minLength: 0)
                        SwitchVisual(isOn: composer.speed == "fast")
                    }
                    .padding(.horizontal, 12)
                    .frame(height: 36)
                    .frame(maxWidth: .infinity)
                }
            }
            if !composer.efforts.isEmpty {
                MenuRowButton(action: { flyout = .effort }) {
                    HStack {
                        Text("Effort")
                            .font(.system(size: 13))
                        Spacer(minLength: 0)
                        HStack(spacing: 2) {
                            Text(composer.effortLabel ?? "")
                            Image(systemName: "chevron.right")
                                .font(.system(size: 11))
                        }
                        .font(.system(size: 13))
                        .foregroundStyle(Theme.C.inkMuted)
                    }
                    .padding(.horizontal, 12)
                    .frame(height: 36)
                    .frame(maxWidth: .infinity)
                    .background(flyout == .effort ? Theme.C.sunken : .clear)
                }
                .onHover { hovering in
                    guard hovering else { return }
                    hover(.effort)
                }
            }
            Rectangle()
                .fill(Theme.C.border)
                .frame(height: 1)
            MenuRowButton(action: { flyout = .model }) {
                HStack {
                    let named = ComposerView.chipLabel(composer.modelLabel) != nil
                    Text(composer.available || !named ? "Model" : "Model unavailable")
                        .font(.system(size: 13))
                    Spacer(minLength: 0)
                    HStack(spacing: 2) {
                        Text(composer.modelLabel)
                            .strikethrough(!composer.available && named)
                            .lineLimit(1)
                        Image(systemName: "chevron.right")
                            .font(.system(size: 11))
                    }
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.C.inkMuted)
                }
                .padding(.horizontal, 12)
                .frame(height: 36)
                .frame(maxWidth: .infinity)
                .background(flyout == .model ? Theme.C.sunken : .clear)
            }
            .onHover { hovering in
                guard hovering else { return }
                hover(.model)
            }
        }
        .frame(width: 232)
        .background(Theme.C.surface)
        .overlay(
            RoundedRectangle(cornerRadius: DesignTokens.Radius.lg, style: .continuous)
                .strokeBorder(Theme.C.edge, lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: DesignTokens.Radius.lg, style: .continuous))
        .popShadow()
    }

    @ViewBuilder
    private var flyoutCard: some View {
        VStack(spacing: 0) {
            switch flyout {
            case .effort:
                ScrollView {
                    VStack(spacing: 0) {
                        ForEach(composer.efforts, id: \.id) { item in
                            MenuRowButton(action: { onSave(ComposerPatch(effort: item.id)) }) {
                                HStack {
                                    Text(item.label)
                                        .font(.system(size: 13))
                                        .foregroundStyle(Theme.C.ink)
                                    Spacer(minLength: 0)
                                    if composer.effort == item.id {
                                        Image(systemName: "checkmark")
                                            .font(.system(size: 12))
                                            .foregroundStyle(Theme.C.inkMuted)
                                    }
                                }
                                .padding(.horizontal, 12)
                                .frame(height: 36)
                                .frame(maxWidth: .infinity)
                                .background(composer.effort == item.id ? Theme.C.sunken : .clear)
                            }
                        }
                    }
                }
                .frame(maxHeight: 240)
            case .model:
                ModelFlyout(composer: composer, onPick: pickModel, onOpenProviders: onOpenProviders)
            case .none:
                EmptyView()
            }
        }
        .frame(width: 260)
        .background(Theme.C.surface)
        .overlay(
            RoundedRectangle(cornerRadius: DesignTokens.Radius.lg, style: .continuous)
                .strokeBorder(Theme.C.edge, lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: DesignTokens.Radius.lg, style: .continuous))
        .popShadow()
    }
}

/// `.composer-model-flyout`: the searchable model list, one section per
/// connected connection from `composer.groups`. The server orders the active
/// connection first. A section header toggles its models; picking a model in
/// another group saves "<connectionId>::<modelId>", which switches the active
/// connection and the model in one write.
private struct ModelFlyout: View {
    let composer: ComposerState
    /// Nil when the pick is the model already in use.
    let onPick: (_ patch: ComposerPatch?) -> Void
    let onOpenProviders: () -> Void

    @State private var query = ""
    @FocusState private var searchFocused: Bool
    /// Opened sections by connection id. Every section starts collapsed, so
    /// the list opens as one row per connection; a search opens every section
    /// with a match.
    @State private var expanded: Set<String> = []

    private var searching: Bool {
        !query.trimmingCharacters(in: .whitespaces).isEmpty
    }

    private func isOpen(_ group: ComposerState.Group) -> Bool {
        searching || expanded.contains(group.connectionId)
    }

    private struct Section {
        let group: ComposerState.Group
        let models: [ComposerState.Option]
    }

    private var sections: [Section] {
        let needle = query.trimmingCharacters(in: .whitespaces).lowercased()
        return composer.groups.compactMap { group in
            guard !needle.isEmpty else { return Section(group: group, models: group.models) }
            if group.label.lowercased().contains(needle) {
                return Section(group: group, models: group.models)
            }
            let models = group.models.filter {
                $0.label.lowercased().contains(needle) || $0.id.lowercased().contains(needle)
            }
            // The search hides sections with no matches.
            guard !models.isEmpty else { return nil }
            return Section(group: group, models: models)
        }
    }

    /// Servers from before groups existed send only the flat list, which
    /// reads as today's rows with no header.
    private var legacyModels: [ComposerState.Option] {
        let needle = query.trimmingCharacters(in: .whitespaces).lowercased()
        guard !needle.isEmpty else { return composer.models }
        return composer.models.filter {
            $0.label.lowercased().contains(needle) || $0.id.lowercased().contains(needle)
        }
    }

    private func isCurrent(group: ComposerState.Group, model: ComposerState.Option) -> Bool {
        guard composer.modelId == model.id else { return false }
        return composer.connectionId.isEmpty || composer.connectionId == group.connectionId
    }

    private func pick(group: ComposerState.Group, model: ComposerState.Option) {
        if isCurrent(group: group, model: model) {
            onPick(nil)
        } else if !composer.connectionId.isEmpty, group.connectionId != composer.connectionId {
            onPick(ComposerPatch(modelId: "\(group.connectionId)::\(model.id)"))
        } else {
            onPick(ComposerPatch(modelId: model.id))
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                TextField("Search models", text: $query)
                    .textFieldStyle(.plain)
                    .font(.system(size: 13))
                    .focused($searchFocused)
            }
            .padding(.horizontal, 12)
            .frame(height: 36)
            .overlay(alignment: .bottom) { Hairline() }

            ScrollView {
                VStack(spacing: 0) {
                    if composer.groups.isEmpty {
                        if legacyModels.isEmpty {
                            Text("No models match")
                                .font(.system(size: 13))
                                .foregroundStyle(Theme.C.inkMuted)
                                .padding(12)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        } else {
                            ForEach(legacyModels, id: \.id) { item in
                                modelRow(
                                    label: item.label,
                                    selected: composer.modelId == item.id,
                                    action: { onPick(composer.modelId == item.id ? nil : ComposerPatch(modelId: item.id)) }
                                )
                            }
                        }
                    } else if sections.isEmpty {
                        Text("No models match")
                            .font(.system(size: 13))
                            .foregroundStyle(Theme.C.inkMuted)
                            .padding(12)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    } else {
                        ForEach(Array(sections.enumerated()), id: \.element.group.connectionId) { index, section in
                            if index > 0 {
                                Hairline()
                            }
                            sectionHeader(section.group)
                            if isOpen(section.group) {
                                ForEach(section.models, id: \.id) { item in
                                    modelRow(
                                        label: item.label,
                                        selected: isCurrent(group: section.group, model: item),
                                        action: { pick(group: section.group, model: item) }
                                    )
                                }
                            }
                        }
                    }
                }
            }
            .frame(maxHeight: 320)

            // `.composer-mode-add`: the web puts the settings link under the list.
            MenuRowButton(action: onOpenProviders) {
                Text("Add models")
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.C.ink)
                    .padding(.horizontal, 12)
                    .frame(height: 36)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .overlay(alignment: .top) { Hairline() }
        }
        // The list opens ready to type into. Deferred a turn: the field has
        // to be in the window before it can take first responder.
        .onAppear {
            DispatchQueue.main.async { searchFocused = true }
        }
    }

    private func sectionHeader(_ group: ComposerState.Group) -> some View {
        let shut = !isOpen(group)
        let mark = group.label.prefix(1)
        return Button {
            // A search holds every matching section open; a click then would
            // only land later, as the opposite of what was meant.
            guard !searching else { return }
            if expanded.contains(group.connectionId) {
                expanded.remove(group.connectionId)
            } else {
                expanded.insert(group.connectionId)
            }
        } label: {
            HStack(spacing: 8) {
                ProviderMark(
                    icon: group.icon,
                    monogram: mark.isEmpty ? "?" : String(mark),
                    size: 18
                )
                Text(group.label)
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(Theme.C.ink)
                    .lineLimit(1)
                Spacer(minLength: 0)
                Image(systemName: shut ? "chevron.right" : "chevron.down")
                    .font(.system(size: 11, weight: .regular))
                    .foregroundStyle(Theme.C.inkMuted)
            }
            .padding(.horizontal, 12)
            .frame(height: 36)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .buttonStyle(.plain)
        .pointerOnHover()
        .accessibilityLabel("\(group.label) models")
    }

    private func modelRow(label: String, selected: Bool, action: @escaping () -> Void) -> some View {
        let meta = [selected ? composer.effortLabel : nil, composer.speed == "fast" ? "Fast" : nil]
            .compactMap { $0 }
            .joined(separator: " ")
        return MenuRowButton(action: action) {
            HStack {
                Text(selected && !meta.isEmpty ? "\(label) \(meta)" : label)
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.C.ink)
                    .lineLimit(1)
                Spacer(minLength: 0)
                if selected {
                    Image(systemName: "checkmark")
                        .font(.system(size: 12))
                        .foregroundStyle(Theme.C.inkMuted)
                }
            }
            .padding(.horizontal, 12)
            .frame(height: 36)
            .frame(maxWidth: .infinity)
            .background(selected ? Theme.C.sunken : .clear)
        }
    }
}

struct ComposerPatch {
    var modelId: String?
    var effort: String?
    var speed: String?
}
