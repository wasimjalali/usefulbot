import AppKit
import SwiftUI
import UsefulBotCore

/// The chat column: header, transcript in a centered
/// 768pt column, empty state, proposal and onboarding cards, composer.
struct ChatView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.starterBotId) private var starterBotId
    @Environment(\.composerRisen) private var composerRisen
    @Environment(\.connectModel) private var connectModel
    @Environment(\.noModelPreview) private var noModelPreview
    /// Starters are for a first conversation: gone for good once the owner
    /// has sent a message from this app.
    @AppStorage(StarterPrompt.sentKey) private var firstMessageSent = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var onDeleteRequest: (ShellBot) -> Void

    /// Measured width of the chat column, so user bubbles cap at 85% of the
    /// column rather than 85% of the wider scroll container.
    @State private var columnWidth: CGFloat = 720
    @State private var infoButtonFrame = CGRect.zero
    /// True while the transcript rests at its newest turn. Auto-scroll only
    /// fires then: streaming replies append below and stay pinned, while a
    /// scroll-up into history never yanks the reader back down.
    @State private var pinnedToBottom = true
    /// Height of the newest reply and of the window showing it. Together they
    /// decide whether landing on the reply's first line is worth moving the
    /// page for: a reply that already fits needs no move.
    @State private var replyHeight: CGFloat = 0
    @State private var viewportHeight: CGFloat = 0
    /// True while the view is parked at the top of a finished reply. It stops
    /// the bottom-pinning triggers from dragging the reader back down as the
    /// durable reload changes the list underneath them.
    @State private var holdingReplyAnchor = false
    /// The chat whose transcript rests at its newest turn. Until it names the
    /// open chat, the transcript lays out hidden under the mascot, so a chat
    /// never opens in the middle of its history while the replay settles.
    /// Keyed by chat rather than a flag, so a switch reads as not landed from
    /// its first frame instead of once the mount's task has run.
    @State private var landedBotId: String?
    /// The transcript's latest scroll geometry, for the landing check. A
    /// plain object so the pin tracker's per-frame writes do not re-render
    /// the chat.
    @State private var scrollProbe = ScrollProbe()
    /// The restored chat whose reload is slow to confirm its rows: the mascot
    /// comes back rather than a blank pane. Keyed by chat, so a chat left
    /// before it landed cannot hand its mascot to the next one.
    @State private var slowRestoreBotId: String?
    /// How long a stalled replay may keep the mascot up before the rows on
    /// hand are shown anyway. A healthy replay lands well inside it: the
    /// mascot stays until the newest turn is in, because rows shown before
    /// then are replaced underneath the reader.
    private static let landingCap: TimeInterval = 10
    /// How long a restored chat waits for its reload with nothing on screen.
    /// The reload's answer (a durable read, a one-file probe, whatever the
    /// session gained since the snapshot) takes about 70 ms, but its reply
    /// can queue behind the transcript's own build on the main thread; one
    /// still missing after this gets the mascot until it is in, so a chat
    /// that gained a turn opens on it rather than showing it arrive.
    private static let resumeConfirmWait: TimeInterval = 0.6
    private static var fastLanding: Bool {
        if #available(macOS 15.0, *) { return true }
        return false
    }
    /// Room for the user's message above the reply, so an answer that only
    /// just fits is left where it is.
    private static let replyAnchorSlack: CGFloat = 120
    /// How long a send's own scrolls are not read as the reader's: the few
    /// frames the composer shrinks and the row lands in.
    private static let sendScrollWindow: TimeInterval = 0.1
    /// How far above the composer the transcript fades out.
    private static let bottomFade: CGFloat = 28
    /// The chat whose landing gate is running. A send while it runs does not
    /// land the chat early: the gate is already waiting for the rows.
    @State private var gatingBotId: String?

    var body: some View {
        HStack(spacing: 0) {
            VStack(spacing: 0) {
                if let bot = model.selectedBot {
                    // The header floats: the transcript runs under it, and
                    // only the bot's pill and the panel control sit on top.
                    ZStack(alignment: .top) {
                    if model.hasThreadContent || model.pending {
                        // Put back from a snapshot or a stash: it lands within
                        // a few frames, so the mascot would only flash and the
                        // fade would only delay it. macOS 14 has no scroll
                        // geometry to land it that fast and keeps both.
                        let restored = model.restoredFromCache && Self.fastLanding
                        // A chat known to be empty that the owner has just
                        // sent into has nothing to wait for: its only rows are
                        // the send's own. It shows them from its first frame,
                        // with no mascot and no fade; the mascot used to wave
                        // for a fifth of a second between the empty state and
                        // the owner's message.
                        // Decided when the chat mounted: a send made while a
                        // first load's gate is running waits for that gate.
                        // Read live, the load finishing mid-gate flipped it and
                        // showed the rows before their geometry settled.
                        let landed = landedBotId == bot.id || (sentIntoReadyChat && gatingBotId != bot.id)
                        transcript(bot)
                            // The landing belongs to this mount. Without this a
                            // chat left for an empty one, or remounted before
                            // its replay, came back shown before it landed.
                            .onDisappear {
                                if landedBotId == bot.id { landedBotId = nil }
                                if gatingBotId == bot.id { gatingBotId = nil }
                            }
                            // A new chat gets a new scroll view. Reusing one
                            // across bots hands the next chat the offset the
                            // last one was left at, which then has to be
                            // corrected on screen.
                            .id(bot.id)
                            // Only the opacity fades. An animation on the whole
                            // transaction also animated any layout still moving
                            // in it, and the rows drifted while they faded in.
                            .animation(restored ? nil : .easeOut(duration: 0.15)) {
                                $0.opacity(landed ? 1 : 0)
                            }
                            .accessibilityHidden(!landed)
                            .overlay {
                                ZStack { if !landed, !restored || slowRestoreBotId == bot.id { loadingState } }
                                    // A restored chat's rows show at once, so
                                    // its mascot must not fade out over them.
                                    // A slow one fades, so a confirmation just past
                                    // the wait does not pop the mascot for a frame.
                                    .animation(restored && slowRestoreBotId != bot.id ? nil : .easeOut(duration: 0.15), value: landed)
                            }
                    } else if model.transcriptReady {
                        emptyState(bot)
                            // The transcript's landing never mounts for a chat
                            // with no rows; the performance guard's wait ends here.
                            .task(id: bot.id) {
                                PerfHarness.shared?.landed(botId: bot.id, reason: "empty", stats: model.perfStats)
                            }
                    } else {
                        loadingState
                    }
                        header(bot)
                    }
                    // While the first load is still in flight the mascot waves
                    // in the middle of the chat: the empty copy belongs to a
                    // chat that is known empty, and flashing it in front of a
                    // history that arrives a moment later reads as a jump.
                    // Anything the bot needs an answer to docks here, between
                    // the transcript and the composer, so the question sits
                    // where the reply is typed instead of scrolling away.
                    // Hangs above the column from a line of no height, so it
                    // floats over the transcript's bottom edge and never takes
                    // the transcript's height the way the banner did.
                    Color.clear
                        .frame(height: 0)
                        .frame(maxWidth: .infinity)
                        .overlay(alignment: .bottom) {
                            if let note = model.threadError ?? model.saveError {
                                ComposerNote(
                                    text: note,
                                    // A rail write that failed has nothing to re-read.
                                    reload: model.threadError != nil ? { model.reloadFromNote() } : nil
                                ) { model.dismissNote() }
                                    .frame(maxWidth: DesignTokens.Space.chatColumnMax)
                                    .padding(.horizontal, DesignTokens.Space.chatColumnPadding)
                                    .padding(.bottom, 8)
                                    .fixedSize(horizontal: false, vertical: true)
                                    .transition(.opacity)
                            }
                        }
                        .zIndex(1)
                    askColumn(bot)
                    composerColumn(bot)
                } else if let note = model.threadError ?? model.saveError {
                    // No bot to chat with (the last one was deleted, or the
                    // first create failed): the note still says what went wrong.
                    Spacer(minLength: 0)
                    ComposerNote(text: note) { model.dismissNote() }
                        .frame(maxWidth: DesignTokens.Space.chatColumnMax)
                        .padding(DesignTokens.Space.chatColumnPadding)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)

            if model.settingsOpen, let bot = model.selectedBot {
                SettingsPaneView(bot: bot, onDeleteRequest: { onDeleteRequest(bot) })
                    .dismissOnOutsideClick(triggers: { [infoButtonFrame] }) {
                        model.settingsOpen = false
                    }
                    .onExitCommand(perform: closePanes)
            }

            if model.detailsOpen, let bot = model.selectedBot {
                ChatDetailsPaneView(bot: bot)
                    .dismissOnOutsideClick(triggers: { [infoButtonFrame] }) {
                        model.detailsOpen = false
                    }
                    .onExitCommand(perform: closePanes)
            }
        }
        .background(Theme.C.surface)
        .onReceive(NotificationCenter.default.publisher(for: .replyToMessage)) { note in
            guard let text = note.userInfo?["text"] as? String,
                  let botId = note.userInfo?["botId"] as? String else { return }
            model.reply(to: text, author: note.userInfo?["author"] as? String, botId: botId)
        }
    }

    /// The owner sent into a chat whose load had already finished, in this
    /// visit. The transcript mounts on that send with its rows ready.
    private var sentIntoReadyChat: Bool {
        model.transcriptReady && model.pending && model.sentSinceOpen
    }

    private func closePanes() {
        model.pane = .none
    }

    // MARK: - Asks

    /// Every open question, docked above the composer in the chat column:
    /// approvals the bot is waiting on and proposals it wants confirmed. Each
    /// one states what it is asking and puts its answers on the same row, the
    /// way a coding agent prompts before it acts.
    @ViewBuilder
    private func askColumn(_ bot: ShellBot) -> some View {
        let hasAsk = !model.approvals.isEmpty
            || !model.openQuestions.isEmpty
            || !model.pendingRequests.isEmpty
            || !model.openProposals.isEmpty
            || model.approvalError != nil
        if hasAsk {
            VStack(spacing: 8) {
                ForEach(model.approvals) { item in
                    approvalAsk(item)
                }
                ForEach(model.openQuestions) { question in
                    questionAsk(question, bot: bot)
                }
                ForEach(model.pendingRequests) { request in
                    WaitingCard(
                        request: request,
                        botName: bot.name,
                        busy: model.busyRequests.contains(request.id)
                    ) { option in model.answerRequest(request, option: option) }
                    dismiss: { model.dismissRequest(request) }
                }
                if let store = model.store {
                    ForEach(model.openProposals) { proposal in
                        ProposalCardView(
                            proposal: proposal,
                            bots: store.bots,
                            pending: model.busyProposals.contains(proposal.id),
                            onDecision: { confirmed in
                                model.decideProposal(proposal, confirmed: confirmed)
                            },
                            onReopen: { model.reopenConnect(proposal) },
                            onConfirmSecret: { secret in
                                model.decideProposal(proposal, confirmed: true, secret: secret)
                            }
                        )
                    }
                }
                if let error = model.approvalError {
                    Text(error)
                        .font(.system(size: 13))
                        .foregroundStyle(Theme.C.danger)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            .frame(maxWidth: DesignTokens.Space.chatColumnMax)
            .padding(.horizontal, DesignTokens.Space.chatColumnPadding)
            .padding(.top, 8)
            .frame(maxWidth: .infinity)
            .transition(.opacity)
        }
    }

    private func approvalAsk(_ item: ApprovalItem) -> some View {
        let busy = model.busyApprovals.contains(item.id)
        let canDecide = !busy && !item.actionSha256.isEmpty
        return VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: "hand.raised")
                    .font(.system(size: 11, weight: .regular))
                Text("Needs approval")
                    .font(.system(size: DesignTokens.FontSize.chatMeta, weight: .semibold))
                    .tracking(DesignTokens.Tracking.label * DesignTokens.FontSize.chatMeta)
                Spacer(minLength: 0)
                Text(item.tool)
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.C.inkMuted)
            }
            // The card sits on the app's own surface, not a warning wash. An
            // approval is the normal way this app works, and a yellow panel
            // over the composer reads as something having gone wrong.
            .foregroundStyle(Theme.C.inkMuted)
            if let origin = item.originLabel(openBotId: model.selectedBotId, openSessionId: model.selectedBot?.sessionId) {
                Text(origin)
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.C.inkFaint)
            }
            // The preview is what the owner is approving; a single truncated
            // line hides the end of a command or an instruction they are
            // agreeing to run.
            Text(item.preview)
                .font(.system(size: 14))
                .foregroundStyle(Theme.C.ink)
                .lineLimit(6)
                .fixedSize(horizontal: false, vertical: true)
                .multilineTextAlignment(.leading)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
            HStack(spacing: 8) {
                Spacer(minLength: 0)
                NativeButton("Deny", kind: .danger, small: true, enabled: canDecide) {
                    model.decideApproval(item, decision: .deny)
                }
                .accessibilityIdentifier("approval-deny")
                NativeButton("Approve", kind: .primary, small: true, enabled: canDecide) {
                    model.decideApproval(item, decision: .approve)
                }
                .accessibilityIdentifier("approval-approve")
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .background(Theme.C.surface)
        .overlay(
            RoundedRectangle(cornerRadius: DesignTokens.Radius.settingsGroup, style: .continuous)
                .strokeBorder(Theme.C.edge, lineWidth: 1)
        )
        .popShadow()
        .clipShape(RoundedRectangle(cornerRadius: DesignTokens.Radius.settingsGroup, style: .continuous))
        .opacity(busy ? 0.7 : 1)
    }

    /// A question the bot asked with `ask_question`. The turn has ended and
    /// the bot is waiting, so without this card the chat just goes quiet.
    private func questionAsk(_ question: OwnerQuestion, bot: ShellBot) -> some View {
        let canAnswer = !model.pending
        return VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 6) {
                Image(systemName: "questionmark.bubble")
                    .font(.system(size: 11, weight: .regular))
                Text("\(bot.name) asks")
                    .font(.system(size: DesignTokens.FontSize.chatMeta, weight: .semibold))
                    .tracking(DesignTokens.Tracking.label * DesignTokens.FontSize.chatMeta)
                Spacer(minLength: 0)
            }
            .foregroundStyle(Theme.C.inkMuted)
            Text(question.prompt)
                .font(.system(size: 14))
                .foregroundStyle(Theme.C.ink)
                .fixedSize(horizontal: false, vertical: true)
                .multilineTextAlignment(.leading)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
            if !question.options.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(question.options) { option in
                        questionOption(option, enabled: canAnswer) {
                            model.answerQuestion(question, option: option)
                        }
                    }
                }
            }
            // A question with no options can only be answered in words, even
            // if the bot forgot to say freeform is allowed.
            if question.allowFreeform || question.options.isEmpty {
                Text(question.options.isEmpty ? "Reply below to answer." : "Or reply below in your own words.")
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.C.inkFaint)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .background(Theme.C.surface)
        .overlay(
            RoundedRectangle(cornerRadius: DesignTokens.Radius.settingsGroup, style: .continuous)
                .strokeBorder(Theme.C.edge, lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: DesignTokens.Radius.settingsGroup, style: .continuous))
        // Flatten first: a shadow on an open stack is drawn under every row
        // inside it, which muddies the options.
        .compositingGroup()
        .popShadow()
        .accessibilityIdentifier("question-card")
    }

    private func questionOption(
        _ option: OwnerQuestion.Option,
        enabled: Bool,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: 2) {
                Text(option.label)
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(Theme.C.ink)
                if !option.detail.isEmpty {
                    Text(option.detail)
                        .font(.system(size: 12))
                        .foregroundStyle(Theme.C.inkMuted)
                }
            }
            .multilineTextAlignment(.leading)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .background(Theme.C.sunken)
            .clipShape(RoundedRectangle(cornerRadius: DesignTokens.Radius.sm, style: .continuous))
            .contentShape(RoundedRectangle(cornerRadius: DesignTokens.Radius.sm, style: .continuous))
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
        .opacity(enabled ? 1 : 0.6)
        .accessibilityIdentifier("question-option")
    }

    // MARK: - Header

    /// The bot as a centered pill over a bare header, and one quiet control
    /// on the right that opens the bot's panel.
    private func header(_ bot: ShellBot) -> some View {
        ZStack {
            HStack(spacing: 8) {
                if bot.isGroup, !members(bot).isEmpty {
                    AvatarStackView(bots: members(bot), size: 22, maxVisible: 3)
                } else {
                    BotAvatarView(bot: bot, size: 22)
                }
                Text(bot.name)
                    .font(.system(size: 14, weight: .medium))
                    .foregroundStyle(Theme.C.ink)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
            .padding(.leading, 6)
            .padding(.trailing, 14)
            .frame(height: 34)
            .background(Theme.C.surface)
            .clipShape(Capsule())
            .overlay(Capsule().strokeBorder(Theme.C.edge, lineWidth: 1))
            .smShadow()
            .padding(.horizontal, 56)
            HStack {
                Spacer(minLength: 0)
                NativeIconButton(systemImage: "sidebar.right", size: 32, iconSize: 15) {
                    model.detailsOpen.toggle()
                }
                .help("Bot settings")
                .accessibilityLabel("Bot settings")
                .trackWindowFrame($infoButtonFrame)
            }
        }
        .padding(.horizontal, 16)
        .frame(minHeight: DesignTokens.Space.chatHead)
    }

    private func members(_ bot: ShellBot) -> [ShellBot] {
        groupMemberBots(bot, store: model.store)
    }

    // MARK: - Transcript

    /// Move to a row without animating the trip. Used for the one automatic
    /// scroll this transcript performs.
    private func scrollWithoutAnimation(_ proxy: ScrollViewProxy, to id: String) {
        var transaction = Transaction()
        transaction.disablesAnimations = true
        scrollProbe.markAppScroll()
        withTransaction(transaction) {
            proxy.scrollTo(id, anchor: .top)
        }
    }

    /// Put the newest turn back against the composer after a banner above
    /// the transcript changed height. Only for a reader who is pinned there.
    /// Below macOS 15 the pin tracker is inert and `pinnedToBottom` never
    /// leaves `true`, so a reader in history would be yanked down; those
    /// systems keep the shift instead, as they had before the re-pin.
    private func repinAfterBannerChange(_ proxy: ScrollViewProxy) {
        guard #available(macOS 15.0, *), pinnedToBottom, !holdingReplyAnchor,
              !scrollProbe.dragging else { return }
        scrollToBottom(proxy)
    }

    /// A chat put back from its snapshot or its stash has its rows ready, so
    /// it lands as soon as its reload confirms them and layout reads the true
    /// bottom at one height on two frames in a row: checked every frame,
    /// where a replayed chat waits out three 50 ms checks, and shown without
    /// the fade.
    @available(macOS 15.0, *)
    private func landRestored(_ proxy: ScrollViewProxy, botId: String) async {
        slowRestoreBotId = nil
        let slowAfter = Date().addingTimeInterval(Self.resumeConfirmWait)
        let deadline = Date().addingTimeInterval(Self.landingCap)
        var lastHeight: CGFloat = -1
        var reason = "cap"
        while Date() < deadline {
            try? await Task.sleep(nanoseconds: 16_000_000)
            guard !Task.isCancelled else { return }
            let height = scrollProbe.contentHeight
            // Geometry that never reports has nothing to settle; it is given
            // a moment to show up first.
            let atBottom = scrollProbe.seen
                ? scrollProbe.distance <= 1 || height <= scrollProbe.viewport + 1
                : Date() >= slowAfter
            // The reload's word that a snapshot's rows are the session, or a
            // send of the owner's in this visit, which lands on its own rows.
            // Rows from a stash are confirmed by a replay from zero, which
            // they never waited for.
            let confirmed = model.transcriptReady || (model.pending && model.sentSinceOpen)
                || !model.restoredFromSnapshot
            if !confirmed {
                if slowRestoreBotId != botId, Date() >= slowAfter { slowRestoreBotId = botId }
                // The two equal frames are counted on the confirmed rows only.
                lastHeight = -1
                continue
            }
            if atBottom, height == lastHeight {
                // The newest rows alone do not fill the window: a short
                // column sits at the top and would drop to the bottom once
                // the rest mounted, so the rest mounts before anything shows.
                if model.slimFirstPaint, scrollProbe.seen, height <= scrollProbe.viewport + 1 {
                    model.finishFirstPaint()
                    lastHeight = -1
                    continue
                }
                reason = scrollProbe.seen ? "settled" : "no_geometry"
                break
            }
            if scrollProbe.seen, !atBottom { scrollToBottom(proxy) }
            lastHeight = height
        }
        pinnedToBottom = true
        // `slowRestoreBotId` stays set through the landing, so a slow
        // chat's mascot fades out; the next landing clears it.
        landedBotId = botId
        PerfHarness.shared?.landed(botId: botId, reason: reason, stats: model.perfStats)
        guard model.slimFirstPaint else { return }
        // Two frames, so the landed frame is committed before the rest of the
        // window is built above it. Not tied to this task: a remount in those
        // frames must not leave the window slim for the rest of the visit.
        Task { @MainActor [model] in
            try? await Task.sleep(nanoseconds: 34_000_000)
            model.finishFirstPaint(for: botId)
        }
    }

    /// The newest turn, without animating the trip. Used where the bottom
    /// anchor is known to be the right place: the transcript's own mount.
    private func scrollToBottom(_ proxy: ScrollViewProxy) {
        var transaction = Transaction()
        transaction.disablesAnimations = true
        withTransaction(transaction) {
            proxy.scrollTo("bottom", anchor: .bottom)
        }
    }

    /// A run is still out by what its card shows (working or quiet), not by
    /// the parent's state alone: one nobody has heard from for hours is not.
    private func cardIsLive(_ card: SubagentCardData) -> Bool {
        model.liveCardIds.contains(card.id)
    }

    private func subagentCard(_ card: SubagentCardData, bot: ShellBot) -> some View {
        SubagentGroupCard(
            card: card,
            chat: model.subagentCards,
            bot: bot,
            parentBusy: model.pending || model.backgroundWorking,
            parked: !model.pendingRequests.isEmpty,
            idleSince: model.parentIdleSince,
            maxWidth: min(DesignTokens.Space.bubbleMax, columnWidth * 0.85),
            store: model.subagentProgress
        )
    }

    private func transcript(_ bot: ShellBot) -> some View {
        let roster = model.store?.bots ?? []
        // What the rows are handed. A row is skipped while its inputs compare
        // equal, and a bot's session pointer and last preview change every
        // time any bot says anything, which made every row in this chat
        // unequal, and rebuilt its markdown, for a reply in another one.
        let rowBot = bot.transcriptFace
        let rowRoster = roster.map(\.transcriptFace)
        let streaming = model.pending || model.backgroundWorking
        // Built once per transcript change in the model, not once per body.
        // This view re-evaluates on every keystroke in the composer, and
        // regrouping several hundred rows there is what made typing stutter.
        // Only the window is mounted: the newest blocks, always the whole
        // newest turn, and older ones as the reader asks for them. The stack
        // stays eager on purpose (see `AppModel.transcriptWindow`).
        let window = model.transcriptWindow
        // A bubble that follows a sub-agent card keeps the full gap: the card
        // broke its turn's stack, and the tight stacking would sit it 8 pt under.
        // A card sits under the block that draws its anchor row (a run of
        // pictures draws several), and goes to the tail when none in the
        // window does.
        let cardsByBlock: [String: [SubagentCardData]] = model.subagentCards.reduce(into: [:]) { found, card in
            guard let anchor = card.anchorRowId,
                  let block = window.blocks.first(where: { $0.holds(rowId: anchor) }) else { return }
            found[block.id, default: []].append(card)
        }
        // Only a card with no anchor, or whose anchor is nowhere in the chat,
        // goes to the tail. One whose block is merely above the mounted window
        // waits for "Show earlier" to mount it.
        // A settled card with no row to follow is not drawn: at the tail it
        // would sit under the newest message as if it were new.
        let tailCards = model.subagentCards.filter { card in
            if let anchor = card.anchorRowId, model.transcriptBlocks.contains(where: { $0.holds(rowId: anchor) }) {
                return false
            }
            return cardIsLive(card)
        }
        // A card covers the sub-agent work only when it sits under its own
        // reply and has a run still out. One parked at the tail does not, so
        // a real working row is never hidden by it.
        let hasActiveCard = cardsByBlock.values.flatMap { $0 }.contains { cardIsLive($0) }
        var afterCard = Set<String>()
        for (above, below) in zip(window.blocks, window.blocks.dropFirst()) where cardsByBlock[above.id] != nil {
            afterCard.insert(below.id)
        }
        return ScrollViewReader { proxy in
            ScrollView {
                    VStack(alignment: .leading, spacing: DesignTokens.Space.transcriptGap) {
                        if model.showOnboarding {
                            OnboardingCardView(
                                name: bot.name,
                                onFillForm: {
                                    model.dismissOnboarding(botId: bot.id)
                                    model.settingsOpen = true
                                },
                                onDismiss: { model.dismissOnboarding(botId: bot.id) }
                            )
                            // A host card on the bot side, under the bubble cap.
                            .frame(maxWidth: DesignTokens.Space.bubbleMax)
                        }
                        if window.hidden > 0 {
                            ShowEarlierRow { model.showEarlierMessages() }
                        }
                        ForEach(window.blocks) { block in
                          Group {
                            switch block {
                            case .dayDivider(_, let label):
                                DayDividerRow(label: label)
                            case .message(let row, _) where row.kind == .failure:
                                // Only the newest failed turn keeps a live
                                // Retry; older ones are the record.
                                let live = row.id == model.retryableFailureRowId
                                FailureRow(
                                    text: row.text,
                                    retryable: live,
                                    enabled: !model.pending,
                                    until: live ? model.failureRetryUntil : nil,
                                    maxWidth: min(DesignTokens.Space.bubbleMax, columnWidth * 0.85)
                                ) { model.retryLastTurn() }
                            case .message(let row, _) where row.kind == .unsent:
                                UnsentRow(
                                    text: row.text,
                                    retryEnabled: !model.pending,
                                    editEnabled: model.canEditUnsent,
                                    maxWidth: min(DesignTokens.Space.bubbleMax, columnWidth * 0.85),
                                    retry: { if let id = UnsentMessage.id(fromLineRowId: row.id) { model.retryUnsent(id) } },
                                    edit: { if let id = UnsentMessage.id(fromLineRowId: row.id) { model.editUnsent(id) } },
                                    dismiss: { if let id = UnsentMessage.id(fromLineRowId: row.id) { model.dismissUnsent(id) } }
                                )
                            case .message(let row, let recipients):
                                if row.id == model.continuationRowId {
                                    // The earlier session could not go on, so
                                    // this one opened with a brief of it.
                                    DayDividerRow(label: "Continued from an earlier session")
                                }
                                TranscriptRowView(
                                    row: row,
                                    bot: rowBot,
                                    bots: rowRoster,
                                    recipients: recipients,
                                    maxBubbleWidth: min(DesignTokens.Space.bubbleMax, columnWidth * 0.85),
                                    queued: model.queuedRowIds.contains(row.id),
                                    // The reply still being written parses
                                    // into one replaceable slot. Part of the
                                    // row's equality, so the turn finishing
                                    // moves its final text into the shared
                                    // cache even when no delta follows.
                                    streaming: streaming && model.latestReplyRunIds.contains(row.id)
                                )
                                .equatable()
                                // One turn can post several bubbles; they
                                // stack close so the turn still reads as one.
                                // Not the first mounted bubble: the one it
                                // would stack under is behind the row.
                                .padding(.top, model.continuationIds.contains(row.id) && row.id != window.startId
                                    && !afterCard.contains(row.id)
                                    ? DesignTokens.Space.bubbleStackGap - DesignTokens.Space.transcriptGap
                                    : 0)
                                // Only the newest reply measures itself, and
                                // only so the scroll can tell an answer that
                                // overflows the window from one that does not.
                                // A reply is every bubble of the turn, so the
                                // heights add up.
                                .background {
                                    if model.latestReplyRunIds.contains(row.id) {
                                        GeometryReader { geometry in
                                            Color.clear.preference(
                                                key: ReplyHeightKey.self,
                                                value: geometry.size.height
                                            )
                                        }
                                    }
                                }
                                // eve held this message behind a request and
                                // never replayed it.
                                if model.droppedRowIds.contains(row.id) {
                                    FailureRow(
                                        text: "\(bot.name) never got this message",
                                        retryable: !Attachments.namesEchoedFile(row.text) && !model.resentRowIds.contains(row.id),
                                        enabled: !model.pending,
                                        until: nil,
                                        maxWidth: min(DesignTokens.Space.bubbleMax, columnWidth * 0.85),
                                        buttonTitle: "Send again"
                                    ) { model.resendDropped(rowId: row.id, text: row.text) }
                                    .padding(.top, DesignTokens.Space.bubbleStackGap - DesignTokens.Space.transcriptGap)
                                }
                            case .images(let rows):
                                GeneratedImageRun(
                                    rows: rows,
                                    maxWidth: min(DesignTokens.Space.bubbleMax, columnWidth * 0.85)
                                )
                            case .summary(_, let count, let botIds):
                                BotMetaRow(
                                    prefix: "\(count) messages with",
                                    botIds: botIds,
                                    roster: roster
                                )
                            }
                            // The sub-agents a turn launched sit under its reply.
                            ForEach(cardsByBlock[block.id] ?? []) { card in
                                subagentCard(card, bot: bot)
                            }
                          }
                        }
                        // A card with no row to follow, or whose row is gone,
                        // goes at the tail where the working row would be.
                        ForEach(tailCards) { card in
                            subagentCard(card, bot: bot)
                        }
                        // Up for the whole turn, under whichever bubble is
                        // newest, so the owner can see the bot is still going
                        // after its first message. The slot keeps its height
                        // when the row leaves: the content is bottom-aligned,
                        // and a row that vanished pulled everything down by
                        // its height.
                        Group {
                            if model.pending || model.backgroundWorking, !(model.activity.isSubagent && hasActiveCard) {
                                WorkingRow(
                                    bot: bot,
                                    activity: model.activity,
                                    since: model.activitySince,
                                    toolkits: model.connectorApps,
                                    runningModel: model.runningModelNote(for: bot.id)
                                )
                            } else if let since = model.runningTaskSince, !hasActiveCard {
                                // The turn that started a sub-agent is over,
                                // and the sub-agent is still at it.
                                WorkingRow(bot: bot, activity: .subagent(finished: false), since: since, toolkits: [])
                            }
                        }
                        .frame(height: WorkingRow.height, alignment: .leading)
                        if !model.searchHits.isEmpty {
                            SearchChipsRow(chips: model.searchHits)
                        }
                        // Spacing only: the scroll target is the marker below,
                        // at the very bottom of the content.
                        Color.clear
                            .frame(height: 1)
                    }
                    // The transcript spans the pane, not a centered column:
                    // the owner's bubbles sit flush right and the bots' flush
                    // left, however wide the window, with `bubbleMax` keeping
                    // the far side empty.
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(
                        GeometryReader { proxy in
                            Color.clear.preference(key: ChatColumnWidthKey.self, value: proxy.size.width)
                        }
                    )
                    .onPreferenceChange(ChatColumnWidthKey.self) { width in
                        if width > 0, abs(width - columnWidth) > 1 { columnWidth = width }
                    }
                    .padding(.horizontal, DesignTokens.Space.chatColumnPadding)
                    .padding(.top, DesignTokens.Space.chatPaddingVertical)
                    // The working row's slot is most of the bottom margin.
                    .padding(.bottom, DesignTokens.Space.chatPaddingVertical - WorkingRow.height + Self.bottomFade)
                    // The floor below is a minimum, not the stack's height. A
                    // finite height here made the eager stack share it out
                    // between rows, and an earlier bubble's paragraph shrank
                    // to one truncated line once a later reply arrived.
                    .fixedSize(horizontal: false, vertical: true)
                    // A chat shorter than the window reads from the top, like
                    // a page. The bottom anchor below would otherwise sit a
                    // first message against the composer with the window
                    // empty above it. Once the chat outgrows the window this
                    // floor does nothing and the anchor takes over.
                    // The container height is already the area under the
                    // header's inset band (measured: visible 657 = container
                    // 595 + inset 62), so it is the floor as it stands.
                    .frame(maxWidth: .infinity, minHeight: max(0, viewportHeight), alignment: .top)
                    // The scroll target sits under the bottom padding. Inside
                    // the stack it sat 8 points above the end of the content,
                    // so every scroll to it stopped short, and the view slid
                    // the rest of the way the next time the bottom anchor
                    // re-applied.
                    .overlay(alignment: .bottom) {
                        Color.clear
                            .frame(height: 1)
                            .id("bottom")
                    }
                }
                .uvScroll()
                // Rows fade out over the last stretch above the composer
                // instead of being cut at a hard line, the way Claude's
                // transcript slides under its composer. The content's bottom
                // padding keeps a chat at rest clear of it.
                .mask {
                    VStack(spacing: 0) {
                        Color.black
                        LinearGradient(colors: [.black, .clear], startPoint: .top, endPoint: .bottom)
                            .frame(height: Self.bottomFade)
                    }
                }
                // The floating header's band is a safe-area inset: rows still
                // scroll under it, and a scroll to a row's top stops below it.
                .safeAreaInset(edge: .top, spacing: 0) {
                    Color.clear.frame(height: DesignTokens.Space.chatHead)
                }
                .modifier(TranscriptAnchor(pinned: pinnedToBottom))
                .modifier(ScrollPinnedTracker(
                    pinned: $pinnedToBottom,
                    viewport: $viewportHeight,
                    probe: scrollProbe,
                    onDrift: { repinAfterBannerChange(proxy) }
                ))
                // The transcript lands hidden under the mascot and is shown
                // only once it rests at its newest turn. Rows on screen before
                // the replay is in (the durable rows, a cached copy) are
                // replaced by it, and the swap left the view mid-history, so
                // the wait is for the replay, not a timer. Then the geometry
                // must read the true bottom, with the content height unchanged,
                // on three checks in a row. A chat opened earlier this session
                // lands on the rows it was left with instead: the replay
                // usually confirms them unchanged, and anything it adds is
                // re-pinned by the drift check. Late layout (fold heights, the
                // column width, drawings) settles hidden instead of on screen.
                // macOS 14 has no scroll geometry and keeps three scrolls
                // across the next layout passes. A send mounts it with nothing
                // to wait for. The cap only covers a stalled replay. Runs on
                // every mount, so each chat starts pinned and none inherits
                // the last one's scroll state.
                .task {
                    pinnedToBottom = true
                    holdingReplyAnchor = false
                    replyHeight = 0
                    // The probe outlives the remount; the last chat's
                    // geometry must not stand in for this one's.
                    scrollProbe.reset()
                    scrollToBottom(proxy)
                    // Shown from its first frame (see `sentIntoReadyChat`);
                    // this only records it, so the rows stay up once the turn
                    // ends and the condition no longer holds.
                    if sentIntoReadyChat {
                        landedBotId = bot.id
                        PerfHarness.shared?.landed(botId: bot.id, reason: "sent", stats: model.perfStats)
                        model.finishFirstPaint()
                        return
                    }
                    gatingBotId = bot.id
                    defer { if gatingBotId == bot.id { gatingBotId = nil } }
                    if #available(macOS 15.0, *), model.restoredFromCache {
                        await landRestored(proxy, botId: bot.id)
                        return
                    }
                    let deadline = Date().addingTimeInterval(Self.landingCap)
                    var steady = 0
                    var lastHeight: CGFloat = -1
                    var lastDistance: CGFloat = -1
                    var nudged = false
                    while steady < 3, Date() < deadline {
                        try? await Task.sleep(nanoseconds: 50_000_000)
                        guard !Task.isCancelled else { return }
                        // A send counts only when it was made in this visit.
                        // One still running from before the chat was left
                        // sits on rows whose history may not be in yet.
                        guard model.transcriptReady || (model.pending && model.sentSinceOpen)
                                || (model.restoredFromCache && !model.restoredFromSnapshot) else {
                            scrollToBottom(proxy)
                            continue
                        }
                        if #available(macOS 15.0, *) {
                            // A chat that fits the window has nothing to
                            // settle, and one whose geometry never reported
                            // has nothing to check. A reply still streaming
                            // changes height on every publish; the drift check
                            // keeps it pinned, so being at the bottom is enough.
                            let height = scrollProbe.contentHeight
                            let atBottom = !scrollProbe.seen
                                || scrollProbe.distance <= 1
                                || height <= scrollProbe.viewport + 1
                            if atBottom, height == lastHeight || model.pending || model.backgroundWorking {
                                steady += 1
                            } else {
                                steady = 0
                                // On a replayed long chat the scroll to the
                                // bottom marker sometimes moves nothing, check
                                // after check, and the chat landed by the cap
                                // thousands of points up its history. A scroll
                                // to the newest block does move it, and the
                                // marker is reached from there. While it stays
                                // stuck, checks alternate between the nudge and
                                // the marker scroll until it moves or the cap
                                // ends the landing.
                                if abs(height - lastHeight) <= 0.5,
                                   abs(scrollProbe.distance - lastDistance) <= 0.5, !nudged,
                                   let last = model.transcriptWindow.blocks.last?.id {
                                    nudged = true
                                    var transaction = Transaction()
                                    transaction.disablesAnimations = true
                                    withTransaction(transaction) { proxy.scrollTo(last, anchor: .bottom) }
                                } else {
                                    nudged = false
                                    scrollToBottom(proxy)
                                }
                            }
                            lastHeight = height
                            lastDistance = scrollProbe.distance
                        } else {
                            steady += 1
                            scrollToBottom(proxy)
                        }
                    }
                    // Hidden, the reader cannot have scrolled: it is pinned.
                    pinnedToBottom = true
                    landedBotId = bot.id
                    if let perf = PerfHarness.shared {
                        var reason = steady >= 3 ? "settled" : "cap"
                        if #available(macOS 15.0, *) {
                            if steady >= 3, !scrollProbe.seen { reason = "no_geometry" }
                        } else if steady >= 3 {
                            reason = "unmeasured"
                        }
                        perf.landed(botId: bot.id, reason: reason, stats: model.perfStats)
                    }
                    model.finishFirstPaint()
                }
                // A replay slower than the cap finishes after the rows were
                // shown; a reader still at the newest turn is kept there.
                .onChange(of: model.transcriptReady) { _, ready in
                    if ready, landedBotId == bot.id { repinAfterBannerChange(proxy) }
                }
                .onPreferenceChange(ReplyHeightKey.self) { replyHeight = $0 }
                // `defaultScrollAnchor(.bottom)` holds the bottom as the content
                // grows: opening a chat, switching bots, streaming and the
                // durable reload keep their place without being told to.
                // Explicit bottom scrolls are kept to the few places that need
                // one (the send below, the banner and landing re-pins), because
                // scrolling to a bottom anchor repositions content that is
                // shorter than the window and SwiftUI had already placed.
                // An explicit send is a request to watch the answer (see
                // `AppModel.send`): the transcript goes to the newest turn
                // whatever the reader was doing. The send's own frame (the
                // composer shrinking, a banner leaving, the row landing) is
                // the app's doing, not the reader scrolling.
                .onChange(of: model.sendTick) {
                    holdingReplyAnchor = false
                    pinnedToBottom = true
                    // Covers the send's own frames and no more. The default
                    // window, marked twice, ignored the reader's wheel for a
                    // third of a second after Return, and the drift check then
                    // pulled a reader who had scrolled up back down.
                    scrollProbe.markAppScroll(for: Self.sendScrollWindow)
                    scrollToBottom(proxy)
                    // Once more after this layout pass, when the new row and
                    // the shorter composer have their final heights.
                    DispatchQueue.main.async {
                        guard pinnedToBottom else { return }
                        scrollProbe.markAppScroll(for: Self.sendScrollWindow)
                        scrollToBottom(proxy)
                    }
                }
                .onChange(of: pinnedToBottom) { holdingReplyAnchor = false }
                .onChange(of: holdingReplyAnchor) { _, holding in scrollProbe.holding = holding }
                // The reader asked for earlier messages. Those mount above
                // the row they were reading, and the scroll offset stays
                // where it was, which would now be the top of the new rows;
                // the row they had is put back at the top instead. Theirs
                // to ask for, so it is not the transcript moving on its own.
                .onChange(of: model.transcriptWindow.hidden) { before, after in
                    guard after < before, let held = model.takeWindowExpandedFrom() else { return }
                    // Reading history now: the growth above must not re-pin.
                    pinnedToBottom = false
                    scrollWithoutAnimation(proxy, to: held)
                }
                // The single exception: an answer taller than the window is
                // read from its first line, so the view moves there once, when
                // the turn finishes. A reply that already fits is left alone.
                .onChange(of: model.pending) { wasPending, nowPending in
                    guard wasPending, !nowPending, landedBotId == bot.id, pinnedToBottom,
                          !scrollProbe.dragging,
                          // The viewport is already the area under the header.
                          replyHeight > viewportHeight - Self.replyAnchorSlack,
                          let anchor = model.latestReplyAnchor else { return }
                    holdingReplyAnchor = true
                    scrollWithoutAnimation(proxy, to: anchor)
                    // The durable reload lands moments later and changes the
                    // list, so the anchor is re-applied once it has settled.
                    Task { @MainActor in
                        try? await Task.sleep(nanoseconds: 250_000_000)
                        guard holdingReplyAnchor else { return }
                        scrollWithoutAnimation(proxy, to: anchor)
                    }
                }
        }
    }

    // MARK: - Empty state

    /// The brand wave while the first transcript load is in flight. The empty
    /// copy is only for a chat known to be empty; before then the mascot marks
    /// the wait so a cold open never reads as a blank pane.
    private var loadingState: some View {
        ZStack {
            LoadingRing(size: 84)
            BrandMotionView(size: 56)
        }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .transition(.opacity)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Loading chat")
    }

    @ViewBuilder
    private func emptyState(_ bot: ShellBot) -> some View {
        // Not under the no-model bar: a tap would fill a composer that can't send.
        if bot.id == starterBotId, !bot.isGroup, !firstMessageSent,
           !(model.noModelConnected || noModelPreview) {
            starters(bot)
        } else if model.noModelConnected || noModelPreview, !bot.isGroup {
            connectFirst(bot)
        } else {
            plainEmptyState(bot)
        }
    }

    /// The first chat's empty state: six things a local Mac agent does that
    /// people may not expect, two of them making more bots. A tap fills the
    /// composer with the full prompt and sends nothing; the tiles step back
    /// while the composer holds text.
    private func starters(_ bot: ShellBot) -> some View {
        let typing = !model.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        return VStack(alignment: .leading, spacing: 20) {
            VStack(alignment: .leading, spacing: 6) {
                Text("What should we do first?")
                    .font(.system(size: 22, weight: .semibold))
                    .tracking(DesignTokens.Tracking.heading * 22)
                    .foregroundStyle(Theme.C.ink)
                Text("\(bot.name) can research, write, work with files and set up new bots for you.")
                    .font(.system(size: 14))
                    .foregroundStyle(Theme.C.inkMuted)
            }
            LazyVGrid(columns: [GridItem(.flexible(), spacing: 10), GridItem(.flexible(), spacing: 10)], spacing: 10) {
                ForEach(StarterPrompt.all) { prompt in
                    StarterPromptButton(text: prompt.label) { model.fillDraft(prompt.prompt) }
                }
            }
            // Faded, not removed, so the heading above doesn't move.
            .opacity(typing ? 0 : 1)
            .allowsHitTesting(!typing)
            .accessibilityHidden(typing)
            .animation(Theme.ease(0.2), value: typing)
        }
        .frame(maxWidth: DesignTokens.Space.bubbleMax)
        .padding(.horizontal, DesignTokens.Space.chatColumnPadding)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    /// A chat with nothing to answer it yet: one thing to do, and what the bot
    /// can do once it can. The tiles are a preview, not buttons: a tap would
    /// fill a composer that can't send.
    private func connectFirst(_ bot: ShellBot) -> some View {
        VStack(spacing: 28) {
            VStack(spacing: 10) {
                BotFaceView(color: BrandAssets.colorID(for: bot), size: 64)
                    .frame(width: 64, height: 64)
                    .padding(.bottom, 6)
                    .accessibilityHidden(true)
                Text("Connect a model to start")
                    .font(.system(size: DesignTokens.FontSize.emptyTitle, weight: .semibold))
                    .tracking(DesignTokens.Tracking.tight * DesignTokens.FontSize.emptyTitle)
                    .foregroundStyle(Theme.C.ink)
                Text("Use a subscription you already pay for, or an API key.")
                    .font(.system(size: DesignTokens.FontSize.emptyBody))
                    .foregroundStyle(Theme.C.inkMuted)
                    .multilineTextAlignment(.center)
                NativeButton("Connect a provider", kind: .primary) {
                    if let connectModel { connectModel.reopen() } else { model.openAppSettings(.providers) }
                }
                .padding(.top, 6)
                .accessibilityIdentifier("no-model-connect")
            }
            if bot.id == starterBotId {
                VStack(alignment: .leading, spacing: 10) {
                    Text("Then try")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(Theme.C.inkFaint)
                    LazyVGrid(columns: [GridItem(.flexible(), spacing: 10), GridItem(.flexible(), spacing: 10)], spacing: 10) {
                        ForEach(StarterPrompt.all) { prompt in
                            StarterPromptButton(text: prompt.label) {}
                        }
                    }
                    .allowsHitTesting(false)
                    .opacity(0.6)
                }
            }
        }
        .frame(maxWidth: DesignTokens.Space.bubbleMax)
        .padding(.horizontal, DesignTokens.Space.chatColumnPadding)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func plainEmptyState(_ bot: ShellBot) -> some View {
        VStack(spacing: 8) {
            if !bot.isGroup {
                BotFaceView(color: BrandAssets.colorID(for: bot), size: 64)
                    .frame(width: 64, height: 64)
                    .padding(.bottom, 8)
                    .accessibilityHidden(true)
            }
            Text("What can I do for you?")
                .font(.system(size: DesignTokens.FontSize.emptyTitle, weight: .semibold))
                .tracking(DesignTokens.Tracking.tight * DesignTokens.FontSize.emptyTitle)
                .foregroundStyle(Theme.C.ink)
            if bot.isGroup {
                Text(groupCopy(bot))
                    .font(.system(size: DesignTokens.FontSize.emptyBody))
                    .lineSpacing(6)
                    .foregroundStyle(Theme.C.inkMuted)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 448)
            } else {
                everydayPrompts
                    .padding(.top, 20)
            }
        }
        .padding(.horizontal, 16)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    /// Four everyday things to start from. A tap fills the composer and sends
    /// nothing; like the first chat's starters, the tiles step back while the
    /// composer holds text.
    private var everydayPrompts: some View {
        let typing = !model.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        return LazyVGrid(columns: [GridItem(.flexible(), spacing: 10), GridItem(.flexible(), spacing: 10)], spacing: 10) {
            ForEach(StarterPrompt.everyday) { prompt in
                StarterPromptButton(text: prompt.label) { model.fillDraft(prompt.prompt) }
            }
        }
        .frame(maxWidth: 560)
        .opacity(typing ? 0 : 1)
        .allowsHitTesting(!typing)
        .accessibilityHidden(typing)
        .animation(Theme.ease(0.2), value: typing)
    }

    private func groupCopy(_ bot: ShellBot) -> String {
        let names = members(bot).map(\.name)
        return "Group chat with \(names.isEmpty ? "no members yet" : names.joined(separator: ", ")). Untargeted messages go to the orchestrator; @name directs one bot."
    }

    // MARK: - Composer column

    private func composerColumn(_ bot: ShellBot) -> some View {
        let noModel = model.noModelConnected || noModelPreview
        return VStack(alignment: .leading, spacing: 0) {
            // A model, effort or speed pick that did not store. Muted rather
            // than danger: the chip reverted, nothing arrived broken.
            if let error = model.composerError {
                Text(error)
                    .font(.system(size: DesignTokens.FontSize.attachError))
                    .foregroundStyle(Theme.C.inkMuted)
                    .padding(.horizontal, 2)
                    .padding(.bottom, 8)
            }
            // Setup was skipped, or every provider was removed: nothing to
            // chat with until one is connected.
            // Not over an empty chat: its middle already asks for the same.
            if noModel, model.hasThreadContent || model.pending || bot.isGroup {
                HStack(spacing: 12) {
                    Text("Connect a model to start chatting.")
                        .font(.system(size: 14))
                        .foregroundStyle(Theme.C.ink)
                    Spacer(minLength: 0)
                    NativeButton("Connect", kind: .primary, small: true) {
                        if let connectModel { connectModel.reopen() } else { model.openAppSettings(.providers) }
                    }
                    .accessibilityIdentifier("no-model-connect")
                }
                .padding(.leading, 14)
                .padding(.trailing, 8)
                .padding(.vertical, 8)
                .background(Theme.C.sunken, in: RoundedRectangle(cornerRadius: DesignTokens.Radius.md, style: .continuous))
                .padding(.top, DesignTokens.Space.composerTop)
                .transition(.opacity)
            }
            ComposerView(
                bot: bot,
                onOpenProviders: { model.openAppSettings(.providers) }
            )
            .allowsHitTesting(!noModel)
            .opacity(noModel ? 0.55 : 1)
            .accessibilityHidden(noModel)
        }
        .frame(maxWidth: DesignTokens.Space.chatColumnMax)
        .padding(.horizontal, DesignTokens.Space.chatColumnPadding)
        .frame(maxWidth: .infinity)
        .offset(y: composerRisen || reduceMotion ? 0 : 28)
        .opacity(composerRisen ? 1 : 0)
    }
}

/// A failed turn, where its reply would have been: a small caution glyph and
/// the reason in secondary text, with Retry on the newest one. Quiet on
/// purpose: the chat goes on, and a red slab over it read as the app broken.
private struct FailureRow: View {
    let text: String
    let retryable: Bool
    let enabled: Bool
    /// A router cool-down's end: the row counts down to it and holds Retry.
    let until: Date?
    let maxWidth: CGFloat
    var buttonTitle = "Retry"
    let retry: () -> Void

    /// A row without the button says what happened, not to press Retry.
    private var shown: String {
        guard !retryable else { return text }
        let kept = text.components(separatedBy: ". ").filter { !$0.contains("Retry") }
        guard !kept.isEmpty else { return text }
        let joined = kept.joined(separator: ". ")
        return joined.hasSuffix(".") ? joined : joined + "."
    }

    var body: some View {
        if let until, until > Date() {
            TimelineView(.periodic(from: .now, by: 1)) { context in
                let left = Int(until.timeIntervalSince(context.date).rounded(.up))
                if left > 0 {
                    row(
                        "The model provider failed repeatedly, so sending is paused for \(left) more \(left == 1 ? "second" : "seconds").",
                        canRetry: false
                    )
                } else {
                    row(shown, canRetry: enabled)
                }
            }
        } else {
            row(shown, canRetry: enabled)
        }
    }

    private func row(_ copy: String, canRetry: Bool) -> some View {
        // Centered with the other event lines: it says what happened to the
        // turn, it is not the bot speaking.
        HStack(spacing: 0) {
            Spacer(minLength: 0)
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Image(systemName: "exclamationmark.triangle")
                    .font(.system(size: 12, weight: .regular))
                    .foregroundStyle(Theme.C.inkMuted)
                    .accessibilityHidden(true)
                Text(copy)
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.C.inkMuted)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
                if retryable {
                    NativeButton(buttonTitle, kind: .secondary, small: true, enabled: canRetry, action: retry)
                        .accessibilityIdentifier("failure-retry")
                }
            }
            .frame(maxWidth: max(160, maxWidth))
            Spacer(minLength: 0)
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("failure-row")
    }
}

