import AppKit
import SwiftUI
import UsefulBotCore

// MARK: - Text box

/// The app's multi-line field (Instructions, a routine's instruction,
/// feedback): it grows with its text from `minHeight` to `maxHeight`, then
/// scrolls. The padding sits inside the scrolling text, so the first and last
/// lines keep their air and the text scrolls to the box's edge in between.
struct TextBox: View {
    @Binding var text: String
    var placeholder = ""
    var minHeight: CGFloat = 96
    var maxHeight: CGFloat = 260
    var editable = true
    /// Take the caret on appear. Off when the field sits in a page the owner
    /// is only reading.
    var focusOnAppear = false
    var invalid = false
    var accessibilityLabel: String
    var accessibilityIdentifier: String
    /// Esc in the field.
    var onCancel: () -> Void = { NSApp.keyWindow?.makeFirstResponder(nil) }
    /// Whether the field holds the caret, for a page that must not overwrite
    /// a draft while it's being typed.
    var focused: Binding<Bool>? = nil

    @State private var textHeight: CGFloat = 0
    @State private var hasFocus = false

    var body: some View {
        BoxTextView(
            text: $text,
            height: $textHeight,
            focused: Binding(get: { hasFocus }, set: { hasFocus = $0; focused?.wrappedValue = $0 }),
            editable: editable,
            focusOnAppear: focusOnAppear,
            accessibilityLabel: accessibilityLabel,
            accessibilityIdentifier: accessibilityIdentifier,
            onCancel: onCancel
        )
        .frame(height: min(maxHeight, max(minHeight, textHeight)))
        .overlay(alignment: .topLeading) {
            if text.isEmpty, !placeholder.isEmpty {
                Text(placeholder)
                    .font(.system(size: BoxTextView.fontSize))
                    .foregroundStyle(Theme.C.inkFaint)
                    .lineSpacing(BoxTextView.lineSpacing)
                    .padding(.top, BoxTextView.inset.height)
                    // Past the caret, which an empty focused field draws at
                    // the first glyph's x.
                    .padding(.leading, BoxTextView.inset.width + 2)
                    .padding(.trailing, BoxTextView.inset.width)
                    .allowsHitTesting(false)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.C.surface)
        .overlay(
            RoundedRectangle(cornerRadius: DesignTokens.Radius.field, style: .continuous)
                .strokeBorder(invalid ? Theme.C.danger : hasFocus ? Theme.C.ink : Theme.C.borderStrong, lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: DesignTokens.Radius.field, style: .continuous))
    }
}

// MARK: - Text view

/// A plain text view at 14/22 that reports its laid-out height, so the box
/// around it can grow with it. TextKit 1: a field's text is short, and laying
/// it all out once keeps scrolling free of the per-frame layout TextKit 2 does.
struct BoxTextView: NSViewRepresentable {
    @Binding var text: String
    @Binding var height: CGFloat
    @Binding var focused: Bool
    var editable = true
    var focusOnAppear = false
    var accessibilityLabel: String
    var accessibilityIdentifier: String
    var onCancel: () -> Void

    static let fontSize = DesignTokens.FontSize.fieldInput
    static let lineHeight: CGFloat = 22
    /// Inside the scrolling text: 12 pt above the first line and below the
    /// last, 12 pt at the sides.
    static let inset = NSSize(width: 12, height: 12)
    private static let font = NSFont.systemFont(ofSize: fontSize)
    /// The gap that puts lines `lineHeight` apart; the placeholder uses it too.
    static let lineSpacing = max(0, lineHeight - ceil(font.ascender - font.descender + font.leading))

    private static var attributes: [NSAttributedString.Key: Any] {
        let style = NSMutableParagraphStyle()
        style.lineSpacing = lineSpacing
        return [.font: font, .foregroundColor: NSColor.labelColor, .paragraphStyle: style]
    }

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeNSView(context: Context) -> NSScrollView {
        let scroll = ContainedScrollView()
        scroll.onWidthChange = { [weak coordinator = context.coordinator] in coordinator?.report() }
        scroll.drawsBackground = false
        scroll.hasVerticalScroller = true
        scroll.autohidesScrollers = true
        scroll.borderType = .noBorder
        // A field inside a page has no bars to clear: automatic insets shifted
        // its top, and the box opened a few points into the text.
        scroll.automaticallyAdjustsContentInsets = false
        scroll.contentInsets = NSEdgeInsetsZero

        let view = FocusTextView(usingTextLayoutManager: false)
        // Async: a resign while SwiftUI removes the field lands mid-update.
        view.onFocus = { [weak coordinator = context.coordinator] focused in
            DispatchQueue.main.async { coordinator?.parent.focused = focused }
        }
        view.drawsBackground = false
        view.isRichText = false
        view.allowsUndo = true
        // What the owner types is what is saved: no smart dashes, symbol
        // replacements or autocorrect.
        view.isAutomaticQuoteSubstitutionEnabled = false
        view.isAutomaticDashSubstitutionEnabled = false
        view.isAutomaticTextReplacementEnabled = false
        view.isAutomaticSpellingCorrectionEnabled = false
        view.isContinuousSpellCheckingEnabled = true
        view.textContainerInset = Self.inset
        view.textContainer?.lineFragmentPadding = 0
        view.textContainer?.widthTracksTextView = true
        // A container that starts at zero width drew nothing in this build
        // (see ComposerTextView); it follows the view's width from here.
        view.textContainer?.containerSize = NSSize(width: max(1, scroll.contentSize.width), height: .greatestFiniteMagnitude)
        view.isVerticallyResizable = true
        view.isHorizontallyResizable = false
        view.autoresizingMask = [.width]
        view.typingAttributes = Self.attributes
        view.defaultParagraphStyle = Self.attributes[.paragraphStyle] as? NSParagraphStyle
        view.insertionPointColor = NSColor.labelColor
        view.setAccessibilityIdentifier(accessibilityIdentifier)
        view.setAccessibilityLabel(accessibilityLabel)
        view.delegate = context.coordinator
        scroll.documentView = view
        context.coordinator.view = view
        view.textStorage?.setAttributedString(NSAttributedString(string: text, attributes: Self.attributes))
        let focus = focusOnAppear
        DispatchQueue.main.async {
            if focus {
                view.window?.makeFirstResponder(view)
                view.setSelectedRange(NSRange(location: view.string.utf16.count, length: 0))
            }
            context.coordinator.report()
            // The box takes its height on the next pass, and growing it left
            // the text a few points scrolled: a field opens at its first line.
            guard !focus else { return }
            DispatchQueue.main.async {
                scroll.contentView.scroll(to: .zero)
                scroll.reflectScrolledClipView(scroll.contentView)
            }
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
            let typing = view.window?.firstResponder === view
            DispatchQueue.main.async {
                context.coordinator.report()
                // New text (another routine, Restore default) opens at its top.
                if !typing {
                    scroll.contentView.scroll(to: .zero)
                    scroll.reflectScrolledClipView(scroll.contentView)
                }
            }
        }
    }

