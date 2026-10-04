import AppKit
import SwiftUI
import UsefulBotCore

/// The wide instructions editor, a sheet over the window. It starts at a
/// comfortable height and grows with the text up to its maximum (652 pt, or
/// the window less margins), then the text scrolls. The draft is never
/// clipped: past the limit Save is off and the footer says by how much.
struct InstructionsEditorView: View {
    @EnvironmentObject private var model: AppModel
    let botId: String
    let onClose: () -> Void

    @State private var draft = ""
    /// The stored description this draft started from.
    @State private var base = ""
    @State private var confirmingDiscard = false
    /// The Discard confirm was opened by Reload, so Discard takes the stored
    /// text instead of closing.
    @State private var reloadPending = false
    @State private var seeded = false
    @State private var context: BotContextInfo?
    @State private var saving = false
    @State private var saveFailed = false
    @State private var textHeight: CGFloat = 0

    private static let width: CGFloat = 720
    private static let headerHeight: CGFloat = 56
    private static let footerHeight: CGFloat = 64
    private static let textTop: CGFloat = 4
    private static let minHeight: CGFloat = 360
    private static let maxHeight: CGFloat = 652
    private static let windowMargin: CGFloat = 48

    private var bot: ShellBot? { model.store?.bots.first { $0.id == botId } }
    private var name: String { bot?.name ?? "Bot" }
    private var dirty: Bool { draft != base }
    /// The stored text moved since the editor opened (another window or a bot
    /// edited it), so a plain Save would overwrite that change.
    private var changedElsewhere: Bool { seeded && dirty && (bot?.description ?? "") != base }

    private var restoreText: String? {
        guard botId == Threads.defaultBotId, let seed = context?.seed, draft != seed.text else { return nil }
        return seed.text
    }

    var body: some View {
        GeometryReader { proxy in
            let ceiling = min(Self.maxHeight, max(Self.minHeight, proxy.size.height - 2 * Self.windowMargin))
            let chrome = Self.headerHeight + Self.textTop + Self.footerHeight
            let height = min(ceiling, max(Self.minHeight, chrome + textHeight))
            ZStack {
                Theme.C.overlay
                    .ignoresSafeArea()
                    // A draft is never lost to a stray click.
                    .onTapGesture { if !dirty { onClose() } }
                dialog(height: height, chrome: chrome)
                    .frame(width: min(Self.width, proxy.size.width - 48), height: height)
                    .background(Theme.C.surface)
                    .overlay(
                        RoundedRectangle(cornerRadius: DesignTokens.Radius.dialog, style: .continuous)
                            .strokeBorder(Theme.C.edge, lineWidth: 1)
                    )
                    .clipShape(RoundedRectangle(cornerRadius: DesignTokens.Radius.dialog, style: .continuous))
                    .popShadow()
                    .animation(.easeOut(duration: 0.12), value: height)
                    .position(x: proxy.size.width / 2, y: proxy.size.height / 2)
            }
        }
        .onExitCommand(perform: cancel)
        .onAppear(perform: seed)
        .task { context = await model.botContext(botId: botId) }
        .onChange(of: bot?.description) { _, live in
            // A clean draft follows the stored text; only a dirty one has a
            // change of its own to protect.
            guard seeded, !saving, !dirty else { return }
            let text = live ?? ""
            if text != base { base = text; draft = text }
        }
        .onChange(of: draft) { _, next in
            saveFailed = false
            confirmingDiscard = false
            // Kept in the model until saved or discarded, so closing the
            // window or the editor never loses it.
            if seeded { model.instructionDrafts[botId] = next == base ? nil : InstructionDraft(base: base, text: next) }
        }
    }

    private func dialog(height: CGFloat, chrome: CGFloat) -> some View {
        VStack(spacing: 0) {
            HStack {
                Text("\(name) instructions")
                    .font(.system(size: DesignTokens.FontSize.settingsTitle, weight: .semibold))
                    .foregroundStyle(Theme.C.ink)
                    .lineLimit(1)
                Spacer(minLength: 0)
                NativeIconButton(systemImage: "xmark", size: 32, iconSize: 14, action: cancel)
                    .accessibilityLabel("Close")
            }
            .padding(.leading, 28)
            .padding(.trailing, 12)
            .frame(height: Self.headerHeight)

            InstructionsTextView(text: $draft, height: $textHeight, editable: !saving, onCancel: cancel)
                .padding(.horizontal, 28)
                .padding(.top, Self.textTop)
                .frame(maxHeight: .infinity)

            footer
        }
    }