/// The line under an owner message the server refused before the bot got it:
/// what happened, then Retry and Edit. Right-aligned under the bubble it
/// belongs to. Edit waits for an empty composer, since the text would
/// otherwise stack on whatever is there.
private struct UnsentRow: View {
    let text: String
    let retryEnabled: Bool
    let editEnabled: Bool
    let maxWidth: CGFloat
    let retry: () -> Void
    let edit: () -> Void
    let dismiss: () -> Void

    var body: some View {
        HStack(spacing: 0) {
            Spacer(minLength: 0)
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Image(systemName: "exclamationmark.triangle")
                    .font(.system(size: 12, weight: .regular))
                    .foregroundStyle(Theme.C.inkMuted)
                    .accessibilityHidden(true)
                Text(text)
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.C.inkMuted)
                    .multilineTextAlignment(.trailing)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
                NativeButton("Retry", kind: .secondary, small: true, enabled: retryEnabled, action: retry)
                    .accessibilityIdentifier("unsent-retry")
                NativeButton("Edit", kind: .secondary, small: true, enabled: editEnabled, action: edit)
                    .help(editEnabled ? "" : UnsentMessage.editBlockedHint)
                    .accessibilityLabel(editEnabled ? "Edit" : UnsentMessage.editBlockedHint)
                    .accessibilityIdentifier("unsent-edit")
                Button(action: dismiss) {
                    Image(systemName: "xmark")
                        .font(.system(size: 11, weight: .regular))
                        .foregroundStyle(Theme.C.inkMuted)
                        .frame(width: 24, height: 24)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help("Dismiss")
                .accessibilityLabel("Dismiss")
                .accessibilityIdentifier("unsent-dismiss")
            }
            .frame(maxWidth: max(160, maxWidth), alignment: .trailing)
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("unsent-row")
    }
}

