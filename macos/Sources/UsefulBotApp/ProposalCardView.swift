import SwiftUI
import UsefulBotCore

/// `proposal-card.tsx`, 1:1: one card per confirmation the bot asked for.
struct ProposalCardView: View {
    let proposal: Proposal
    let bots: [ShellBot]
    let pending: Bool
    let onDecision: (_ confirmed: Bool) -> Void
    /// Reopen the hosted sign-in for a connect card that is waiting or timed out.
    var onReopen: () -> Void = {}
    /// Connect server with an API key typed on the card. Never used for OAuth.
    var onConfirmSecret: (String) -> Void = { _ in }

    @State private var secretDraft = ""

    private func nameOf(_ id: String) -> String {
        bots.first { $0.id == id }?.name ?? "a bot"
    }

    var body: some View {
        switch proposal.kind {
        case .createBot:
            card(title: "New teammate", tone: .accent) {
                Text(proposal.name ?? "")
                    .font(Theme.font(15, .semibold))
                if let title = proposal.title, !title.isEmpty {
                    Text(title)
                        .font(.system(size: 13))
                        .foregroundStyle(Theme.C.inkMuted)
                }
                if let description = proposal.description, !description.isEmpty {
                    Text(description)
                        .font(.system(size: 13))
                        .lineSpacing(3)
                        .foregroundStyle(Theme.C.inkMuted)
                        .padding(.top, 8)
                } else {
                    Text("No standing instructions yet.")
                        .font(.system(size: 13))
                        .foregroundStyle(Theme.C.inkMuted)
                        .padding(.top, 8)
                }
                if let brief = proposal.brief, !brief.isEmpty {
                    Text("First brief: \(brief)")
                        .font(.system(size: 12))
                        .lineSpacing(3)
                        .foregroundStyle(Theme.C.inkFaint)
                        .padding(.top, 8)
                }
                actions(confirm: "Add teammate", dismiss: "Not now")
            }
        case .createGroup:
            // Show only the real roster the server would accept, so a pruned
            // or stale member id is not rendered as "a bot".
            let members = Threads.groupMembers(
                Threads.speakers(from: bots),
                memberIds: proposal.memberIds
            )
            card(title: "New group chat", tone: .accent) {
                Text(proposal.name ?? "")
                    .font(Theme.font(15, .semibold))
                HStack(spacing: 6) {
                    Image(systemName: "person.2")
                        .font(.system(size: 13))
                    Text("\(members.count) members")
                        .font(.system(size: 13))
                }
                .foregroundStyle(Theme.C.inkMuted)
                .padding(.top, 4)
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(members, id: \.id) { member in
                        Text(member.name)
                            .font(.system(size: 13))
                            .foregroundStyle(Theme.C.inkMuted)
                    }
                }
                .padding(.top, 8)
                if let description = proposal.description, !description.isEmpty {
                    Text(description)
                        .font(.system(size: 13))
                        .lineSpacing(3)
                        .foregroundStyle(Theme.C.inkMuted)
                        .padding(.top, 8)
                }
                actions(confirm: "Create group", dismiss: "Not now")
            }
        case .updateBotProfile:
            let target = bots.first { $0.id == proposal.botId }
            card(title: "Profile edit: \(target?.name ?? "bot")", tone: .plain) {
                VStack(alignment: .leading, spacing: 6) {
                    patchRow("Name", before: target?.name ?? "", after: proposal.patch?.name ?? "")
                    patchRow("Title", before: target?.label ?? "", after: proposal.patch?.title ?? "")
                    if let description = proposal.patch?.description {
                        patchRow("Description", before: target?.description ?? "", after: description)
                    }
                }
                actions(confirm: "Apply profile", dismiss: "Keep as is")
            }
        case .fanout:
            let group = proposal.groupId.flatMap { id in bots.first { $0.id == id } }
            let targetId = proposal.fanoutTargetId
            card(title: group.map { "Post to \($0.name)" } ?? "Send to several bots", tone: .warning) {
                Text(proposal.message ?? "")
                    .font(.system(size: 13))
                    .lineSpacing(3)
                    .foregroundStyle(Theme.C.ink)
                Text(targetNote)
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.C.inkMuted)
                    .padding(.top, 8)
                actions(
                    confirm: targetId != nil
                        ? (proposal.groupId != nil ? "Send to group" : "Send to \(proposal.targetIds.count)")
                        : "Nothing to send",
                    dismiss: "Cancel",
                    confirmDisabled: targetId == nil
                )
            }
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
                        if proposal.phase == .connected, let count = proposal.toolCount {
                            Text(count == 1 ? "1 tool" : "\(count) tools")
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
                        if proposal.phase == .connected, let count = proposal.toolCount {
                            Text(count == 1 ? "1 tool" : "\(count) tools")
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
                        SecureField("Paste key", text: $secretDraft)
                            .textFieldStyle(.plain)
                            .font(.system(size: DesignTokens.FontSize.fieldInput))
                            .padding(.horizontal, 10)
                            .frame(minHeight: DesignTokens.Control.fieldMinHeight)
                            .background(Theme.C.sunken)
                            .clipShape(RoundedRectangle(cornerRadius: DesignTokens.Radius.field, style: .continuous))
                            .padding(.top, 12)
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

    private var targetNote: String {
        // An empty target list with a group is a valid fan-out: the message
        // goes to the group, so only a proposal with no target at all has no
        // recipients.
        guard proposal.fanoutTargetId != nil else {
            return "No recipients are available for this proposal."
        }
        if let groupId = proposal.groupId {
            let name = bots.first { $0.id == groupId }?.name ?? "the group"
            return "This will post to \(name)."
        }
        let names = proposal.targetIds.map(nameOf).joined(separator: ", ")
        return "\(proposal.targetIds.count) bots will each run on this: \(names)"
    }

    @ViewBuilder
    private func patchRow(_ label: String, before: String, after: String) -> some View {
        let changed = before != after
        HStack(alignment: .top, spacing: 8) {
            Text(label)
                .font(.system(size: 13))
                .foregroundStyle(Theme.C.inkFaint)
                .frame(width: 86, alignment: .leading)
            HStack(alignment: .top, spacing: 4) {
                if changed {
                    if !before.isEmpty {
                        Text(before)
                            .strikethrough()
                            .foregroundStyle(Theme.C.inkMuted.opacity(0.6))
                    }
                    Text(after.isEmpty ? "(empty)" : after)
                        .fontWeight(.medium)
                        .foregroundStyle(Theme.C.ink)
                } else {
                    Text(after.isEmpty ? "(empty)" : after)
                        .foregroundStyle(Theme.C.inkMuted)
                }
            }
            .font(.system(size: 13))
            Spacer(minLength: 0)
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

/// First-turn onboarding prompt for a bot that has no profile yet.
struct OnboardingCardView: View {
    let name: String
    let onFillForm: () -> Void
    let onDismiss: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("NEW BOT")
                .font(.system(size: DesignTokens.FontSize.proposalTitle, weight: .semibold))
                .tracking(DesignTokens.Tracking.label * DesignTokens.FontSize.proposalTitle)
                .foregroundStyle(Theme.C.inkFaint)
            Text("\(name) has no job yet. What should I own? Give me a job title, standing rules, and anything I must never do without asking.")
                .font(.system(size: 15))
                .lineSpacing(6)
                .foregroundStyle(Theme.C.ink)
                .padding(.top, 6)
            Text("Answer here and I will propose a profile for you to confirm, or fill the form.")
                .font(.system(size: 12))
                .lineSpacing(3)
                .foregroundStyle(Theme.C.inkMuted)
                .padding(.top, 8)
            HStack(spacing: 8) {
                NativeButton("Fill the form", kind: .primary, small: true, action: onFillForm)
                NativeButton("Skip", kind: .ghost, small: true, action: onDismiss)
            }
            .padding(.top, 12)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.C.surface)
        .clipShape(RoundedRectangle(cornerRadius: DesignTokens.Radius.md, style: .continuous))
        .cardLift(cornerRadius: DesignTokens.Radius.md)
    }
}
