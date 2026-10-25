import AppKit
import SwiftUI
import UsefulBotCore

/// What one added tile opens on the Connectors page: who it is, how it
/// is doing, what the owner can do with it and the tools it offers.
private struct ConnectorDetailPage: View {
    @EnvironmentObject private var model: AppModel
    let tile: ConnectorTile
    let search: String
    /// Back to the Connectors list; also closes the page once the item is gone.
    let onBack: () -> Void

    @State private var confirming = false
    @State private var appTools: [DirectConnectionTool]?
    @State private var toolsFailed = false
    @State private var scope: ConnectorToolScope = .all
    @State private var filter = ""

    private var busy: Bool {
        switch tile.source {
        case .app(let row): return model.connectorBusy == row.slug
        case .server(let row): return model.directConnectionBusy.contains(row.id)
        }
    }

    private var kindLine: String {
        switch tile.source {
        case .app:
            // The payload only carries an opaque account id, never a name to show.
            return "App \u{00B7} Composio"
        case .server(let row): return "\(row.host) \u{00B7} \(row.kind.label)"
        }
    }

    private var tools: [DirectConnectionTool]? {
        switch tile.source {
        case .app: return appTools
        case .server(let row): return row.tools
        }
    }

    /// A server shows its tools only once they are known: ready, or listed as none.
    private var showsTools: Bool {
        switch tile.source {
        case .app: return true
        case .server(let row):
            switch row.state {
            case .ready, .zeroTools: return true
            default: return false
            }
        }
    }

    private var errorMessage: String? {
        if case .server(let row) = tile.source, !row.state.isChecking, let message = row.lastError?.message, !message.isEmpty {
            return message
        }
        return nil
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button(action: onBack) {
                HStack(spacing: 4) {
                    Image(systemName: "chevron.left")
                        .font(.system(size: 12, weight: .semibold))
                    Text("Connectors")
                        .font(.system(size: 13, weight: .medium))
                }
                .foregroundStyle(Theme.C.inkMuted)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Back to Connectors")
            .padding(.horizontal, 28)
            HStack(spacing: 12) {
                AppLogo(name: tile.name, url: tile.logoURL, size: 26, data: tile.iconData)
                    .frame(width: 40, height: 40)
                    .background(Theme.C.surface)
                    .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                    .overlay(
                        RoundedRectangle(cornerRadius: 10, style: .continuous)
                            .strokeBorder(Theme.C.edge, lineWidth: 1)
                    )
                VStack(alignment: .leading, spacing: 2) {
                    Text(tile.name)
                        .font(.system(size: DesignTokens.FontSize.dialogTitle, weight: .semibold))
                        .foregroundStyle(Theme.C.ink)
                        .lineLimit(1)
                    Text(kindLine)
                        .font(.system(size: 12))
                        .foregroundStyle(Theme.C.inkMuted)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                Spacer(minLength: 8)
                if !confirming { actions }
            }
            .padding(.horizontal, 28)
            .padding(.top, 14)
            if confirming {
                confirmRow
                    .padding(.horizontal, 28)
                    .padding(.top, 12)
            }
            HStack(spacing: 10) {
                ConnectorStateChip(tile: tile)
                if let counts = countsLine {
                    Text(counts)
                        .font(.system(size: 13))
                        .foregroundStyle(Theme.C.inkMuted)
                        .monospacedDigit()
                }
            }
            .padding(.horizontal, 28)
            .padding(.top, 14)
            if let errorMessage {
                Text(errorMessage)
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.C.inkMuted)
                    .padding(.horizontal, 28)
                    .padding(.top, 4)
            }
            // A failed Disconnect or Remove shows here, where the owner pressed it.
            if let actionError = tile.source.isApp ? model.connectorsError : model.directConnectionsError {
                Text(actionError)
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.C.danger)
                    .padding(.horizontal, 28)
                    .padding(.top, 8)
            }
            if showsTools {
                toolsSection
                    .padding(.horizontal, 28)
                    .padding(.top, 16)
                    .padding(.bottom, 16)
            }
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .task {
            // An error left from the list page is not about this tile.
            if tile.source.isApp { model.connectorsError = nil } else { model.directConnectionsError = nil }
            // A lapsed app has no tool list to ask for until it signs in again.
            if case .app(let row) = tile.source, !tile.needsSignIn {
                if let list = await model.connectorTools(row) { appTools = list } else { toolsFailed = true }
            }
        }
    }