/// One line over the composer for a failure no turn can hold: a send that
/// never reached the server, a load that failed, a write that was refused.
private struct ComposerNote: View {
    let text: String
    /// Reads the chat again, the way the banner's Retry did for a failure
    /// it could not resend.
    var reload: (() -> Void)?
    let dismiss: () -> Void

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "exclamationmark.triangle")
                .font(.system(size: 11, weight: .regular))
                .foregroundStyle(Theme.C.inkMuted)
                .accessibilityHidden(true)
            Text(text)
                .font(.system(size: 13))
                .foregroundStyle(Theme.C.ink)
                .lineLimit(1)
                .truncationMode(.tail)
                .help(text)
            Spacer(minLength: 0)
            if let reload {
                // Plain text, not a button slab: the note stays one quiet line.
                Button(action: reload) {
                    Text("Reload")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(Theme.C.ink)
                        .padding(.horizontal, 6)
                        .frame(minHeight: 28)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .pointerOnHover()
                .accessibilityIdentifier("composer-note-reload")
            }
            Button(action: dismiss) {
                Image(systemName: "xmark")
                    .font(.system(size: 9, weight: .medium))
                    .foregroundStyle(Theme.C.inkMuted)
                    .frame(width: 20, height: 20)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .pointerOnHover()
            .accessibilityLabel("Dismiss")
        }
        .padding(.leading, 12)
        .padding(.trailing, 6)
        .frame(minHeight: 32)
        .background(Theme.C.surface)
        .overlay(
            RoundedRectangle(cornerRadius: DesignTokens.Radius.field, style: .continuous)
                .strokeBorder(Theme.C.edge, lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: DesignTokens.Radius.field, style: .continuous))
        .popShadow()
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("composer-note")
    }
}

