import AppKit
import SwiftUI
import UsefulBotCore

/// Settings sections.
enum AppSettingsTab: String, CaseIterable, Identifiable {
    case general
    case providers
    case computer
    case usage
    case feedback
    case about

    var id: String { rawValue }

    var label: String {
        switch self {
        case .general: return "General"
        case .providers: return "Providers"
        case .computer: return "Computer"
        case .usage: return "Usage"
        case .feedback: return "Feedback"
        case .about: return "About"
        }
    }

    var icon: String {
        switch self {
        case .general: return "gearshape"
        case .providers: return "server.rack"
        case .computer: return "desktopcomputer"
        case .usage: return "chart.bar"
        case .feedback: return "bubble.left"
        case .about: return "info.circle"
        }
    }
}

/// `.settings-modal`: a 200pt nav rail and the scrolling pane, 860x640.
struct AppSettingsView: View {
    @EnvironmentObject private var model: AppModel

    let onClose: () -> Void
    @State private var tab: AppSettingsTab
    @AppStorage(AppAppearance.storageKey) private var appearance: AppAppearance = .light
    @ObservedObject private var avatarStore = OperatorAvatarStore.shared
    /// The daily limit while it is being typed. The usage tab polls every few
    /// seconds, and the poll must not overwrite a half-typed number.
    @State private var editedBudget: String?
    /// Tracks the daily-limit field so clicking away commits the typed value
    /// the way Return does.
    @FocusState private var budgetFieldFocused: Bool
    /// The same two for the daily request limit.
    @State private var editedRequests: String?
    @FocusState private var requestFieldFocused: Bool
    /// The open Providers brand card, rendered at the dialog root so the
    /// scrolling body cannot clip it. Anchors come from the pane.
    @State private var providersCard: ProvidersCard?
    @State private var providersKeySheet: KeySheetTarget?
    @ObservedObject private var updater = AppUpdater.shared
    /// The form outlives the dialog: closing Settings keeps what was typed.
    @ObservedObject private var feedbackDraft = FeedbackDraft.shared
    @State private var feedbackEmailError: String?
    @State private var feedbackSending = false
    @State private var feedbackSent = false
    @State private var feedbackError: String?
    @FocusState private var feedbackEmailFocused: Bool

    init(initialTab: AppSettingsTab, onClose: @escaping () -> Void) {
        self.onClose = onClose
        _tab = State(initialValue: initialTab)
    }

    var body: some View {
        ZStack {
            Theme.C.overlay
                .ignoresSafeArea()
                .onTapGesture(perform: onClose)
            HStack(spacing: 0) {
                nav
                main
            }
            .frame(width: 860, height: 640)
            .background(Theme.C.surface)
            .overlay(
                RoundedRectangle(cornerRadius: DesignTokens.Radius.dialog, style: .continuous)
                    .strokeBorder(Theme.C.edge, lineWidth: 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: DesignTokens.Radius.dialog, style: .continuous))
            .popShadow()
            .overlayPreferenceValue(ProvidersCardAnchorsKey.self) { anchors in
                GeometryReader { proxy in
                    if tab == .providers, let card = providersCard,
                       let match = anchors.first(where: { $0.card == card }) {
                        let host = ProvidersCardHost(
                            pane: providersPaneView,
                            card: card,
                            openCard: $providersCard,
                            anchor: proxy[match.bounds],
                            dialogSize: proxy.size
                        )
                        Color.clear
                            .frame(width: proxy.size.width, height: proxy.size.height)
                            .overlay(alignment: host.alignment) {
                                // Keyed by card: a switch between two cards gets a
                                // fresh host, so its height is measured anew.
                                host.id(card)
                                    .offset(x: host.xOffset, y: host.yOffset)
                            }
                    }
                }
            }
            .sheet(item: $providersKeySheet) { target in
                KeySheetView(target: target, onClose: { providersKeySheet = nil })
            }
        }
        .onExitCommand {
            if providersCard != nil {
                providersCard = nil
            } else {
                onClose()
            }
        }
        .onChange(of: model.appSettingsTab) { _, next in
            tab = next
        }
        .onChange(of: tab) { _, _ in
            providersCard = nil
        }
        .task(id: tab) {
            switch tab {
            case .providers:
                await model.loadProviders()
            case .usage:
                var delay: UInt64 = 4_000_000_000
                while !Task.isCancelled {
                    await model.loadUsage()
                    // Back off a failed poll so a server that is down is not
                    // hit every 4s, and reset once it answers again.
                    delay = model.usageError == nil
                        ? 4_000_000_000
                        : min(delay * 2, 30_000_000_000)
                    try? await Task.sleep(nanoseconds: delay)
                }
            default:
                break
            }
        }
    }

    // MARK: - Chrome