    /// "48 tools · 31 read · 17 write"; a write count includes destructive tools.
    private var countsLine: String? {
        guard let tools, !tools.isEmpty else { return nil }
        let total = tools.count == 1 ? "1 tool" : "\(tools.count) tools"
        // A server's tools all ask first in Auto, so there is no read count to give.
        if !tile.source.isApp { return total }
        let reads = tools.filter { $0.risk == .read }.count
        return "\(total) \u{00B7} \(reads) read \u{00B7} \(tools.count - reads) write"
    }

    @ViewBuilder
    private var toolsSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            if tile.needsSignIn && tile.source.isApp {
                Text("Sign in again to see its tools.")
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.C.inkMuted)
            } else if let tools {
                if tools.isEmpty {
                    Text("No tools")
                        .font(.system(size: 13))
                        .foregroundStyle(Theme.C.inkMuted)
                } else {
                    HStack(spacing: 12) {
                        // A server's tools are one group, so there is nothing to switch between.
                        if tile.source.isApp { ConnectorToolScopePicker(scope: $scope) }
                        HStack(spacing: 8) {
                            Image(systemName: "magnifyingglass")
                                .font(.system(size: 13))
                                .foregroundStyle(Theme.C.inkFaint)
                            TextField("Filter tools", text: $filter)
                                .textFieldStyle(.plain)
                                .font(.system(size: 13))
                                .foregroundStyle(Theme.C.ink)
                                .accessibilityLabel("Filter tools")
                        }
                        .padding(.horizontal, 12)
                        .frame(height: 32)
                        .background(Theme.C.sunken)
                        .clipShape(Capsule(style: .continuous))
                    }
                    toolList(tools)
                }
            } else if toolsFailed {
                Text("Couldn't load the tools.")
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.C.danger)
            } else {
                ProgressView().controlSize(.small)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    @ViewBuilder
    private func toolList(_ tools: [DirectConnectionTool]) -> some View {
        let query = filter.trimmingCharacters(in: .whitespaces)
        let shown = tools.filter { tool in
            query.isEmpty
                || tool.name.localizedCaseInsensitiveContains(query)
                || (tool.description?.localizedCaseInsensitiveContains(query) ?? false)
        }
        // `mcpToolGate` asks for every server tool in Auto, so a server's page has one group.
        let isApp = tile.source.isApp
        let reads = isApp && scope != .writes ? shown.filter { $0.risk == .read } : []
        let writes = isApp ? (scope == .reads ? [] : shown.filter { $0.risk != .read }) : shown
        if reads.isEmpty && writes.isEmpty {
            Text("No tools match.")
                .font(.system(size: 13))
                .foregroundStyle(Theme.C.inkMuted)
        } else {
            ScrollView {
                VStack(spacing: 0) {
                    toolGroup("Reads", "Run without asking", reads, first: true)
                    toolGroup("Writes", "Ask you first in Auto", writes, first: reads.isEmpty)
                }
                .clipShape(RoundedRectangle(cornerRadius: DesignTokens.Radius.md, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: DesignTokens.Radius.md, style: .continuous)
                        .strokeBorder(Theme.C.edge, lineWidth: 1)
                )
                .padding(1)
            }
            .uvScroll()
        }
    }

    @ViewBuilder
    private func toolGroup(_ title: String, _ note: String, _ tools: [DirectConnectionTool], first: Bool) -> some View {
        if !tools.isEmpty {
            VStack(spacing: 0) {
                if !first { Hairline() }
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(title)
                        .font(.system(size: 12))
                        .foregroundStyle(Theme.C.inkMuted)
                    Spacer(minLength: 8)
                    Text(note)
                        .font(.system(size: 12))
                        .foregroundStyle(Theme.C.inkMuted)
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(Theme.C.sunken)
                ForEach(Array(tools.enumerated()), id: \.offset) { _, tool in
                    Hairline()
                    toolRow(tool)
                        .padding(.horizontal, 12)
                }
            }
        }
    }

    private func toolRow(_ tool: DirectConnectionTool) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(tool.name)
                    .font(.system(size: 12, design: .monospaced))
                    .foregroundStyle(Theme.C.ink)
                    .lineLimit(1)
                    .truncationMode(.middle)
                if let description = tool.description, !description.isEmpty {
                    Text(description)
                        .font(.system(size: 12))
                        .foregroundStyle(Theme.C.inkMuted)
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
            }
            Spacer(minLength: 8)
            // A write is the warning tint; a read stays grey.
            let asks = tool.risk != .read
            Text(asks ? "Asks first" : "Read")
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(asks ? Theme.C.warning : Theme.C.inkMuted)
                .padding(.horizontal, 6)
                .padding(.vertical, 1)
                .background(asks ? Theme.C.warningSoft : Theme.C.sunken)
                .clipShape(RoundedRectangle(cornerRadius: DesignTokens.Radius.action, style: .continuous))
        }
        .padding(.vertical, 8)
    }

    private var actions: some View {
        HStack(spacing: 8) {
            switch tile.source {
            case .app(let row):
                NativeButton("Reconnect", kind: tile.needsSignIn ? .primary : .secondary, small: true, enabled: !busy) {
                    Task { await model.connectConnector(row, search: search) }
                }
                NativeButton("Disconnect", kind: .ghost, small: true, enabled: !busy && row.accountId != nil) { confirming = true }
            case .server(let row):
                if row.canReconnect {
                    NativeButton(
                        "Reconnect",
                        kind: row.reconnectProminent ? .primary : .secondary,
                        small: true,
                        enabled: !busy
                    ) { Task { await model.reconnectDirectConnection(row) } }
                }
                NativeButton("Refresh", kind: .secondary, small: true, enabled: !busy) {
                    Task { await model.refreshDirectConnection(row) }
                }
                if row.canRemove {
                    NativeButton("Disconnect", kind: .ghost, small: true, enabled: !busy) { confirming = true }
                }
            }
        }
    }

    private var confirmRow: some View {
        HStack(spacing: 8) {
            Text("Disconnect \(tile.name)?")
                .font(.system(size: 13))
                .foregroundStyle(Theme.C.ink)
            NativeButton("Disconnect", kind: .danger, small: true, enabled: !busy, action: confirm)
            NativeButton("Cancel", kind: .secondary, small: true) { confirming = false }
            Spacer(minLength: 0)
        }
    }

    private func confirm() {
        confirming = false
        switch tile.source {
        case .app(let row):
            Task {
                // A failed disconnect leaves the app added; the page stays and the error shows on it.
                if await model.disconnectConnector(row, search: search) { onBack() }
            }
        case .server(let row):
            Task {
                await model.removeDirectConnection(row)
                if !model.directConnections.contains(where: { $0.id == row.id }) { onBack() }
            }
        }
    }
}