private struct ChatColumnWidthKey: PreferenceKey {
    static var defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = max(value, nextValue())
    }
}

/// A spinner arc circling the mascot while a chat loads, so the wait reads
/// as work in progress. Held still when the owner asks for reduced motion.
private struct LoadingRing: View {
    let size: CGFloat
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var spinning = false

    var body: some View {
        ZStack {
            Circle()
                .stroke(Theme.C.edge, lineWidth: 2)
            Circle()
                .trim(from: 0, to: 0.28)
                .stroke(Theme.C.inkMuted, style: StrokeStyle(lineWidth: 2, lineCap: .round))
                .rotationEffect(.degrees(spinning ? 360 : 0))
                .animation(
                    reduceMotion ? nil : .linear(duration: 0.9).repeatForever(autoreverses: false),
                    value: spinning
                )
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
        .onAppear { spinning = true }
    }
}

/// The centered date rule from the Grok Bot reference: "Today 5:10 PM".
/// The row above a windowed transcript. Mounts the next stretch of history;
/// `defaultScrollAnchor(.bottom)` keeps what was on screen in place while
/// the rows above it appear.
private struct ShowEarlierRow: View {
    let action: () -> Void

    var body: some View {
        HStack(spacing: 0) {
            Spacer(minLength: 0)
            Button(action: action) {
                Text("Show earlier messages")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(Theme.C.inkMuted)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 6)
                    .background(Theme.C.bubbleBot)
                    .clipShape(Capsule())
                    .overlay(Capsule().strokeBorder(Theme.C.edge, lineWidth: 1))
            }
            .buttonStyle(.plain)
            .pointerOnHover()
            Spacer(minLength: 0)
        }
        .padding(.vertical, 4)
    }
}

