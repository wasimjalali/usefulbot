import AppKit
import SwiftUI
import UsefulBotCore

/// Providers v2 pane: connected connections, the Connect popover, the key
/// sheet, the OAuth device sheet and the task-model picks. It renders only
/// what the server returns: names, modes, hints, URLs and models all come
/// from `GET /api/providers`.
struct ProvidersPaneView: View {
    /// Passed in, not read from the environment: the settings dialog also
    /// builds this view's card content from a plain copy of the struct at its
    /// root, outside the pane's own hierarchy, where an environment object is
    /// never populated and its getter traps.
    @ObservedObject var model: AppModel
    /// Which brand card the dialog renders at its root. Owned by
    /// AppSettingsView so the card floats above the scrolling body.
    @Binding var openCard: ProvidersCard?
    @Binding var keySheet: KeySheetTarget?

    private static let connectSections = ["Subscription", "API", "Local"]
    private static let connectCard = ProvidersCard(kind: .connect, key: "")

    var body: some View {
        VStack(alignment: .leading, spacing: 24) {
            section(nil) {
                if let error = model.providersError {
                    Text(error)
                        .font(.system(size: 14))
                        .foregroundStyle(Theme.C.danger)
                        .padding(.bottom, 8)
                }
                if model.providerCatalog.isEmpty && model.providersError == nil {
                    Text("Loading providers.")
                        .font(.system(size: 14))
                        .foregroundStyle(Theme.C.inkMuted)
                } else if !model.providerCatalog.isEmpty {
                    settingsGroup {
                        ForEach(model.providerConnections) { connection in
                            connectionRow(connection)
                        }
                        connectRow(last: true, hasRows: !model.providerConnections.isEmpty)
                    }
                }
            }

            section("Task models") {
                VStack(alignment: .leading, spacing: 24) {
                    settingsGroup {
                        let showsImage = !(model.imageRole?.models.isEmpty ?? true)
                        roleRow(
                            role: "default",
                            title: "Default model",
                            sub: "Used for chat",
                            detail: model.defaultRole,
                            last: !showsImage
                        )
                        // The row appears only while a connected provider
                        // actually serves image generation.
                        if showsImage {
                            roleRow(
                                role: "image",
                                title: "Image model",
                                sub: "Used for generated images",
                                detail: model.imageRole,
                                last: true
                            )
                        }
                    }
                }
            }
        }
        .sheet(isPresented: oauthPresented) {
            OAuthSheetView(onClose: { Task { await model.cancelOAuth() } })
        }
    }

    private var oauthPresented: Binding<Bool> {
        Binding(
            get: { model.oauth != nil },
            set: { showing in
                if !showing, model.oauth != nil {
                    Task { await model.cancelOAuth() }
                }
            }
        )
    }

    // MARK: - Connections

