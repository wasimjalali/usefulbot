import SwiftUI
import UsefulBotCore

/// `proposal-card.tsx`, 1:1: one card per confirmation the bot asked for.
struct ProposalCardView: View {
    let proposal: Proposal
    let pending: Bool
    let onDecision: (_ confirmed: Bool) -> Void
    /// Reopen the hosted sign-in for a connect card that is waiting or timed out.
    var onReopen: () -> Void = {}
    /// Connect server with an API key typed on the card. Never used for OAuth.
    var onConfirmSecret: (String) -> Void = { _ in }

    @State private var secretDraft = ""

    var body: some View {
        switch proposal.kind {
        case .connectApp:
            let name = proposal.name ?? "this app"
            card(title: "Connect app", tone: .accent) {
                HStack(alignment: .center, spacing: 12) {
                    AppLogo(name: name, url: proposal.logo)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(name)
                            .font(Theme.font(15, .semibold))
                        if let purpose = proposal.purpose, !purpose.isEmpty {
                            Text(purpose)
                                .font(.system(size: 13))
                                .foregroundStyle(Theme.C.inkMuted)
                        }
                        if let line = proposal.connectedToolsLine {
                            Text(line)
                                .font(.system(size: 12))
                                .foregroundStyle(Theme.C.inkFaint)
                        }
                    }
                    Spacer(minLength: 0)
                    if proposal.phase == .connected {
                        connectedPill
                    }
                }
                switch proposal.phase {
                case .proposed:
                    actions(confirm: "Authorize", dismiss: "Not now")
                case .failed:
                    Text(Proposal.ConnectFailure.line(for: proposal.reason))
                        .font(.system(size: 13))
                        .foregroundStyle(Theme.C.warning)
                        .padding(.top, 12)
                    actions(confirm: "Authorize", dismiss: "Not now")
                case .unknown:
                    unknownPhaseRow
                case .waiting:
                    waitingRow(text: "Waiting for \(name) sign-in", tone: Theme.C.inkMuted)
                case .expired:
                    waitingRow(text: "Sign-in timed out", tone: Theme.C.warning)
                case .connected:
                    // The pill stays until the bot resumes; Not now puts the
                    // card away early without touching the connection.
                    HStack {
                        Spacer(minLength: 0)
                        NativeButton(kind: .secondary, small: true, enabled: !pending) {
                            onDecision(false)
                        } label: {
                            Text("Not now")
                        }
                    }
                    .padding(.top, 14)
                }
            }
        case .connectServer:
            let name = proposal.name ?? "this server"
            card(title: "Connect server", tone: .accent) {
                HStack(alignment: .center, spacing: 12) {
                    Image(systemName: "server.rack")
                        .font(.system(size: 20, weight: .regular))
                        .foregroundStyle(Theme.C.inkMuted)
                        .frame(width: 28, height: 28)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(name)
                            .font(Theme.font(15, .semibold))
                        if let purpose = proposal.purpose, !purpose.isEmpty {
                            Text(purpose)
                                .font(.system(size: 13))
                                .foregroundStyle(Theme.C.inkMuted)
                        }
                        if let host = proposal.urlHost, !host.isEmpty {
                            Text(host)
                                .font(.system(size: 12))
                                .foregroundStyle(Theme.C.inkFaint)
                        }
                        if let line = proposal.connectedToolsLine {
                            Text(line)
                                .font(.system(size: 12))
                                .foregroundStyle(Theme.C.inkFaint)
                        }
                    }
                    Spacer(minLength: 0)
                    if proposal.phase == .connected {
                        connectedPill
                    }
                }
                switch proposal.phase {
                case .proposed:
                    if proposal.authKind == .apiKey || proposal.authKind == .bearer {
                        secretField
                        HStack(spacing: 8) {
                            NativeButton(
                                "Connect",
                                kind: .primary,
                                small: true,
                                enabled: !pending && !secretDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                            ) {
                                onConfirmSecret(secretDraft)
                            }
                            NativeButton("Not now", kind: .secondary, small: true, enabled: !pending) {
                                onDecision(false)
                            }
                        }
                        .padding(.top, 14)
                    } else {
                        actions(
                            confirm: proposal.authKind == .oauth ? "Authorize" : "Connect",
                            dismiss: "Not now"
                        )
                    }
                case .waiting:
                    waitingRow(text: "Waiting for \(name) sign-in", tone: Theme.C.inkMuted)
                case .expired:
                    waitingRow(text: "Sign-in timed out", tone: Theme.C.warning)
                case .failed:
                    Text(Proposal.ConnectFailure.line(for: proposal.reason))
                        .font(.system(size: 13))
                        .foregroundStyle(Theme.C.warning)
                        .padding(.top, 12)
                    let needsKey = proposal.authKind == .apiKey || proposal.authKind == .bearer
                    if needsKey {
                        secretField
                    }
                    HStack(spacing: 8) {
                        NativeButton(
                            "Try again",
                            kind: .primary,
                            small: true,
                            enabled: !pending && ProposalActions.confirm(proposal) != nil
                                && (!needsKey || !secretDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                        ) {
                            if needsKey { onConfirmSecret(secretDraft) } else { onDecision(true) }
                        }
                        NativeButton("Not now", kind: .secondary, small: true, enabled: !pending) {
                            onDecision(false)
                        }
                    }
                    .padding(.top, 10)
                case .unknown:
                    unknownPhaseRow
                case .connected:
                    HStack {
                        Spacer(minLength: 0)
                        NativeButton(kind: .secondary, small: true, enabled: !pending) {
                            onDecision(false)
                        } label: {
                            Text("Not now")
                        }
                    }
                    .padding(.top, 14)
                }
            }
        case .unknown:
            card(title: "Unsupported proposal", tone: .plain) {
                Text("This app does not know how to confirm this proposal yet. Update Useful Bot and try again.")
                    .font(.system(size: 13))
                    .lineSpacing(3)
                    .foregroundStyle(Theme.C.inkMuted)
                HStack(spacing: 8) {
                    NativeButton("Dismiss", kind: .secondary, small: true, enabled: !pending) {
                        onDecision(false)
                    }
                }
                .padding(.top, 14)
            }
        }
    }

    @ViewBuilder
    private func actions(confirm: String, dismiss: String, confirmDisabled: Bool = false) -> some View {
        let actionable = ProposalActions.confirm(proposal) != nil
        HStack(spacing: 8) {
            NativeButton(kind: .primary, small: true, enabled: !pending && !confirmDisabled && actionable) {
                onDecision(true)
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: "checkmark")
                        .font(.system(size: 12, weight: .medium))
                    Text(confirm)
                }
            }
            NativeButton(kind: .secondary, small: true, enabled: !pending) {
                onDecision(false)
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: "xmark")
                        .font(.system(size: 12, weight: .regular))
                    Text(dismiss)
                }
            }
        }
        .padding(.top, 14)
    }

    private var secretField: some View {
        SecureField("Paste key", text: $secretDraft)
            .textFieldStyle(.plain)
            .font(.system(size: DesignTokens.FontSize.fieldInput))
            .padding(.horizontal, 10)
            .frame(minHeight: DesignTokens.Control.fieldMinHeight)
            .background(Theme.C.sunken)
            .clipShape(RoundedRectangle(cornerRadius: DesignTokens.Radius.field, style: .continuous))
            .padding(.top, 12)
    }

    /// A connect phase this build doesn't know: a plain line, and the card
    /// can only be put away.
    @ViewBuilder
    private var unknownPhaseRow: some View {
        Text("This card needs a newer app.")
            .font(.system(size: 13))
            .foregroundStyle(Theme.C.inkMuted)
            .padding(.top, 12)
        HStack(spacing: 8) {
            NativeButton("Not now", kind: .secondary, small: true, enabled: !pending) {
                onDecision(false)
            }
        }
        .padding(.top, 10)
    }

    private var connectedPill: some View {
        HStack(spacing: 6) {
            Image(systemName: "checkmark")
                .font(.system(size: 11, weight: .semibold))
            Text("Connected")
                .font(.system(size: 12, weight: .medium))
        }
        .foregroundStyle(Theme.C.success)
        .padding(.horizontal, 10)
        .padding(.vertical, 5)
        .background(Theme.C.successSoft)
        .clipShape(Capsule())
    }

    @ViewBuilder
    private func waitingRow(text: String, tone: Color) -> some View {
        HStack(spacing: 8) {
            if proposal.phase == .waiting {
                ProgressView()
                    .controlSize(.small)
            }
            Text(text)
                .font(.system(size: 13))
                .foregroundStyle(tone)
            Spacer(minLength: 0)
            NativeButton(kind: .secondary, small: true, enabled: !pending) {
                onReopen()
            } label: {
                Text("Reopen")
            }
            NativeButton(kind: .secondary, small: true, enabled: !pending) {
                onDecision(false)
            } label: {
                Text("Not now")
            }
        }
        .padding(.top, 14)
    }

    private enum Tone {
        case accent
        case warning
        case plain
    }

    @ViewBuilder
    private func card<Content: View>(
        title: String,
        tone: Tone,
        @ViewBuilder content: () -> Content
    ) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(title.uppercased())
                .font(.system(size: DesignTokens.FontSize.proposalTitle, weight: .semibold))
                .tracking(DesignTokens.Tracking.label * DesignTokens.FontSize.proposalTitle)
                .foregroundStyle(tone == .warning ? Theme.C.warning : Theme.C.inkFaint)
            VStack(alignment: .leading, spacing: 0) {
                content()
            }
            .padding(.top, 4)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(tone == .warning ? Theme.C.warningSoft : Theme.C.surface)
        .overlay(
            RoundedRectangle(cornerRadius: DesignTokens.Radius.md, style: .continuous)
                .strokeBorder(Theme.C.warning.opacity(tone == .warning ? 0.4 : 0), lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: DesignTokens.Radius.md, style: .continuous))
        .cardLift(cornerRadius: DesignTokens.Radius.md)
    }
}
