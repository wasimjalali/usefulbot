import SwiftUI
import UsefulBotCore

/// The inline right pane: 320pt wide with a left hairline and its own scroll.
/// A bot reads Profile, Instructions, Routines, Memory, then the notification
/// row; a group reads Profile, Instructions and Members. Opening a routine
/// replaces the pane body with its editor, as in the details pane.
struct SettingsPaneView: View {
    @EnvironmentObject private var model: AppModel
    let bot: ShellBot
    var onDeleteRequest: (() -> Void)? = nil

    var body: some View {
        VStack(spacing: 0) {
            if model.routineCreating {
                RoutineEditorView(bot: bot, routine: nil)
            } else if let routine = model.openRoutine {
                RoutineEditorView(bot: bot, routine: routine)
            } else {
                overview
            }
        }
        .frame(width: DesignTokens.Space.settingsPaneWidth)
        .frame(maxHeight: .infinity)
        .background(Theme.C.surface)
        .overlay(alignment: .leading) { VerticalHairline() }
    }

    private var overview: some View {
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
            .padding(.leading, 20)
            .padding(.trailing, 12)
            .frame(height: 52)

            ScrollView {
                VStack(alignment: .leading, spacing: 28) {
                    ProfileSection(bot: bot)
                    InstructionsSection(bot: bot)
                    if bot.isGroup {
                        GroupSettingsFields(
                            bot: bot,
                            canDelete: (model.store?.bots.count ?? 0) > 1,
                            onDeleteRequest: onDeleteRequest
                        )
                    } else {
                        RoutinesSection(bot: bot)
                        MemorySectionView(bot: bot)
                        NotifyRow(bot: bot)
                        if let error = model.saveError {
                            Text(error)
                                .font(.system(size: 13))
                                .foregroundStyle(Theme.C.danger)
                        }
                    }
                }
                .padding(.horizontal, 20)
                .padding(.top, 8)
                .padding(.bottom, 32)
            }
            .uvScroll()
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

// MARK: - Profile

private struct ProfileSection: View {
    @EnvironmentObject private var model: AppModel
    let bot: ShellBot

    @State private var name = ""
    @State private var label = ""
    @State private var loaded = false
    @FocusState private var focus: Field?

    private enum Field: Hashable {
        case name
        case label
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            SettingsSectionHeader(title: "Profile") { EmptyView() }
            HStack(alignment: .top, spacing: 14) {
                BotAvatarView(bot: bot, size: 76)
                VStack(spacing: 8) {
                    TextField("Name", text: $name)
                        .font(.system(size: 13, weight: .semibold))
                        .profileField(focused: focus == .name)
                        .focused($focus, equals: .name)
                        .onSubmit { commitName(bot) }
                        .accessibilityLabel("Name")
                    if !bot.isGroup {
                        TextField("Label (optional)", text: $label)
                            .font(.system(size: 13))
                            .profileField(focused: focus == .label)
                            .focused($focus, equals: .label)
                            .onSubmit { commitLabel(bot) }
                            .accessibilityLabel("Label")
                    }
                }
            }
            AvatarColorPicker(bot: bot)
        }
        .onAppear(perform: seed)
        .onChange(of: bot.id) { old, _ in
            // The view already holds the incoming bot here, so the outgoing
            // bot is looked up by its old id and its edits commit before the
            // fields are reseeded for the new one.
            if let outgoing = model.store?.bots.first(where: { $0.id == old }) {
                commitName(outgoing)
                commitLabel(outgoing)
            }
            loaded = false
            seed()
        }
        // Only the edited fields: a poll that moves lastPreview or the
        // session must not reseed a just-committed edit back to the old text
        // while its echo is still in flight.
        .onChange(of: [bot.name, bot.label]) { _, _ in
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
            }
        }
        .onDisappear {
            commitName(bot)
            commitLabel(bot)
        }
    }

    private func seed() {
        guard !loaded else { return }
        name = bot.name
        label = bot.label
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
        guard !target.isGroup else { return }
        let next = label.trimmingCharacters(in: .whitespacesAndNewlines)
        if next != target.label { model.patchBot(botId: target.id, ["label": next]) }
    }
}

