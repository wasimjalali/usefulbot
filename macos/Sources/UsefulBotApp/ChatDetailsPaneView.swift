import SwiftUI
import UsefulBotCore

/// The right-hand chat details pane from the Grok Bot reference
/// (`03-agent-pane/`): a room's members, or a 1:1 bot's profile, above the
/// bot's routines. The gear opens the full settings pane and the chevrons
/// collapse the pane, mirroring the reference's pane chrome. Opening a routine
/// replaces the pane body with its detail view.
struct ChatDetailsPaneView: View {
    @EnvironmentObject private var model: AppModel
    let bot: ShellBot

    private var members: [ShellBot] {
        groupMemberBots(bot, store: model.store)
    }

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
            toolbar

            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    if bot.isGroup {
                        membersSection
                    } else {
                        profileSection
                    }
                    routinesSection
                }
                .padding(.horizontal, 16)
                .padding(.bottom, 20)
            }
            .uvScroll()
        }
    }

    // MARK: - Chrome

    private var toolbar: some View {
        HStack(spacing: 2) {
            Spacer(minLength: 0)
            NativeIconButton(systemImage: "gearshape", size: 32, iconSize: 15) {
                model.settingsOpen = true
            }
            .help("Settings")
            .accessibilityLabel("Settings")
            .accessibilityIdentifier("details-settings")
            NativeIconButton(systemImage: "chevron.right.2", size: 32, iconSize: 15) {
                model.detailsOpen = false
            }
            .help("Collapse details")
            .accessibilityLabel("Collapse details")
            .accessibilityIdentifier("details-collapse")
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
    }

    // MARK: - Group members

    private var membersSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            sectionLabel("Members")
            if members.isEmpty {
                // A roster that no longer resolves is different from a group
                // that was never staffed.
                Text(bot.memberIds.isEmpty
                    ? "No members yet. Add two to six bots from the group settings."
                    : "This group's members are gone. Pick new ones in the group settings.")
                    .font(.system(size: 13))
                    .lineSpacing(3)
                    .foregroundStyle(Theme.C.inkMuted)
            } else {
                VStack(alignment: .leading, spacing: 2) {
                    ForEach(members) { member in
                        HStack(spacing: 10) {
                            BotAvatarView(bot: member, size: 28)
                            VStack(alignment: .leading, spacing: 1) {
                                Text(member.name)
                                    .font(.system(size: 14))
                                    .foregroundStyle(Theme.C.ink)
                                    .lineLimit(1)
                                if !member.label.isEmpty {
                                    Text(member.label.uppercased())
                                        .font(.system(size: 10, weight: .semibold))
                                        .tracking(DesignTokens.Tracking.label * 10)
                                        .foregroundStyle(Theme.C.inkFaint)
                                        .lineLimit(1)
                                }
                            }
                            Spacer(minLength: 0)
                        }
                        .padding(.horizontal, 4)
                        .frame(minHeight: 40)
                    }
                }
            }
        }
        .padding(.top, 8)
    }

    // MARK: - 1:1 profile

    private var profileSection: some View {
        VStack(spacing: 10) {
            HStack {
                Spacer(minLength: 0)
                BotAvatarView(bot: bot, size: 72)
                Spacer(minLength: 0)
            }
            Text(bot.name)
                .font(.system(size: DesignTokens.FontSize.settingsTitle, weight: .semibold))
                .foregroundStyle(Theme.C.ink)
                .multilineTextAlignment(.center)
            if !bot.label.isEmpty {
                Text(bot.label.uppercased())
                    .font(.system(size: 10, weight: .semibold))
                    .tracking(DesignTokens.Tracking.label * 10)
                    .foregroundStyle(Theme.C.inkFaint)
            }
            if !bot.description.isEmpty {
                Text(bot.description)
                    .font(.system(size: 13))
                    .lineSpacing(3)
                    .foregroundStyle(Theme.C.inkMuted)
                    .multilineTextAlignment(.center)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 12)
    }

    // MARK: - Routines

    private var routinesSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            Hairline()
                .padding(.bottom, 2)
            HStack(spacing: 4) {
                sectionLabel("Routines")
                Spacer(minLength: 0)
                NativeIconButton(systemImage: "plus", size: 26, iconSize: 13) {
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
                routinesEmptyState
            } else {
                VStack(spacing: 2) {
                    ForEach(model.routines) { routine in
                        RoutineRowView(routine: routine) { model.openRoutineId = routine.id }
                    }
                }
            }
        }
    }

    /// The reference's empty state: one calm line and one button.
    private var routinesEmptyState: some View {
        VStack(spacing: 10) {
            Text("Tasks this bot runs on a schedule.")
                .font(.system(size: 13))
                .lineSpacing(3)
                .foregroundStyle(Theme.C.inkMuted)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 260)
            NativeButton("Create routine", kind: .secondary, small: true) {
                model.routineCreating = true
            }
            .accessibilityIdentifier("routine-create")
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 12)
    }

    private func sectionLabel(_ text: String) -> some View {
        Text(text)
            .font(.system(size: 13, weight: .medium))
            .foregroundStyle(Theme.C.inkMuted)
    }
}

