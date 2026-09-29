import SwiftUI
import UsefulBotCore

/// The inline right pane from `bot-settings-panel.tsx` and
/// `group-settings-panel.tsx`: 320pt wide with a left hairline, its own
/// scroll, and the face picker at the top.
struct SettingsPaneView: View {
    @EnvironmentObject private var model: AppModel
    let bot: ShellBot
    var onDeleteRequest: (() -> Void)? = nil

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text(bot.isGroup ? "Group" : "Settings")
                    .font(.system(size: DesignTokens.FontSize.settingsTitle, weight: .semibold))
                    .foregroundStyle(Theme.C.ink)
                Spacer(minLength: 0)
                NativeIconButton(systemImage: "xmark", size: 32, iconSize: 15) {
                    model.settingsOpen = false
                }
                .accessibilityLabel("Close settings")
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)

            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    FacePickerView(bot: bot)
                    if bot.isGroup {
                        groupFields
                    } else {
                        botFields
                    }
                }
                .padding(.horizontal, 16)
                .padding(.bottom, 20)
            }
            .uvScroll()
        }
        .frame(width: DesignTokens.Space.settingsPaneWidth)
        .frame(maxHeight: .infinity)
        .background(Theme.C.surface)
        .overlay(alignment: .leading) { VerticalHairline() }
    }

    // MARK: - Bot fields

    private var botFields: some View {
        BotSettingsFields(bot: bot)
    }

    // MARK: - Group fields

    @ViewBuilder
    private var groupFields: some View {
        GroupSettingsFields(
            bot: bot,
            canDelete: (model.store?.bots.count ?? 0) > 1,
            onDeleteRequest: onDeleteRequest
        )
    }
}

// MARK: - Face picker

private struct FacePickerView: View {
    @EnvironmentObject private var model: AppModel
    let bot: ShellBot

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Spacer(minLength: 0)
                BotAvatarView(bot: bot, size: 80)
                Spacer(minLength: 0)
            }

            HStack {
                Text("Avatar color")
                    .font(Theme.font(12, .semibold))
                Spacer()
                NativeButton("Reset", kind: .secondary, small: true) {
                    let color = bot.id == Threads.defaultBotId ? "ink" : FacePalette.defaultFace(for: bot.id).color
                    select(color, custom: bot.id != Threads.defaultBotId)
                }
                .accessibilityIdentifier("avatar-reset")
            }

            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 6), count: 4), spacing: 6) {
                ForEach(FacePalette.colors, id: \.self) { color in
                    let selected = BrandAssets.colorID(for: bot) == color
                    Button {
                        select(color)
                    } label: {
                        VStack(spacing: 2) {
                            BotStillFaceView(color: color, size: 40)
                            Text(BrandAssets.palette[color]!.label)
                                .font(Theme.font(10, .medium))
                                .foregroundStyle(Theme.C.ink)
                                .lineLimit(1)
                        }
                        .frame(maxWidth: .infinity, minHeight: 64)
                        .background(selected ? Theme.C.sunken : .clear)
                        .overlay(
                            RoundedRectangle(cornerRadius: DesignTokens.Radius.sm)
                                .strokeBorder(selected ? Theme.C.ink : .clear, lineWidth: 1.5)
                        )
                        .clipShape(RoundedRectangle(cornerRadius: DesignTokens.Radius.sm))
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .pointerOnHover()
                    .accessibilityLabel("\(BrandAssets.palette[color]!.label) avatar")
                    .accessibilityAddTraits(selected ? .isSelected : [])
                    .accessibilityIdentifier("avatar-color-\(color)")
                }
            }
        }
        .padding(.top, 4)
    }

    private func select(_ color: String, custom: Bool = true) {
        model.patchBot(botId: bot.id, [
            "avatarColor": color,
            "avatarShape": "circle",
            "avatarImage": nil,
            "avatarCustom": custom,
        ])
    }
}

// MARK: - Bot settings fields

private struct BotSettingsFields: View {
    @EnvironmentObject private var model: AppModel
    let bot: ShellBot

    @State private var name = ""
    @State private var label = ""
    @State private var description = ""
    @State private var loaded = false
    @FocusState private var focus: Field?

    private enum Field: Hashable {
        case name
        case label
        case description
    }