    private var nav: some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(AppSettingsTab.allCases) { item in
                Button {
                    tab = item
                } label: {
                    HStack(spacing: 8) {
                        Image(systemName: item.icon)
                            .font(.system(size: 14, weight: .regular))
                            .frame(width: 16)
                        Text(item.label)
                            .font(.system(size: 13))
                        Spacer(minLength: 0)
                    }
                    .padding(.horizontal, 10)
                    .padding(.vertical, 8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(tab == item ? Theme.C.sunken : .clear)
                    .foregroundStyle(tab == item ? Theme.C.ink : Theme.C.inkMuted)
                    .clipShape(RoundedRectangle(cornerRadius: DesignTokens.Radius.sm, style: .continuous))
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .pointerOnHover()
                .accessibilityAddTraits(tab == item ? [.isSelected] : [])
                .accessibilityIdentifier("settings-tab-\(item.rawValue)")
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 16)
        .frame(width: 200)
        .frame(maxHeight: .infinity, alignment: .top)
        .background(Theme.C.canvas)
        .overlay(alignment: .trailing) { VerticalHairline() }
    }

    private var main: some View {
        VStack(alignment: .leading, spacing: 0) {
            // The title row stays put above the scroller: when it scrolled
            // with the pane, a long pane slid under the close button.
            HStack {
                Text(tab.label)
                    .font(.system(size: 20, weight: .semibold))
                    .foregroundStyle(Theme.C.ink)
                Spacer(minLength: 0)
                NativeIconButton(systemImage: "xmark", size: 32, iconSize: 15, action: onClose)
                    .accessibilityLabel("Close settings")
            }
            .frame(minHeight: 32)
            .padding(EdgeInsets(top: 20, leading: 32, bottom: 20, trailing: 28))

            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    switch tab {
                    case .general: generalPane
                    case .providers: providersPane
                    case .computer: computerPane
                    case .usage: usagePane
                    case .feedback: feedbackPane
                    case .about: aboutPane
                    }
                }
                .padding(EdgeInsets(top: 0, leading: 32, bottom: 28, trailing: 28))
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .uvScroll()
        }
    }

    // MARK: - General

    /// The same name and initials the rail shows (`AppModel.loadOperator`).
    private var displayName: String { model.operatorName }
    private var displayInitials: String { model.operatorInitials }

    private var generalPane: some View {
        VStack(alignment: .leading, spacing: 24) {
            section("Account") {
                settingsGroup {
                    settingsRow(last: true) {
                        HStack(spacing: 12) {
                            Button {
                                avatarStore.pick()
                            } label: {
                                OperatorAvatarView(initials: displayInitials, size: 40)
                            }
                            .buttonStyle(.plain)
                            .pointerOnHover()
                            .help("Change photo")
                            .accessibilityLabel("Change profile photo")
                            VStack(alignment: .leading, spacing: 1) {
                                Text(displayName)
                                    .font(.system(size: 14, weight: .medium))
                                    .foregroundStyle(Theme.C.ink)
                                    .lineLimit(1)
                                if let error = avatarStore.error {
                                    Text(error)
                                        .font(.system(size: 12))
                                        .foregroundStyle(Theme.C.danger)
                                        .fixedSize(horizontal: false, vertical: true)
                                }
                            }
                            Spacer(minLength: 0)
                            if avatarStore.image != nil {
                                NativeButton("Remove", kind: .secondary, small: true, action: avatarStore.remove)
                            }
                            NativeButton(avatarStore.image == nil ? "Upload photo" : "Change photo", kind: .secondary, small: true, action: avatarStore.pick)
                        }
                    }
                }
            }

            section("Appearance") {
                settingsGroup {
                    settingsRow {
                        Text("Theme")
                            .font(.system(size: 14))
                            .foregroundStyle(Theme.C.ink)
                        Spacer(minLength: 0)
                        AppearancePicker(selection: $appearance)
                    }
                    settingsRow(last: true) {
                        Text("Language")
                            .font(.system(size: 14))
                            .foregroundStyle(Theme.C.ink)
                        Spacer(minLength: 0)
                        settingsValue("System")
                    }
                }
            }

            section("System") {
                settingsGroup {
                    settingsRow(last: true) {
                        Text("Timezone")
                            .font(.system(size: 14))
                            .foregroundStyle(Theme.C.ink)
                        Spacer(minLength: 0)
                        settingsValue(TimeZone.current.identifier)
                    }
                }
            }
        }
    }

    // MARK: - Providers

    private var providersPaneView: ProvidersPaneView {
        ProvidersPaneView(model: model, openCard: $providersCard, keySheet: $providersKeySheet)
    }

    private var providersPane: some View {
        providersPaneView
    }

    // MARK: - Computer

