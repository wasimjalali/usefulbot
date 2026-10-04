import SwiftUI
import UsefulBotCore

/// The bot's notes: titles in a list, collapsed until opened. The 4 s refresh
/// keeps the open row and the scroll position, because rows are keyed by note
/// id and the list is only republished when it changed.
struct MemorySectionView: View {
    @EnvironmentObject private var model: AppModel
    let bot: ShellBot

    private static let firstRows = 8

    @State private var openId: String?
    @State private var showAll = false
    @State private var fullBodies: [String: FullBody] = [:]
    @State private var deleting: Set<String> = []

    private struct FullBody {
        let updatedAt: String
        let text: String
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            SettingsSectionHeader(title: "Memory") {
                if let notes = model.memoryNotes, !notes.isEmpty {
                    Text(notes.count == 1 ? "1 note" : "\(notes.count) notes")
                        .font(.system(size: 13))
                        .foregroundStyle(Theme.C.inkMuted)
                        .monospacedDigit()
                }
            }
            if let error = model.memoryError {
                Text(error)
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.C.danger)
            }
            if let notes = model.memoryNotes {
                if notes.isEmpty {
                    Text("Nothing remembered yet. \(bot.name) saves notes as you work together.")
                        .font(.system(size: 13))
                        .lineSpacing(3)
                        .foregroundStyle(Theme.C.inkMuted)
                        .settingsQuietCard()
                } else {
                    list(notes)
                }
            } else if model.memoryError == nil {
                Text("Loading notes.")
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.C.inkMuted)
            }
        }
        .task(id: bot.id) {
            openId = nil
            showAll = false
            fullBodies = [:]
            while !Task.isCancelled {
                await model.loadMemory(botId: bot.id)
                try? await Task.sleep(nanoseconds: 4_000_000_000)
            }
        }
    }

    private func list(_ notes: [MemoryNote]) -> some View {
        let shown = showAll ? notes : Array(notes.prefix(Self.firstRows))
        return VStack(spacing: 0) {
            ForEach(Array(shown.enumerated()), id: \.element.id) { index, note in
                if index > 0 { Hairline() }
                MemoryRow(
                    note: note,
                    open: openId == note.id,
                    fullText: fullText(for: note),
                    busy: deleting.contains(note.id),
                    toggle: { toggle(note) },
                    delete: { delete(note) }
                )
            }
            if notes.count > shown.count {
                Hairline()
                MemoryShowAllRow(count: notes.count) {
                    withAnimation(.easeOut(duration: 0.16)) { showAll = true }
                }
            }
        }
        .background(Theme.C.surface)
        .clipShape(RoundedRectangle(cornerRadius: DesignTokens.Radius.md, style: .continuous))
        .cardLift(cornerRadius: DesignTokens.Radius.md)
    }

    /// The whole note once fetched; until then what the list carried.
    private func fullText(for note: MemoryNote) -> String {
        if let full = fullBodies[note.id], full.updatedAt == note.updatedAt { return full.text }
        return note.truncated ? "\(note.body)..." : note.body
    }

    private func toggle(_ note: MemoryNote) {
        let opening = openId != note.id
        withAnimation(.easeOut(duration: 0.16)) { openId = opening ? note.id : nil }
        guard opening, note.truncated else { return }
        if let full = fullBodies[note.id], full.updatedAt == note.updatedAt { return }
        let botId = bot.id
        Task {
            guard let full = await model.fullMemoryNote(botId: botId, id: note.id) else { return }
            fullBodies[note.id] = FullBody(updatedAt: note.updatedAt, text: full.body)
        }
    }

    private func delete(_ note: MemoryNote) {
        guard deleting.insert(note.id).inserted else { return }
        let botId = bot.id
        Task {
            let ok = await model.deleteMemoryNote(botId: botId, note: note)
            deleting.remove(note.id)
            if ok, openId == note.id { openId = nil }
        }
    }
}

private struct MemoryRow: View {
    let note: MemoryNote
    let open: Bool
    let fullText: String
    let busy: Bool
    let toggle: () -> Void
    let delete: () -> Void

    @State private var hovering = false
    @FocusState private var focused: Bool
    @ObservedObject private var modality = InputModality.shared

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 10) {
                Text(note.title)
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(Theme.C.ink)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Text(MemoryDateLabel.label(iso: note.updatedAt))
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.C.inkFaint)
                    .monospacedDigit()
                Image(systemName: "chevron.right")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(Theme.C.inkFaint)
                    .rotationEffect(.degrees(open ? 90 : 0))
                    .animation(.easeOut(duration: 0.16), value: open)
            }
            .padding(.leading, 14)
            .padding(.trailing, 12)
            .frame(minHeight: 40)
            .background(hovering ? Theme.C.sunken.opacity(0.5) : .clear)
            .overlay(
                Rectangle()
                    .strokeBorder(Theme.C.ink, lineWidth: 2)
                    .opacity(focused && !modality.pointerDriven ? 1 : 0)
            )
            .contentShape(Rectangle())
            .onTapGesture(perform: toggle)
            .onHover { hovering = $0 }
            .pointerOnHover()
            .focusable()
            .focused($focused)
            .focusEffectDisabled()
            .onKeyPress(keys: [.return, .space]) { _ in
                toggle()
                return .handled
            }
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(.isButton)
            .accessibilityValue(open ? "expanded" : "collapsed")
            .accessibilityAction(.default, toggle)
            .accessibilityIdentifier("memory-row-\(note.id)")

            if open {
                VStack(alignment: .leading, spacing: 8) {
                    Text(fullText)
                        .font(.system(size: 13))
                        .lineSpacing(3)
                        .foregroundStyle(Theme.C.ink.opacity(0.85))
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    HStack(spacing: 8) {
                        if note.afterOutsideContent {
                            Text("After outside content")
                                .font(.system(size: 11, weight: .medium))
                                .foregroundStyle(Theme.C.inkMuted)
                                .padding(.horizontal, 6)
                                .padding(.vertical, 1)
                                .background(Theme.C.sunken)
                                .clipShape(RoundedRectangle(cornerRadius: DesignTokens.Radius.action, style: .continuous))
                        }
                        Spacer(minLength: 0)
                        Button(action: delete) {
                            Text("Delete note")
                                .font(.system(size: 12))
                                .foregroundStyle(Theme.C.inkMuted)
                                .padding(.horizontal, 2)
                                .padding(.vertical, 4)
                        }
                        .buttonStyle(.plain)
                        .disabled(busy)
                        .pointerOnHover()
                        .accessibilityIdentifier("memory-delete-\(note.id)")
                    }
                }
                .padding(.horizontal, 14)
                .padding(.bottom, 12)
                .transition(.opacity)
            }
        }
        .clipped()
    }
}

private struct MemoryShowAllRow: View {
    let count: Int
    let action: () -> Void

    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            Text("Show all \(count)")
                .font(.system(size: 13))
                .foregroundStyle(Theme.C.inkMuted)
                .padding(.horizontal, 14)
                .frame(maxWidth: .infinity, minHeight: 40, alignment: .leading)
                .background(hovering ? Theme.C.sunken.opacity(0.5) : .clear)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .pointerOnHover()
        .accessibilityIdentifier("memory-show-all")
    }
}