    var body: some View {
        Group {
            FieldShell(label: "Name") {
                TextField("", text: $name)
                    .nativeField(focused: focus == .name)
                    .focused($focus, equals: .name)
                    .onSubmit { commitName(bot) }
            }
            FieldShell(label: "Label (optional)") {
                TextField("", text: $label)
                    .nativeField(focused: focus == .label)
                    .focused($focus, equals: .label)
                    .onSubmit { commitLabel(bot) }
            }
            FieldShell(label: "Description") {
                ZStack(alignment: .topLeading) {
                    TextEditor(text: $description)
                        .font(.system(size: DesignTokens.FontSize.fieldInput))
                        .foregroundStyle(Theme.C.ink)
                        .scrollContentBackground(.hidden)
                        .scrollIndicators(.never)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 6)
                        .frame(minHeight: 96)
                        .focused($focus, equals: .description)
                    if description.isEmpty {
                        Text("")
                            .padding(.horizontal, 12)
                            .padding(.vertical, 8)
                    }
                }
                .background(Theme.C.surface)
                .overlay(
                    RoundedRectangle(cornerRadius: DesignTokens.Radius.field, style: .continuous)
                        .strokeBorder(focus == .description ? Theme.C.ink : Theme.C.borderStrong, lineWidth: 1)
                )
                .clipShape(RoundedRectangle(cornerRadius: DesignTokens.Radius.field, style: .continuous))
                .shadow(color: focus == .description ? Theme.C.ink.opacity(0.08) : .clear, radius: 1.5)
            }

            notificationsRow

            memorySection

            if let error = model.saveError {
                Text(error)
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.C.danger)
            }
        }
        .onAppear(perform: seed)
        .onChange(of: bot.id) { old, _ in
            // The view already holds the incoming bot here, so the outgoing
            // bot is looked up by its old id and its edits commit before the
            // fields are reseeded for the new one.
            if let outgoing = model.store?.bots.first(where: { $0.id == old }) {
                commitName(outgoing)
                commitLabel(outgoing)
                commitDescription(outgoing)
            }
            loaded = false
            seed()
        }
        // Only the edited fields: a poll that moves lastPreview or the
        // session must not reseed a just-committed edit back to the old text
        // while its echo is still in flight.
        .onChange(of: [bot.name, bot.label, bot.description]) { _, _ in
            // Store echoes and polls can rename the bot while the pane is
            // open; refresh the fields from the snapshot unless the owner is
            // typing in one of them.
            guard focus == nil else { return }
            loaded = false
            seed()
        }
        .onChange(of: focus) { _, next in
            if next == nil {
                commitName(bot)
                commitLabel(bot)
                commitDescription(bot)
            }
        }
        .onDisappear {
            commitName(bot)
            commitLabel(bot)
            commitDescription(bot)
        }
    }

    private var notificationsRow: some View {
        HStack(alignment: .center, spacing: 12) {
            VStack(alignment: .leading, spacing: 1) {
                Text("Notifications")
                    .font(.system(size: 14, weight: .medium))
                    .foregroundStyle(Theme.C.ink)
                Text("Get notified when this bot finishes.")
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.C.inkMuted)
            }
            Spacer(minLength: 0)
            NativeSwitch(isOn: bot.notify) {
                // Resolve the live flag so a double tap cannot send !old twice.
                let live = model.store?.bots.first { $0.id == bot.id } ?? bot
                model.patchBot(botId: bot.id, ["notify": !live.notify])
            }
            .accessibilityLabel("Notifications")
            .accessibilityValue(bot.notify ? "on" : "off")
            .accessibilityIdentifier("notify-switch")
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .overlay(
            RoundedRectangle(cornerRadius: DesignTokens.Radius.md, style: .continuous)
                .strokeBorder(Theme.C.edge, lineWidth: 1)
        )
    }

    @ViewBuilder
    private var memorySection: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("Memory")
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(Theme.C.inkMuted)
            Text("Notes for this bot only. Other bots cannot read them.")
                .font(.system(size: 12))
                .foregroundStyle(Theme.C.inkMuted)
                .padding(.top, 4)
            VStack(alignment: .leading, spacing: 8) {
                if let error = model.memoryError {
                    Text(error)
                        .font(.system(size: 14))
                        .foregroundStyle(Theme.C.danger)
                } else if let notes = model.memoryNotes {
                    if notes.isEmpty {
                        Text("Nothing remembered for \(bot.name) yet.")
                            .font(.system(size: 14))
                            .foregroundStyle(Theme.C.inkMuted)
                    } else {
                        ForEach(notes) { note in
                            MemoryNoteView(note: note)
                        }
                    }
                } else {
                    Text("Loading notes.")
                        .font(.system(size: 14))
                        .foregroundStyle(Theme.C.inkMuted)
                }
            }
            .padding(.top, 8)
        }
        .task(id: bot.id) {
            while !Task.isCancelled {
                await model.loadMemory(botId: bot.id)
                try? await Task.sleep(nanoseconds: 4_000_000_000)
            }
        }
    }

    private func seed() {
        guard !loaded else { return }
        name = bot.name
        label = bot.label
        description = bot.description
        loaded = true
    }

    private func commitName(_ target: ShellBot) {
        let next = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !next.isEmpty else {
            name = target.name
            return
        }
        if next != target.name { model.patchBot(botId: target.id, ["name": next]) }
    }

    private func commitLabel(_ target: ShellBot) {
        let next = label.trimmingCharacters(in: .whitespacesAndNewlines)
        if next != target.label { model.patchBot(botId: target.id, ["label": next]) }
    }

    private func commitDescription(_ target: ShellBot) {
        if description != target.description {
            model.patchBot(botId: target.id, ["description": description])
        }
    }
}