/// `.field-input` at the profile's 34 pt height, so two of them and the gap
/// stand as tall as the 76 pt avatar.
private struct ProfileFieldStyle: ViewModifier {
    let focused: Bool

    func body(content: Content) -> some View {
        content
            .textFieldStyle(.plain)
            .foregroundStyle(Theme.C.ink)
            .padding(.horizontal, 12)
            .frame(height: 34)
            .background(Theme.C.surface)
            .overlay(
                RoundedRectangle(cornerRadius: DesignTokens.Radius.field, style: .continuous)
                    .strokeBorder(focused ? Theme.C.ink : Theme.C.borderStrong, lineWidth: 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: DesignTokens.Radius.field, style: .continuous))
            .shadow(color: focused ? Theme.C.ink.opacity(0.08) : .clear, radius: 1.5)
    }
}

private extension View {
    func profileField(focused: Bool) -> some View {
        modifier(ProfileFieldStyle(focused: focused))
    }
}

// MARK: - Avatar color

/// 30 swatches: 10 hues in three tones, one row per tone. A bot on a legacy
/// color shows that color's name and no selected swatch.
private struct AvatarColorPicker: View {
    @EnvironmentObject private var model: AppModel
    let bot: ShellBot

    private var current: String { BrandAssets.colorID(for: bot) }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text("Avatar color")
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.C.inkMuted)
                Spacer(minLength: 0)
                Text(BrandAssets.palette[current]?.label ?? "")
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.C.inkMuted)
                    .lineLimit(1)
                Button {
                    let color = bot.id == Threads.defaultBotId ? "ink" : FacePalette.defaultFace(for: bot.id).color
                    select(color, custom: bot.id != Threads.defaultBotId)
                } label: {
                    Text("Reset")
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(Theme.C.ink)
                }
                .buttonStyle(.plain)
                .pointerOnHover()
                .accessibilityIdentifier("avatar-reset")
            }

            // Cells are 28 pt so every hit target clears 24; the swatch inside keeps
            // its 21 pt look.
            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 0), count: 10), spacing: 0) {
                ForEach(FacePalette.gridColors, id: \.self) { color in
                    swatch(color)
                }
            }
        }
    }

    private func swatch(_ color: String) -> some View {
        let selected = current == color
        let entry = BrandAssets.palette[color]
        return Button {
            select(color)
        } label: {
            Circle()
                .fill(Theme.color(entry?.fill ?? "#FFFFFF"))
                .aspectRatio(1, contentMode: .fit)
                .overlay(Circle().strokeBorder(Color.black.opacity(0.08), lineWidth: 1))
                .overlay(
                    Circle().strokeBorder(Theme.C.surface, lineWidth: 2).padding(-2)
                        .opacity(selected ? 1 : 0)
                )
                .overlay(
                    Circle().strokeBorder(Theme.C.ink, lineWidth: 1.5).padding(-3.5)
                        .opacity(selected ? 1 : 0)
                )
                .padding(3.6)
                .frame(maxWidth: .infinity)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .pointerOnHover()
        .accessibilityLabel(entry?.label ?? color)
        .accessibilityAddTraits(selected ? .isSelected : [])
        .accessibilityIdentifier("avatar-color-\(color)")
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

// MARK: - Instructions

/// Read-only preview clamped to seven lines; Edit opens the wide editor.
private struct InstructionsSection: View {
    @EnvironmentObject private var model: AppModel
    let bot: ShellBot

    private var isEmpty: Bool {
        bot.description.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            SettingsSectionHeader(title: "Instructions") {
                if isEmpty {
                    NativeButton("Write instructions", kind: .primary, small: true, action: open)
                        .accessibilityIdentifier("settings-instructions-edit")
                } else {
                    NativeButton("Edit", kind: .secondary, small: true, action: open)
                        .accessibilityIdentifier("settings-instructions-edit")
                }
            }
            if isEmpty {
                Text(bot.isGroup
                    ? "\(bot.name) has no instructions yet."
                    : "\(bot.name) works as a general assistant until you tell it its job, its limits and how to report.")
                    .font(.system(size: 13))
                    .lineSpacing(3)
                    .foregroundStyle(Theme.C.inkMuted)
                    .settingsQuietCard()
            } else {
                Text(bot.description)
                    .font(.system(size: 13))
                    .lineSpacing(3)
                    .foregroundStyle(Theme.C.ink.opacity(0.85))
                    .lineLimit(7)
                    .truncationMode(.tail)
                    .settingsQuietCard()
                    .accessibilityIdentifier("settings-instructions-preview")
            }
        }
    }

    private func open() {
        model.instructionsEditorBotId = bot.id
    }
}

// MARK: - Routines

private struct RoutinesSection: View {
    @EnvironmentObject private var model: AppModel
    let bot: ShellBot

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            SettingsSectionHeader(title: "Routines") {
                NativeIconButton(systemImage: "plus", size: 28, iconSize: 12) {
                    model.routineCreating = true
                }
                .help("New routine")
                .accessibilityLabel("New routine")
                .accessibilityIdentifier("routine-add")
            }
            if let error = model.routinesError {
                Text(error)
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.C.danger)
            }
            if model.routines.isEmpty {
                Text("Tasks this bot runs on a schedule.")
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.C.inkMuted)
                    .settingsQuietCard()
            } else {
                VStack(spacing: 0) {
                    ForEach(Array(model.routines.enumerated()), id: \.element.id) { index, routine in
                        if index > 0 { Hairline() }
                        RoutineRowView(routine: routine) { model.openRoutineId = routine.id }
                    }
                }
                .padding(.horizontal, 6)
                .padding(.vertical, 4)
                .background(Theme.C.surface)
                .clipShape(RoundedRectangle(cornerRadius: DesignTokens.Radius.md, style: .continuous))
                .cardLift(cornerRadius: DesignTokens.Radius.md)
            }
        }
    }
}