    private var computerPane: some View {
        VStack(alignment: .leading, spacing: 24) {
            section(nil) {
                settingsGroup {
                    settingsRow {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("This Mac")
                                .font(.system(size: 14))
                                .foregroundStyle(Theme.C.ink)
                            Text("Bots run their tools on this Mac.")
                                .font(.system(size: 12))
                                .foregroundStyle(Theme.C.inkMuted)
                        }
                        Spacer(minLength: 0)
                        settingsValue(Self.chipName)
                    }
                    settingsRow(last: true) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Local execution")
                                .font(.system(size: 14))
                                .foregroundStyle(Theme.C.ink)
                            Text("Writes and shell still need your approval.")
                                .font(.system(size: 12))
                                .foregroundStyle(Theme.C.inkMuted)
                        }
                        Spacer(minLength: 0)
                        settingsValue("On")
                    }
                }
            }
        }
    }

    /// `machdep.cpu.brand_string` reports the real chip ("Apple M2 Max",
    /// "Intel(R) Core(TM) i7...") instead of the web's hardcoded platform.
    static let chipName: String = {
        var size = 0
        guard sysctlbyname("machdep.cpu.brand_string", nil, &size, nil, 0) == 0, size > 0 else {
            return "This Mac"
        }
        var buffer = [CChar](repeating: 0, count: size)
        guard sysctlbyname("machdep.cpu.brand_string", &buffer, &size, nil, 0) == 0 else {
            return "This Mac"
        }
        return String(cString: buffer)
    }()

    // MARK: - Usage

    private var usagePane: some View {
        VStack(alignment: .leading, spacing: 24) {
            if let usage = model.usage {
                if let error = model.usageError {
                    // A failed poll keeps the last good numbers on screen; the
                    // line above them says they may be stale.
                    Text(error)
                        .font(.system(size: 13))
                        .foregroundStyle(Theme.C.danger)
                }
                section("Today") {
                    settingsGroup {
                        usageMeterRow(
                            label: "Input",
                            used: usage.chargedInputTokens,
                            cap: usage.caps.input24h
                        )
                        usageMeterRow(
                            label: "Output",
                            used: usage.chargedOutputTokens,
                            cap: usage.caps.output24h
                        )
                        settingsRow(last: true) {
                            Text("Requests")
                                .font(.system(size: 14))
                                .foregroundStyle(Theme.C.ink)
                            Spacer(minLength: 0)
                            settingsValue(BudgetInput.requestUsage(used: usage.requests, cap: usage.caps.requests24h))
                        }
                    }
                }
                if let budget = usage.budget {
                    section("Daily limit") {
                        settingsGroup {
                            settingsRow(last: usage.requestBudget == nil) {
                                Text("Tokens a day")
                                    .font(.system(size: 14))
                                    .foregroundStyle(Theme.C.ink)
                                Spacer(minLength: 0)
                                if !budget.isDefault {
                                    Button("Reset") {
                                        editedBudget = nil
                                        model.clearBudgetError(.tokens)
                                        model.setDailyTokenBudget(nil)
                                    }
                                    .buttonStyle(.plain)
                                    .font(.system(size: 13))
                                    .foregroundStyle(Theme.C.inkMuted)
                                    .pointerOnHover()
                                    .disabled(model.usageBusy)
                                }
                                budgetStepper(budget)
                            }
                            if let requestBudget = usage.requestBudget {
                                settingsRow(last: true) {
                                    Text("Requests a day")
                                        .font(.system(size: 14))
                                        .foregroundStyle(Theme.C.ink)
                                    Spacer(minLength: 0)
                                    if !requestBudget.isDefault {
                                        Button("Reset") {
                                            editedRequests = nil
                                            model.clearBudgetError(.requests)
                                            model.setDailyRequestBudget(nil)
                                        }
                                        .buttonStyle(.plain)
                                        .font(.system(size: 13))
                                        .foregroundStyle(Theme.C.inkMuted)
                                        .pointerOnHover()
                                        .disabled(model.usageBusy)
                                    }
                                    requestStepper(requestBudget)
                                }
                            }
                        }
                        if let error = model.budgetMessages.current {
                            Text(error)
                                .font(.system(size: 13))
                                .foregroundStyle(Theme.C.danger)
                                .padding(.leading, 4)
                                .padding(.top, 8)
                        } else if BudgetInput.tokenBudgetAboveDefault(tokens: budget.tokens, default: budget.default) {
                            Text("Higher limits can mean higher provider bills.")
                                .font(.system(size: 13))
                                .foregroundStyle(Theme.C.inkMuted)
                                .padding(.leading, 4)
                                .padding(.top, 8)
                        }
                    }
                }
                if let week = usage.week {
                    section("This week") {
                        settingsGroup {
                            settingsRow {
                                Text("Tokens")
                                    .font(.system(size: 14))
                                    .foregroundStyle(Theme.C.ink)
                                Spacer(minLength: 0)
                                settingsValue(compact(week.totalTokens))
                                    .help(count(week.totalTokens))
                            }
                            settingsRow(last: true) {
                                Text("Requests")
                                    .font(.system(size: 14))
                                    .foregroundStyle(Theme.C.ink)
                                Spacer(minLength: 0)
                                settingsValue(compact(week.requests))
                            }
                        }
                    }
                }
                section("By model") {
                    if usage.byModel.isEmpty {
                        Text("No model traffic this week yet.")
                            .font(.system(size: 14))
                            .foregroundStyle(Theme.C.inkMuted)
                    } else {
                        settingsGroup {
                            ForEach(Array(usage.byModel.enumerated()), id: \.element.id) { index, row in
                                settingsRow(last: index == usage.byModel.count - 1) {
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(row.model)
                                            .font(.system(size: 14))
                                            .foregroundStyle(Theme.C.ink)
                                            .lineLimit(1)
                                        Text("\(row.provider) · \(compact(row.requests)) requests")
                                            .font(.system(size: 12))
                                            .foregroundStyle(Theme.C.inkMuted)
                                    }
                                    Spacer(minLength: 0)
                                    settingsValue(compact(row.inputTokens + row.outputTokens))
                                        .help(count(row.inputTokens + row.outputTokens))
                                }
                            }
                        }
                    }
                }
            } else if let error = model.usageError {
                Text(error)
                    .font(.system(size: 14))
                    .foregroundStyle(Theme.C.danger)
            } else {
                Text("Loading usage.")
                    .font(.system(size: 14))
                    .foregroundStyle(Theme.C.inkMuted)
            }
        }
    }

    /// One capped quantity: the numbers on the row, the meter under them. The
    /// window is the rolling day the caps are enforced over, so the bar can be
    /// read as how close the day is to stopping.
    private func usageMeterRow(label: String, used: Int, cap: Int) -> some View {
        settingsRow {
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 16) {
                    Text(label)
                        .font(.system(size: 14))
                        .foregroundStyle(Theme.C.ink)
                    Spacer(minLength: 0)
                    settingsValue(cap > 0 ? "\(compact(used)) of \(compact(cap))" : compact(used))
                        .help(count(used))
                }
                usageMeter(fraction: BudgetInput.meterFraction(used: used, cap: cap))
            }
        }
    }

    /// Minus, the budget, plus. The field takes a typed number as well, since
    /// moving from 500M to 2,000M is a sentence, not forty taps.
    private func budgetStepper(_ budget: UsagePayload.Budget) -> some View {
        let step = Self.budgetStep(for: budget.tokens)
        return limitStepper(
            text: Binding(
                get: { editedBudget ?? BudgetInput.tokenLabel(budget.tokens) },
                set: { editedBudget = $0; model.clearBudgetError(.tokens) }
            ),
            focused: $budgetFieldFocused,
            atMin: budget.tokens <= budget.min,
            atMax: budget.max.map { budget.tokens >= $0 } ?? false,
            lower: { commitBudget(budget.tokens - step, budget) },
            raise: { commitBudget(budget.tokens + step, budget) },
            submit: { commitTypedBudget(budget) },
            changed: { editedBudget = nil; model.clearBudgetError(.tokens) },
            value: budget.tokens,
            lowerLabel: "Lower the daily token limit",
            raiseLabel: "Raise the daily token limit",
            fieldLabel: "Daily token limit in millions"
        )
    }

    private func requestStepper(_ budget: UsagePayload.RequestBudget) -> some View {
        let step = Self.requestStep(for: budget.requests)
        return limitStepper(
            text: Binding(
                get: { editedRequests ?? BudgetInput.requestLabel(budget.requests) },
                set: { editedRequests = $0; model.clearBudgetError(.requests) }
            ),
            focused: $requestFieldFocused,
            atMin: budget.requests <= budget.min,
            atMax: budget.max.map { budget.requests >= $0 } ?? false,
            lower: { commitRequests(budget.requests - step, budget) },
            raise: { commitRequests(budget.requests + step, budget) },
            submit: { commitTypedRequests(budget) },
            changed: { editedRequests = nil; model.clearBudgetError(.requests) },
            value: budget.requests,
            lowerLabel: "Lower the daily request limit",
            raiseLabel: "Raise the daily request limit",
            fieldLabel: "Daily request limit"
        )
    }

    private func limitStepper(
        text: Binding<String>,
        focused: FocusState<Bool>.Binding,
        atMin: Bool,
        atMax: Bool,
        lower: @escaping () -> Void,
        raise: @escaping () -> Void,
        submit: @escaping () -> Void,
        changed: @escaping () -> Void,
        value: Int,
        lowerLabel: String,
        raiseLabel: String,
        fieldLabel: String
    ) -> some View {
        HStack(spacing: 2) {
            NativeIconButton(systemImage: "minus", size: 28, iconSize: 12, action: lower)
                .disabled(model.usageBusy || atMin)
                .opacity(atMin ? 0.4 : 1)
                .accessibilityLabel(lowerLabel)

            TextField("", text: text)
                .textFieldStyle(.plain)
                .font(.system(size: 14, weight: .medium).monospacedDigit())
                .multilineTextAlignment(.center)
                .foregroundStyle(Theme.C.ink)
                .frame(width: 88)
                .focused(focused)
                .onSubmit(submit)
                // The typed value stays until the router confirms it: cleared
                // here on the new server value, so a refused write leaves the
                // text the error is talking about in the field.
                .onChange(of: value) { _, _ in changed() }
                // Clicking away commits the same way Return does; the poll
                // never overwrites an uncommitted edit, so without this the
                // field would keep showing a limit the router is not enforcing.
                .onChange(of: focused.wrappedValue) { _, isFocused in
                    guard !isFocused else { return }
                    submit()
                }
                .accessibilityLabel(fieldLabel)

            NativeIconButton(systemImage: "plus", size: 28, iconSize: 12, action: raise)
                .disabled(model.usageBusy || atMax)
                .opacity(atMax ? 0.4 : 1)
                .accessibilityLabel(raiseLabel)
        }
        .padding(.horizontal, 4)
        .frame(height: 32)
        .overlay(
            RoundedRectangle(cornerRadius: DesignTokens.Radius.action, style: .continuous)
                .strokeBorder(Theme.C.edge, lineWidth: 1)
        )
    }

    /// A step that keeps the stepper useful as the budget grows: a million at a
    /// time near the floor, half a billion once it is in the billions.
    private static func budgetStep(for tokens: Int) -> Int {
        switch tokens {
        case ..<10_000_000: return 1_000_000
        case ..<100_000_000: return 5_000_000
        case ..<1_000_000_000: return 50_000_000
        default: return 500_000_000
        }
    }

    private static func requestStep(for requests: Int) -> Int {
        switch requests {
        case ..<1_000: return 100
        case ..<10_000: return 500
        case ..<100_000: return 5_000
        default: return 50_000
        }
    }

    /// The field is in millions. "35", "35M" and "3.5" all mean what they look
    /// like; anything else is refused with the rule it broke, because
    /// reinterpreting "3.5M" would change the spend limit and call it a typo.
    /// A rejected value stays in the field so the message names text the owner
    /// can still see.
    private func commitTypedBudget(_ budget: UsagePayload.Budget) {
        guard let typed = editedBudget else { return }
        switch BudgetInput.tokens(typed, min: budget.min, max: budget.max) {
        case .failure(let error):
            model.reportBudgetError(.tokens, error.message)
        case .success(let tokens):
            guard tokens != budget.tokens else {
                editedBudget = nil
                return
            }
            model.setDailyTokenBudget(tokens)
        }
    }

    private func commitTypedRequests(_ budget: UsagePayload.RequestBudget) {
        guard let typed = editedRequests else { return }
        switch BudgetInput.requests(typed, min: budget.min, max: budget.max) {
        case .failure(let error):
            model.reportBudgetError(.requests, error.message)
        case .success(let requests):
            guard requests != budget.requests else {
                editedRequests = nil
                return
            }
            model.setDailyRequestBudget(requests)
        }
    }

    /// The stepper's own moves: pressing - at the floor stops at the floor
    /// rather than erroring. Typed input takes the stricter path above.
    private func commitBudget(_ tokens: Int, _ budget: UsagePayload.Budget) {
        let clamped = max(budget.min, min(budget.max ?? BudgetInput.maxSafe, tokens))
        // A click is a new answer: a refusal about earlier typed text is stale,
        // and so is the text, so both go together even when the value holds.
        editedBudget = nil
        model.clearBudgetError(.tokens)
        guard clamped != budget.tokens else { return }
        model.setDailyTokenBudget(clamped)
    }

    private func commitRequests(_ requests: Int, _ budget: UsagePayload.RequestBudget) {
        let clamped = max(budget.min, min(budget.max ?? BudgetInput.maxSafe, requests))
        editedRequests = nil
        model.clearBudgetError(.requests)
        guard clamped != budget.requests else { return }
        model.setDailyRequestBudget(clamped)
    }

    private func usageMeter(fraction: Double) -> some View {
        GeometryReader { proxy in
            ZStack(alignment: .leading) {
                // The card is sunken grey, so the track takes the border tone.
                Capsule().fill(Theme.C.border)
                Capsule()
                    .fill(fraction >= 0.9 ? Theme.C.danger : Theme.C.ink)
                    .frame(width: max(fraction > 0 ? 2 : 0, proxy.size.width * fraction))
            }
        }
        .frame(height: 4)
    }

    /// Grouped in the language the app is written in. The machine's locale
    /// would render 2,000 as "2.000" beside English labels, which reads as two.
    private func count(_ value: Int) -> String {
        value.formatted(.number.grouping(.automatic).locale(Locale(identifier: "en_US")))
    }

    /// 1,238,402 reads as noise in a meter row; 1.2M reads as a quantity. The
    /// exact number stays one hover away.
    private func compact(_ value: Int) -> String {
        if value >= 1_000_000 {
            let millions = Double(value) / 1_000_000
            // A round budget is "30M", not "30.0M"; a real total keeps its
            // tenth, because 2.2M and 2.9M are a different day.
            if millions >= 100 || millions == millions.rounded() {
                return "\(count(Int(millions.rounded())))M"
            }
            return String(format: "%.1fM", millions)
        }
        if value >= 10_000 {
            return "\(Int((Double(value) / 1_000).rounded()))K"
        }
        return count(value)
    }

    // MARK: - About

    private var aboutPane: some View {
        VStack(alignment: .leading, spacing: 24) {
            HStack(spacing: 14) {
                Image(nsImage: BrandAssets.image("png/black/useful-bot-256.png"))
                    .resizable()
                    .interpolation(.high)
                    .scaledToFit()
                    .frame(width: 56, height: 56)
                    .clipShape(RoundedRectangle(cornerRadius: DesignTokens.Radius.md, style: .continuous))
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Useful Bot")
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundStyle(Theme.C.ink)
                    Text("Version \(AppUpdater.version) (\(AppUpdater.build))")
                        .font(.system(size: 13))
                        .foregroundStyle(Theme.C.inkMuted)
                        .textSelection(.enabled)
                        .accessibilityIdentifier("about-version")
                }
            }

            section("Updates") {
                settingsGroup {
                    if updater.available {
                        settingsRow {
                            Text(updateStatus)
                                .font(.system(size: 14))
                                .foregroundStyle(Theme.C.ink)
                                .lineLimit(2)
                            Spacer(minLength: 0)
                            if updater.pendingVersion != nil {
                                // Same as the account menu: installs a downloaded
                                // update, or opens Sparkle's window for a found one.
                                NativeButton("Update now", kind: .primary, small: true,
                                             enabled: updater.canCheckForUpdates) { updater.updateNow() }
                                    .accessibilityIdentifier("about-install-update")
                            } else {
                                NativeButton("Check now", kind: .secondary, small: true,
                                             enabled: updater.canCheckForUpdates && updater.status != .checking) {
                                    updater.checkForUpdates()
                                }
                                .accessibilityIdentifier("about-check-now")
                            }
                        }
                        settingsRow(last: true) {
                            Text("Install updates automatically")
                                .font(.system(size: 14))
                                .foregroundStyle(Theme.C.ink)
                            Spacer(minLength: 0)
                            NativeSwitch(isOn: updater.installAutomatically) {
                                updater.setInstallAutomatically(!updater.installAutomatically)
                            }
                            .disabled(!updater.allowsAutomaticUpdates)
                            .opacity(updater.allowsAutomaticUpdates ? 1 : 0.55)
                            .accessibilityLabel("Install updates automatically")
                        }
                    } else {
                        settingsRow(last: true) {
                            Text("This is a development build. Updates come with releases.")
                                .font(.system(size: 14))
                                .foregroundStyle(Theme.C.inkMuted)
                            Spacer(minLength: 0)
                        }
                    }
                }
            }

            if ReleaseLinks.whatsNew != nil || ReleaseLinks.privacy != nil {
                section("Links") {
                    settingsGroup {
                        if let url = ReleaseLinks.whatsNew {
                            linkRow("What's new in \(AppUpdater.version)", url: url, last: ReleaseLinks.privacy == nil)
                        }
                        if let url = ReleaseLinks.privacy {
                            linkRow("Privacy", url: url, last: true)
                        }
                    }
                }
            }
        }
    }

    private var updateStatus: String {
        switch updater.status {
        case .checking: return "Checking for updates…"
        case .available(let version): return "Version \(version) is available"
        case .ready(let version): return "Version \(version) is ready to install"
        case .failed: return "Couldn't check for updates. Try again later."
        case .upToDate, .idle:
            guard let checked = updater.lastChecked else {
                return updater.status == .upToDate ? "Up to date" : "Not checked yet"
            }
            let ago = Date().timeIntervalSince(checked) < 60
                ? "just now"
                : RelativeDateTimeFormatter().localizedString(for: checked, relativeTo: Date())
            return "Up to date. Checked \(ago)"
        }
    }

    private func linkRow(_ title: String, url: URL, last: Bool, value: String? = nil) -> some View {
        Button {
            NSWorkspace.shared.open(url)
        } label: {
            settingsRow(last: last) {
                Text(title)
                    .font(.system(size: 14))
                    .foregroundStyle(Theme.C.ink)
                Spacer(minLength: 0)
                if let value { settingsValue(value) }
                Image(systemName: "arrow.up.right")
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(Theme.C.inkMuted)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .pointerOnHover()
    }

    // MARK: - Feedback

    /// Info.plist's `UBFeedbackURL`, written by build-app.sh; a defaults value
    /// of the same name overrides it for a local check. Nil means this build
    /// cannot send.
    private static var feedbackURL: URL? {
        // The dev app never posts to the production Worker, even with a defaults override.
        guard AppVariant.current.allowsFeedback else { return nil }
        let raw = UserDefaults.standard.string(forKey: "UBFeedbackURL")
            ?? Bundle.main.object(forInfoDictionaryKey: "UBFeedbackURL") as? String
        guard let raw, let url = URL(string: raw), url.scheme == "https" || url.scheme == "http" else { return nil }
        return url
    }

    private var feedbackDetails: String {
        "Useful Bot \(AppUpdater.version) (\(AppUpdater.build)), macOS \(Feedback.macOSVersion()) and \(Self.chipName)"
    }

    private var feedbackPlaceholder: String {
        switch feedbackDraft.kind {
        case .idea: return "What would make Useful Bot better for you?"
        case .problem: return "What happened, and what did you expect?"
        case .other: return "Tell us anything."
        }
    }

    private var feedbackLength: Int { Feedback.length(feedbackDraft.message) }

    private var canSendFeedback: Bool {
        !feedbackSending && Self.feedbackURL != nil && Feedback.canSend(feedbackDraft.message)
    }

    private var feedbackPane: some View {
        VStack(alignment: .leading, spacing: 24) {
            if feedbackSent {
                settingsGroup {
                    settingsRow(last: true) {
                        Image(systemName: "checkmark.circle.fill")
                            .font(.system(size: 16))
                            .foregroundStyle(Theme.C.success)
                        Text("Thanks. Your feedback reached us.")
                            .font(.system(size: 14))
                            .foregroundStyle(Theme.C.ink)
                            .accessibilityIdentifier("feedback-sent")
                        Spacer(minLength: 0)
                        NativeButton("Send more", kind: .secondary, small: true) {
                            feedbackSent = false
                        }
                    }
                }
                .transition(.opacity)
            } else {
                feedbackForm
            }

            section("Contact") {
                settingsGroup {
                    if let url = ReleaseLinks.reportBug {
                        linkRow("Report a bug on GitHub", url: url, last: false, value: "Public")
                    }
                    linkRow("Email us", url: ReleaseLinks.contactMail, last: true, value: ReleaseLinks.contactAddress)
                }
            }
        }
        .animation(Theme.ease(0.25), value: feedbackSent)
    }

    private var feedbackForm: some View {
        VStack(alignment: .leading, spacing: 16) {
            ToneSegmented(
                items: FeedbackKind.allCases,
                selection: $feedbackDraft.kind,
                height: 32,
                accessibilityLabel: "Kind",
                label: { kind in AnyView(Text(Self.kindLabel(kind)).font(.system(size: 13, weight: .medium))) },
                name: { Self.kindLabel($0) }
            )
            .frame(width: 300)

            VStack(alignment: .leading, spacing: 6) {
                Text("Your message")
                    .font(.system(size: DesignTokens.FontSize.fieldLabel, weight: .medium))
                    .foregroundStyle(Theme.C.inkMuted)
                ZStack(alignment: .topLeading) {
                    TextEditor(text: $feedbackDraft.message)
                        .font(.system(size: DesignTokens.FontSize.fieldInput))
                        .foregroundStyle(Theme.C.ink)
                        .scrollContentBackground(.hidden)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 8)
                        .accessibilityLabel("Your message")
                        .accessibilityIdentifier("feedback-message")
                    if feedbackDraft.message.isEmpty {
                        Text(feedbackPlaceholder)
                            .font(.system(size: DesignTokens.FontSize.fieldInput))
                            .foregroundStyle(Theme.C.inkFaint)
                            .padding(.horizontal, 13)
                            .padding(.vertical, 8)
                            .allowsHitTesting(false)
                    }
                }
                .frame(height: 150)
                .background(Theme.C.surface)
                .overlay(
                    RoundedRectangle(cornerRadius: DesignTokens.Radius.field, style: .continuous)
                        .strokeBorder(feedbackLength > Feedback.messageMax ? Theme.C.danger : Theme.C.borderStrong, lineWidth: 1)
                )
                .clipShape(RoundedRectangle(cornerRadius: DesignTokens.Radius.field, style: .continuous))
                // The count shows only near the limit, where it matters.
                if feedbackLength > Feedback.messageMax - 500 {
                    Text("\(feedbackLength.formatted(.number.locale(Locale(identifier: "en_US")))) of 4,000")
                        .font(.system(size: 12).monospacedDigit())
                        .foregroundStyle(feedbackLength > Feedback.messageMax ? Theme.C.danger : Theme.C.inkMuted)
                        .frame(maxWidth: .infinity, alignment: .trailing)
                }
            }

            FieldShell(label: "Email for a reply (optional)", error: feedbackEmailError) {
                TextField("you@example.com", text: $feedbackDraft.email)
                    .nativeField(focused: feedbackEmailFocused)
                    .focused($feedbackEmailFocused)
                    .accessibilityIdentifier("feedback-email")
                    // The complaint goes as soon as the address is touched again.
                    .onChange(of: feedbackDraft.email) { _, _ in feedbackEmailError = nil }
            }
            .frame(maxWidth: 360)

            Button {
                feedbackDraft.includesDetails.toggle()
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: feedbackDraft.includesDetails ? "checkmark.square.fill" : "square")
                        .font(.system(size: 14))
                        .foregroundStyle(feedbackDraft.includesDetails ? Theme.C.accent : Theme.C.inkFaint)
                    Text("Include \(feedbackDetails)")
                        .font(.system(size: 13))
                        .foregroundStyle(Theme.C.ink)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .pointerOnHover()
            .accessibilityAddTraits(feedbackDraft.includesDetails ? [.isSelected] : [])
            .accessibilityIdentifier("feedback-include")

            HStack(spacing: 12) {
                NativeButton(feedbackSending ? "Sending" : "Send", kind: .primary, small: true,
                             enabled: canSendFeedback, action: sendFeedback)
                    .accessibilityIdentifier("feedback-send")
                Text(Self.feedbackURL == nil
                     ? "Feedback isn't set up in this build. Email us instead."
                     : "Only this form and an anonymous install ID are sent. No chats, no files.")
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.C.inkMuted)
            }
            if let feedbackError {
                Text(feedbackError)
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.C.danger)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("feedback-error")
            }
        }
    }

    private static func kindLabel(_ kind: FeedbackKind) -> String {
        switch kind {
        case .idea: return "Idea"
        case .problem: return "Problem"
        case .other: return "Other"
        }
    }

    private func sendFeedback() {
        guard canSendFeedback, let url = Self.feedbackURL else { return }
        let email = feedbackDraft.email.trimmingCharacters(in: .whitespacesAndNewlines)
        if !email.isEmpty, !Feedback.plausibleEmail(email) {
            feedbackEmailError = "That email doesn't look right."
            return
        }
        let submission = FeedbackSubmission(
            kind: feedbackDraft.kind,
            message: feedbackDraft.message,
            replyEmail: email,
            installId: Feedback.installId(),
            context: feedbackDraft.includesDetails
                ? FeedbackContext(appVersion: AppUpdater.version, build: AppUpdater.build,
                                  macosVersion: Feedback.macOSVersion(), chip: Self.chipName)
                : nil
        )
        feedbackSending = true
        feedbackError = nil
        Task {
            let result = await Feedback.send(submission, to: url)
            feedbackSending = false
            switch result {
            case .sent:
                feedbackDraft.message = ""
                feedbackSent = true
            case .rateLimited:
                feedbackError = "You've reached today's feedback limit. Try again tomorrow."
            case .server:
                feedbackError = "Couldn't send. Check your connection and try again."
            case .invalid(_, let message):
                feedbackError = message ?? "Something in the form isn't right. Check it and try again."
            }
        }
    }

    // MARK: - Rows

    /// A quiet heading over a grey card, the way macOS and Grok group settings.
    /// A group with its label above it; nil for the pane's first group, which
    /// the pane title already names.
    private func section<Content: View>(_ label: String?, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            if let label {
                Text(label)
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.C.inkMuted)
                    .padding(.leading, 4)
                    .padding(.bottom, 8)
            }
            content()
        }
    }

    private func settingsGroup<Content: View>(@ViewBuilder content: () -> Content) -> some View {
        VStack(spacing: 0) {
            content()
        }
        .background(Theme.C.sunken)
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    }

    private func settingsRow<Content: View>(last: Bool = false, @ViewBuilder content: () -> Content) -> some View {
        HStack(spacing: 16) {
            content()
        }
        .frame(minHeight: 44)
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .overlay(alignment: .bottom) {
            if !last { Hairline().padding(.horizontal, 12) }
        }
    }

    private func settingsValue(_ value: String) -> some View {
        Text(value)
            .font(.system(size: 13))
            .foregroundStyle(Theme.C.inkMuted)
            .lineLimit(1)
    }
}