    private func connectionRow(_ connection: ConnectionPublic) -> some View {
        let card = ProvidersCard(kind: .menu, key: connection.id)
        return settingsRow {
            ProviderMark(icon: connection.icon, monogram: connection.monogram, size: 28)
            VStack(alignment: .leading, spacing: 2) {
                Text(connection.label)
                    .font(.system(size: 14, weight: .medium))
                    .foregroundStyle(Theme.C.ink)
                    .lineLimit(1)
                Text(connection.accountLabel.map { "\(connection.kindLabel) · \($0)" } ?? connection.kindLabel)
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.C.inkMuted)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            Spacer(minLength: 0)
            statusDot(connection.status)
            Button {
                toggle(card)
            } label: {
                Image(systemName: "ellipsis")
                    .font(.system(size: 13, weight: .regular))
                    .foregroundStyle(Theme.C.inkMuted)
                    .frame(width: 40, height: 40)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .pointerOnHover()
            .anchorPreference(key: ProvidersCardAnchorsKey.self, value: .bounds) {
                [ProvidersCardAnchor(card: card, bounds: $0)]
            }
            .trackWindowFrame(ProvidersTriggerFrames.shared.binding(for: card))
            .onDisappear { ProvidersTriggerFrames.shared.forget(card) }
            .accessibilityLabel("Actions for \(connection.label)")
            .accessibilityIdentifier("provider-menu-\(connection.id)")
        }
        .accessibilityIdentifier("provider-row-\(connection.id)")
    }

    private func statusDot(_ status: String) -> some View {
        let color: Color = status == "ok" ? Theme.C.success : (status == "expired" ? Theme.C.warning : Theme.C.danger)
        let label = status == "ok" ? "Connected" : (status == "expired" ? "Expired" : "Error")
        return Circle()
            .fill(color)
            .frame(width: 8, height: 8)
            .accessibilityLabel(label)
    }

    private func connectRow(last: Bool, hasRows: Bool) -> some View {
        settingsRow(last: last || !hasRows) {
            Button {
                toggle(Self.connectCard)
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: "plus.circle")
                        .font(.system(size: 14))
                        .foregroundStyle(Theme.C.inkMuted)
                        .frame(width: 16)
                    Text("Connect")
                        .font(.system(size: 14))
                        .foregroundStyle(Theme.C.inkMuted)
                    Spacer(minLength: 0)
                }
                .frame(minHeight: 40)
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .pointerOnHover()
            .anchorPreference(key: ProvidersCardAnchorsKey.self, value: .bounds) {
                [ProvidersCardAnchor(card: Self.connectCard, bounds: $0)]
            }
            .trackWindowFrame(ProvidersTriggerFrames.shared.binding(for: Self.connectCard))
            .onDisappear { ProvidersTriggerFrames.shared.forget(Self.connectCard) }
            .accessibilityIdentifier("providers-connect")
        }
    }

    // MARK: - Connect card