private extension ConnectorTile.Source {
    var isApp: Bool {
        if case .app = self { return true }
        return false
    }
}

/// The Connectors page on the stage: the catalogue of apps and servers, or
/// the page of one added item.
struct ConnectorsPage: View {
    @EnvironmentObject private var model: AppModel

    @State private var search = ""
    @State private var selectedTile: String?
    @State private var keyDraft = ""
    /// What the owner has typed into the own-app form, by field name. Cleared
    /// when the form closes; it never outlives the page.
    @State private var ownAppDraft: [String: String] = [:]
    /// The debounced search load, cancelled when the page goes.
    @State private var searchTask: Task<Void, Never>?
    @FocusState private var keyFocused: Bool
    @FocusState private var searchFocused: Bool
    @FocusState private var ownAppFocused: String?

    /// Every added item in one list: the connected apps and every direct server.
    private var addedTiles: [ConnectorTile] {
        ConnectorTile.merge(apps: model.connectors?.toolkits ?? [], servers: model.directConnections)
    }

    private var selectedTileValue: ConnectorTile? {
        guard let selectedTile else { return nil }
        return addedTiles.first { $0.id == selectedTile }
    }

    var body: some View {
        connectorsPanel
        .onChange(of: selectedTile) { _, value in
            // Back from a detail page lands on the search field again.
            guard value == nil, model.connectors?.hasKey == true else { return }
            Task { @MainActor in searchFocused = true }
        }
        .onChange(of: addedTiles.map(\.id)) { _, ids in
            if let selectedTile, !ids.contains(selectedTile) { self.selectedTile = nil }
        }
    }