// MARK: - List row

/// Clock icon, name, schedule subtitle. A paused routine reads muted so the
/// list does not claim it is going to run.
struct RoutineRowView: View {
    let routine: Routine
    let onOpen: () -> Void

    @State private var hovering = false

    var body: some View {
        Button(action: onOpen) {
            HStack(spacing: 10) {
                Image(systemName: "clock")
                    .font(.system(size: 14))
                    .foregroundStyle(routine.active ? Theme.C.inkMuted : Theme.C.inkFaint)
                VStack(alignment: .leading, spacing: 1) {
                    Text(routine.name)
                        .font(.system(size: 14))
                        .foregroundStyle(routine.active ? Theme.C.ink : Theme.C.inkMuted)
                        .lineLimit(1)
                        .truncationMode(.tail)
                    Text(routine.active
                        ? RoutineCopy.scheduleLine(routine.schedules)
                        : "Paused")
                        .font(.system(size: 12))
                        .foregroundStyle(Theme.C.inkFaint)
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(hovering ? Theme.C.sunken : .clear)
            .clipShape(RoundedRectangle(cornerRadius: DesignTokens.Radius.channel, style: .continuous))
            .contentShape(RoundedRectangle(cornerRadius: DesignTokens.Radius.channel, style: .continuous))
        }
        .buttonStyle(.plain)
        .pointerOnHover()
        .onHover { hovering = $0 }
        .accessibilityIdentifier("routine-row")
    }
}

// MARK: - Detail

/// One routine, or the create form when `routine` is nil. Edits to name and
/// instruction commit on blur the way the settings pane's fields do; the
/// toggle, the schedule rows and Delete commit immediately.
struct RoutineEditorView: View {
    @EnvironmentObject private var model: AppModel
    let bot: ShellBot
    let routine: Routine?

    @State private var name = ""
    @State private var instruction = ""
    @State private var schedules: [RoutineSchedule] = []
    @State private var loadedId: String?
    @State private var confirmingDelete = false
    @FocusState private var focus: Field?

    private enum Field: Hashable { case name, instruction }

    /// The zone the server reads this routine's wall clock in. A new routine
    /// has none yet, and the server stamps the host's, so that is what the
    /// editor shows until it comes back.
    private var routineZone: String { routine?.timezone ?? TimeZone.current.identifier }

    private var isNew: Bool { routine == nil }
    private var busy: Bool { routine.map { model.routineBusy.contains($0.id) } ?? false }

    var body: some View {
        VStack(spacing: 0) {
            toolbar
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    if let routine {
                        actionsRow(routine)
                    }
                    FieldShell(label: "Name") {
                        TextField("", text: $name)
                            .nativeField(focused: focus == .name)
                            .focused($focus, equals: .name)
                            .onSubmit { commitName() }
                            .accessibilityIdentifier("routine-name")
                    }
                    FieldShell(label: "Instruction") {
                        instructionEditor
                    }
                    scheduleCard
                    if let routine, !isNew {
                        runHistory(routine)
                    }
                    if isNew {
                        NativeButton(
                            "Create routine",
                            kind: .primary,
                            small: true,
                            enabled: canCreate && !model.routineCreateBusy
                        ) {
                            model.createRoutine(name: trimmedName, instruction: trimmedInstruction, schedules: schedules)
                        }
                        .accessibilityIdentifier("routine-save")
                    }
                    if let error = model.routinesError {
                        Text(error)
                            .font(.system(size: 13))
                            .foregroundStyle(Theme.C.danger)
                    }
                }
                .padding(.horizontal, 16)
                .padding(.bottom, 24)
            }
            .uvScroll()
        }
        .onAppear(perform: seed)
        .onChange(of: routine?.id) { _, _ in seed() }
        // A server-side turn can edit the routine while the pane is open.
        // The refreshed row reseeds the fields, unless the owner is typing
        // in one of them: a poll must never overwrite an edit in progress,
        // the way the settings pane guards its own reseed on focus.
        .onChange(of: routine) { _, _ in
            let id = routine?.id ?? "new"
            if loadedId != id {
                seed()
                return
            }
            // A write of this routine still in flight owns the rows: a poll
            // that lands between the edit and its echo would put the old
            // server copy back over it.
            guard focus == nil, let current = routine, !model.routineBusy.contains(current.id) else { return }
            name = current.name
            instruction = current.instruction
            schedules = current.schedules
        }
        // A refused schedule write leaves the rows showing a schedule the
        // server does not have. Put the server's copy back so the rows match
        // what the next edit starts from. The error is shared by every
        // routine write, so only a routine with no write of its own in
        // flight is restored: for that one the server copy is the truth.
        .onChange(of: model.routinesError) { _, next in
            guard next != nil, let routine, !model.routineBusy.contains(routine.id) else { return }
            schedules = routine.schedules
        }
        .onChange(of: focus) { _, next in
            if next == nil {
                commitName()
                commitInstruction()
            }
        }
    }