    /// Rows for the Connect card. The dialog host wraps this in the brand
    /// card and a scrolling body capped to the space around the anchor.
    var connectCardContent: some View {
        let groups = Self.connectSections.compactMap { section -> (String, [CatalogPublic])? in
            let rows = model.providerCatalog.filter { $0.kindLabel == section && !$0.connected && $0.providerId != "custom" }
            return rows.isEmpty ? nil : (section, rows)
        }
        let custom = model.providerCatalog.first { $0.providerId == "custom" && !$0.connected }
        return VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(groups.enumerated()), id: \.element.0) { index, group in
                if index > 0 { Hairline() }
                Text(group.0)
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.C.inkFaint)
                    .padding(.horizontal, 10)
                    .padding(.top, 10)
                    .padding(.bottom, 4)
                ForEach(group.1) { entry in
                    connectEntryRow(entry)
                }
                Spacer(minLength: 6)
            }
            if let custom {
                Hairline()
                connectCustomRow(custom)
            }
        }
        .padding(.vertical, 6)
    }

    private func connectEntryRow(_ entry: CatalogPublic) -> some View {
        MenuRowButton(action: { pickCatalogEntry(entry) }) {
            HStack(spacing: 10) {
                ProviderMark(icon: entry.icon, monogram: entry.monogram, size: 28)
                Text(entry.label)
                    .font(.system(size: 14))
                    .foregroundStyle(Theme.C.ink)
                    .lineLimit(1)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .frame(minHeight: 40)
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
        }
    }

    private func connectCustomRow(_ entry: CatalogPublic) -> some View {
        MenuRowButton(action: { pickCatalogEntry(entry) }) {
            HStack(spacing: 10) {
                Image(systemName: "plus")
                    .font(.system(size: 13, weight: .regular))
                    .foregroundStyle(Theme.C.inkMuted)
                    .frame(width: 28)
                Text("Add custom provider")
                    .font(.system(size: 14))
                    .foregroundStyle(Theme.C.inkMuted)
                    .lineLimit(1)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .frame(minHeight: 40)
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
        }
    }

    private func pickCatalogEntry(_ entry: CatalogPublic) {
        openCard = nil
        if entry.oauth {
            Task { await model.startOAuth(providerId: entry.providerId, label: entry.label) }
        } else {
            model.clearConnectError()
            keySheet = KeySheetTarget(entry: entry, editing: nil)
        }
    }

    // MARK: - Row menu card

    private var menuConnection: ConnectionPublic? {
        guard openCard?.kind == .menu, let id = openCard?.key else { return nil }
        return model.providerConnections.first { $0.id == id }
    }

    private var menuEntry: CatalogPublic? {
        guard let connection = menuConnection else { return nil }
        return model.providerCatalog.first {
            $0.providerId == connection.providerId && $0.mode == connection.mode
        }
    }

    var rowMenuCardContent: some View {
        VStack(alignment: .leading, spacing: 2) {
            if menuEntry != nil, let connection = menuConnection {
                MenuRowButton(action: {
                    openCard = nil
                    editConnection(connection)
                }) {
                    HStack(spacing: 8) {
                        Image(systemName: "pencil")
                            .font(.system(size: 13))
                            .foregroundStyle(Theme.C.ink)
                            .frame(width: 16)
                        Text("Edit")
                            .font(.system(size: 13))
                            .foregroundStyle(Theme.C.ink)
                        Spacer(minLength: 0)
                    }
                    .padding(.horizontal, 10)
                    .frame(minHeight: 40)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            if let connection = menuConnection, connection.id == "openai:oauth" {
                MenuRowButton(action: {
                    openCard = nil
                    if let url = URL(string: "https://chatgpt.com/settings/usage") {
                        NSWorkspace.shared.open(url)
                    }
                }) {
                    HStack(spacing: 8) {
                        Image(systemName: "chart.bar")
                            .font(.system(size: 13))
                            .foregroundStyle(Theme.C.ink)
                            .frame(width: 16)
                        Text("Manage usage")
                            .font(.system(size: 13))
                            .foregroundStyle(Theme.C.ink)
                        Spacer(minLength: 0)
                    }
                    .padding(.horizontal, 10)
                    .frame(minHeight: 40)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            if let connection = menuConnection {
                MenuRowButton(action: {
                    let id = connection.id
                    openCard = nil
                    Task { await model.disconnectConnection(id) }
                }) {
                    HStack(spacing: 8) {
                        Image(systemName: "trash")
                            .font(.system(size: 13))
                            .foregroundStyle(Theme.C.danger)
                            .frame(width: 16)
                        Text("Disconnect")
                            .font(.system(size: 13))
                            .foregroundStyle(Theme.C.danger)
                        Spacer(minLength: 0)
                    }
                    .padding(.horizontal, 10)
                    .frame(minHeight: 40)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
        .padding(6)
    }

    private func editConnection(_ connection: ConnectionPublic) {
        guard let entry = model.providerCatalog.first(where: {
            $0.providerId == connection.providerId && $0.mode == connection.mode
        }) else { return }
        if entry.oauth {
            Task { await model.startOAuth(providerId: entry.providerId, label: entry.label) }
        } else {
            model.clearConnectError()
            keySheet = KeySheetTarget(entry: entry, editing: connection)
        }
    }

    // MARK: - Task models

    private func roleRow(role: String, title: String, sub: String, detail: RolePublic?, last: Bool) -> some View {
        settingsRow(last: last) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.system(size: 14))
                    .foregroundStyle(Theme.C.ink)
                Text(sub)
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.C.inkMuted)
            }
            Spacer(minLength: 0)
            if let detail {
                modelChipButton(role: role, detail: detail)
                if !detail.efforts.isEmpty {
                    let card = ProvidersCard(kind: .effort, key: role)
                    Button {
                        toggle(card)
                    } label: {
                        Image(systemName: "ellipsis")
                            .font(.system(size: 13, weight: .regular))
                            .foregroundStyle(Theme.C.inkMuted)
                            .frame(width: 40, height: 40)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .pointerOnHover()
                    .anchorPreference(key: ProvidersCardAnchorsKey.self, value: .bounds) {
                        [ProvidersCardAnchor(card: card, bounds: $0)]
                    }
                    .trackWindowFrame(ProvidersTriggerFrames.shared.binding(for: card))
            .onDisappear { ProvidersTriggerFrames.shared.forget(card) }
                    .accessibilityLabel("Reasoning for \(title)")
                    .accessibilityIdentifier("role-\(role)-reasoning")
                }
            } else {
                Text("Loading.")
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.C.inkMuted)
            }
        }
    }

    private func modelChipButton(role: String, detail: RolePublic) -> some View {
        let card = ProvidersCard(kind: .picker, key: role)
        return Button {
            toggle(card)
        } label: {
            HStack(spacing: 6) {
                ProviderMark(icon: detail.connectionIcon, monogram: chipMonogram(detail: detail), size: 22)
                Text(detail.modelLabel.isEmpty ? "Model" : detail.modelLabel)
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.C.ink)
                    .lineLimit(1)
                Image(systemName: "chevron.down")
                    .font(.system(size: 11, weight: .regular))
                    .foregroundStyle(Theme.C.inkMuted)
            }
            .padding(.horizontal, 10)
            .frame(minHeight: 40)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .pointerOnHover()
        .anchorPreference(key: ProvidersCardAnchorsKey.self, value: .bounds) {
            [ProvidersCardAnchor(card: card, bounds: $0)]
        }
        .trackWindowFrame(ProvidersTriggerFrames.shared.binding(for: card))
            .onDisappear { ProvidersTriggerFrames.shared.forget(card) }
        .overlay(
            RoundedRectangle(cornerRadius: DesignTokens.Radius.action, style: .continuous)
                .strokeBorder(Theme.C.edge, lineWidth: 1)
        )
        .disabled(model.providerBusy == "role-\(role)")
        .accessibilityIdentifier("role-\(role)-model")
    }

    private func chipMonogram(detail: RolePublic) -> String {
        if let id = detail.connectionId,
           let connection = model.providerConnections.first(where: { $0.id == id }) {
            return connection.monogram
        }
        return "?"
    }

    private func roleDetail(_ role: String) -> RolePublic? {
        switch role {
        case "reviewer": return model.reviewerRole
        case "image": return model.imageRole
        default: return model.defaultRole
        }
    }

    // MARK: - Model picker card

    func modelPickerCardContent(role: String, maxHeight: CGFloat = 320) -> some View {
        let detail = roleDetail(role)
        return RoleModelPicker(
            models: detail?.models ?? [],
            currentConnectionId: detail?.connectionId ?? "",
            currentModelId: detail?.modelId ?? "",
            onPick: { option in
                openCard = nil
                saveModelPick(role: role, option: option)
            },
            maxHeight: maxHeight
        )
    }

    private func saveModelPick(role: String, option: RoleModelOption) {
        let connectionId = option.connectionId.isEmpty ? nil : option.connectionId
        if role == "default" {
            let effort = model.defaultRole?.effort
            Task { await model.saveDefaultModel(connectionId: connectionId, modelId: option.id, effort: effort) }
        } else {
            // Image and reviewer both persist through the generic role write;
            // image carries no effort.
            let effort = role == "reviewer" ? model.reviewerRole?.effort : nil
            Task { await model.saveRole(role, connectionId: connectionId, modelId: option.id, effort: effort) }
        }
    }

    // MARK: - Reasoning card

    func effortCardContent(role: String) -> some View {
        let detail = roleDetail(role)
        return VStack(alignment: .leading, spacing: 0) {
            Text("Reasoning")
                .font(.system(size: 12))
                .foregroundStyle(Theme.C.inkFaint)
                .padding(.horizontal, 10)
                .padding(.top, 10)
                .padding(.bottom, 4)
            ForEach(detail?.efforts ?? [], id: \.id) { item in
                let selected = detail?.effort == item.id
                MenuRowButton(action: {
                    openCard = nil
                    saveEffortPick(role: role, effort: item.id)
                }) {
                    HStack(spacing: 8) {
                        Text(item.label)
                            .font(.system(size: 13))
                            .foregroundStyle(Theme.C.ink)
                        Spacer(minLength: 0)
                        if selected {
                            Image(systemName: "checkmark")
                                .font(.system(size: 12))
                                .foregroundStyle(Theme.C.inkMuted)
                        }
                    }
                    .padding(.horizontal, 10)
                    .frame(minHeight: 40)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(selected ? Theme.C.sunken : .clear)
                }
            }
        }
        .padding(.vertical, 6)
    }

    private func saveEffortPick(role: String, effort: String) {
        if role == "default" {
            let current = model.defaultRole
            guard let modelId = current?.modelId, !modelId.isEmpty else { return }
            Task {
                await model.saveDefaultModel(connectionId: current?.connectionId, modelId: modelId, effort: effort)
            }
        } else {
            let current = roleDetail(role)
            Task {
                await model.saveRole(
                    role,
                    connectionId: current?.connectionId,
                    modelId: current?.modelId,
                    effort: effort
                )
            }
        }
    }

    // MARK: - Helpers

    /// One open card at a time: tapping the open card's trigger closes it.
    private func toggle(_ card: ProvidersCard) {
        openCard = (openCard == card) ? nil : card
    }

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
        .background(Theme.C.canvas)
        .overlay(
            RoundedRectangle(cornerRadius: DesignTokens.Radius.settingsGroup, style: .continuous)
                .strokeBorder(Theme.C.edge, lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: DesignTokens.Radius.settingsGroup, style: .continuous))
    }

    private func settingsRow<Content: View>(last: Bool = false, @ViewBuilder content: () -> Content) -> some View {
        HStack(spacing: 16) {
            content()
        }
        .frame(minHeight: 52)
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .overlay(alignment: .bottom) {
            if !last { Hairline() }
        }
    }
}

/// What the key sheet edits: a catalogue entry, plus the connection when the
/// row menu opened it for editing.
struct KeySheetTarget: Identifiable {
    let entry: CatalogPublic
    let editing: ConnectionPublic?

    var id: String {
        if let editing { return "\(entry.id)::\(editing.id)" }
        return entry.id
    }
}

/// The connect sheet: heading, key and extra fields, hint, key link, errors.
struct KeySheetView: View {
    @EnvironmentObject private var model: AppModel
    let target: KeySheetTarget
    let onClose: () -> Void

    @State private var key: String
    @State private var values: [String: String]
    @FocusState private var focused: Bool

    init(target: KeySheetTarget, onClose: @escaping () -> Void) {
        self.target = target
        self.onClose = onClose
        _key = State(initialValue: "")
        var prefilled: [String: String] = [:]
        for field in target.entry.fields ?? [] {
            prefilled[field.id] = target.editing?.fields[field.id]
                ?? (field.id == "baseUrl" ? field.placeholder : "")
        }
        _values = State(initialValue: prefilled)
    }

    private var entry: CatalogPublic { target.entry }
    private var showsKeyField: Bool { entry.mode != "local" }
    private var canConnect: Bool {
        model.providerBusy == nil
            && (entry.mode == "local" || !key.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(entry.label)
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(Theme.C.ink)
            VStack(alignment: .leading, spacing: 12) {
                if showsKeyField {
                    FieldShell(label: "Key") {
                        SecureField("Paste key", text: $key)
                            .nativeField(focused: focused)
                            .focused($focused)
                            .onSubmit(connect)
                    }
                }
                ForEach(entry.fields ?? [], id: \.id) { field in
                    FieldShell(label: field.label) {
                        if field.secret {
                            SecureField(field.placeholder, text: fieldBinding(field.id))
                                .nativeField(focused: false)
                        } else {
                            TextField(field.placeholder, text: fieldBinding(field.id))
                                .nativeField(focused: false)
                        }
                    }
                }
                if !entry.hint.isEmpty {
                    Text(entry.hint)
                        .font(.system(size: 12))
                        .foregroundStyle(Theme.C.inkMuted)
                }
                if let keyUrl = entry.keyUrl, !keyUrl.isEmpty {
                    Button("Get a key") {
                        if let url = URL(string: keyUrl) {
                            NSWorkspace.shared.open(url)
                        }
                    }
                    .buttonStyle(.plain)
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.C.accent)
                    .pointerOnHover()
                }
                if let error = model.connectError {
                    Text(error)
                        .font(.system(size: 13))
                        .foregroundStyle(Theme.C.danger)
                }
            }
            HStack(spacing: 8) {
                Spacer(minLength: 0)
                NativeButton("Cancel", kind: .secondary, action: onClose)
                NativeButton("Connect", kind: .primary, enabled: canConnect, action: connect)
            }
        }
        .padding(24)
        .frame(width: 384)
        .background(Theme.C.surface)
        .clipShape(RoundedRectangle(cornerRadius: DesignTokens.Radius.dialog, style: .continuous))
    }

    private func fieldBinding(_ id: String) -> Binding<String> {
        Binding(
            get: { values[id] ?? "" },
            set: { values[id] = $0 }
        )
    }

    private func connect() {
        guard canConnect else { return }
        let trimmedKey = key.trimmingCharacters(in: .whitespacesAndNewlines)
        var fields: [String: String] = [:]
        for field in entry.fields ?? [] {
            let value = (values[field.id] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            if !value.isEmpty { fields[field.id] = value }
        }
        Task {
            await model.connectProvider(
                providerId: entry.providerId,
                mode: entry.mode,
                key: trimmedKey.isEmpty ? nil : trimmedKey,
                fields: fields.isEmpty ? nil : fields
            )
            if model.connectError == nil {
                onClose()
            }
        }
    }
}

/// The OAuth device sheet: the user code, the sign-in button and the wait.
private struct OAuthSheetView: View {
    @EnvironmentObject private var model: AppModel
    let onClose: () -> Void
    /// The flow clears the moment sign-in finishes, while the sheet is still
    /// fading out: it keeps showing the last flow instead of an empty card.
    @State private var lastShown: OAuthPending?

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            if let pending = model.oauth ?? lastShown {
                Text(pending.label)
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(Theme.C.ink)
                if pending.flow == "browser" {
                    Text("Continue with ChatGPT to sign in and approve Useful Bot in your browser.")
                        .font(.system(size: 14))
                        .foregroundStyle(Theme.C.inkMuted)
                } else {
                    Text("Open the sign-in page and type this code.")
                        .font(.system(size: 14))
                        .foregroundStyle(Theme.C.inkMuted)
                    Text(pending.userCode)
                        .font(.system(size: 28, weight: .semibold, design: .monospaced))
                        .tracking(4)
                        .foregroundStyle(Theme.C.ink)
                        .frame(maxWidth: .infinity, alignment: .center)
                        .padding(.vertical, 8)
                }
                if let error = model.oauthError {
                    Text(error)
                        .font(.system(size: 13))
                        .foregroundStyle(Theme.C.danger)
                }
                HStack(spacing: 8) {
                    Spacer(minLength: 0)
                    if model.oauthDone {
                        if pending.flow == "browser" {
                            if model.oauthOffersNewAccount {
                                UseDifferentAccountControl(
                                    accounts: pending.accounts, currentClientId: pending.clientId, afterError: true, kind: .secondary,
                                    onPick: { id in Task { await model.startOAuth(providerId: pending.providerId, label: pending.label, clientId: id) } },
                                    onAddNew: { Task { await model.startOAuth(providerId: pending.providerId, label: pending.label, newAccount: true) } }
                                )
                            } else {
                                NativeButton("Try again", kind: .secondary) {
                                    Task { await model.retryOAuth(providerId: pending.providerId, label: pending.label) }
                                }
                            }
                        }
                        NativeButton("Close", kind: .secondary) {
                            Task { await model.cancelOAuth() }
                        }
                    } else {
                        NativeButton("Cancel", kind: .secondary) {
                            Task { await model.cancelOAuth() }
                        }
                        if pending.flow == "browser" {
                            ContinueWithChatGPTButton {
                                if let url = URL(string: pending.verificationUrl), !pending.verificationUrl.isEmpty {
                                    NSWorkspace.shared.open(url)
                                }
                            }
                        } else {
                            NativeButton("Open sign-in page", kind: .primary) {
                                let link = pending.verificationUrlComplete ?? pending.verificationUrl
                                if let url = URL(string: link), !link.isEmpty {
                                    NSWorkspace.shared.open(url)
                                }
                            }
                        }
                    }
                }
                if pending.flow == "browser", !model.oauthDone, pending.account != nil || pending.reusesSaved {
                    // Stacked: side by side, a long email squeezed both lines.
                    VStack(alignment: .leading, spacing: 6) {
                        if let account = pending.account {
                            Text("Continues as \(account).")
                                .font(.system(size: 13))
                                .foregroundStyle(Theme.C.inkMuted)
                                .lineLimit(1)
                                .truncationMode(.middle)
                        }
                        UseDifferentAccountControl(
                            accounts: pending.accounts, currentClientId: pending.clientId,
                            onPick: { id in Task { await model.startOAuth(providerId: pending.providerId, label: pending.label, clientId: id) } },
                            onAddNew: { Task { await model.startOAuth(providerId: pending.providerId, label: pending.label, newAccount: true) } }
                        )
                    }
                }
                if !model.oauthDone {
                    HStack(spacing: 8) {
                        ProgressView()
                            .controlSize(.small)
                        Text(pending.flow == "browser" ? "Waiting for the browser" : "Waiting for approval")
                            .font(.system(size: 13))
                            .foregroundStyle(Theme.C.inkMuted)
                        Spacer(minLength: 0)
                    }
                }
            }
        }
        .padding(24)
        .frame(width: 384)
        .background(Theme.C.surface)
        .clipShape(RoundedRectangle(cornerRadius: DesignTokens.Radius.dialog, style: .continuous))
        .onAppear { if let pending = model.oauth { lastShown = pending } }
        .onChange(of: model.oauth) { _, next in
            if let next { lastShown = next }
        }
    }
}

/// The searchable model list behind a role chip, grouped by connection.
struct RoleModelPicker: View {
    let models: [RoleModelOption]
    let currentConnectionId: String
    let currentModelId: String
    let onPick: (RoleModelOption) -> Void
    var maxHeight: CGFloat = 320

    @State private var query = ""

    private var filtered: [RoleModelOption] {
        let needle = query.trimmingCharacters(in: .whitespaces).lowercased()
        guard !needle.isEmpty else { return models }
        return models.filter {
            $0.label.lowercased().contains(needle) || $0.id.lowercased().contains(needle)
        }
    }

    private struct ModelGroup {
        let connectionId: String
        let label: String
        let icon: String
        var options: [RoleModelOption]
    }

    private var groups: [ModelGroup] {
        var order: [String] = []
        var map: [String: ModelGroup] = [:]
        for option in filtered {
            if map[option.connectionId] == nil {
                order.append(option.connectionId)
                map[option.connectionId] = ModelGroup(
                    connectionId: option.connectionId,
                    label: option.connectionLabel,
                    icon: option.icon,
                    options: []
                )
            }
            map[option.connectionId]?.options.append(option)
        }
        return order.compactMap { map[$0] }
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                TextField("Search models", text: $query)
                    .textFieldStyle(.plain)
                    .font(.system(size: 13))
            }
            .padding(.horizontal, 12)
            .frame(height: 40)
            .overlay(alignment: .bottom) { Hairline() }

            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    if groups.isEmpty {
                        Text("No models match")
                            .font(.system(size: 13))
                            .foregroundStyle(Theme.C.inkMuted)
                            .padding(12)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    } else {
                        ForEach(groups, id: \.connectionId) { group in
                            if !group.label.isEmpty {
                                HStack(spacing: 6) {
                                    ProviderMark(
                                        icon: group.icon,
                                        monogram: String(group.label.prefix(1)),
                                        size: 16
                                    )
                                    Text(group.label)
                                        .font(.system(size: 12))
                                        .foregroundStyle(Theme.C.inkFaint)
                                        .lineLimit(1)
                                }
                                .padding(.horizontal, 12)
                                .padding(.top, 8)
                                .padding(.bottom, 2)
                            }
                            ForEach(group.options, id: \.id) { option in
                                let selected = currentModelId == option.id && (currentConnectionId.isEmpty || currentConnectionId == option.connectionId)
                                MenuRowButton(action: { onPick(option) }) {
                                    HStack {
                                        Text(option.label)
                                            .font(.system(size: 13))
                                            .foregroundStyle(Theme.C.ink)
                                            .lineLimit(1)
                                        Spacer(minLength: 0)
                                        if selected {
                                            Image(systemName: "checkmark")
                                                .font(.system(size: 12))
                                                .foregroundStyle(Theme.C.inkMuted)
                                        }
                                    }
                                    .padding(.horizontal, 12)
                                    .frame(minHeight: 40)
                                    .frame(maxWidth: .infinity)
                                    .background(selected ? Theme.C.sunken : .clear)
                                }
                            }
                        }
                    }
                }
                .padding(.vertical, 6)
            }
            .frame(maxHeight: maxHeight)
        }
    }
}