    private var footer: some View {
        VStack(spacing: 0) {
            Hairline()
            HStack(spacing: 12) {
                if let restoreText, !saving {
                    Button {
                        draft = restoreText
                    } label: {
                        Text("Restore default")
                            .font(.system(size: 13))
                            .foregroundStyle(Theme.C.inkMuted)
                            .padding(.horizontal, 6)
                            .frame(height: 32)
                    }
                    .buttonStyle(.plain)
                    .pointerOnHover()
                    .accessibilityIdentifier("instructions-restore")
                }
                status
                Spacer(minLength: 0)
                if confirmingDiscard {
                    NativeButton("Keep editing", kind: .secondary, small: true) {
                        confirmingDiscard = false
                        reloadPending = false
                    }
                        .accessibilityIdentifier("instructions-keep")
                    NativeButton("Discard", kind: .danger, small: true, action: discard)
                        .accessibilityIdentifier("instructions-discard")
                } else {
                    NativeButton("Cancel", kind: .secondary, small: true, action: cancel)
                        .accessibilityIdentifier("instructions-cancel")
                    if changedElsewhere {
                        NativeButton("Reload", kind: .secondary, small: true, action: requestReload)
                            .accessibilityIdentifier("instructions-reload")
                    }
                    NativeButton(
                        saveFailed ? "Try again" : (changedElsewhere ? "Save anyway" : "Save"),
                        kind: .primary,
                        small: true,
                        enabled: InstructionsLimit.canSave(draft, max: limit) && !saving,
                        action: save
                    )
                    .accessibilityIdentifier("instructions-save")
                }
            }
            .padding(.leading, 22)
            .padding(.trailing, 20)
            .frame(height: Self.footerHeight - 1)
        }
    }

    private var limit: Int { context?.max ?? InstructionsLimit.max }

    @ViewBuilder
    private var status: some View {
        if confirmingDiscard {
            Text("Discard changes?")
                .font(.system(size: 13))
                .foregroundStyle(Theme.C.ink)
        } else if saveFailed {
            Text("Couldn't save. Your text is kept here.")
                .font(.system(size: 13))
                .foregroundStyle(Theme.C.danger)
        } else if changedElsewhere {
            Text("This changed since you opened it.")
                .font(.system(size: 13))
                .foregroundStyle(Theme.C.warning)
        } else {
            switch InstructionsLimit.footer(for: draft, max: limit) {
            case .none:
                EmptyView()
            case .near(let text):
                Text(text)
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.C.inkMuted)
                    .monospacedDigit()
            case .over(let text):
                Text(text)
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.C.danger)
                    .monospacedDigit()
            }
        }
    }

    private func seed() {
        guard !seeded else { return }
        let live = bot?.description ?? ""
        if let kept = model.instructionDrafts[botId] {
            base = kept.base
            draft = kept.text
        } else {
            base = live
            draft = live
        }
        seeded = true
    }

    /// Esc, the close button and Cancel: a dirty draft asks first.
    private func cancel() {
        if confirmingDiscard { confirmingDiscard = false; reloadPending = false; return }
        if dirty { confirmingDiscard = true } else { onClose() }
    }

    private func discard() {
        if reloadPending {
            reloadPending = false
            confirmingDiscard = false
            reload()
            return
        }
        model.instructionDrafts[botId] = nil
        onClose()
    }

    /// Reload over a dirty draft asks first, through the Discard confirm.
    private func requestReload() {
        if dirty {
            reloadPending = true
            confirmingDiscard = true
        } else {
            reload()
        }
    }

    /// Take the stored text over the draft.
    private func reload() {
        let live = bot?.description ?? ""
        base = live
        draft = live
        model.instructionDrafts[botId] = nil
    }

    private func save() {
        guard !saving else { return }
        guard dirty else { onClose(); return }
        saving = true
        saveFailed = false
        model.patchBot(botId: botId, ["description": draft]) { ok in
            saving = false
            if ok {
                model.instructionDrafts[botId] = nil
                onClose()
            } else {
                saveFailed = true
            }
        }
    }
}

