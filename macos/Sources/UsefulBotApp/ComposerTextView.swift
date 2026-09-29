import AppKit
import SwiftUI
import UsefulBotCore

/// The composer's text input, backed by a real `NSTextView` instead of
/// SwiftUI's `TextField(axis: .vertical)`.
///
/// SwiftUI's vertical field on macOS desyncs from its binding at exactly the
/// moments this composer cares about: macOS dictation commits its final text
/// and the field re-inserts it (the "double pasted transcript"), a model-side
/// clear after a send keeps showing the sent text (the "copy left in the
/// composer"), and long pastes could not scroll inside the six-line cap.
/// A real text view handles dictation, undo, paste and scrolling itself, and
/// the two-way sync below never rewrites the text while the user is composing
/// it (marked text), which is what broke dictation.
struct ComposerTextView: NSViewRepresentable {
    @Binding var text: String
    /// Changes only when the app deliberately writes the draft. See
    /// `AppModel.draftWriteToken`: this is what separates a real write from a
    /// re-render carrying a stale value.
    var writeToken: UInt64
    /// False while a turn is in flight: Return then falls through to a
    /// newline, matching the key handler it replaces.
    var returnSends: Bool
    /// Live reads of the composer state, so a command issued mid-turn sees
    /// the values of that moment rather than of the last render.
    var canSend: () -> Bool
    var pending: () -> Bool
    var onSend: () -> Void
    var onFocusChange: (Bool) -> Void
    /// Fires when an over-cap paste is cut to the cap, so the composer can
    /// tell the owner. Defaults to nothing: the field and the model stay in
    /// sync without it.
    var onClip: () -> Void = {}
    /// Files dropped on the field. `NSTextView` takes a file drop itself and
    /// pastes the path as text, which is not an attachment; this hands the
    /// URLs to the composer instead.
    var onDropFiles: ([URL]) -> Void = { _ in }
    /// Bumped to put the caret in the field (Reply on a message).
    var focusToken: UInt64 = 0

    func makeCoordinator() -> Coordinator {
        Coordinator(text: $text)
    }

    func makeNSView(context: Context) -> NSScrollView {
        let scrollView = NSScrollView()
        scrollView.hasVerticalScroller = true
        scrollView.hasHorizontalScroller = false
        scrollView.autohidesScrollers = true
        scrollView.borderType = .noBorder
        scrollView.drawsBackground = false
        // The app-wide swizzle dresses every scroll view in the thin knob;
        // this one only shows it once the field actually scrolls.
        ThinScrollbar.install()

        // A fresh field takes the token as it stands: only a Reply made
        // after it mounted should move the caret.
        context.coordinator.focusToken = focusToken
        let textView = FocusReportingTextView()
        textView.onFocusChange = { [weak coordinator = context.coordinator] focused in
            coordinator?.onFocusChange(focused)
        }
        textView.onDropFiles = { [weak coordinator = context.coordinator] urls in
            coordinator?.onDropFiles(urls)
        }
        textView.delegate = context.coordinator
        textView.isRichText = false
        textView.allowsUndo = true
        textView.importsGraphics = false
        textView.drawsBackground = false
        textView.isVerticallyResizable = true
        textView.isHorizontallyResizable = false
        textView.textContainer?.widthTracksTextView = true
        textView.textContainer?.containerSize = NSSize(width: 0, height: CGFloat.greatestFiniteMagnitude)
        textView.isAutomaticQuoteSubstitutionEnabled = false
        textView.isAutomaticDashSubstitutionEnabled = false
        textView.isAutomaticSpellingCorrectionEnabled = false
        textView.isContinuousSpellCheckingEnabled = false
        textView.isGrammarCheckingEnabled = false
        textView.font = .systemFont(ofSize: DesignTokens.FontSize.chatBody)
        textView.textColor = NSColor(Theme.C.ink)
        textView.insertionPointColor = NSColor(Theme.C.ink)
        textView.typingAttributes = [
            .font: NSFont.systemFont(ofSize: DesignTokens.FontSize.chatBody),
            .foregroundColor: NSColor(Theme.C.ink),
        ]
        textView.minSize = NSSize(width: 0, height: Self.minHeight)
        textView.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: .greatestFiniteMagnitude)
        textView.textContainerInset = NSSize(width: 0, height: 6)

