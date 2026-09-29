import SwiftUI
import UsefulBotCore

/// Renders the blocks from `ChatMarkdownParser` with the chat type scale:
/// 15pt body at 1.65 line height, 13pt mono code on the sunken surface, 12pt
/// block gaps.
struct ChatMarkdownView: View, Equatable {
    let text: String
    var textColor: Color = Theme.C.ink
    /// Chat bubbles hug their content up to a cap; full-width surfaces such as
    /// proposal cards keep the expand-to-fill behavior.
    var expandsWidth = true
    /// Set while the text is still growing: the parse then lives in one slot
    /// for this key rather than filling the shared cache with every prefix.
    var streamingKey: String?

    var body: some View {
        let blocks = ChatMarkdownCache.blocks(from: text, streamingKey: streamingKey)
        VStack(alignment: .leading, spacing: 12) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                blockView(block)
            }
        }
        .font(Theme.font(DesignTokens.FontSize.chatBody, .regular))
        .foregroundStyle(textColor)
        .lineSpacing(7)
        .frame(maxWidth: expandsWidth ? .infinity : nil, alignment: .leading)
        .textSelection(.enabled)
    }

    @ViewBuilder
    private func blockView(_ block: MarkdownBlock) -> some View {
        switch block {
        case .paragraph(let content):
            Text(inline(content))
        case .heading(let level, let content):
            Text(inline(content))
                .font(Theme.font(headingSize(level), .semibold))
                .tracking(-0.02 * headingSize(level))
                .padding(.top, level == 1 ? 2 : 1)
        case .unorderedList(let items):
            VStack(alignment: .leading, spacing: 3) {
                ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                    HStack(alignment: .top, spacing: 8) {
                        Text("•")
                            .foregroundStyle(Theme.C.inkMuted)
                        // Wraps instead of truncating: inside a bubble that
                        // hugs its content the row is offered one line's
                        // height first, and took it.
                        Text(inline(item))
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
            .padding(.leading, 18)
        case .orderedList(let items, let start):
            VStack(alignment: .leading, spacing: 3) {
                ForEach(Array(items.enumerated()), id: \.offset) { index, item in
                    HStack(alignment: .top, spacing: 8) {
                        Text("\(start + index).")
                            .foregroundStyle(Theme.C.inkMuted)
                            .monospacedDigit()
                        // Wraps instead of truncating: inside a bubble that
                        // hugs its content the row is offered one line's
                        // height first, and took it.
                        Text(inline(item))
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
            .padding(.leading, 18)
        case .code(_, let body):
            CodeBlockView(text: body)
        case .table(let table):
            MarkdownTableView(table: table) { inline($0) }
        case .quote(let inner):
            HStack(alignment: .top, spacing: 10) {
                // The bar carries the quote; no tint, so a quoted line stays
                // as readable as the prose around it. It takes its height from
                // the text beside it: a bare Rectangle reports a small ideal
                // height, and with `fixedSize` that became the whole block's
                // height, so the next row in the transcript drew over the
                // quote instead of below it.
                Rectangle()
                    .fill(Theme.C.borderStrong)
                    .frame(width: 2)
                    .frame(maxHeight: .infinity)
                // The nested blocks render inside the bar, so a fenced block
                // inside a quote keeps its code card instead of flattening
                // to backticks.
                // Erased: the recursion would otherwise define the opaque
                // return type in terms of itself.
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(Array(inner.enumerated()), id: \.offset) { _, block in
                        AnyView(blockView(block))
                    }
                }
                .foregroundStyle(Theme.C.inkMuted)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .fixedSize(horizontal: false, vertical: true)
        case .rule:
            Rectangle()
                .fill(Theme.C.border)
                .frame(height: 1)
                .padding(.vertical, 2)
        }
    }

    private func headingSize(_ level: Int) -> CGFloat {
        switch level {
        case 1: return DesignTokens.FontSize.chatBody * 1.15
        case 2: return DesignTokens.FontSize.chatBody * 1.05
        default: return DesignTokens.FontSize.chatBody
        }
    }

    /// Inline spans turned into one attributed string: code on the sunken
    /// mono face, bold, italics, and http(s) links only. `_snake_case_` stays
    /// plain and no other emphasis form renders.
    private func inline(_ source: String) -> AttributedString {
        var attributed = AttributedString()
        for span in ChatMarkdownCache.inline(from: source, streamingKey: streamingKey) {
            switch span.kind {
            case .text:
                attributed.append(AttributedString(span.text))
            case .code:
                var run = AttributedString(span.text)
                run.font = .system(size: 13, design: .monospaced)
                run.backgroundColor = Theme.C.sunken
                attributed.append(run)
            case .strong:
                var run = AttributedString(span.text)
                run.font = Theme.font(DesignTokens.FontSize.chatBody, .semibold)
                attributed.append(run)
            case .emphasized:
                var run = AttributedString(span.text)
                run.font = Theme.font(DesignTokens.FontSize.chatBody, .regular).italic()
                attributed.append(run)
            case .link:
                var run = AttributedString(span.text)
                if Self.linkTarget(span.href) != nil {
                    run.link = Self.linkTarget(span.href)
                    run.foregroundColor = Theme.C.ink
                    run.underlineStyle = .single
                }
                attributed.append(run)
            }
        }
        return attributed
    }

    /// Model output may only link to the public web; `file://` and local
    /// server links must not become tap targets.
    private static func linkTarget(_ href: String) -> URL? {
        guard let url = URL(string: href),
              let scheme = url.scheme?.lowercased(),
              scheme == "http" || scheme == "https",
              !LocalHost.isLocal(url.host) else { return nil }
        return url
    }
}

/// A pipe table as a real grid.
///
/// `Grid` keeps the columns aligned across rows without measuring anything by
/// hand. The table takes the width the transcript column offers and no more:
/// columns size to their content while there is room, and once there is not,
/// cells wrap and the rows grow taller. Nothing is pinned to its content width,
/// because a table that insists on it turns a long cell into a sideways scroll
/// through the one thing the reader wants to read.
struct MarkdownTableView: View {
    let table: MarkdownTable
    /// The row renderer's inline parser, passed in so the table draws bold,
    /// code and links inside cells exactly like the prose around it.
    let inline: (String) -> AttributedString

    var body: some View {
        Grid(alignment: .topLeading, horizontalSpacing: 0, verticalSpacing: 0) {
            GridRow {
                ForEach(Array(table.headers.enumerated()), id: \.offset) { index, cell in
                    cellView(cell, column: index, header: true)
                }
            }
            // Body rows carry no fill. The header band is what separates the
            // titles from the data; striping the rest only adds noise to a
            // grid whose rules already say where each row ends.
            ForEach(Array(table.rows.enumerated()), id: \.offset) { _, row in
                Divider().gridCellUnsizedAxes(.horizontal)
                GridRow {
                    ForEach(Array(row.enumerated()), id: \.offset) { index, cell in
                        cellView(cell, column: index, header: false)
                    }
                }
            }
        }
        .overlay(
            RoundedRectangle(cornerRadius: DesignTokens.Radius.sm, style: .continuous)
                .strokeBorder(Theme.C.edge, lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: DesignTokens.Radius.sm, style: .continuous))
        // Hugs left when the table is narrower than the column, rather than
        // stretching two short columns across the whole width.
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func cellView(_ cell: String, column: Int, header: Bool) -> some View {
        let alignment = table.alignments.indices.contains(column)
            ? table.alignments[column]
            : .leading
        return Text(inline(cell))
            .font(header ? Theme.font(DesignTokens.FontSize.chatBody, .semibold) : nil)
            .multilineTextAlignment(textAlignment(alignment))
            // Wraps rather than truncating or forcing the column wider. No
            // width cap: the Grid shares out what the column has, and a cell
            // that cannot fit its line takes another one.
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: frameAlignment(alignment))
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            // Only the header stretches, and only because its band has to be
            // even when one title wraps and the others do not. Body cells are
            // left to their natural height: making every cell greedy left the
            // grid reporting less height than it drew, and the next row in the
            // transcript was laid out over the bottom of the table.
            .modifier(FillRowHeight(active: header))
            .background(header ? Theme.C.sunken : Color.clear)
    }

    private func textAlignment(_ alignment: MarkdownTable.Alignment) -> TextAlignment {
        switch alignment {
        case .leading: return .leading
        case .center: return .center
        case .trailing: return .trailing
        }
    }

    private func frameAlignment(_ alignment: MarkdownTable.Alignment) -> Alignment {
        switch alignment {
        case .leading: return .leading
        case .center: return .center
        case .trailing: return .trailing
        }
    }
}

/// Stretch to the row's height, or leave the view alone. Applying
/// `maxHeight: .infinity` to every cell makes the whole grid greedy; this
/// keeps it to the cells that actually need an even band.
private struct FillRowHeight: ViewModifier {
    let active: Bool

    func body(content: Content) -> some View {
        if active {
            content.frame(maxHeight: .infinity)
        } else {
            content
        }
    }
}

/// One fenced code block: a sunken mono card, with a
/// copy affordance so a drafted prompt can go straight to the pasteboard.
/// The block spans the column and long lines scroll horizontally under the
/// app-wide thin scroller instead of pushing the layout out past the edge.
struct CodeBlockView: View {
    let text: String

    @State private var copied = false

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            Text(text)
                .font(.system(size: 13, design: .monospaced))
                .foregroundStyle(Theme.C.ink)
                .fixedSize(horizontal: true, vertical: false)
                .padding(.horizontal, 14)
                .padding(.vertical, 12)
                .padding(.trailing, 48)
        }
        .background(Theme.C.sunken)
        .overlay(alignment: .topTrailing) {
            copyButton.padding(.top, 8).padding(.trailing, 10)
        }
        .clipShape(RoundedRectangle(cornerRadius: DesignTokens.Radius.sm, style: .continuous))
        .animation(.easeOut(duration: 0.15), value: copied)
    }

    private var copyButton: some View {
        Button {
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(text, forType: .string)
            copied = true
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.4) {
                copied = false
            }
        } label: {
            Image(systemName: copied ? "checkmark" : "doc.on.doc")
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(Theme.C.inkMuted)
                .frame(width: 26, height: 26)
                .background(Theme.C.surface)
                .overlay(Capsule().strokeBorder(Theme.C.edge, lineWidth: 1))
                .clipShape(Capsule())
        }
        .buttonStyle(.plain)
        .pointerOnHover()
        .accessibilityLabel(copied ? "Copied" : "Copy code")
        .help("Copy")
    }
}