// MARK: - Notifications

private struct NotifyRow: View {
    @EnvironmentObject private var model: AppModel
    let bot: ShellBot

    @State private var denied = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .center, spacing: 8) {
                Text("Notify when \(bot.name) finishes")
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(Theme.C.ink)
                    // One line: the label takes the row before the spacer does,
                    // and a long name truncates instead of wrapping.
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .layoutPriority(1)
                Spacer(minLength: 0)
                NativeSwitch(isOn: bot.notify) {
                    // Resolve the live flag so a double tap cannot send !old twice.
                    let live = model.store?.bots.first { $0.id == bot.id } ?? bot
                    let next = !live.notify
                    model.patchBot(botId: bot.id, ["notify": next])
                    // The first time on is when the system asks.
                    if next {
                        Task { denied = !(await TurnNotifier.shared.requestAuthorization()) }
                    }
                }
                .accessibilityLabel("Notify when \(bot.name) finishes")
                .accessibilityValue(bot.notify ? "on" : "off")
                .accessibilityIdentifier("notify-switch")
            }
            if bot.notify && denied {
                Text("Notifications are off for Useful Bot in System Settings.")
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.C.danger)
                NativeButton("Open Notifications settings", kind: .secondary, small: true) {
                    TurnNotifier.shared.openSystemSettings()
                }
                .accessibilityIdentifier("notify-open-settings")
            }
        }
        .settingsQuietCard()
        .task(id: bot.id) { denied = await TurnNotifier.shared.isDenied() }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
            Task { denied = await TurnNotifier.shared.isDenied() }
        }
    }
}

// MARK: - Group settings fields

private struct GroupSettingsFields: View {
    @EnvironmentObject private var model: AppModel
    let bot: ShellBot
    var canDelete = true
    var onDeleteRequest: (() -> Void)?

    @State private var notice = ""

    private var candidates: [ShellBot] {
        (model.store?.bots ?? []).filter { candidate in
            candidate.kind == "bot"
                && candidate.id != Threads.defaultBotId
                && !candidate.hidden
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
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
}