        scrollView.documentView = textView
        return scrollView
    }

    func updateNSView(_ scrollView: NSScrollView, context: Context) {
        guard let textView = scrollView.documentView as? NSTextView else { return }
        textView.delegate = context.coordinator
        context.coordinator.canSend = canSend
        context.coordinator.pending = pending
        context.coordinator.onSend = onSend
        context.coordinator.onFocusChange = onFocusChange
        context.coordinator.onClip = onClip
        context.coordinator.onDropFiles = onDropFiles
        context.coordinator.returnSends = returnSends
        context.coordinator.syncFromModel(into: textView, text: text, writeToken: writeToken)
        if focusToken != context.coordinator.focusToken {
            context.coordinator.focusToken = focusToken
            DispatchQueue.main.async { textView.window?.makeFirstResponder(textView) }
        }
    }

    func sizeThatFits(_ proposal: ProposedViewSize, nsView: NSScrollView, context: Context) -> CGSize? {
        guard let textView = nsView.documentView as? NSTextView else { return nil }
        guard let layoutManager = textView.layoutManager, let container = textView.textContainer else { return nil }
        layoutManager.ensureLayout(forCharacterRange: NSRange(location: 0, length: (textView.string as NSString).length))
        let content = layoutManager.usedRect(for: container).height
            + textView.textContainerInset.height * 2
        let height = min(max(content, Self.minHeight), Self.maxHeight)
        let width = proposal.width ?? nsView.frame.width
        return CGSize(width: width, height: height)
    }

    static let minHeight: CGFloat = 32
    /// Six chat lines, the SwiftUI `lineLimit(1...6)` cap it replaces.
    static let maxHeight: CGFloat = 148

    @MainActor
    final class Coordinator: NSObject, NSTextViewDelegate {
        @Binding var text: String
        var returnSends = true
        var canSend: () -> Bool = { false }
        var pending: () -> Bool = { false }
        var onSend: () -> Void = {}
        var onFocusChange: (Bool) -> Void = { _ in }
        var onClip: () -> Void = {}
        var onDropFiles: ([URL]) -> Void = { _ in }
        var focusToken: UInt64 = 0
        init(text: Binding<String>) {
            self._text = text
        }

        /// The last write token this coordinator applied. Nil until the first
        /// `updateNSView`, which seeds the field.
        private var appliedWriteToken: UInt64?

        /// Model -> view, and only when the app actually asked for it.
        ///
        /// Comparing the incoming text against the field was not enough. A
        /// SwiftUI rebuild carries whatever `draft` held when it was scheduled,
        /// so during a fast multi-chunk insert (which is exactly how a
        /// dictation app delivers an utterance) a rebuild could arrive with
        /// text older than what the field already had, match neither the field
        /// nor what it had just pushed, and be written back over the newer content. The
        /// dictation app then re-inserted its full utterance on top of the
        /// remains, which is the doubled transcript. So a write happens only
        /// when the token says the app meant one: the send-clear, or the
        /// restore of a failed send. Everything else leaves the field alone,
        /// because while someone is composing, the field is the truth.
        ///
        /// Marked text is still refused outright, and the selection is kept so
        /// a mid-text clear does not throw the caret to the end.
        func syncFromModel(into textView: NSTextView, text next: String, writeToken: UInt64) {
            let deliberate = appliedWriteToken != writeToken
            appliedWriteToken = writeToken
            if !deliberate { return }
            if textView.string == next || textView.hasMarkedText() { return }
            let selection = textView.selectedRanges
            let length = (next as NSString).length
            // Text written into an empty field (a starter prompt, a restored
            // draft) leaves the caret after it, not in front of it.
            let wasEmpty = textView.string.isEmpty
            textView.string = next
            let kept = selection.filter { $0.rangeValue.location <= length }
            if kept.isEmpty || wasEmpty {
                textView.setSelectedRange(NSRange(location: length, length: 0))
            } else {
                textView.selectedRanges = kept
            }
        }

        func textView(_ textView: NSTextView, doCommandBy commandSelector: Selector) -> Bool {
            guard commandSelector == #selector(NSResponder.insertNewline(_:)) else { return false }
            // Modified keys always fall through and insert their newline.
            let flags = NSApp.currentEvent?.modifierFlags.intersection(.deviceIndependentFlagsMask) ?? []
            if flags.contains(.shift) || flags.contains(.command)
                || flags.contains(.option) || flags.contains(.control) {
                return false
            }
            if returnSends {
                if !canSend() { return true }
                if pending() { return false }
                onSend()
                return true
            }
            return false
        }
        func textDidChange(_ notification: Notification) {
            guard let textView = notification.object as? NSTextView else { return }
            let current = textView.string
            guard current.utf16.count > ComposerView.maxDraftLength else {
                text = current
                return
            }
            // An over-cap paste is cut to the cap. The model is published
            // first, from the clipped value, and the field is only rewritten
            // when it still holds the unclipped text: the rewrite re-enters
            // this method, and publishing after it raced the re-entrant pass,
            // which left the draft empty or stale while the field showed
            // text, with Send disabled and Return doing nothing.
            let clipped = ComposerDraft.clip(current, toUTF16: ComposerView.maxDraftLength)
            text = clipped
            if textView.string != clipped {
                textView.string = clipped
                let length = (clipped as NSString).length
                let kept = textView.selectedRanges.filter {
                    $0.rangeValue.location <= length
                }
                if kept.isEmpty {
                    textView.setSelectedRange(NSRange(location: length, length: 0))
                } else {
                    textView.selectedRanges = kept
                }
            }
            onClip()
        }

        // `textDidBeginEditing` and `textDidEndEditing` are not focus: AppKit
        // posts them around the first edit, so a field clicked into but not
        // yet typed in never reported focus at all. `FocusReportingTextView`
        // reports the first-responder change instead, which is what a caret
        // in the field actually means.
    }
}