    private var connectorsPanel: some View {
        Group {
            if let tile = selectedTileValue {
                ConnectorDetailPage(tile: tile, search: search, onBack: { selectedTile = nil })
                    .id(tile.id)
            } else {
                listPage
            }
        }
        .padding(.top, 20)
        .frame(maxWidth: 760, maxHeight: .infinity, alignment: .top)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background(Theme.C.surface)
        // Esc on an app page goes back to the list; on the list it does nothing.
        .onExitCommand { if selectedTile != nil { selectedTile = nil } }
        .task {
            async let direct: Void = model.loadDirectConnections()
            await model.loadConnectors()
            await direct
        }
        .onChange(of: search) { _, value in
            model.connectorSearch = value
            searchTask?.cancel()
            searchTask = Task {
                try? await Task.sleep(for: .milliseconds(150))
                guard !Task.isCancelled, value == search else { return }
                await model.loadConnectors(search: value, quiet: true)
            }
        }
        .onChange(of: model.connectors?.hasKey) { _, hasKey in
            if hasKey == true { searchFocused = true } else { keyFocused = true }
        }
        // Field names repeat across apps (client_id, client_secret), so a
        // draft typed for one app must not prefill the next app's form.
        .onChange(of: model.connectorOwnApp?.toolkit) { _, _ in ownAppDraft = [:] }
        .onDisappear {
            searchTask?.cancel()
            model.stopConnectorPoll()
            model.stopDirectConnectionPoll()
            model.dismissOwnApp()
            // The query dies with the page: the quiet polls and the sidebar dot
            // read the whole list, not what was last typed.
            if !model.connectorSearch.isEmpty {
                model.connectorSearch = ""
                Task { await model.loadConnectors(search: "", quiet: true) }
            }
        }
    }