private struct DayDividerRow: View {
    let label: String

    var body: some View {
        HStack(spacing: 0) {
            Spacer(minLength: 0)
            Text(label)
                .font(.system(size: 11))
                .monospacedDigit()
                .foregroundStyle(Theme.C.inkFaint)
            Spacer(minLength: 0)
        }
        .padding(.vertical, 4)
    }
}

/// The centered cross-bot strip: "Messaged Growth", "Message from CEO",
/// "2 messages with 2 Bots". Centered over a bubble too, the way Grok sets
/// every event line apart from what was said. Avatars come from the live roster; a deleted bot
/// falls back to a plain count.
private struct BotMetaRow: View {
    let prefix: String
    let botIds: [String]
    var names: [String] = []
    let roster: [ShellBot]

    private var bots: [ShellBot] {
        botIds.compactMap { id in roster.first { $0.id == id } }
    }

    private var label: String {
        ChatAttribution.metaLabel(idCount: botIds.count, resolved: bots.map(\.name), names: names)
    }

    var body: some View {
        HStack(spacing: 0) {
            Spacer(minLength: 0)
            HStack(spacing: 6) {
                Text(prefix)
                if !bots.isEmpty {
                    AvatarStackView(bots: bots, size: 16, maxVisible: 2)
                }
                Text(label)
            }
            .font(.system(size: 11))
            .foregroundStyle(Theme.C.inkMuted)
            Spacer(minLength: 0)
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }
}

private extension ShellBot {
    /// This bot without the fields that move on every turn and that no
    /// transcript row draws: a row shows a name and a face, never a preview.
    var transcriptFace: ShellBot {
        var face = self
        face.sessionId = nil
        face.lastPreview = ""
        face.lastAt = nil
        return face
    }
}

/// What the owner said. A long message folds to its first rendered lines
/// with a Show more under it, the way Claude.ai and Slack fold one, so a
/// pasted document does not push the reply off the screen. Two hidden twins
/// of the text, one clipped to the preview and one not, measure how much a
/// fold would hide; the clip and the button both follow that one answer, so
/// a message never loses a line without a button to get it back, and Show
/// less stays once the bubble is open. The fold is the row's own state, and
/// a row that leaves the window comes back folded.
private struct UserBubbleView: View {
    let text: String
    /// The bot message this one replies to, shown as a quote line on top.
    var quote: String?
    @State private var expanded = false
    @State private var previewHeight: CGFloat = 0
    @State private var fullHeight: CGFloat = 0