/// The open Providers brand card, rendered by the settings dialog at its root
/// so the scrolling body cannot clip it. Placement follows the anchor the pane
/// published: below the trigger when it fits, else above it.
struct ProvidersCardHost: View {
    let pane: ProvidersPaneView
    let card: ProvidersCard
    @Binding var openCard: ProvidersCard?
    let anchor: CGRect
    let dialogSize: CGSize

    /// Natural height of the open card's rows, measured inside its scroll view.
    @State private var rowsHeight: CGFloat = 0

    private var width: CGFloat {
        switch card.kind {
        case .connect, .picker: return 280
        case .menu, .effort: return 220
        }
    }

    /// Room below the anchor, then room above it. Under 200 pt below, the card
    /// opens above the anchor instead, capped the same way.
    private var openAbove: Bool {
        let below = dialogSize.height - anchor.maxY - 16
        let above = anchor.minY - 16
        return below < 200 && above > below
    }

    private var cap: CGFloat {
        let room = openAbove ? anchor.minY - 16 : dialogSize.height - anchor.maxY - 16
        return max(room, 120)
    }

    private var leading: CGFloat {
        let rightAligned = anchor.maxX - width
        return min(max(rightAligned, 8), max(dialogSize.width - width - 8, 8))
    }

    /// The overlay alignment and offset that sit the card against the anchor.
    /// Below the trigger in the top-leading container, or 4 pt above it in
    /// the bottom-leading one so the height can stay content driven.
    var alignment: Alignment { openAbove ? .bottomLeading : .topLeading }