    private var listPage: some View {
            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: 10) {
                    Text("Connectors")
                        .font(.system(size: 20, weight: .semibold))
                        .foregroundStyle(Theme.C.ink)
                    Spacer(minLength: 0)
                    addedSummary
                }
                .padding(.horizontal, 28)
                .padding(.top, 4)
                if let error = model.directConnectionsError {
                    HStack(spacing: 12) {
                        Text(error)
                            .font(.system(size: 13))
                            .foregroundStyle(Theme.C.danger)
                        NativeButton("Retry", kind: .secondary, small: true) {
                            Task { await model.loadDirectConnections() }
                        }
                        Spacer(minLength: 0)
                    }
                    .padding(.horizontal, 28)
                    .padding(.top, 12)
                }
                if let payload = model.connectors {
                    if payload.hasKey {
                        catalogue(payload)
                    } else {
                        if !model.directConnections.isEmpty {
                            catalogueSection("Added", addedTiles)
                                .padding(.horizontal, 28)
                                .padding(.top, 20)
                        }
                        keyForm
                    }
                } else {
                    skeletonRows
                        .padding(.horizontal, 20)
                        .padding(.vertical, 20)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    // MARK: - No key

    private var keyForm: some View {
        VStack(alignment: .leading, spacing: 16) {
            FieldShell(label: "Composio API key", error: model.connectorsError) {
                SecureField("Paste key", text: $keyDraft)
                    .nativeField(focused: keyFocused)
                    .focused($keyFocused)
                    .accessibilityLabel("Composio API key")
                    .onSubmit(saveKey)
            }
            HStack(spacing: 12) {
                NativeButton("Save key", kind: .primary, enabled: canSaveKey, action: saveKey)
                Link("Get a key at composio.dev", destination: URL(string: "https://platform.composio.dev")!)
                    .font(.system(size: 14))
                    .foregroundStyle(Theme.C.inkMuted)
                    .underline()
                    .pointerOnHover()
                Spacer(minLength: 0)
            }
        }
        .padding(.horizontal, 28)
        .padding(.top, 16)
        .padding(.bottom, 24)
        .onAppear { keyFocused = true }
    }

    private var canSaveKey: Bool {
        model.connectorBusy != "key" && !keyDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private func saveKey() {
        guard canSaveKey else { return }
        let key = keyDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        Task {
            await model.saveConnectorsKey(key)
            if model.connectorsError == nil { keyDraft = "" }
        }
    }

    // MARK: - Catalogue

    /// The apps already added, as a row of overlapping logos and a count.
    @ViewBuilder
    private var addedSummary: some View {
        let added = addedTiles
        // A search narrows the list it counts, so the count waits for it to clear.
        if !added.isEmpty, search.trimmingCharacters(in: .whitespaces).isEmpty {
            HStack(spacing: 8) {
                HStack(spacing: -6) {
                    ForEach(added.prefix(4)) { row in
                        AppLogo(name: row.name, url: row.logoURL, size: 22, data: row.iconData)
                            .background(Theme.C.surface, in: RoundedRectangle(cornerRadius: DesignTokens.Radius.sm, style: .continuous))
                            .overlay(
                                RoundedRectangle(cornerRadius: DesignTokens.Radius.sm, style: .continuous)
                                    .strokeBorder(Theme.C.surface, lineWidth: 1.5)
                            )
                    }
                }
                Text("\(added.count) added")
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.C.inkMuted)
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("\(added.count) added")
        }
    }

    private func catalogue(_ payload: ConnectorsPayload) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass")
                    .font(.system(size: 14, weight: .regular))
                    .foregroundStyle(Theme.C.inkFaint)
                TextField("Search apps", text: $search)
                    .textFieldStyle(.plain)
                    .font(.system(size: 14))
                    .foregroundStyle(Theme.C.ink)
                    .focused($searchFocused)
                    .accessibilityLabel("Search apps")
            }
            .padding(.horizontal, 14)
            .frame(height: 38)
            .background(Theme.C.sunken)
            .overlay(
                Capsule(style: .continuous)
                    .strokeBorder(searchFocused ? Theme.C.borderStrong : Theme.C.edge, lineWidth: 1)
            )
            .clipShape(Capsule(style: .continuous))
            .padding(.horizontal, 24)
            .padding(.top, 16)
            if let error = model.connectorsError {
                HStack(spacing: 12) {
                    Text(error)
                        .font(.system(size: 14))
                        .foregroundStyle(Theme.C.danger)
                    NativeButton("Retry", kind: .secondary, small: true) {
                        Task { await model.loadConnectors(search: search) }
                    }
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, 28)
                .padding(.top, 12)
            }
            ScrollViewReader { proxy in
                ScrollView {
                    catalogueList(payload)
                        .padding(.horizontal, 28)
                        .padding(.bottom, 16)
                }
                .uvScroll()
                // The own-app form opens at the top of the list; the owner may
                // have pressed Add far below it.
                .onChange(of: model.connectorOwnApp?.toolkit) { _, toolkit in
                    guard toolkit != nil else { return }
                    withAnimation(.easeOut(duration: DesignTokens.Motion.fast)) {
                        proxy.scrollTo("own-app-form", anchor: .top)
                    }
                }
            }
            // A failed load with nothing to list leaves only the error line.
            .frame(maxHeight: payload.toolkits.isEmpty && model.connectorsError != nil && addedTiles.isEmpty ? 0 : .infinity)
            keyFooter(payload)
        }
    }

    /// Which Composio key the catalogue runs on, and the way to take it out.
    private func keyFooter(_ payload: ConnectorsPayload) -> some View {
        HStack(spacing: 8) {
            Text("Composio key ·…\(payload.last4 ?? "")")
                .font(.system(size: 12))
                .foregroundStyle(Theme.C.inkMuted)
                .lineLimit(1)
            Spacer(minLength: 0)
            NativeButton("Remove key", kind: .ghost, small: true, enabled: model.connectorBusy != "key") {
                Task {
                    await model.removeConnectorsKey()
                    search = ""
                }
            }
        }
        .padding(.horizontal, 28)
        .padding(.vertical, 12)
        .overlay(alignment: .top) { Hairline() }
    }

    private static let columns = [
        GridItem(.flexible(), spacing: 32, alignment: .leading),
        GridItem(.flexible(), spacing: 32, alignment: .leading),
    ]

    @ViewBuilder
    private func catalogueList(_ payload: ConnectorsPayload) -> some View {
        let query = search.trimmingCharacters(in: .whitespaces)
        if payload.toolkits.isEmpty && model.connectorsError != nil {
            if !addedTiles.isEmpty && query.isEmpty {
                catalogueSection("Added", addedTiles)
                    .padding(.top, 20)
            }
        } else if payload.toolkits.isEmpty {
            Text(query.isEmpty ? "No apps to show." : "No apps match \u{201C}\(query)\u{201D}.")
                .font(.system(size: 14))
                .foregroundStyle(Theme.C.inkMuted)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 40)
        } else {
            VStack(alignment: .leading, spacing: 24) {
                // The own-app form needs the full width, so it opens above
                // the grid rather than under its row.
                if let form = model.connectorOwnApp,
                   let row = payload.toolkits.first(where: { $0.slug == form.toolkit }) {
                    ownAppCard(row, form)
                }
                let rest = payload.toolkits.filter { !$0.connected && !$0.needsSignIn }
                if !query.isEmpty {
                    catalogueSection("Results", payload.toolkits.map(rowTile))
                } else {
                    if !addedTiles.isEmpty { catalogueSection("Added", addedTiles) }
                    if !rest.isEmpty { catalogueSection("All apps", rest.map(rowTile)) }
                }
                if let next = payload.nextOffset, next > 0 {
                    HStack {
                        Spacer(minLength: 0)
                        NativeButton(
                            model.connectorMoreBusy ? "Loading" : "Show more (\(max(payload.total - payload.toolkits.count, 0)) left)",
                            kind: .secondary,
                            small: true,
                            enabled: !model.connectorMoreBusy
                        ) {
                            Task { await model.loadMoreConnectors(search: search) }
                        }
                        Spacer(minLength: 0)
                    }
                }
            }
            .padding(.top, 20)
        }
    }

    /// A catalogue row as a tile: an added app is a tile of the Added grid,
    /// any other is an app with an Add button.
    private func rowTile(_ row: ConnectorToolkit) -> ConnectorTile {
        ConnectorTile(app: row)
    }

    private func catalogueSection(_ title: String, _ tiles: [ConnectorTile]) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(title)
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(Theme.C.ink)
            LazyVGrid(columns: Self.columns, alignment: .leading, spacing: 18) {
                ForEach(tiles) { tile in
                    switch tile.source {
                    case .app(let row) where !row.connected && !row.needsSignIn:
                        connectorTile(row)
                    default:
                        addedTile(tile)
                    }
                }
            }
        }
    }

    private func tileLogo(_ name: String, url: String?, data: Data?) -> some View {
        AppLogo(name: name, url: url, size: 26, data: data)
            .frame(width: 40, height: 40)
            .background(Theme.C.surface)
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .strokeBorder(Theme.C.edge, lineWidth: 1)
            )
    }

    /// An added app or server. The whole tile opens its detail view.
    private func addedTile(_ tile: ConnectorTile) -> some View {
        var removing = false
        if case .app(let row) = tile.source { removing = model.connectorBusy == row.slug }
        return ConnectorAddedTile(tile: tile, removing: removing) { selectedTile = tile.id }
    }

    private func connectorTile(_ row: ConnectorToolkit) -> some View {
        let pending = model.connectorPending == row.slug
        let busy = model.connectorBusy == row.slug
        let formOpen = model.connectorOwnApp?.toolkit == row.slug
        return HStack(spacing: 12) {
            tileLogo(row.name, url: row.logo, data: nil)
            VStack(alignment: .leading, spacing: 2) {
                Text(row.name)
                    .font(.system(size: 14, weight: .medium))
                    .foregroundStyle(Theme.C.ink)
                    .lineLimit(1)
                Text(statusCopy(row, pending: pending))
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.C.inkMuted)
                    .lineLimit(1)
            }
            Spacer(minLength: 8)
            if !formOpen {
                AddPillButton(title: pending ? "Adding" : "Add", enabled: !busy && model.connectorPending == nil) {
                    Task { await model.connectConnector(row, search: search) }
                }
                .accessibilityLabel("Add \(row.name)")
            }
        }
        .frame(minHeight: 48)
    }

    private func ownAppCard(_ row: ConnectorToolkit, _ form: OwnAppForm) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 10) {
                AppLogo(name: row.name, url: row.logo, size: 24)
                Text(row.name)
                    .font(.system(size: 14, weight: .medium))
                    .foregroundStyle(Theme.C.ink)
            }
            ownAppForm(row, form)
        }
        .padding(16)
        .background(Theme.C.sunken)
        .clipShape(RoundedRectangle(cornerRadius: DesignTokens.Radius.settingsGroup, style: .continuous))
        .id("own-app-form")
    }

    /// The owner's own OAuth app for a connector Composio has no app for.
    /// The one line of help is there because the redirect URI has to be
    /// registered with the provider before the sign-in can come back.
    private func ownAppForm(_ row: ConnectorToolkit, _ form: OwnAppForm) -> some View {
        let busy = model.connectorBusy == row.slug
        return VStack(alignment: .leading, spacing: 12) {
            Text("Composio has no \(row.name) app of its own. Create one in the \(row.name) developer portal with this redirect URI, then paste its details here.")
                .font(.system(size: 13))
                .foregroundStyle(Theme.C.inkMuted)
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 8) {
                Text(form.redirectUri)
                    .font(.system(size: 12, design: .monospaced))
                    .foregroundStyle(Theme.C.ink)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .textSelection(.enabled)
                NativeButton("Copy", kind: .secondary, small: true) {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(form.redirectUri, forType: .string)
                }
                Spacer(minLength: 0)
            }
            ForEach(form.fields) { field in
                FieldShell(label: field.label) {
                    let text = Binding(
                        get: { ownAppDraft[field.name] ?? "" },
                        set: { ownAppDraft[field.name] = $0 }
                    )
                    if field.secret {
                        SecureField("", text: text)
                            .nativeField(focused: ownAppFocused == field.name)
                            .focused($ownAppFocused, equals: field.name)
                            .accessibilityLabel(field.label)
                    } else {
                        TextField("", text: text)
                            .nativeField(focused: ownAppFocused == field.name)
                            .focused($ownAppFocused, equals: field.name)
                            .accessibilityLabel(field.label)
                    }
                }
            }
            HStack(spacing: 12) {
                NativeButton(busy ? "Connecting" : "Connect", kind: .primary, small: true, enabled: !busy && ownAppComplete(form)) {
                    submitOwnApp(row, form)
                }
                NativeButton("Cancel", kind: .secondary, small: true, enabled: !busy) {
                    model.dismissOwnApp()
                    ownAppDraft = [:]
                }
                Spacer(minLength: 0)
            }
        }
        .onAppear { ownAppFocused = form.fields.first?.name }
    }

    private func ownAppComplete(_ form: OwnAppForm) -> Bool {
        form.fields.allSatisfy { !(ownAppDraft[$0.name] ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    }

    private func submitOwnApp(_ row: ConnectorToolkit, _ form: OwnAppForm) {
        // The busy flag is set inside the task, so a second click before the
        // first hop is refused here rather than sent twice.
        guard ownAppComplete(form), model.connectorBusy == nil else { return }
        var credentials: [String: String] = [:]
        for field in form.fields {
            credentials[field.name] = (ownAppDraft[field.name] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        }
        Task {
            await model.connectOwnApp(row, credentials: credentials)
            if model.connectorOwnApp == nil { ownAppDraft = [:] }
        }
    }

    private func statusCopy(_ row: ConnectorToolkit, pending: Bool) -> String {
        if row.connected { return "Ready to use" }
        if pending { return "Waiting for approval in the browser" }
        if model.connectorTimedOut == row.slug { return "Still not connected. Try again." }
        if row.noAuth { return "No sign-in needed" }
        if row.ownApp { return "Needs your own app" }
        return "Not connected"
    }

    private var skeletonRows: some View {
        VStack(spacing: 0) {
            ForEach(0..<4, id: \.self) { index in
                HStack(spacing: 12) {
                    RoundedRectangle(cornerRadius: DesignTokens.Radius.sm, style: .continuous)
                        .fill(Theme.C.border)
                        .frame(width: 28, height: 28)
                    RoundedRectangle(cornerRadius: DesignTokens.Radius.xs, style: .continuous)
                        .fill(Theme.C.border)
                        .frame(width: 112, height: 14)
                    Spacer(minLength: 0)
                    RoundedRectangle(cornerRadius: DesignTokens.Radius.sm, style: .continuous)
                        .fill(Theme.C.border)
                        .frame(width: 80, height: 32)
                }
                .frame(minHeight: 52)
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .overlay(alignment: .bottom) {
                    if index < 3 { Hairline() }
                }
            }
        }
        .background(Theme.C.canvas)
        .overlay(
            RoundedRectangle(cornerRadius: DesignTokens.Radius.settingsGroup, style: .continuous)
                .strokeBorder(Theme.C.edge, lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: DesignTokens.Radius.settingsGroup, style: .continuous))
        .accessibilityLabel("Loading connectors")
    }
}

/// Grok's small grey "Add" capsule.
private struct AddPillButton: View {
    let title: String
    var enabled = true
    let action: () -> Void

    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(Theme.C.ink)
                .padding(.horizontal, 14)
                .frame(height: 30)
                .background(hovering && enabled ? Theme.C.border : Theme.C.sunken)
                .clipShape(Capsule())
                .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
        .opacity(enabled ? 1 : 0.6)
        .pointerOnHover()
        .onHover { hovering = $0 }
    }
}

/// Which tools the app page lists.
private enum ConnectorToolScope: String, CaseIterable, Identifiable {
    case all = "All"
    case reads = "Reads"
    case writes = "Writes"

    var id: String { rawValue }
}

/// All / Reads / Writes as one grey pill with the chosen part raised.
private struct ConnectorToolScopePicker: View {
    @Binding var scope: ConnectorToolScope

    var body: some View {
        HStack(spacing: 2) {
            ForEach(ConnectorToolScope.allCases) { item in
                Button {
                    scope = item
                } label: {
                    Text(item.rawValue)
                        .font(.system(size: 13, weight: scope == item ? .medium : .regular))
                        .foregroundStyle(scope == item ? Theme.C.ink : Theme.C.inkMuted)
                        .padding(.horizontal, 12)
                        .frame(height: 26)
                        .background(scope == item ? Theme.C.surface : .clear)
                        .clipShape(Capsule(style: .continuous))
                        .contentShape(Capsule(style: .continuous))
                }
                .buttonStyle(.plain)
                .pointerOnHover()
                .accessibilityAddTraits(scope == item ? .isSelected : [])
                .accessibilityIdentifier("connector-tools-\(item.rawValue.lowercased())")
            }
        }
        .padding(3)
        .background(Theme.C.sunken)
        .clipShape(Capsule(style: .continuous))
    }
}

/// Connected, Sign in again or the server's own trouble, as a small chip.
private struct ConnectorStateChip: View {
    let tile: ConnectorTile

    var body: some View {
        HStack(spacing: 5) {
            if tile.mark == .checking {
                ProgressView().controlSize(.mini)
            }
            Text(label)
                .font(.system(size: 12, weight: .medium))
        }
        .foregroundStyle(warning ? Theme.C.warning : (connected ? Theme.C.success : Theme.C.inkMuted))
        .padding(.horizontal, 8)
        .frame(height: 22)
        .background(warning ? Theme.C.warningSoft : (connected ? Theme.C.successSoft : Theme.C.sunken))
        .clipShape(Capsule(style: .continuous))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(label)
    }

    private var warning: Bool {
        if tile.needsSignIn { return true }
        if case .warning = tile.mark { return true }
        return false
    }

    private var connected: Bool { !tile.needsSignIn && tile.mark == .added }

    private var label: String {
        if tile.needsSignIn { return "Sign in again" }
        switch tile.mark {
        case .added: return "Connected"
        case .checking: return "Checking"
        case .warning: return tile.status
        }
    }
}

/// An added app or server. The whole tile opens its page.
private struct ConnectorAddedTile: View {
    let tile: ConnectorTile
    let removing: Bool
    let open: () -> Void

    @State private var hovering = false

    var body: some View {
        HStack(spacing: 12) {
            AppLogo(name: tile.name, url: tile.logoURL, size: 26, data: tile.iconData)
                .frame(width: 40, height: 40)
                .background(Theme.C.surface)
                .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .strokeBorder(Theme.C.edge, lineWidth: 1)
                )
            VStack(alignment: .leading, spacing: 2) {
                Text(tile.name)
                    .font(.system(size: 14, weight: .medium))
                    .foregroundStyle(Theme.C.ink)
                    .lineLimit(1)
                Text(tile.needsSignIn && tile.mark == .added ? "Sign-in expired" : tile.status)
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.C.inkMuted)
                    .lineLimit(1)
            }
            Spacer(minLength: 8)
            if removing {
                Text("Removing")
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.C.inkMuted)
            } else {
                ConnectorStateChip(tile: tile)
            }
            Image(systemName: "chevron.right")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(Theme.C.inkFaint)
        }
        .frame(minHeight: 48)
        .padding(.horizontal, 8)
        .background(hovering ? Theme.C.sunken.opacity(0.6) : .clear)
        .clipShape(RoundedRectangle(cornerRadius: DesignTokens.Radius.md, style: .continuous))
        .contentShape(Rectangle())
        .onTapGesture(perform: open)
        .onHover { hovering = $0 }
        .pointerOnHover()
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isButton)
        .accessibilityAction(.default, open)
        .accessibilityIdentifier("connector-tile-\(tile.id)")
    }
}