    // MARK: Chrome

    private var toolbar: some View {
        HStack(spacing: 2) {
            NativeIconButton(systemImage: "chevron.left", size: 32, iconSize: 15) {
                // Commit before leaving: an edit still focused would be lost.
                commitName()
                commitInstruction()
                model.closeRoutineDetail()
            }
            .help("Back to routines")
            .accessibilityLabel("Back to routines")
            .accessibilityIdentifier("routine-back")
            Text(isNew ? "New routine" : "Routine")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(Theme.C.ink)
                .lineLimit(1)
            Spacer(minLength: 0)
            NativeIconButton(systemImage: "chevron.right.2", size: 32, iconSize: 15) {
                // Also reached from the settings pane, which hosts this editor.
                model.pane = .none
            }
            .help("Collapse pane")
            .accessibilityLabel("Collapse pane")
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
    }

    private func actionsRow(_ routine: Routine) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Text("Active")
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.C.ink)
                Spacer(minLength: 0)
                NativeSwitch(isOn: routine.active) {
                    model.updateRoutine(id: routine.id, active: !routine.active)
                }
                .accessibilityLabel("Active")
                .accessibilityIdentifier("routine-active")
            }
            HStack(spacing: 8) {
                NativeButton("Test run", kind: .primary, small: true, enabled: !busy) {
                    model.runRoutine(id: routine.id)
                }
                .accessibilityIdentifier("routine-test-run")
                Spacer(minLength: 0)
                NativeButton(
                    confirmingDelete ? "Confirm delete" : "Delete",
                    systemImage: "trash",
                    kind: .danger,
                    small: true,
                    enabled: !busy
                ) {
                    if confirmingDelete {
                        model.deleteRoutine(id: routine.id)
                    } else {
                        confirmingDelete = true
                    }
                }
                .accessibilityIdentifier("routine-delete")
            }
            if confirmingDelete {
                Text("Click Confirm delete to remove this routine.")
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.C.inkMuted)
            }
        }
        .padding(.top, 4)
    }

    private var instructionEditor: some View {
        ZStack(alignment: .topLeading) {
            TextEditor(text: $instruction)
                .font(.system(size: DesignTokens.FontSize.fieldInput))
                .foregroundStyle(Theme.C.ink)
                .scrollContentBackground(.hidden)
                .scrollIndicators(.never)
                .padding(.horizontal, 8)
                .padding(.vertical, 6)
                .frame(minHeight: 96)
                .focused($focus, equals: .instruction)
                .accessibilityIdentifier("routine-instruction")
            if instruction.isEmpty {
                Text("What \(bot.name) should do each time")
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
                .strokeBorder(focus == .instruction ? Theme.C.ink : Theme.C.borderStrong, lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: DesignTokens.Radius.field, style: .continuous))
    }

    // MARK: Schedules

    private var scheduleCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("When to run")
                .font(.system(size: DesignTokens.FontSize.fieldLabel, weight: .medium))
                .foregroundStyle(Theme.C.inkMuted)
            VStack(spacing: 6) {
                if schedules.isEmpty {
                    Text("No schedule yet. This routine only runs when you test it.")
                        .font(.system(size: 12))
                        .foregroundStyle(Theme.C.inkFaint)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                // Keyed by position, not by value: two rows added in a row
                // start identical, and duplicate ids make SwiftUI drop one.
                ForEach(Array(schedules.enumerated()), id: \.offset) { index, schedule in
                    ScheduleRowView(
                        schedule: schedule,
                        timezone: routineZone,
                        onChange: { next in replace(index, with: next) },
                        onRemove: { remove(index) }
                    )
                }
                Button {
                    guard let next = nextSchedule() else { return }
                    schedules.append(next)
                    commitSchedules()
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: "plus")
                            .font(.system(size: 11, weight: .regular))
                        Text("Add another")
                            .font(.system(size: 13))
                    }
                    .foregroundStyle(Theme.C.inkMuted)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.vertical, 4)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .pointerOnHover()
                .disabled(nextSchedule() == nil)
                .accessibilityIdentifier("routine-add-schedule")
            }
            .padding(10)
            .background(Theme.C.sunken)
            .overlay(
                RoundedRectangle(cornerRadius: DesignTokens.Radius.field, style: .continuous)
                    .strokeBorder(Theme.C.edge, lineWidth: 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: DesignTokens.Radius.field, style: .continuous))
        }
    }

    /// The next weekly slot nothing is using yet. The server dedupes exact
    /// matches, so appending a second copy of an existing row adds a line that
    /// disappears on the following poll.
    private func nextSchedule() -> RoutineSchedule? {
        for day in [1, 2, 3, 4, 5, 6, 0] {
            let candidate = RoutineSchedule.weekly(days: [day], time: "09:00")
            if !schedules.contains(candidate) { return candidate }
        }
        return nil
    }

    // MARK: Run history

    private func runHistory(_ routine: Routine) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Run history")
                .font(.system(size: DesignTokens.FontSize.fieldLabel, weight: .medium))
                .foregroundStyle(Theme.C.inkMuted)
            if routine.runHistory.isEmpty {
                Text("No runs yet.")
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.C.inkFaint)
            } else {
                // Newest first: the owner checks the last run, not the first.
                // Keyed by position: two runs that land in the same millisecond
                // with the same status share a `RoutineRun.id`, and SwiftUI
                // drops one of a duplicated pair.
                ForEach(Array(routine.runHistory.enumerated()).reversed(), id: \.offset) { _, run in
                    HStack(alignment: .top, spacing: 8) {
                        Image(systemName: run.succeeded ? "checkmark.circle" : "exclamationmark.triangle")
                            .font(.system(size: 12))
                            .foregroundStyle(run.succeeded ? Theme.C.inkMuted : Theme.C.danger)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(RoutineCopy.runLabel(iso: run.at))
                                .font(.system(size: 13))
                                .foregroundStyle(Theme.C.ink)
                            if !run.succeeded, !run.error.isEmpty {
                                Text(run.error)
                                    .font(.system(size: 12))
                                    .foregroundStyle(Theme.C.danger)
                                    .lineLimit(2)
                            }
                        }
                        Spacer(minLength: 0)
                    }
                    .padding(.vertical, 2)
                }
            }
        }
    }

    // MARK: Editing

    private var trimmedName: String { name.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var trimmedInstruction: String { instruction.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var canCreate: Bool { !trimmedName.isEmpty && !trimmedInstruction.isEmpty }

    /// Load the server's copy once per routine. A poll that refreshes the list
    /// mid-edit must not overwrite what the owner is typing.
    private func seed() {
        let id = routine?.id ?? "new"
        guard loadedId != id else { return }
        loadedId = id
        confirmingDelete = false
        name = routine?.name ?? ""
        instruction = routine?.instruction ?? ""
        schedules = routine?.schedules ?? [.weekly(days: [1], time: "09:00")]
    }

    private func commitName() {
        guard let routine, !trimmedName.isEmpty, trimmedName != routine.name else { return }
        model.updateRoutine(id: routine.id, name: trimmedName)
    }

    private func commitInstruction() {
        guard let routine, !trimmedInstruction.isEmpty, trimmedInstruction != routine.instruction else { return }
        model.updateRoutine(id: routine.id, instruction: trimmedInstruction)
    }

    private func commitSchedules() {
        guard let routine else { return }
        model.updateRoutine(id: routine.id, schedules: schedules)
    }

    private func replace(_ index: Int, with next: RoutineSchedule) {
        guard schedules.indices.contains(index) else { return }
        schedules[index] = next
        commitSchedules()
    }

    private func remove(_ index: Int) {
        guard schedules.indices.contains(index) else { return }
        schedules.remove(at: index)
        commitSchedules()
    }
}

// MARK: - Schedule row

/// One editable schedule: repeat kind, the day it lands on, and the time.
private struct ScheduleRowView: View {
    let schedule: RoutineSchedule
    /// The zone the server fires this routine in. The picker is read and
    /// written in it, not in the viewer's own zone: a one-shot edited from
    /// another zone near midnight would otherwise move a day.
    let timezone: String
    let onChange: (RoutineSchedule) -> Void
    let onRemove: () -> Void

    @State private var time = ""
    @FocusState private var timeFocused: Bool

    private var weekdayNames: [String] {
        let formatter = DateFormatter()
        formatter.locale = .current
        return formatter.shortWeekdaySymbols ?? []
    }

    private var days: [Int] {
        if case .weekly(let days, _) = schedule { return days }
        return []
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Menu {
                    Button("Every week") { onChange(.weekly(days: days.isEmpty ? [1] : days, time: schedule.time)) }
                    Button("Every day") { onChange(.daily(time: schedule.time)) }
                    Button("Once") { onChange(.once(date: today(), time: schedule.time)) }
                } label: {
                    Text(kindLabel)
                        .font(.system(size: 13))
                        .foregroundStyle(Theme.C.ink)
                }
                .menuStyle(.borderlessButton)
                .fixedSize()
                .accessibilityIdentifier("routine-schedule-kind")

                TextField("09:00", text: $time)
                    .nativeField(focused: timeFocused)
                    .focused($timeFocused)
                    .frame(width: 74)
                    .onSubmit { commitTime() }
                    .accessibilityLabel("Time")
                    .accessibilityIdentifier("routine-schedule-time")

                Spacer(minLength: 0)
                NativeIconButton(systemImage: "xmark", size: 24, iconSize: 11, action: onRemove)
                    .help("Remove schedule")
                    .accessibilityLabel("Remove schedule")
                    .accessibilityIdentifier("routine-schedule-remove")
            }
            if case .weekly = schedule {
                HStack(spacing: 3) {
                    ForEach(0..<7, id: \.self) { index in
                        dayChip(index)
                    }
                }
            }
            if case .once(let date, let time) = schedule {
                // A picker rather than a field: it cannot produce 2026-02-31,
                // which the server refuses, and a one-shot schedule with no way
                // to change its date could only be deleted and made again.
                DatePicker(
                    "",
                    selection: Binding(
                        get: { day(from: date) },
                        set: { onChange(.once(date: iso(from: $0), time: time)) }
                    ),
                    displayedComponents: .date
                )
                .labelsHidden()
                .datePickerStyle(.field)
                .environment(\.timeZone, zone)
                .fixedSize()
                .accessibilityLabel("Date")
                .accessibilityIdentifier("routine-schedule-date")
            }
        }
        .onAppear { time = schedule.time }
        .onChange(of: schedule.time) { _, next in
            // Only adopt the server's value when the owner is not editing.
            if !timeFocused { time = next }
        }
        .onChange(of: timeFocused) { _, focused in
            if !focused { commitTime() }
        }
    }

    private var kindLabel: String {
        switch schedule {
        case .weekly: return "Every week"
        case .daily: return "Every day"
        case .once: return "Once"
        }
    }

    private func dayChip(_ index: Int) -> some View {
        let on = days.contains(index)
        let symbols = weekdayNames
        let label = index < symbols.count ? String(symbols[index].prefix(2)) : "\(index)"
        return Button {
            var next = Set(days)
            if on { next.remove(index) } else { next.insert(index) }
            // A weekly schedule with no day would never fire; keep at least one.
            let ordered = next.sorted()
            onChange(.weekly(days: ordered.isEmpty ? [index] : ordered, time: schedule.time))
        } label: {
            Text(label)
                .font(.system(size: 11, weight: on ? .semibold : .regular))
                .foregroundStyle(on ? Theme.C.accentInk : Theme.C.inkMuted)
                .frame(width: 28, height: 22)
                .background(on ? Theme.C.accent : Theme.C.surface)
                .overlay(
                    RoundedRectangle(cornerRadius: DesignTokens.Radius.xs, style: .continuous)
                        .strokeBorder(on ? .clear : Theme.C.borderStrong, lineWidth: 1)
                )
                .clipShape(RoundedRectangle(cornerRadius: DesignTokens.Radius.xs, style: .continuous))
                .contentShape(RoundedRectangle(cornerRadius: DesignTokens.Radius.xs, style: .continuous))
        }
        .buttonStyle(.plain)
        .pointerOnHover()
        .accessibilityLabel(index < symbols.count ? symbols[index] : "Day \(index)")
        .accessibilityAddTraits(on ? .isSelected : [])
    }

    private func commitTime() {
        let candidate = time.trimmingCharacters(in: .whitespaces)
        guard candidate != schedule.time else { return }
        guard RoutineTime.isValid(candidate) else {
            // Reject rather than send: the server would drop the whole schedule.
            time = schedule.time
            return
        }
        switch schedule {
        case .weekly(let days, _): onChange(.weekly(days: days, time: candidate))
        case .daily: onChange(.daily(time: candidate))
        case .once(let date, _): onChange(.once(date: date, time: candidate))
        }
    }

    private func today() -> String {
        iso(from: Date())
    }

    private var zone: TimeZone {
        TimeZone(identifier: timezone) ?? .current
    }

    /// The wire date is a civil day, not an instant, so it is read and written
    /// in the routine's own zone. The picker renders in the same zone, so the
    /// day the owner sees in the control is the day that goes on the wire and
    /// the day the server fires on.
    private func wireDate() -> DateFormatter {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = zone
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter
    }

    private func iso(from date: Date) -> String {
        wireDate().string(from: date)
    }

    private func day(from iso: String) -> Date {
        wireDate().date(from: iso) ?? Date()
    }
}