    private var mayFold: Bool { LongMessage.mayFold(text) }
    /// Unmeasured counts as folded: the twins report a frame after the first
    /// pass, and a bubble that opened whole and then snapped shut flashed a
    /// document and jolted the scroll anchor.
    private var folds: Bool {
        guard mayFold else { return false }
        if fullHeight == 0 || previewHeight == 0 { return true }
        return LongMessage.hidesEnough(full: fullHeight, preview: previewHeight)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let quote {
                HStack(alignment: .top, spacing: 6) {
                    Image(systemName: "arrowshape.turn.up.left")
                        .font(.system(size: 10, weight: .medium))
                        .padding(.top, 3)
                    Text(ReplyQuote.preview(quote))
                        .font(.system(size: 13))
                        .lineLimit(2)
                        .truncationMode(.tail)
                }
                .foregroundStyle(Theme.C.inkMuted)
                .accessibilityElement(children: .combine)
                .accessibilityLabel("Replying to: \(quote)")
            }
            body(text)
                .lineLimit(folds && !expanded ? LongMessage.previewLines : nil)
                .background(alignment: .topLeading) {
                    if mayFold {
                        body(text)
                            .lineLimit(LongMessage.previewLines)
                            .hidden()
                            .background(heightReader($previewHeight))
                        body(text)
                            .fixedSize(horizontal: false, vertical: true)
                            .hidden()
                            .background(heightReader($fullHeight))
                    }
                }
            if folds {
                Button(expanded ? "Show less" : "Show more") {
                    expanded.toggle()
                }
                .buttonStyle(.plain)
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(Theme.C.inkMuted)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .background(Theme.C.sunken)
        .clipShape(
            UnevenRoundedRectangle(
                topLeadingRadius: DesignTokens.Radius.md,
                bottomLeadingRadius: DesignTokens.Radius.md,
                bottomTrailingRadius: DesignTokens.Radius.xs,
                topTrailingRadius: DesignTokens.Radius.md,
                style: .continuous
            )
        )
    }

    private func body(_ text: String) -> some View {
        Text(text)
            .font(.system(size: DesignTokens.FontSize.chatBody))
            .lineSpacing(7)
            .foregroundStyle(Theme.C.ink)
            .textSelection(.enabled)
    }

    private func heightReader(_ height: Binding<CGFloat>) -> some View {
        GeometryReader { proxy in
            Color.clear
                .onAppear { height.wrappedValue = proxy.size.height }
                .onChange(of: proxy.size.height) { _, next in height.wrappedValue = next }
        }
    }
}

/// One transcript row. What the owner said is a right-aligned bubble, and what
/// a bot said is a left-aligned white one, set apart by a border and a soft
/// shadow. Each
/// message a bot posts is its own bubble, so a turn reads as a run of them.
/// Equatable so a streamed publish only rebuilds the row whose text changed.
/// Nothing here reads the environment, so skipping the body is safe.
struct TranscriptRowView: View, Equatable {
    let row: TranscriptRow
    let bot: ShellBot
    var bots: [ShellBot] = []
    var recipients: [String] = []
    var maxBubbleWidth: CGFloat = 612
    /// eve is holding this owner message until a waiting card is answered.
    var queued = false
    /// The bubble of a turn still running: its markdown is parsed into a
    /// transient slot instead of the shared cache, one entry per delta.
    var streaming = false

    var body: some View {
        switch row.kind {
        case .user:
            userRow
        case .handoff:
            VStack(alignment: .leading, spacing: 8) {
                BotMetaRow(
                    prefix: "Messaged",
                    botIds: recipients.isEmpty ? row.targetBotIds : recipients,
                    names: ["a teammate"],
                    roster: bots
                )
                replyRow(showsSpeaker: false)
            }
        case .post:
            let author = row.author ?? ""
            VStack(alignment: .leading, spacing: 8) {
                // Always labelled: an unattributed post on the bot side would
                // read as the chat's own bot speaking.
                BotMetaRow(
                    prefix: "Message from",
                    botIds: row.authorBotId.map { [$0] } ?? [],
                    // A deleted bot that stored no name still reads as a
                    // teammate rather than as "1 Bot".
                    names: [author.isEmpty ? "a teammate" : author],
                    roster: bots
                )
                // Whatever a teammate posts, a question to this bot or an
                // answer, is a bot speaking: it sits on the left in the bot
                // bubble, under the "Message from" line that names it. Only
                // the owner's words go on the right.
                replyRow(showsSpeaker: false)
            }
        case .note where row.connectedName != nil:
            connectedCard(name: row.connectedName ?? "")
        case .note:
            // An event, not something said: one centered line with the
            // face of whoever did it, like the cross-bot strips.
            HStack(spacing: 0) {
                Spacer(minLength: 0)
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    noteAvatar
                        .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + 4 }
                    // The chat's own bot needs only its face; a teammate's
                    // note says whose it is.
                    if let name = noteAuthorName {
                        Text(name).fontWeight(.semibold)
                    }
                    Text(row.text)
                        .multilineTextAlignment(.center)
                }
                .font(.system(size: 11))
                .foregroundStyle(Theme.C.inkMuted)
                .frame(maxWidth: max(160, maxBubbleWidth))
                .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
            }
            .padding(.vertical, 2)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel([noteAuthorName, row.text].compactMap { $0 }.joined(separator: ": "))
        case .assistant:
            replyRow(showsSpeaker: true)
        case .widget:
            // A host card on the bot side, under the same width cap as every
            // bubble.
            HStack(spacing: 0) {
                WidgetSlot(widgetId: row.text)
                    .clipShape(RoundedRectangle(cornerRadius: DesignTokens.Radius.md, style: .continuous))
                    .cardLift(cornerRadius: DesignTokens.Radius.md)
                    .frame(maxWidth: max(160, maxBubbleWidth))
                Spacer(minLength: 0)
            }
        case .image:
            // The event's text is the prompt; the id names the stored bytes.
            GeneratedImageRow(imageId: row.imageId ?? "", prompt: row.text)
        case .page:
            // The row's text is the page title; the id names the Library item.
            PageRow(mediaId: row.imageId ?? "", title: row.text)
        case .failure, .unsent:
            // Drawn by the transcript itself, which owns its Retry.
            EmptyView()
        }
    }

    private var userRow: some View {
        // Pictures the owner sent sit above their words, a size up from the
        // composer's preview; the lines that name them are not shown.
        let sent = Attachments.sentImages(in: row.text)
        return VStack(alignment: .trailing, spacing: 6) {
            if !sent.images.isEmpty {
                HStack(spacing: 0) {
                    Spacer(minLength: 60)
                    WrapHStack(spacing: 6) {
                        ForEach(sent.images, id: \.self) { name in
                            SentImageView(name: name, botId: bot.id, side: sent.images.count == 1 ? 240 : 120, keepsShape: sent.images.count == 1)
                        }
                    }
                    .frame(maxWidth: max(160, maxBubbleWidth), alignment: .trailing)
                    .fixedSize(horizontal: true, vertical: false)
                }
            }
            if !sent.text.isEmpty {
                HStack(spacing: 0) {
                    Spacer(minLength: 60)
                    if let reply = ReplyQuote.split(sent.text) {
                        UserBubbleView(text: reply.body, quote: reply.quote)
                            .frame(maxWidth: max(160, maxBubbleWidth), alignment: .trailing)
                    } else {
                        UserBubbleView(text: sent.text)
                            .frame(maxWidth: max(160, maxBubbleWidth), alignment: .trailing)
                    }
                }
            }
            if queued { QueuedTag() }
        }
    }

    /// One message from a bot, in its own bubble. The avatar gutter shows only
    /// in a room where more than one bot can answer.
    private func replyRow(showsSpeaker: Bool) -> some View {
        let attributed = showsSpeaker && row.authorBotId != nil && row.authorBotId != bot.id
        let showsAvatar = attributed && speaker != nil
        return HStack(alignment: .top, spacing: 10) {
            if showsAvatar, let speaker {
                BotAvatarView(bot: speaker, size: 24)
            }
            VStack(alignment: .leading, spacing: 4) {
                if attributed, let speakerLabel {
                    Text(speakerLabel)
                        .font(.system(size: DesignTokens.FontSize.chatMeta, weight: .semibold))
                        .tracking(DesignTokens.Tracking.label * DesignTokens.FontSize.chatMeta)
                        .foregroundStyle(Theme.C.inkFaint)
                }
                MessageHoverActions(text: row.text, botId: bot.id, author: row.authorBotId != nil && row.authorBotId != bot.id ? (speaker?.name ?? row.author) : nil, enabled: !streaming) {
                    ChatMarkdownView(text: row.text, expandsWidth: false, streamingKey: streaming ? row.id : nil)
                        .padding(.horizontal, 16)
                        .padding(.vertical, 10)
                        .background(Theme.C.bubbleBot)
                        .clipShape(RoundedRectangle(cornerRadius: DesignTokens.Radius.md, style: .continuous))
                        .cardLift(cornerRadius: DesignTokens.Radius.md)
                }
                // The cap holds the bubble plus its actions, so the actions sit
                // right beside a short bubble instead of at the cap's far edge.
                // One cap for every bubble, code and tables included: a wide
                // block scrolls or wraps inside it rather than going full
                // column.
                .frame(maxWidth: max(160, maxBubbleWidth) + MessageHoverActionsWidth.value, alignment: .leading)
            }
            Spacer(minLength: 0)
        }
    }