/// System, Light and Dark as a pop-up button: the choice on a grey pill, a
/// chevron, the system menu.
private struct AppearancePicker: View {
    @Binding var selection: AppAppearance

    var body: some View {
        Menu {
            ForEach(AppAppearance.allCases) { option in
                Button {
                    selection = option
                } label: {
                    if option == selection {
                        Label(option.label, systemImage: "checkmark")
                    } else {
                        Text(option.label)
                    }
                }
            }
        } label: {
            // Wide enough for the longest choice: macOS sizes this menu to
            // the button, and at "Light"'s width it cut "System" to "Sy…m".
            SettingsPopUpLabel(title: selection.label)
                .frame(minWidth: 96, alignment: .trailing)
        }
        // The button style with a plain look draws the label as built; the
        // borderless style flattens it to text and moves the chevron.
        .menuStyle(.button)
        .buttonStyle(.plain)
        .menuIndicator(.hidden)
        .fixedSize()
        .pointerOnHover()
        .accessibilityLabel("Theme")
        .accessibilityValue(selection.label)
    }
}

/// The face of a settings pop-up: the value and a small chevron on a grey pill.
struct SettingsPopUpLabel: View {
    let title: String

    var body: some View {
        HStack(spacing: 5) {
            Text(title)
                .font(.system(size: 13))
                .foregroundStyle(Theme.C.ink)
            Image(systemName: "chevron.down")
                .font(.system(size: 9, weight: .semibold))
                .foregroundStyle(Theme.C.inkMuted)
        }
        .padding(.horizontal, 10)
        .frame(height: 26)
        .background(Theme.C.border.opacity(0.6))
        .clipShape(RoundedRectangle(cornerRadius: 7, style: .continuous))
    }
}

/// Links into the public releases repo, github.com/wasimjalali/useful-bot-releases.
enum ReleaseLinks {
    /// On since v1.0.0 (2026-09-29). The rows that need the repo hide when it's false.
    static let releasesRepoLive = true
    static let contactAddress = "hello@usefulbuild.com"
    static let contactMail = URL(string: "mailto:hello@usefulbuild.com")!

    static var reportBug: URL? {
        releasesRepoLive ? URL(string: "https://github.com/wasimjalali/useful-bot-releases/issues/new") : nil
    }

    static var whatsNew: URL? {
        releasesRepoLive ? URL(string: "https://github.com/wasimjalali/useful-bot-releases/releases/tag/v\(AppUpdater.version)") : nil
    }

    /// What the app sends and where (site/public/privacy).
    static let privacy: URL? = URL(string: "https://bot.usefulbuild.com/privacy/")
}

/// Settings > Feedback's form, kept for the life of the app so closing the
/// dialog doesn't throw away what was typed.
@MainActor
final class FeedbackDraft: ObservableObject {
    static let shared = FeedbackDraft()
    @Published var kind: FeedbackKind = .idea
    @Published var message = ""
    @Published var email = ""
    @Published var includesDetails = true
}