    final class Coordinator: NSObject, NSTextViewDelegate {
        var parent: BoxTextView
        weak var view: NSTextView?

        init(_ parent: BoxTextView) { self.parent = parent }

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

        /// The text's height with both insets, for the box to grow to.
        func report() {
            guard let view, let layout = view.layoutManager, let container = view.textContainer else { return }
            layout.ensureLayout(for: container)
            let used = layout.usedRect(for: container).height
            let next = ceil(used + BoxTextView.inset.height * 2)
            if abs(parent.height - next) > 0.5 { parent.height = next }
        }
    }
}

/// An `NSTextView` that says when it takes and gives up the caret.
private final class FocusTextView: NSTextView {
    var onFocus: ((Bool) -> Void)?

    override func becomeFirstResponder() -> Bool {
        let took = super.becomeFirstResponder()
        if took { onFocus?(true) }
        return took
    }

    override func resignFirstResponder() -> Bool {
        let gave = super.resignFirstResponder()
        if gave { onFocus?(false) }
        return gave
    }
}

/// The field's scroll view. A swipe or wheel flick that starts inside the
/// field stays in it, momentum included, so the page behind doesn't move with
/// it; one that starts with the field already at that edge scrolls the page. Its text view
/// fills the box, so a click anywhere in the field places the caret, and a
/// width change re-measures the text.
private final class ContainedScrollView: NSScrollView {
    var onWidthChange: (() -> Void)?
    private var lastWidth: CGFloat = 0
    /// Where the current trackpad swipe goes, once its direction is known.
    private var swipeToPage: Bool?
    private var lastWheel: TimeInterval = 0
    /// A swipe's opening events, held until its direction is known.
    private var held: [NSEvent] = []

    override func scrollWheel(with event: NSEvent) {
        guard abs(event.scrollingDeltaY) >= abs(event.scrollingDeltaX),
              let document = documentView,
              document.frame.height > contentView.bounds.height + 1 else {
            // Held opening events go first, so the field sees its swipe in order.
            held.forEach { super.scrollWheel(with: $0) }
            held = []
            super.scrollWheel(with: event)
            return
        }
        let dy = event.scrollingDeltaY
        let clip = contentView.bounds
        // A positive delta scrolls toward the top; the text view is flipped.
        let atEdge = dy > 0 ? clip.minY <= 0.5 : dy < 0 ? clip.maxY >= document.frame.height - 0.5 : false
        // A mouse wheel has no phases: notches less than 0.35 s apart are one
        // flick, decided like a swipe by where it started.
        let wheel = event.phase.isEmpty && event.momentumPhase.isEmpty
        if event.phase == .began || event.phase == .mayBegin
            || (wheel && event.timestamp - lastWheel > 0.35) {
            swipeToPage = nil
            held = []
        }
        if wheel { lastWheel = event.timestamp }
        // A swipe's first events can carry no movement yet: they wait until
        // its direction says where the whole swipe goes, so it isn't split.
        if swipeToPage == nil, dy == 0, event.phase == .began || event.phase == .mayBegin {
            held.append(event)
            return
        }
        // Any other still event with no direction yet (a swipe that ended
        // without moving, a stray momentum tail) goes to the field with what
        // was held.
        if swipeToPage == nil, dy == 0 {
            held.forEach { super.scrollWheel(with: $0) }
            held = []
            super.scrollWheel(with: event)
            return
        }
        if swipeToPage == nil { swipeToPage = atEdge }
        let toPage = swipeToPage ?? false
        let pending = held
        held = []
        for early in pending {
            if toPage { nextResponder?.scrollWheel(with: early) } else { super.scrollWheel(with: early) }
        }
        if toPage {
            nextResponder?.scrollWheel(with: event)
        } else if !atEdge {
            super.scrollWheel(with: event)
        }
    }

    override func tile() {
        super.tile()
        if let text = documentView as? NSTextView, text.minSize.height != contentSize.height {
            text.minSize = NSSize(width: 0, height: contentSize.height)
            // A lower floor alone leaves a shrunk box's text view tall, and
            // it then looked scrollable and kept the page's swipes.
            text.sizeToFit()
        }
        if abs(contentSize.width - lastWidth) > 0.5 {
            lastWidth = contentSize.width
            DispatchQueue.main.async { [weak self] in self?.onWidthChange?() }
        }
    }
}