private struct MemoryNoteView: View {
    let note: MemoryNote

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .top, spacing: 12) {
                Text(note.title)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(Theme.C.ink)
                Spacer(minLength: 0)
                Text(String(note.updatedAt.prefix(10)))
                    .font(.system(size: 11))
                    .foregroundStyle(Theme.C.inkFaint)
                    .monospacedDigit()
            }
            Text(note.truncated ? "\(note.body)..." : note.body)
                .font(.system(size: 13))
                .lineSpacing(3)
                .foregroundStyle(Theme.C.inkMuted)
                .padding(.top, 4)
        }
        .padding(.horizontal, 18)
        .padding(.vertical, 16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.C.surface)
        .overlay(
            RoundedRectangle(cornerRadius: DesignTokens.Radius.lg, style: .continuous)
                .strokeBorder(Theme.C.borderStrong, lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: DesignTokens.Radius.lg, style: .continuous))
        .smShadow()
    }
}

// MARK: - Group settings fields

private struct GroupSettingsFields: View {
    @EnvironmentObject private var model: AppModel
    let bot: ShellBot
    var canDelete = true
    var onDeleteRequest: (() -> Void)?

    @State private var name = ""
    @State private var instructions = ""
    @State private var notice = ""
    @State private var loaded = false
    @FocusState private var focus: Field?

    private enum Field: Hashable {
        case name
        case instructions
    }

    private var candidates: [ShellBot] {
        (model.store?.bots ?? []).filter { candidate in
            candidate.kind == "bot"
                && candidate.id != Threads.defaultBotId
                && !candidate.hidden
        }
    }