/// An `NSTextView` that says when it holds the caret.
///
/// The placeholder has to disappear the moment the field is clicked, not on
/// the first character; a caret blinking inside grey placeholder text reads as
/// content that will not delete.
private final class FocusReportingTextView: NSTextView {
    var onFocusChange: (Bool) -> Void = { _ in }
    var onDropFiles: ([URL]) -> Void = { _ in }

    /// File URLs on the drag, or nil when the drag carries none, in which
    /// case the text view handles it as it always did (dropped text).
    private func droppedFileURLs(_ sender: NSDraggingInfo) -> [URL]? {
        let urls = sender.draggingPasteboard.readObjects(
            forClasses: [NSURL.self],
            options: [.urlReadingFileURLsOnly: true]
        ) as? [URL] ?? []
        return urls.isEmpty ? nil : urls
    }

    override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
        droppedFileURLs(sender) == nil ? super.draggingEntered(sender) : .copy
    }

    override func draggingUpdated(_ sender: NSDraggingInfo) -> NSDragOperation {
        droppedFileURLs(sender) == nil ? super.draggingUpdated(sender) : .copy
    }

    override func prepareForDragOperation(_ sender: NSDraggingInfo) -> Bool {
        droppedFileURLs(sender) == nil ? super.prepareForDragOperation(sender) : true
    }

    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        guard let urls = droppedFileURLs(sender) else { return super.performDragOperation(sender) }
        onDropFiles(urls)
        return true
    }

    override func becomeFirstResponder() -> Bool {
        let accepted = super.becomeFirstResponder()
        if accepted { onFocusChange(true) }
        return accepted
    }

    override func resignFirstResponder() -> Bool {
        let resigned = super.resignFirstResponder()
        if resigned { onFocusChange(false) }
        return resigned
    }
}