    /// The host's word that an app was added, written by the app and not by
    /// the bot: a bubble with the logo, the name and the outcome.
    private func connectedCard(name: String) -> some View {
        HStack(spacing: 0) {
            HStack(alignment: .center, spacing: 12) {
                AppLogo(name: name, url: row.connectedLogo)
                Text(name)
                    .font(Theme.font(DesignTokens.FontSize.chatBody, .semibold))
                    .foregroundStyle(Theme.C.ink)
                    .lineLimit(1)
                Spacer(minLength: 24)
                HStack(spacing: 6) {
                    Image(systemName: "checkmark")
                        .font(.system(size: 11, weight: .semibold))
                    Text("Added")
                        .font(.system(size: 12, weight: .medium))
                }
                .foregroundStyle(Theme.C.success)
                .padding(.horizontal, 10)
                .padding(.vertical, 5)
                .background(Theme.C.successSoft)
                .clipShape(Capsule())
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .frame(maxWidth: 420)
            .background(Theme.C.bubbleBot)
            .clipShape(RoundedRectangle(cornerRadius: DesignTokens.Radius.md, style: .continuous))
            .cardLift(cornerRadius: DesignTokens.Radius.md)
            Spacer(minLength: 0)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(name) added")
    }

    /// A note's face: the speaker's, the chat owner's for its own note, and
    /// none at all when the author id names a bot the roster no longer has.
    @ViewBuilder
    private var noteAvatar: some View {
        switch ChatAttribution.face(
            authorBotId: row.authorBotId,
            ownerBotId: bot.id,
            speakerResolved: speaker != nil
        ) {
        case .speaker:
            if let speaker { BotAvatarView(bot: speaker, size: 16) }
        case .owner:
            BotAvatarView(bot: bot, size: 16)
        case .unknown:
            // Centered, a missing face just leaves the line shorter.
            EmptyView()
        }
    }

    /// The bot that spoke, when the row is attributed and it is not the chat
    /// owner itself.
    private var speaker: ShellBot? {
        guard let id = row.authorBotId, id != bot.id else { return nil }
        return bots.first { $0.id == id }
    }

    /// A note's author when it is not the chat's own bot.
    private var noteAuthorName: String? {
        // A note with only a stored name still says whose it is, unless the
        // name is the chat's own bot.
        guard row.authorBotId != bot.id else { return nil }
        let name = speaker?.name ?? row.author ?? ""
        if row.authorBotId == nil, name == bot.name { return nil }
        return name.isEmpty ? nil : name
    }

    private var speakerLabel: String? {
        guard speaker != nil || (row.authorBotId != nil && row.authorBotId != bot.id) else { return nil }
        return ChatAttribution.label(speakerName: speaker?.name, author: row.author)
    }
}

private struct WorkingRow: View {
    let bot: ShellBot
    let activity: TurnActivity
    /// When this step began. The row counts up from it, a second at a time.
    let since: Date
    /// The connected apps, for the logo and name of a connector step.
    let toolkits: [ConnectorToolkit]
    /// The model this turn is still on when the owner has picked another
    /// since it started. Nil when they match.
    var runningModel: String?

    /// The avatar's box, which is also the slot the transcript reserves.
    static let height: CGFloat = 24

    /// A connected app's step: its logo leads the label, the way Claude
    /// shows "Searching Gmail email threads" behind the Gmail mark.
    private var connector: (logo: String, name: String, label: String)? {
        guard case .tool("connector_execute", let detail?) = activity else { return nil }
        let step = TurnActivity.connectorStep(detail, toolkits: toolkits.map { ($0.slug, $0.name) })
        let slug = step.toolkit ?? String(detail.lowercased().prefix { $0 != "_" })
        let logo = toolkits.first { $0.slug == slug }?.logo ?? "https://logos.composio.dev/api/\(slug)"
        return (logo, slug, step.label)
    }

    var body: some View {
        let connector = connector
        let step = connector?.label ?? activity.label
        let label = runningModel.map { "\(step) · \($0)" } ?? step
        // Sits where the reply will, so the text does not jump sideways
        // when the first token lands.
        HStack(alignment: .center, spacing: 10) {
            // The face is drawn a shade larger than a reply avatar, but its
            // box is not, so the label keeps the reply's left edge. Its eyes
            // say what the bot is doing; the label holds still.
            BotFaceView(color: BrandAssets.colorID(for: bot), size: 28, pose: BotFacePose(activity: activity))
                .frame(width: Self.height, height: Self.height)
            HStack(spacing: 8) {
                if let connector {
                    AppLogo(name: connector.name, url: connector.logo, size: 16)
                        .transition(.opacity)
                }
                // Swapped in one frame, the way Claude's step line does: a
                // crossfade between labels of different widths ran the old
                // one over the timer beside it.
                Text(label)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .font(.system(size: DesignTokens.FontSize.chatBody))
                    .foregroundStyle(Theme.C.inkMuted)
                // One text view redrawn once a second, not a clock ticking
                // through the transcript.
                TimelineView(.periodic(from: since, by: 1)) { context in
                    Text(Self.elapsed(from: since, to: context.date))
                        .font(.system(size: DesignTokens.FontSize.chatBody).monospacedDigit())
                        .foregroundStyle(Theme.C.inkFaint)
                }
                .layoutPriority(1)
            }
            .animation(.easeInOut(duration: DesignTokens.Motion.fast), value: connector?.logo)
            // The logo's own fade only. The first reply pushes
            // the row down in the same update that turns "Thinking"
            // into "Writing", and without this the label slid down
            // from under the new bubble while its face jumped.
            .geometryGroup()
            Spacer(minLength: 0)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(label)
    }

    /// "0s", "9s", "1m 5s": whole seconds, never negative.
    static func elapsed(from start: Date, to now: Date) -> String {
        let seconds = max(0, Int(now.timeIntervalSince(start)))
        return seconds < 60 ? "\(seconds)s" : "\(seconds / 60)m \(seconds % 60)s"
    }
}

/// `.search-chip` row: wrapped pills that open the result in the browser.
struct SearchChipsRow: View {
    let chips: [SearchChip]

    var body: some View {
        WrapHStack(spacing: 8) {
            // Two results can share a URL, so identity is by position.
            ForEach(Array(chips.enumerated()), id: \.offset) { _, chip in
                SearchChipView(chip: chip)
            }
        }
        .accessibilityElement(children: .contain)
    }
}

private struct SearchChipView: View {
    let chip: SearchChip

    @State private var hovering = false

    var body: some View {
        Button {
            open(chip.url)
        } label: {
            Text(chip.title)
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(Theme.C.ink)
                .lineLimit(1)
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
                .background(hovering ? Theme.C.sunken : Theme.C.surface)
                .overlay(Capsule().strokeBorder(Theme.C.borderStrong, lineWidth: 1))
                .clipShape(Capsule())
                .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .pointerOnHover()
        .onHover { hovering = $0 }
        .help(chip.snippet.isEmpty ? chip.url : chip.snippet)
    }

    /// Tool output must not be able to send the browser at the local server
    /// with its session cookie, so loopback and private hosts stay unopened.
    private func open(_ string: String) {
        guard
            let url = URL(string: string),
            let scheme = url.scheme?.lowercased(),
            scheme == "http" || scheme == "https",
            !LocalHost.isLocal(url.host)
        else { return }
        NSWorkspace.shared.open(url)
    }
}

/// A minimal wrapping row so chips flow onto the next line like `flex-wrap`.
struct WrapHStack: Layout {    var spacing: CGFloat = 8

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let maxWidth = proposal.width ?? .infinity
        var x: CGFloat = 0
        var y: CGFloat = 0
        var rowHeight: CGFloat = 0
        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if x > 0, x + size.width > maxWidth {
                x = 0
                y += rowHeight + spacing
                rowHeight = 0
            }
            x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
        }
        return CGSize(width: maxWidth == .infinity ? x : maxWidth, height: y + rowHeight)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX
        var y = bounds.minY
        var rowHeight: CGFloat = 0
        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if x > bounds.minX, x + size.width > bounds.maxX {
                x = bounds.minX
                y += rowHeight + spacing
                rowHeight = 0
            }
            subview.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
            x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
        }
    }
}

/// Watches the transcript's scroll geometry and reports whether the viewport
/// rests at the newest turn, so auto-scroll can tell "keep me pinned" apart
/// from "I am reading history". Needs the scroll-geometry API of macOS 15;
/// older systems keep the previous always-follow behavior, with the bottom
/// default anchor still handling the short-content and open cases.
/// The height of the newest reply, reported up from the row that renders it.
private struct ReplyHeightKey: PreferenceKey {
    static let defaultValue: CGFloat = 0

    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value += nextValue()
    }
}

/// The transcript's latest distance from its bottom and content height,
/// written on every scroll frame and read by the landing check. A class, and
/// not observed, so the writes never invalidate a view.
private final class ScrollProbe {
    var distance: CGFloat = .infinity
    var contentHeight: CGFloat = 0
    var viewport: CGFloat = 0
    /// Whether the geometry has reported since the last reset.
    var seen = false
    var offset: CGFloat = 0
    /// The offset when the reader's current gesture began.
    var gestureStartOffset: CGFloat = 0
    /// True while the reader's hand is on the transcript. The app's own
    /// scrolls wait until the gesture has been judged.
    var dragging = false
    /// Mirrors `holdingReplyAnchor`: while the view is parked at the top of a
    /// finished reply, no re-pin runs, and an offset change a late reload
    /// makes is not taken for the reader scrolling.
    var holding = false
    /// Until when an offset change is the app's own scroll rather than the
    /// reader's.
    var appScrollUntil = Date.distantPast

    func reset() {
        distance = .infinity
        contentHeight = 0
        viewport = 0
        seen = false
        // A gesture on the last chat's scroll view never ends on this one.
        dragging = false
        gestureStartOffset = 0
        holding = false
    }

    /// Extends, never shortens: a send's short window must not cut off a
    /// longer one an anchor scroll is still inside.
    func markAppScroll(for seconds: TimeInterval = 0.35) {
        appScrollUntil = max(appScrollUntil, Date().addingTimeInterval(seconds))
    }
}

/// Opens at the newest turn and keeps a reader who is there with it as the
/// content grows. A reader up in the history keeps what they are reading
/// instead: with the bottom anchor on every size change, a reply growing below
/// them moved their rows up by as much as it grew.
private struct TranscriptAnchor: ViewModifier {
    let pinned: Bool

    func body(content: Content) -> some View {
        if #available(macOS 15.0, *) {
            content
                .defaultScrollAnchor(.bottom, for: .initialOffset)
                .defaultScrollAnchor(.bottom, for: .alignment)
                .defaultScrollAnchor(pinned ? .bottom : .top, for: .sizeChanges)
        } else {
            content.defaultScrollAnchor(.bottom)
        }
    }
}

private struct ScrollPinnedTracker: ViewModifier {
    @Binding var pinned: Bool
    /// The visible height of the transcript, for deciding whether a reply
    /// overflows it.
    @Binding var viewport: CGFloat
    let probe: ScrollProbe
    /// Called when the content or the window changed size and left a pinned
    /// reader short of the bottom. The caller scrolls back if it still should.
    let onDrift: () -> Void
    /// A reader who scrolls back down to within half a line of the bottom is
    /// pinned again, so they need not land on it exactly.
    private static let tolerance: CGFloat = 48

    /// The rule for a mouse wheel and the keyboard, which move the offset with
    /// no scroll phase to judge at rest. The reader left the newest turn when the
    /// offset went up and took them further from the bottom; the bottom anchor
    /// lowering the offset for a shrink keeps the distance, and content
    /// growing below moves no offset, so neither counts. Only a move down can
    /// bring them back, so the last sub-point frames of an upward flick never
    /// re-pin.
    private static func movedAway(_ old: Geometry, _ new: Geometry) -> Bool {
        new.offset < old.offset && new.distance > old.distance + 0.25 && new.distance > 2
    }

    private static func cameBack(_ old: Geometry, _ new: Geometry) -> Bool {
        new.offset > old.offset && new.distance <= tolerance
    }

    /// Offset and content height together, because the pin can only be judged
    /// from the pair: the same distance-from-bottom means "the reader scrolled
    /// up" when the offset moved and "a row was appended" when the content grew.
    private struct Geometry: Equatable {
        var offset: CGFloat
        var contentHeight: CGFloat
        var distance: CGFloat
        var viewport: CGFloat
    }

