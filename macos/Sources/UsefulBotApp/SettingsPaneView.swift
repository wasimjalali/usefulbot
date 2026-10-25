import SwiftUI
import UsefulBotCore

/// Instructions, then memory, for the one bot.
struct InstructionsMemoryContent: View {
    @EnvironmentObject private var model: AppModel
    let bot: ShellBot

    var body: some View {
        VStack(alignment: .leading, spacing: 28) {
            InstructionsSection(bot: bot)
            MemorySectionView(bot: bot)
            if let error = model.saveError {
                Text(error)
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.C.danger)
            }
        }
    }
}

// MARK: - Shared bits

/// A section's title row: 13 semibold in a 28 pt line, with room on the right.
struct SettingsSectionHeader<Trailing: View>: View {
    let title: String
    @ViewBuilder var trailing: Trailing

    var body: some View {
        HStack(alignment: .center, spacing: 8) {
            Text(title)
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(Theme.C.ink)
            Spacer(minLength: 0)
            trailing
        }
        .frame(height: 28)
    }
}

extension View {
    /// The quiet card behind a preview or a one-line note.
    func settingsQuietCard() -> some View {
        padding(.horizontal, 14)
            .padding(.vertical, 12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.C.sunken.opacity(0.5))
            .overlay(
                RoundedRectangle(cornerRadius: DesignTokens.Radius.md, style: .continuous)
                    .strokeBorder(Theme.C.edge, lineWidth: 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: DesignTokens.Radius.md, style: .continuous))
    }
}

// MARK: - Instructions

/// Read-only preview clamped to seven lines; Edit opens the wide editor.
private struct InstructionsSection: View {
    @EnvironmentObject private var model: AppModel
    let bot: ShellBot

    @State private var context: BotContextInfo?
    @State private var draft = ""
    /// The stored description this draft started from.
    @State private var base = ""
    @State private var seeded = false
    @State private var saving = false
    @State private var saveFailed = false

    private static let minBox: CGFloat = 96
    private static let maxBox: CGFloat = 260

    private var limit: Int { context?.max ?? InstructionsLimit.max }
    private var dirty: Bool { draft != base }
    /// The stored text moved since the draft started (another window or the
    /// bot edited it), so a plain Save would overwrite that change. A stored
    /// text that is the draft itself (a save that landed while Settings was
    /// closed) is not a change by someone else.
    private var changedElsewhere: Bool { seeded && dirty && bot.description != base && bot.description != draft }
    private var over: Bool { !InstructionsLimit.canSave(draft, max: limit) }

    private var restoreText: String? {
        guard bot.id == Threads.defaultBotId, let seed = context?.seed, draft != seed.text else { return nil }
        return seed.text
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            SettingsSectionHeader(title: "Instructions") {
                Text("\(Self.grouped(InstructionsLimit.count(draft))) of \(Self.grouped(limit))")
                    .font(.system(size: 12))
                    .foregroundStyle(over ? Theme.C.danger : Theme.C.inkMuted)
                    .monospacedDigit()
                    .accessibilityIdentifier("settings-instructions-count")
            }
            TextBox(
                text: $draft,
                placeholder: "Useful Bot works as a general assistant until you tell it its job, its limits and how to report.",
                minHeight: Self.minBox,
                maxHeight: Self.maxBox,
                editable: !saving,
                accessibilityLabel: "Instructions",
                accessibilityIdentifier: "instructions-editor"
            )
            .accessibilityIdentifier("settings-instructions-box")
            HStack(alignment: .firstTextBaseline, spacing: 12) {
                status
                    .frame(maxWidth: .infinity, alignment: .leading)
                if dirty {
                    if let restoreText, !saving {
                        NativeButton("Restore default", kind: .ghost, small: true) { draft = restoreText }
                            .accessibilityIdentifier("instructions-restore")
                    }
                    NativeButton("Cancel", kind: .secondary, small: true, enabled: !saving, action: cancel)
                        .accessibilityIdentifier("instructions-cancel")
                    if changedElsewhere {
                        NativeButton("Reload", kind: .secondary, small: true, enabled: !saving, action: cancel)
                            .accessibilityIdentifier("instructions-reload")
                    }
                    NativeButton(
                        saveFailed ? "Try again" : (changedElsewhere ? "Save anyway" : "Save"),
                        kind: .primary,
                        small: true,
                        enabled: !over && !saving,
                        action: save
                    )
                    .accessibilityIdentifier("instructions-save")
                }
            }
        }
        .onAppear(perform: seed)
        // The cost follows the stored text, so a save refreshes the limit and the default.
        .task(id: bot.description) { context = await model.botContext(botId: bot.id) }
        .onChange(of: bot.description) { _, live in
            // A clean draft follows the stored text; only a dirty one has a
            // change of its own to protect.
            guard seeded, !saving, !dirty else { return }
            if live != base { base = live; draft = live }
        }
        .onChange(of: draft) { _, next in
            saveFailed = false
            // Kept in the model until saved or discarded, so leaving Settings
            // never loses it.
            if seeded {
                model.instructionDrafts[bot.id] = next == base ? nil : InstructionDraft(base: base, text: next)
            }
        }
    }

    @ViewBuilder
    private var status: some View {
        if saveFailed {
            Text("Couldn't save. Your text is kept here.")
                .font(.system(size: 12))
                .foregroundStyle(Theme.C.danger)
        } else if changedElsewhere {
            Text("This changed since you started editing.")
                .font(.system(size: 12))
                .foregroundStyle(Theme.C.warning)
        } else if over, case .over(let text) = InstructionsLimit.footer(for: draft, max: limit) {
            Text(text)
                .font(.system(size: 12))
                .foregroundStyle(Theme.C.danger)
                .monospacedDigit()
        } else {
            Text("Useful Bot reads these at the start of every chat.")
                .font(.system(size: 12))
                .foregroundStyle(Theme.C.inkMuted)
        }
    }

    private static func grouped(_ value: Int) -> String {
        value.formatted(.number.locale(Locale(identifier: "en_US")))
    }

    private func seed() {
        guard !seeded else { return }
        if let kept = model.instructionDrafts[bot.id] {
            base = kept.base
            draft = kept.text
        } else {
            base = bot.description
            draft = bot.description
        }
        seeded = true
    }

    /// Cancel and Reload both take the stored text over the draft.
    private func cancel() {
        base = bot.description
        draft = bot.description
        model.instructionDrafts[bot.id] = nil
    }

    private func save() {
        guard !saving, dirty else { return }
        saving = true
        saveFailed = false
        let saved = draft
        model.patchBot(botId: bot.id, ["description": saved]) { ok in
            saving = false
            if ok {
                base = saved
                model.instructionDrafts[bot.id] = nil
            } else {
                saveFailed = true
            }
        }
    }
}