    var xOffset: CGFloat { leading }

    var yOffset: CGFloat {
        openAbove ? -(dialogSize.height - anchor.minY + 4) : anchor.maxY + 4
    }

    var body: some View {
        ProvidersBrandCard(width: width, content: bodyContent)
            .dismissOnOutsideClick(triggers: { ProvidersTriggerFrames.shared.allFrames() }) {
                openCard = nil
            }
    }

    @ViewBuilder
    private func bodyContent() -> some View {
        switch card.kind {
        case .connect:
            fitOrScroll { pane.connectCardContent }
        case .menu:
            fitOrScroll { pane.rowMenuCardContent }
        case .picker:
            // The picker keeps its 40 pt search row above the list, so the list gets the rest.
            pane.modelPickerCardContent(role: card.key, maxHeight: max(cap - 40, 80))
        case .effort:
            fitOrScroll { pane.effortCardContent(role: card.key) }
        }
    }

    /// The card is as tall as its rows and only scrolls past the cap. A
    /// `maxHeight` frame is flexible: it grows into all the height it is
    /// offered, up to the cap, and centers what it holds, which left a two row
    /// menu hanging down to the bottom of the dialog. So the rows are measured
    /// at their natural height (from a hidden copy, since the one inside the
    /// scroll view is laid out by AppKit) and the card takes exactly that, up
    /// to the cap. Before the first measure the card is zero tall for a frame;
    /// the settings dialog keys the host by card, so every open measures fresh.
    private func fitOrScroll<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        let rows = content()
        return ScrollView { rows }
            .uvScroll()
            .frame(height: min(rowsHeight, cap))
            .background(alignment: .top) {
                rows
                    .fixedSize(horizontal: false, vertical: true)
                    .hidden()
                    .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { rowsHeight = $0 }
            }
    }
}