    /// True only while the reader's own hand is on the transcript. Every other
    /// offset change belongs to the app.
    @State private var dragging = false

    func body(content: Content) -> some View {
        if #available(macOS 15.0, *) {
            content
            .onScrollPhaseChange { _, phase in
                switch phase {
                case .tracking, .interacting, .decelerating:
                    if !dragging { probe.gestureStartOffset = probe.offset }
                    dragging = true
                    probe.dragging = true
                default:
                    guard dragging else { return }
                    dragging = false
                    probe.dragging = false
                    // The reader's own gesture is judged once, where it came
                    // to rest, not frame by frame while the hand is on it:
                    // momentum, slow drags and lines streaming in under the
                    // gesture all move the geometry in ways a single frame
                    // cannot tell apart. It is judged by where the offset
                    // went, since lines streaming in change the distance but
                    // not the offset: a move up keeps the pin only at the very
                    // bottom, a move down pins again near it, and fingers that
                    // rested without moving change nothing.
                    let end = probe.distance
                    let netUp = probe.gestureStartOffset - probe.offset
                    let atBottom: Bool
                    if netUp > 2 {
                        atBottom = end <= 2
                    } else if netUp < -2 {
                        atBottom = end <= Self.tolerance
                    } else {
                        atBottom = pinned
                    }
                    if pinned != atBottom { pinned = atBottom }
                    // Lines that streamed in under a resting hand were not
                    // followed; a pinned reader catches up now.
                    if atBottom, end > 1 { onDrift() }
                }
            }
            .onScrollGeometryChange(for: Geometry.self) { geometry in
                // The visible rect, not the offset plus the container: the
                // floating header's top inset shifts the offset, and adding
                // the container to it put the true bottom 62 points short, so
                // every settle at the bottom read as the reader scrolling up
                // and the landing never saw the bottom.
                let bottomEdge = geometry.visibleRect.maxY - geometry.contentInsets.bottom
                return Geometry(
                    offset: geometry.contentOffset.y,
                    contentHeight: geometry.contentSize.height,
                    distance: max(0, geometry.contentSize.height - bottomEdge),
                    viewport: geometry.containerSize.height
                )
            } action: { old, new in
                // This fires for every scroll frame; the window only changes
                // height on a resize.
                if viewport != new.viewport { viewport = new.viewport }
                probe.distance = new.distance
                probe.offset = new.offset
                probe.contentHeight = new.contentHeight
                probe.viewport = new.viewport
                probe.seen = true
                // Only the reader's own gesture may break the pin.
                //
                // Everything else that moves this geometry is the app's doing
                // and used to read as "they scrolled away": a new row makes the
                // content taller a frame before anything scrolls, and the
                // durable reload after a turn replaces a short transcript with
                // a tall one. Both left the viewport a long way from the bottom
                // for one frame, the pin dropped, and every auto-scroll below
                // is gated on the pin, which is how sending a message stranded
                // the reader in the middle of the history.
                guard dragging else {
                    // A mouse wheel or the keyboard moves the offset without
                    // a scroll phase. The app only ever moves a pinned reader
                    // down, except for its own anchor scrolls, so a move up
                    // that the app did not make, and that took the reader
                    // further from the bottom, is the reader's, however small
                    // and even when the content changes size in the same
                    // frame. The bottom anchor lowering the offset for a
                    // shrink keeps the distance, and a clamp at the bottom
                    // leaves none, so neither is mistaken for one.
                    let appScroll = Date() < probe.appScrollUntil
                    let resized = new.contentHeight != old.contentHeight || new.viewport != old.viewport
                    // A taller window (the composer shrinking after a send, a
                    // banner leaving) clamps a reader at the bottom back by
                    // the same amount, and a row landing in that frame then
                    // looks like a move up. That frame is the app's; the drift
                    // check below puts the reader back at the bottom.
                    // Only as far as it grew: a clamp moves the offset up by
                    // at most the growth, so a move past that is the reader's
                    // own wheel in the same frame, and it unpins.
                    let growth = max(0, new.viewport - old.viewport)
                    let viewportGrew = growth > 0 && old.offset - new.offset <= growth + 0.5
                    // A shorter window is the app's too: a question card
                    // docking over the composer takes the room the working
                    // row gave up in the same frame, and that pair read as a
                    // move up. The pin dropped, nothing re-pinned, and the
                    // owner's message sat hidden under the card.
                    // Only as far as it shrank (plus the content change in the
                    // same frame): past that, the reader's own wheel moved too.
                    let shrink = max(0, old.viewport - new.viewport)
                    let viewportShrank = shrink > 0
                        && old.offset - new.offset <= shrink + abs(new.contentHeight - old.contentHeight) + 0.5
                    // While the view is parked at the top of a finished reply,
                    // a resize frame is the reload settling, not the reader.
                    if !appScroll, !viewportGrew, !viewportShrank, !(probe.holding && resized),
                       Self.movedAway(old, new) {
                        if pinned { pinned = false }
                        return
                    }
                    if !resized, !appScroll, new.offset != old.offset {
                        // Back down to the newest turn by wheel or keys pins again.
                        if Self.cameBack(old, new), !pinned { pinned = true }
                        return
                    }
                    // The bottom anchor does not hold through every change:
                    // the replay replacing the rows kept the old offset, which
                    // is mid-history in the new list. A reader at the newest
                    // turn is put back there. Size changes only, so a scroll
                    // the app made on purpose is left where it went.
                    if pinned, new.distance > 1,
                       new.contentHeight != old.contentHeight || new.viewport != old.viewport {
                        onDrift()
                    }
                    return
                }
                // During the reader's own gesture nothing is decided here;
                // the phase change above judges it where it comes to rest.
            }
        } else {
            content
        }
    }
}

extension Notification.Name {
    /// Reply on a bot message. Rows post it rather than observe AppModel, so
    /// transcript rows stay cheap.
    static let replyToMessage = Notification.Name("useful-bot.reply-to-message")
}

/// Reply, Copy and the gap before them.
enum MessageHoverActionsWidth {
    static let value: CGFloat = 8 + 28 + 2 + 28
}

private enum HoverActionsDebug {
    /// `-ubShowHoverActions YES` at launch keeps them on screen, so a check
    /// can capture them without moving the real pointer.
    static let forced = UserDefaults.standard.bool(forKey: "ubShowHoverActions")
}

/// Reply and Copy beside a bot message, shown while the pointer is on
/// its row. They keep their room when hidden, so the bubble never shifts.
private struct MessageHoverActions<Content: View>: View {
    let text: String
    /// The chat the message is in, and who wrote it when that is a member.
    let botId: String
    var author: String?
    var enabled = true
    @ViewBuilder var content: Content

    @State private var hovering = false
    @State private var copied = false

    var body: some View {
        let hovering = hovering || HoverActionsDebug.forced
        HStack(alignment: .center, spacing: 8) {
            content
            HStack(spacing: 2) {
                Button(action: reply) {
                    Image(systemName: "arrowshape.turn.up.left")
                        .font(.system(size: 14))
                        .foregroundStyle(Theme.C.inkMuted)
                        .frame(width: 28, height: 28)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .pointerOnHover()
                .help("Reply")
                .accessibilityLabel("Reply")
                Button(action: copy) {
                    Image(systemName: copied ? "checkmark" : "doc.on.doc")
                        .font(.system(size: 13))
                        .foregroundStyle(Theme.C.inkMuted)
                        .frame(width: 28, height: 28)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .pointerOnHover()
                .help("Copy")
                .accessibilityLabel(copied ? "Copied" : "Copy")
            }
            .opacity(hovering && enabled ? 1 : 0)
            .allowsHitTesting(hovering && enabled)
            .accessibilityHidden(!enabled)
        }
        .contentShape(Rectangle())
        .onHover { self.hovering = $0 }
        // Hidden buttons leave the accessibility tree, so the same two
        // actions ride on the message for VoiceOver and keyboard users.
        .accessibilityActions {
            if enabled {
                Button("Reply", action: reply)
                Button("Copy", action: copy)
            }
        }
    }

    private func reply() {
        var info: [String: String] = ["text": text, "botId": botId]
        if let author { info["author"] = author }
        NotificationCenter.default.post(name: .replyToMessage, object: nil, userInfo: info)
    }

    private func copy() {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
        copied = true
        Task {
            try? await Task.sleep(for: .seconds(1.5))
            copied = false
        }
    }
}

/// One starter prompt: a sunken tile that tones up on hover.
private struct StarterPromptButton: View {
    let text: String
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            Text(text)
                .font(.system(size: 13))
                .foregroundStyle(Theme.C.ink)
                .multilineTextAlignment(.leading)
                .padding(14)
                .frame(maxWidth: .infinity, minHeight: 48, alignment: .leading)
                .background(hovering ? Self.hover : Theme.C.sunken,
                            in: RoundedRectangle(cornerRadius: DesignTokens.Radius.md, style: .continuous))
                .contentShape(RoundedRectangle(cornerRadius: DesignTokens.Radius.md, style: .continuous))
        }
        .buttonStyle(.plain)
        .pointerOnHover()
        .onHover { hovering = $0 }
        .animation(Theme.ease(0.15), value: hovering)
        .accessibilityIdentifier("starter-prompt")
    }

    private static let hover = Theme.adaptive(DesignTokens.Hex.border, DesignTokens.DarkHex.borderStrong)
}

/// One starter: the short label on the tile and the fuller prompt it puts in
/// the composer.
struct StarterPrompt: Identifiable {
    let label: String
    let prompt: String
    var id: String { label }

    /// Set once the owner has sent a first message from the app.
    static let sentKey = "ub.firstMessageSent"

    static let all = [
        StarterPrompt(
            label: "Find what's taking up space on my Mac",
            prompt: "Find what's taking up the most space on my Mac. List the biggest folders and files with their sizes. Don't delete anything."
        ),
        StarterPrompt(
            label: "Rename my screenshots by date",
            prompt: "List the screenshots on my Desktop and rename each one to the date and time it was taken. Show me the new names before you rename anything."
        ),
        StarterPrompt(
            label: "Save a folder's file list as a spreadsheet",
            prompt: "List the files in a folder I pick, with their sizes and dates, and save them as a CSV file I can open in Numbers."
        ),
        StarterPrompt(
            label: "Research a topic and save a report",
            prompt: "Research a topic I'll name, then save a short report with sources as a document on my Desktop."
        ),
        StarterPrompt(
            label: "Create a bot that plans a Downloads tidy-up",
            prompt: "Create a bot that looks through my Downloads folder, tells me what is in there and proposes a tidy-up plan I can approve before anything moves."
        ),
        StarterPrompt(
            label: "Create a copywriter bot for my brand",
            prompt: "Create a copywriter bot for my brand. Ask me a few questions about my brand and voice first, then set it up."
        ),
    ]

    /// Any empty chat's tiles: two bots worth making, the first step to
    /// connecting apps and a routine, so the owner sees what's possible.
    static let everyday = [
        StarterPrompt(
            label: "Create an inbox assistant",
            prompt: "Create a bot that goes through my email every morning, sums up what needs me and shows me draft replies here to review. Ask me what to watch for first."
        ),
        StarterPrompt(
            label: "Create a writer for my social posts",
            prompt: "Create a bot that writes my social media posts in my voice. Ask me about my audience, my topics and a few posts I like first, then set it up."
        ),
        StarterPrompt(
            label: "How do I connect my apps?",
            prompt: "How do I connect my apps, like Gmail, Calendar and Drive, so you can work in them?"
        ),
        StarterPrompt(
            label: "Get a morning news brief every day",
            prompt: "Every day at 8:00, post a short news brief here with sources on topics I pick. Ask me the topics first, then set it up as a routine."
        ),
    ]
}