// MARK: - Text view

/// A plain text view at 14/22 that reports its laid-out height, so the
/// dialog can grow with it. The scroller only matters once the dialog stops
/// growing.
private struct InstructionsTextView: NSViewRepresentable {
    @Binding var text: String
    @Binding var height: CGFloat
    var editable = true
    var onCancel: () -> Void

    private static let font = NSFont.systemFont(ofSize: 14)
    private static let lineHeight: CGFloat = 22
    /// Air under the last line, so the caret never sits on the footer rule.
    private static let bottomPad: CGFloat = 16

    private static var attributes: [NSAttributedString.Key: Any] {
        let style = NSMutableParagraphStyle()
        style.lineSpacing = max(0, lineHeight - ceil(font.ascender - font.descender + font.leading))
        return [.font: font, .foregroundColor: NSColor.labelColor, .paragraphStyle: style]
    }

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeNSView(context: Context) -> NSScrollView {
        let scroll = NSScrollView()
        scroll.drawsBackground = false
        scroll.hasVerticalScroller = true
        scroll.autohidesScrollers = true
        scroll.borderType = .noBorder

        let view = NSTextView()
        view.drawsBackground = false
        view.isRichText = false
        view.allowsUndo = true
        view.isAutomaticQuoteSubstitutionEnabled = false
        view.isContinuousSpellCheckingEnabled = true
        view.textContainerInset = .zero
        view.textContainer?.lineFragmentPadding = 0
        view.textContainer?.widthTracksTextView = true
        view.isVerticallyResizable = true
        view.isHorizontallyResizable = false
        view.autoresizingMask = [.width]
        view.typingAttributes = Self.attributes
        view.defaultParagraphStyle = Self.attributes[.paragraphStyle] as? NSParagraphStyle
        view.insertionPointColor = NSColor.labelColor
        view.setAccessibilityIdentifier("instructions-editor")
        view.setAccessibilityLabel("Instructions")
        view.delegate = context.coordinator
        scroll.documentView = view
        context.coordinator.view = view
        view.textStorage?.setAttributedString(NSAttributedString(string: text, attributes: Self.attributes))
        DispatchQueue.main.async {
            view.window?.makeFirstResponder(view)
            view.setSelectedRange(NSRange(location: view.string.utf16.count, length: 0))
            context.coordinator.report()
        }
        return scroll
    }

    func updateNSView(_ scroll: NSScrollView, context: Context) {
        context.coordinator.parent = self
        guard let view = scroll.documentView as? NSTextView else { return }
        if view.isEditable != editable { view.isEditable = editable }
        if view.string != text {
            // An outside change (Restore default). A keystroke already
            // matches, so typing never resets the caret.
            let selection = view.selectedRange()
            view.textStorage?.setAttributedString(NSAttributedString(string: text, attributes: Self.attributes))
            view.setSelectedRange(NSRange(location: min(selection.location, text.utf16.count), length: 0))
            DispatchQueue.main.async { context.coordinator.report() }
        }
    }

    final class Coordinator: NSObject, NSTextViewDelegate {
        var parent: InstructionsTextView
        weak var view: NSTextView?

        init(_ parent: InstructionsTextView) { self.parent = parent }

        func textDidChange(_ notification: Notification) {
            guard let view else { return }
            parent.text = view.string
            report()
        }

        func textView(_ textView: NSTextView, doCommandBy selector: Selector) -> Bool {
            guard selector == #selector(NSResponder.cancelOperation(_:)) else { return false }
            parent.onCancel()
            return true
        }

        func report() {
            guard let view, let layout = view.layoutManager, let container = view.textContainer else { return }
            layout.ensureLayout(for: container)
            let used = layout.usedRect(for: container).height
            let next = ceil(used + InstructionsTextView.bottomPad)
            if abs(parent.height - next) > 0.5 { parent.height = next }
        }
    }
}