    var body: some View {
        Group {
            FieldShell(label: "Name") {
                TextField("", text: $name)
                    .nativeField(focused: focus == .name)
                    .focused($focus, equals: .name)
                    .onSubmit { commitName(bot) }
            }
            FieldShell(label: "Instructions") {
                ZStack(alignment: .topLeading) {
                    TextEditor(text: $instructions)
                        .font(.system(size: DesignTokens.FontSize.fieldInput))
                        .foregroundStyle(Theme.C.ink)
                        .scrollContentBackground(.hidden)
                        .scrollIndicators(.never)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 6)
                        .frame(minHeight: 80)
                        .focused($focus, equals: .instructions)
                    if instructions.isEmpty {
                        Text("How this room should run")
                            .font(.system(size: DesignTokens.FontSize.fieldInput))
                            .foregroundStyle(Theme.C.inkFaint)
                            .padding(.horizontal, 12)
                            .padding(.vertical, 8)
                            .allowsHitTesting(false)
                    }
                }
                .background(Theme.C.surface)
                .overlay(
                    RoundedRectangle(cornerRadius: DesignTokens.Radius.field, style: .continuous)
                        .strokeBorder(focus == .instructions ? Theme.C.ink : Theme.C.borderStrong, lineWidth: 1)
                )
                .clipShape(RoundedRectangle(cornerRadius: DesignTokens.Radius.field, style: .continuous))
            }

            membersSection
            if !notice.isEmpty {
                Text(notice)
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.C.warning)
            }
            if let error = model.saveError {
                Text(error)
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.C.danger)
            }
            NativeButton("Delete group", systemImage: "trash", kind: .danger, small: true, enabled: canDelete) {
                onDeleteRequest?()
            }
            if !canDelete {
                Text("The last bot cannot be deleted.")
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.C.inkMuted)
            }
        }
        .onAppear(perform: seed)
        .onChange(of: bot.id) { old, _ in
            // The view already holds the incoming bot here, so the outgoing
            // bot is looked up by its old id and its edits commit before the
            // fields are reseeded for the new one.
            if let outgoing = model.store?.bots.first(where: { $0.id == old }) {
                commitName(outgoing)
                commitInstructions(outgoing)
            }
            loaded = false
            seed()
        }
        // Only the edited fields, for the same reason as the bot pane.
        .onChange(of: [bot.name, bot.description]) { _, _ in
            // Store echoes and polls can rename the group while the pane is
            // open; refresh the fields from the snapshot unless the owner is
            // typing in one of them.
            guard focus == nil else { return }
            loaded = false
            seed()
        }
        .onChange(of: focus) { _, next in
            if next == nil {
                commitName(bot)
                commitInstructions(bot)
            }
        }
        .onDisappear {
            commitName(bot)
            commitInstructions(bot)
        }
    }

    private var membersSection: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text("Members")
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(Theme.C.inkMuted)
                Spacer(minLength: 0)
                Text("\(bot.memberIds.count)/\(Threads.groupMaxMembers)")
                    .font(.system(size: 11))
                    .foregroundStyle(Theme.C.inkFaint)
            }
            VStack(alignment: .leading, spacing: 4) {
                ForEach(candidates) { candidate in
                    let active = bot.memberIds.contains(candidate.id)
                    Button {
                        toggle(candidate.id, active: active)
                    } label: {
                        HStack(spacing: 8) {
                            BotAvatarView(bot: candidate, size: 24)
                            Text(candidate.name)
                                .font(.system(size: 13))
                                .foregroundStyle(Theme.C.ink)
                                .lineLimit(1)
                            Spacer(minLength: 0)
                            Text(active ? "In group" : "Add")
                                .font(.system(size: 11))
                                .foregroundStyle(Theme.C.inkFaint)
                        }
                        .padding(.horizontal, 8)
                        .padding(.vertical, 5)
                        .frame(minHeight: 34)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(active ? Theme.C.surface : .clear)
                        .overlay(
                            RoundedRectangle(cornerRadius: DesignTokens.Radius.channel, style: .continuous)
                                .strokeBorder(active ? Theme.C.borderStrong : .clear, lineWidth: 1)
                        )
                        .clipShape(RoundedRectangle(cornerRadius: DesignTokens.Radius.channel, style: .continuous))
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .pointerOnHover()
                }
                if candidates.isEmpty {
                    Text("Create another bot first. A group needs two member bots.")
                        .font(.system(size: 13))
                        .foregroundStyle(Theme.C.inkMuted)
                }
            }
            .padding(.top, 8)
            Text("Use @name in the composer to direct a turn at one member. Untargeted messages go to the orchestrator.")
                .font(.system(size: 12))
                .lineSpacing(3)
                .foregroundStyle(Theme.C.inkMuted)
                .padding(.top, 8)
        }
    }

    private func toggle(_ id: String, active: Bool) {
        notice = ""
        // Resolve the live roster: the view's `bot` snapshot can be one echo
        // behind, and two quick taps must not drop an earlier update.
        let live = model.store?.bots.first { $0.id == bot.id } ?? bot
        var members = live.memberIds
        let isActive = members.contains(id)
        if isActive {
            guard members.count > Threads.groupMinMembers else {
                notice = "A group needs at least \(Threads.groupMinMembers) bots."
                return
            }
            members.removeAll { $0 == id }
        } else {
            guard members.count < Threads.groupMaxMembers else {
                notice = "A group holds at most \(Threads.groupMaxMembers) bots."
                return
            }
            // The roster can be one echo behind a double tap; never add twice.
            guard !members.contains(id) else { return }
            members.append(id)
        }
        model.patchBot(botId: bot.id, ["memberIds": members])
    }

    private func seed() {
        guard !loaded else { return }
        name = bot.name
        instructions = bot.description
        loaded = true
    }

    private func commitName(_ target: ShellBot) {
        let next = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !next.isEmpty else {
            name = target.name
            return
        }
        if next != target.name { model.patchBot(botId: target.id, ["name": next]) }
    }

    private func commitInstructions(_ target: ShellBot) {
        if instructions != target.description {
            model.patchBot(botId: target.id, ["description": instructions])
        }
    }
}
