import AppKit
import Foundation
import os
import UniformTypeIdentifiers
import UsefulBotCore

/// A device flow the Providers pane is waiting on. The key itself never
/// appears here, only the code the owner types on the sign-in page.
/// `expiresAt` and `intervalMs` come from the start response: the app keeps
/// polling transient answers until the entry's expiry.
struct OAuthPending: Equatable {
    let pollId: String
    let providerId: String
    let label: String
    let userCode: String
    let verificationUrl: String
    let verificationUrlComplete: String?
    let expiresAt: Double
    var intervalMs: Int
}

/// Snapshot writes are a cache: a failure costs the next open its speed, not
/// its rows, so it is logged rather than surfaced.
private let snapshotLog = Logger(subsystem: "com.usefulbot.app", category: "chat-snapshot")

@MainActor
final class AppModel: ObservableObject {
    enum Phase: Equatable {
        case starting
        case unavailable
        case ready
    }

    @Published private(set) var phase: Phase = .starting
    /// Why startup failed when the reason is more specific than a dead server,
    /// for example a missing node binary. Shown on the launch screen.
    @Published private(set) var startupError: String?
    @Published private(set) var store: ShellStore? {
        didSet {
            // A chat deleted anywhere (the phone, a bot's own tool) leaves
            // the disk with its bot, not only one deleted from this rail.
            guard let oldValue, let store else { return }
            let kept = Set(store.bots.map(\.id))
            for bot in oldValue.bots where !kept.contains(bot.id) {
                removeSnapshot(bot.id)
            }
        }
    }
    @Published private(set) var selectedBotId: String? {
        // Opening a chat is reading its reply.
        didSet {
            if let id = selectedBotId, replyReady.contains(id) { replyReady.remove(id) }
            // Leaving a chat means its end wasn't seen, so a handoff ending
            // after the switch still counts as an unread reply.
            if selectedBotId != oldValue { selectedAtLastTick = nil }
        }
    }
    @Published private(set) var transcript: [TranscriptRow] = []
    /// The grouped render list for `transcript`. Derived once per change here
    /// rather than in the view body: `ChatView` observes this model, so every
    /// keystroke in the composer re-evaluates it, and regrouping the whole
    /// transcript on each one is what made typing feel heavy.
    @Published private(set) var transcriptBlocks: [TranscriptBlock] = [] {
        didSet {
            continuationIds = TranscriptBlocks.continuationIds(transcriptBlocks)
            latestReplyRunIds = TranscriptBlocks.latestReplyRunIds(transcriptBlocks, taskReplies: projection.taskReplyRowIds)
            republishWindow()
        }
    }
    /// What the transcript mounts: the newest blocks, and everything back to
    /// where the reader last asked for more. The rest sits behind the "Show
    /// earlier messages" row. Layout used to scale with the whole history on
    /// every real change, tables included, because the transcript is an eager
    /// stack and has to stay one: the reply-height sum and the tall-reply
    /// anchor both need the newest reply mounted whole.
    @Published private(set) var transcriptWindow = TranscriptBlocks.Window(blocks: [], hidden: 0)
    /// The owner row that opened a carried-over session, where the chat says
    /// the conversation continues from an earlier one.
    @Published private(set) var continuationRowId: String?
    /// Per bot, the first block the reader expanded the window back to. Held
    /// for the session so a chat comes back the way it was left.
    private var windowStarts: [String: String] = [:]
    /// Derived with the blocks, not in the view: the chat body re-evaluates on
    /// every composer keystroke.
    private(set) var continuationIds = Set<String>()
    private(set) var latestReplyRunIds = Set<String>()
    @Published private(set) var pending = false {
        didSet { if pending, !oldValue { activitySince = Date() } }
    }
    /// A turn is running in this bot's session that this app did not send (a
    /// handoff, a connect resume, a routine). Drives the working row the same
    /// way `pending` does; the follower keeps it in step with the stream.
    @Published private(set) var backgroundWorking = false {
        didSet { if backgroundWorking, !oldValue, !pending { activitySince = Date() } }
    }
    /// Failures with no turn to put them under (a send that never reached
    /// the server, a load that failed, a write that was refused), shown as a
    /// one-line note over the composer. A turn that failed is a row in the
    /// transcript instead.
    @Published private(set) var threadError: String?
    /// The failure row whose Retry is live: the newest failed turn's, while
    /// nothing has started since.
    @Published private(set) var retryableFailureRowId: String?
    /// When that row's Retry unlocks, for a router cool-down that said.
    @Published private(set) var failureRetryUntil: Date?
    /// Profile save failures surface inside the settings pane.
    @Published private(set) var saveError: String?
    /// Proposals waiting on the owner for the open thread.
    @Published private(set) var proposals: [Proposal] = []
    @Published private(set) var busyProposals: Set<String> = []
    @Published private(set) var operatorName = "Desktop owner"
    @Published private(set) var operatorInitials = "DO"
    @Published private(set) var composer: ComposerState?
    /// A model, effort or speed pick the router would not store, shown by the
    /// composer so the chip reverting does not read as the tap doing nothing.
    @Published private(set) var composerError: String?
    @Published private(set) var memoryNotes: [MemoryNote]?
    @Published private(set) var memoryError: String?

    /// Pending approvals from `/api/approvals`, shown above the chat.
    @Published private(set) var approvals: [ApprovalItem] = []
    /// Approvals with a decision in flight, so double taps cannot double-post.
    @Published private(set) var busyApprovals: Set<String> = []
    /// Recently decided approvals, briefly hidden from a racing poll.
    private var decidedApprovals: [String: Date] = [:]
    @Published private(set) var approvalError: String?
    /// Web results the live turn surfaced, shown as chips under the transcript.
    @Published private(set) var searchHits: [SearchChip] = []
    /// Questions the open chat's bot is waiting on the owner to answer.
    @Published private(set) var openQuestions: [OwnerQuestion] = []
    /// What the live turn is doing, shown in the working row until the reply
    /// takes its place.
    @Published private(set) var activity: TurnActivity = .thinking
    /// When the running turn began, for the working row's timer. It counts
    /// the whole turn, from the send to the reply, through every step: a
    /// timer that went back to 0 at each tool read as the bot starting over.
    @Published private(set) var activitySince = Date()
    /// When the oldest background sub-agent still out in this chat started,
    /// or nil when none is. The working row stays up for it after the turn
    /// that started it has ended.
    @Published private(set) var runningTaskSince: Date?
    /// Operator identity plus build info for the settings dialog.
    @Published private(set) var appStatus: AppStatus?
    /// App settings dialog, opened from the rail account row or the composer.
    @Published var appSettingsOpen = false
    @Published var appSettingsTab: AppSettingsTab = .general
    @Published private(set) var providers: [ProviderPublic]?
    @Published var providersError: String?
    @Published private(set) var providerBusy: String?
    /// Providers v2 catalogue and connections from `GET /api/providers`. The
    /// UI renders only what the server returns.
    @Published private(set) var providerCatalog: [CatalogPublic] = []
    /// The providers have been read at least once, so an empty connection
    /// list means none is connected rather than not known yet.
    @Published private(set) var providersLoaded = false
    /// The last providers read failed and none has succeeded since.
    @Published private(set) var providersLoadFailed = false

    /// Known to have no provider connected: chat has no model to talk to.
    var noModelConnected: Bool { providersLoaded && providerConnections.isEmpty }
    @Published private(set) var providerConnections: [ConnectionPublic] = []
    @Published private(set) var defaultRole: RolePublic?
    @Published private(set) var reviewerRole: RolePublic?
    @Published private(set) var imageRole: RolePublic?
    /// A connect-sheet failure, shown under the field it belongs to.
    @Published private(set) var connectError: String?
    /// A device flow the Providers pane is waiting on, with its poll.
    @Published private(set) var oauth: OAuthPending?
    @Published private(set) var oauthError: String?
    /// True once the flow ended in an error the sheet shows. The pending entry
    /// stays so the sheet stays up with the error; the spinner and the
    /// sign-in button hide, and Close clears everything.
    @Published private(set) var oauthDone = false
    /// Bumped each time a device sign-in completes, so a screen waiting on
    /// one can tell it finished rather than was cancelled.
    @Published private(set) var oauthCompletions = 0
    /// Consecutive poll errors; the flow ends at the limit rather than waiting out the code.
    private var oauthErrorStreak = 0
    private static let oauthErrorLimit = 6
    private var oauthPoll: Task<Void, Never>?
    @Published private(set) var usage: UsagePayload?
    @Published var usageError: String?
    /// A budget change in flight, so the stepper cannot fire twice.
    @Published private(set) var usageBusy = false
    /// Bumped on every budget write, so a poll from before it is discarded.
    private var usageGeneration: UInt64 = 0
    /// Connectors dialog: the catalogue, the key state and one in-flight
    /// OAuth flow the dialog polls for.
    @Published private(set) var connectors: ConnectorsPayload?
    @Published var connectorsError: String?
    @Published private(set) var connectorBusy: String?
    @Published private(set) var connectorPending: String?
    @Published private(set) var connectorTimedOut: String?
    /// The own-app form open under one row: Composio has no OAuth app for
    /// that connector, so the owner supplies their own.
    @Published private(set) var connectorOwnApp: OwnAppForm?
    /// The dialog's live search, so a poll started earlier reloads what is on screen.
    @Published var connectorSearch = ""
    private var connectorPoll: Task<Void, Never>?
    private static let connectorUpstreamError = "Composio did not answer. Try again in a moment."
    private static let connectorKeyRejected = "Composio rejected this key. Remove it and paste a fresh one from platform.composio.dev."
    private static let connectorLoadErrors: Set<String> = [
        "Could not load connectors.",
        connectorUpstreamError,
        connectorKeyRejected,
    ]

    /// Which inline pane is open. One value, so settings and the details pane
    /// can never fight over the 320pt sidebar.
    enum Pane: Equatable {
        case none
        case settings
        case details
    }

    @Published var pane: Pane = .none {
        didSet {
            // The pane opens on the list, never on the row it showed last time.
            if pane != .details { closeRoutineDetail() }
            if pane == .details, let botId = selectedBotId {
                Task { @MainActor [weak self] in await self?.loadRoutines(botId: botId) }
            }
        }
    }

    /// Routines for the open bot, plus the pane's own navigation state.
    @Published private(set) var routines: [Routine] = []
    @Published private(set) var routinesError: String?
    /// Routine ids with a write in flight, so a double click cannot double-post.
    @Published private(set) var routineBusy: Set<String> = []
    /// A create in flight. It has no id yet, so it needs its own flag; without
    /// one a second click on Create routine makes a second routine.
    @Published private(set) var routineCreateBusy = false
    /// The routine the pane has drilled into, or nil for the list.
    @Published var openRoutineId: String?
    /// The pane is showing the create form.
    @Published var routineCreating = false

    /// Inline settings pane, opened from the details pane's gear.
    var settingsOpen: Bool {
        get { pane == .settings }
        set { pane = newValue ? .settings : (pane == .settings ? .none : pane) }
    }

    /// Inline chat details pane, toggled from the info button in the header.
    var detailsOpen: Bool {
        get { pane == .details }
        set { pane = newValue ? .details : (pane == .details ? .none : pane) }
    }
    /// ⌘K palette.
    @Published var searchOpen = false
    /// Composer draft is page-level on the web, so it survives a bot switch.
    @Published var draft = ""
    /// Bumped only when the app itself writes `draft`: the send-clear and the
    /// restore of a failed send. Typing never bumps it.
    ///
    /// The composer's text view uses this to tell a deliberate write apart from
    /// a re-render. SwiftUI rebuilds the composer on every unrelated published
    /// change (the poll republishes the store, the transcript, the proposals),
    /// and such a rebuild can carry a `draft` captured a moment earlier. While
    /// a dictation app is inserting an utterance in chunks, that stale value
    /// used to be written back over the newer text in the field, and the
    /// dictation app then re-inserted the whole utterance on top of what was
    /// left: the doubled transcript. Model-to-view writes now happen only when
    /// this token changes.
    @Published private(set) var draftWriteToken: UInt64 = 0
    /// A bot message the owner is replying to: it rides above the composer
    /// as a chip and goes out quoted above the next message to that bot.
    @Published var replyQuotes: [String: ReplyQuote] = [:]
    /// Bumped when Reply wants the caret in the composer.
    @Published private(set) var composerFocusToken: UInt64 = 0
    @Published var attachments: [Attachment] = []
    @Published var attachError: String?
    @Published private(set) var onboardingDismissedFor: Set<String> = []

    private let config: ServerConfig
    private let services = LocalServices()
    private let poller = HealthPoller(probe: URLSessionHealthProbe())
    private let client: BackendClient
    private var startAttempt = 0
    /// The start in flight, so a retry can cancel it before starting another.
    private var bootTask: Task<Void, Never>?
    /// A retry already tearing down and restarting the stack.
    private var retrying = false

    init() {
        let config = ServerConfig.resolved()
        self.config = config
        // DesktopEndpointPolicy never rejects; the throws exists so iOS
        // policies can refuse an endpoint (spec 4.7).
        self.client = try! BackendClient(base: config.baseURL)
        if let perf = PerfHarness.shared {
            for botId in perf.snapshotsToDrop { snapshots.remove(botId: botId) }
        }
    }

    private var projection = StreamProjection()
    private var durableEvents: [AgentEvent] = []
    private var pollTask: Task<Void, Never>?
    private var approvalPollTask: Task<Void, Never>?
    private var reloadTask: Task<Void, Never>?
    private var followTask: Task<Void, Never>?
    private var sendTask: Task<Void, Never>?
    /// One send task per bot, so a turn on A keeps running while the owner
    /// talks to B. `sendTask` is the selected bot's task when it has one.
    private var sendTasks: [String: Task<Void, Never>] = [:]
    /// Per-bot send generation: bumping one bot must not abort another.
    private var sendGenerations: [String: Int] = [:]
    /// Session ids for turns this app started, keyed by bot, including bots
    /// the owner has switched away from.
    private var inflightSessions: [String: String] = [:]
    /// Live projections for bots whose send is still running in the background.
    private var backgroundProjections: [String: StreamProjection] = [:]
    /// When each bot's caches were last on screen, for the budget below.
    private var cacheUse: [String: Date] = [:]
    /// What the per-bot transcript caches and stashed projections may hold
    /// together. Chats visited used to stay cached for the life of the app.
    /// A chat here is a few hundred KB, so this is room for dozens; the
    /// oldest go first, and never a bot with a send or a turn in flight.
    private static let cacheBudgetBytes = 16 * 1024 * 1024
    /// Bots with a turn still running, selected or not. Drives the rail pulse.
    @Published private(set) var workingBotIds: Set<String> = []
    /// Handoff deliveries in flight on bots the owner is not looking at.
    @Published private(set) var handoffWorkingIds: Set<String> = []
    /// Live activity of working bots the owner is not looking at, published
    /// only when it changes. The selected bot's is `activity`.
    @Published private(set) var backgroundActivities: [String: TurnActivity] = [:]
    /// Unselected bots whose turn finished with a reply the owner has not
    /// opened yet. In memory only.
    @Published private(set) var replyReady: Set<String> = []
    /// Bumped once per finished reply; the rail face hops on each change.
    @Published private(set) var railHops: [String: Int] = [:]
    private var saveChain: Task<Void, Never>?
    private var uploadChain: Task<Void, Never>?
    /// The newest session this app started, scoped to its bot so a Stop on
    /// another bot cannot cancel the wrong session.
    private var activeSession: (botId: String, sessionId: String)?
    /// Where the open chat's follower resumes reading its eve session: the
    /// index of the first event the projection does not hold yet. The reload's
    /// replay from zero sets it and the follower advances it, so the follower
    /// asks the server only for what is new. Before this it re-read the whole
    /// session every few seconds and decided what was old from a second read,
    /// and a turn that finished during that second read was taken for history
    /// and never shown.
    /// `lastEventId` is the id of the event at `next - 1`, which is how a
    /// saved chat tells, from the session's newest id alone, that nothing was
    /// recorded after it.
    private var followCursor: (sessionId: String, next: Int, lastEventId: String?)?
    /// Where the next reload picks the session up, set when a chat was put
    /// back from a snapshot (the stash of one left at rest, or the file on
    /// disk). That reload reads only what the session recorded after it
    /// instead of replaying from zero, which for a long chat meant eve
    /// opening every chunk file twice and the app decoding every event.
    private var resumePoint: (sessionId: String, next: Int, lastEventId: String?)?
    /// Per-bot chat snapshots on disk, so a first open after launch starts
    /// where the chat was left instead of at event zero.
    private let snapshots = ChatSnapshotStore(directory: ChatSnapshotStore.defaultDirectory, build: AppModel.snapshotKey)
    /// Which snapshots this app trusts. A bundled build carries the hash of the
    /// replay logic's sources (build-app.sh): UsefulBotCore and this file, which
    /// feeds the fold. An update that leaves them alone keeps every chat's
    /// snapshot and opens it at once; one that touches them replays each chat
    /// once. Without the stamp (a bare `swift run`), every rebuild of the
    /// binary starts over.
    private static let snapshotKey: String = {
        if let logic = Bundle.main.object(forInfoDictionaryKey: "UBSnapshotLogic") as? String, !logic.isEmpty {
            return "v\(ChatSnapshot.formatVersion)-core-\(logic)"
        }
        return buildId
    }()
    /// This binary: every rebuild changes its size or modification time.
    private static let buildId: String = {
        guard let url = Bundle.main.executableURL,
              let attributes = try? FileManager.default.attributesOfItem(atPath: url.path) else { return "unknown" }
        let size = (attributes[.size] as? NSNumber)?.int64Value ?? 0
        let modified = (attributes[.modificationDate] as? Date)?.timeIntervalSince1970 ?? 0
        return "\(size)-\(Int64(modified))"
    }()
    /// Snapshots of chats left at rest this session, per bot: the in-memory
    /// twin of the file, restored before the file is read.
    private var stashSnapshots: [String: ChatSnapshot] = [:]
    /// Writes go out one after another, so an older snapshot can never land
    /// on top of a newer one.
    private var snapshotWrite: Task<Void, Never>?
    /// The open chat's pending snapshot, coalesced so a turn's run of
    /// terminal events writes once.
    private var snapshotTimer: Task<Void, Never>?
    /// Bots being deleted: nothing may write their chat back to disk.
    private var snapshotsBlocked: Set<String> = []
    /// Builds snapshots for chats never opened, one at a time, after launch.
    private var prewarmTask: Task<Void, Never>?
    /// The load generation whose reload finished. A snapshot is only taken
    /// while it is the current one: an in-place reload (Retry, a proposal,
    /// Stop) rewinds the cursor to zero while the old projection is still on
    /// screen, and a snapshot of that pair would replay events it holds.
    private var completedLoad: Int?
    /// Turns a local send streamed to their end, per session. The follower resumes
    /// from a cursor that sits before them, so it meets their events again and
    /// must pass over them rather than lean on the projection's bounded id
    /// dedupe. Dropped when a reload rebuilds the session from zero.
    private var localTurnIds: [String: Set<String>] = [:]
    /// Every turn id this app has read off a session, from the reload, the
    /// follower and its own sends. A send reads only the end of the session
    /// before it posts, and this is what still tells it which turns are old:
    /// it covers the stretch the follower read past the recorded tail, which
    /// no snapshot reaches. A session with an entry here is known to tag its
    /// turns, so an untagged message can never be the one a send arms on.
    private var seenTurnIds: [String: Set<String>] = [:]
    /// Set once a snapshot comes back without a tail: reading from the cursor
    /// first would only put a second, wasted read in front of the send.
    private var tailUnreported = false

    private func noteTurnId(_ event: EveEvent, sessionId: String) {
        if let turnId = event.turnId, !turnId.isEmpty {
            seenTurnIds[sessionId, default: []].insert(turnId)
        }
    }
    /// A session a bot's pointer has moved off (retired by eve, or replaced
    /// by a fresh-session retry) is never read again, so its turn ids go
    /// with it. Kept, every rotation left a set behind for the app's life.
    private func forgetTurnIds(of sessionId: String?) {
        guard let sessionId, !sessionId.isEmpty else { return }
        seenTurnIds[sessionId] = nil
        localTurnIds[sessionId] = nil
    }
    /// One handoff pump at a time; a slow server must not stack ticks.
    private var tickInFlight = false
    /// Consecutive unauthorized polls, surfaced after the second failure.
    private var pollAuthFailures = 0
    /// Bumped by retry so a shell write that was already in flight cannot
    /// land its echo over the fresh reload.
    private var storeEpoch = 0
    /// A send's own failure banner, preserved across its trailing reload.
    private var stickyThreadError: String?
    /// A quiet stretch this long inside a session replay means the history
    /// burst is over. The loopback server sends it as fast as it can read it.
    private static let replayBurstGap: TimeInterval = 0.35
    private var loadGeneration = 0
    /// Bumped once per owner-initiated send. The transcript watches it to jump
    /// to the newest turn: sending is an explicit request to watch the answer,
    /// so it overrides whatever the reader's scroll position was.
    @Published private(set) var sendTick: UInt64 = 0
    /// `sendTick` when the open chat was put on screen.
    private var sendTickAtOpen: UInt64 = 0
    /// Whether the owner sent in this chat since opening it. The transcript
    /// lands on a send's rows only then: a send still running from before the
    /// chat was left can sit on a history that never finished loading.
    var sentSinceOpen: Bool { sendTick != sendTickAtOpen }
    /// False from the moment a chat is opened until its rows are all in.
    ///
    /// A thread arrives in two waves (the durable rows, then the session
    /// replay) and a scroll view that already exists while they land keeps
    /// the offset it had, which is the top. Something then has to scroll it
    /// down, and that trip is what reads as "it starts in the middle and
    /// jumps". The transcript is not built at all until this is true, so its
    /// first layout is the finished one and `defaultScrollAnchor(.bottom)`
    /// puts it on the newest turn with nothing to animate.
    @Published private(set) var transcriptReady = false
    /// True while the rows on screen are the ones this chat was left with,
    /// put back on a switch before the reload confirms them. The transcript
    /// may land on those without waiting for the replay; nothing re-renders
    /// on it, so it is not published.
    private(set) var restoredFromCache = false
    /// True when those rows came from a snapshot, whose reload reads on from
    /// its cursor in tens of milliseconds: the transcript waits for that to
    /// confirm the rows. Rows from a stash or the row cache are confirmed by
    /// a replay from zero, which it does not wait for.
    private(set) var restoredFromSnapshot = false
    /// Chats whose stash was taken after their replay had finished. A chat
    /// left while the mascot was still up was stashed with the durable rows
    /// only, and landing on those would show rows the replay then replaces.
    private var readyStashes: Set<String> = []
    /// Whether the open chat's last load finished its replay. A failed load
    /// also marks the transcript ready, with rows the next replay replaces.
    private var loadSucceeded = false
    /// Per-bot fence for New Chat / Open Recent. A global counter aborted
    /// background sends on every other bot.
    private var chatGenerations: [String: Int] = [:]
    /// The rows each chat last rendered, keyed by bot id. A switch back shows
    /// them at once: the fresh load replaces the old empty state a beat later,
    /// and that beat read as the chat opening blank, or on its start page,
    /// before the conversation snapped in.
    /// The durable events ride along: a switch back restores the stashed
    /// projection and rebuilds at once, and without them that first build is
    /// the projection alone, published, then replaced by the reload's full
    /// merge a second later. With them it is the full merge already, and the
    /// reload confirms it without publishing.
    private var transcriptCache: [String: (rows: [TranscriptRow], blocks: [TranscriptBlock], events: [AgentEvent])] = [:]
    private var sendBotId: String?
    /// Per-bot send failure, so a turn that died in the background still
    /// explains itself when the owner comes back.
    private var sendErrors: [String: SendFailure] = [:]
    /// A send that never reached the server, on a bot the owner had already
    /// left. The composer was cleared when the turn was committed, so the text
    /// and its files wait here and go back when that chat is opened again.
    private var unsentDrafts: [String: (text: String, attachments: [Attachment])] = [:]
    private var started = false
    /// Rebuilding the transcript on every streamed event re-parses markdown
    /// for every row; the replay of a long session contains thousands of
    /// events, so publishes are throttled and the final state is forced.
    private var lastTranscriptPublish = Date.distantPast
    /// The trailing edge of the throttle. Without it a burst of deltas that
    /// ends inside the window leaves the newest text unrendered until the next
    /// event, which is what made a reply arrive in visible steps.
    private var pendingPublish: Task<Void, Never>?
    private static let publishInterval: TimeInterval = 0.1

    var selectedBot: ShellBot? {
        guard let store else { return nil }
        return store.bots.first { $0.id == selectedBotId } ?? store.bots.first
    }

    /// The live row behind a rendered snapshot. A menu that toggles a flag has
    /// to read it here: the snapshot can be an echo behind, and acting on a
    /// stale value would undo the tap.
    func liveBot(_ bot: ShellBot) -> ShellBot {
        store?.bots.first { $0.id == bot.id } ?? bot
    }

    var startingMessage: String {
        if phase == .starting { return "Starting local server" }
        return startupError ?? "Local server unavailable"
    }

    // MARK: - Lifecycle

    func start() async {
        guard !started else { return }
        started = true
        // Held so a retry can cancel the attempt it replaces. Two supervisors
        // running at once would both be starting and stopping the same ports.
        let boot = Task { @MainActor [weak self] in
            guard let self else { return }
            await self.boot()
        }
        bootTask = boot
        await boot.value
    }

    private func boot() async {
        startAttempt += 1
        let attempt = startAttempt
        phase = .starting
        startupError = nil
        threadError = nil
        stickyThreadError = nil
        saveError = nil
        // A release build first lays out the services it carries (a copy only
        // after an update) and refreshes the local credentials.
        // Only into its own folder: the copy deletes what the payload does not
        // carry, so a checkout set as `repoPath` must never be its target.
        if let bundled = RuntimeInstall.bundledRuntime(), config.repoPath == RuntimeInstall.installRoot.path {
            let root = RuntimeInstall.installRoot
            // Held through `prepare`, so a second copy of the app starting now
            // waits here and then finds the copy done.
            let locked = await Task.detached { () -> Result<RuntimeInstall.InstallLock, Error> in
                Result { try RuntimeInstall.InstallLock(root: root) }
            }.value
            guard !Task.isCancelled, attempt == startAttempt else { return }
            let lock: RuntimeInstall.InstallLock
            switch locked {
            case .success(let held): lock = held
            case .failure(let error):
                NSLog("Useful Bot: install lock failed: %@", String(describing: error))
                startupError = "Useful Bot couldn't set up its local services. Details are in Console."
                phase = .unavailable
                return
            }
            // After an update the previous version's services are still up
            // (they outlive the app) and would keep serving from files the
            // copy is about to replace, so they stop first and `ensure`
            // starts the new ones.
            if RuntimeInstall.needsCopy(bundled: bundled, root: root) {
                await services.stopOwnServices(config: config)
                guard !Task.isCancelled, attempt == startAttempt else { return }
            }
            let prepared = await Task.detached { () -> Result<Bool, Error> in
                Result { try RuntimeInstall.prepare(bundled: bundled, root: root, holding: lock) }
            }.value
            // New credentials replace ones a running router, eve or web still
            // holds (each reads them once at boot). The stop happens even for
            // a cancelled attempt: the next launch sees a config and would
            // keep the stale services.
            if case .success(true) = prepared {
                await services.stopOwnServices(config: config)
            }
            guard !Task.isCancelled, attempt == startAttempt else { return }
            switch prepared {
            case .failure(let error as RuntimeInstall.SetupFailure):
                // The owner gets a sentence; the raw tool output goes to Console.
                NSLog("Useful Bot: local setup failed: %@", error.detail)
                startupError = error.message
                phase = .unavailable
                return
            case .failure(let error):
                NSLog("Useful Bot: local setup failed: %@", String(describing: error))
                startupError = "Useful Bot couldn't set up its local services. Details are in Console."
                phase = .unavailable
                return
            case .success:
                break
            }
        }
        let outcome = await services.ensure(config: config)
        // A cancelled attempt paints nothing at all: the retry that cancelled
        // it owns the screen from here, and `startAttempt` is only bumped once
        // this task has been awaited, so it cannot stand in for this check.
        guard !Task.isCancelled, attempt == startAttempt else { return }
        if outcome == .nodeMissing {
            // A missing interpreter is a different failure from a dead server:
            // say so instead of making the owner wait for the retry.
            startupError = "Node.js was not found at "
                + ServiceSupervisor.nodeCandidates.joined(separator: " or ")
                + ". Install Node 24, or run scripts/setup-local.mjs once."
            phase = .unavailable
            return
        }
        // `ensure` is the authority on whether the stack is up, and it checks
        // all three services. Re-gating on the web endpoint alone is what let
        // the app open looking healthy with a dead router behind it, so an
        // unavailable outcome stops here and says which part is missing.
        if outcome == .unavailable {
            // Which one is not known here, and guessing would send the owner
            // to the wrong log.
            startupError = "The local services did not all start. One of the router, the agent or the web server is not answering."
            phase = .unavailable
            return
        }
        // No second gate on the web endpoint alone: `ensure` just checked all
        // three, and asking again about one of them only re-opened the door
        // this fix closes. A service that dies after this point surfaces as a
        // failed request, which says what actually went wrong.
        do {
            try await client.signIn()
            guard !Task.isCancelled, attempt == startAttempt else { return }
            let loaded = try await client.shell()
            guard !Task.isCancelled, attempt == startAttempt else { return }
            store = loaded
            selectedBotId = loaded.selectedBotId ?? loaded.bots.first?.id
            PerfHarness.shared?.mark("initial_selection", ["bot": selectedBotId ?? ""])
            // The chat the app opens on is painted from its snapshot in the
            // same pass that shows the window, not after the reads below.
            if let first = selectedBotId, transcript.isEmpty { restoreChat(first) }
            phase = .ready
            PerfHarness.shared?.run(model: self)
            // The chat's load starts first; the operator and composer reads
            // share nothing with it and no longer hold it back.
            startReload()
            let firstLoad = reloadTask
            await loadOperator()
            await refreshComposer()
            await firstLoad?.value
            await pollApprovals()
            // The first-run gate and the skipped-setup bar read these. Not
            // awaited: a cold live-model refresh can take seconds.
            Task { await self.loadProviders() }
            startPolling()
            startPrewarm()
        } catch is CancellationError {
            return
        } catch {
            guard !Task.isCancelled, attempt == startAttempt else { return }
            threadError = (error as? LocalizedError)?.errorDescription ?? "Could not reach the local server."
            phase = .unavailable
        }
    }

    func retry() async {
        // Two retries in flight would each cancel the same boot and then start
        // their own, which is the pair of supervisors `bootTask` exists to
        // prevent. The second press is a no-op instead.
        guard !retrying else { return }
        retrying = true
        defer { retrying = false }
        // First, so the attempt being replaced stops supervising the ports the
        // new one is about to.
        bootTask?.cancel()
        await bootTask?.value
        bootTask = nil
        pollTask?.cancel()
        approvalPollTask?.cancel()
        reloadTask?.cancel()
        // Let the serialised shell writes drain instead of forking a second
        // chain: cancellation is cooperative and a tail could still land.
        await saveChain?.value
        // Anything that was in flight from before this retry must not paint
        // over the fresh state.
        storeEpoch += 1
        uploadChain?.cancel()
        uploadChain = nil
        cancelSend()
        pollTask = nil
        approvalPollTask = nil
        reloadTask = nil
        loadGeneration += 1
        pending = false
        backgroundWorking = false
        started = false
        await start()
    }

    private func startPolling() {
        pollTask?.cancel()
        pollTask = Task { @MainActor [weak self] in
            // With no window on screen there is nobody to show a fresh rail
            // or thread to, so those reads drop to every fourth tick. The
            // handoff pump is not display work and keeps every tick.
            var hiddenTicks = 0
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 2_500_000_000)
                guard let self else { return }
                let visible = NSApp.windows.contains { $0.isVisible && $0.occlusionState.contains(.visible) }
                hiddenTicks = visible ? 0 : (hiddenTicks + 1) % 4
                await self.pollOnce(displayReads: visible || hiddenTicks == 0)
            }
        }
        // The web polls approvals every 1.5s while the shell is open.
        approvalPollTask?.cancel()
        approvalPollTask = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 1_500_000_000)
                guard let self else { return }
                await self.pollApprovals()
            }
        }
    }

    private func pollApprovals() async {
        guard phase == .ready else { return }
        if let items = try? await client.approvals() {
            let visible = items.filter { decidedApprovals[$0.id] == nil }
            if visible != approvals { approvals = visible }
            // A decided id stays hidden until the server stops returning it,
            // so a slow poll cannot resurface the card. In-flight busy ids
            // are owned by the decider, never by the poll.
            let live = Set(items.map(\.id))
            decidedApprovals = decidedApprovals.filter { live.contains($0.key) }
        }
    }

    private func loadOperator() async {
        // The Mac's own name first, so a slow or failed status call never
        // leaves the placeholder showing.
        let local = NSFullUserName().trimmingCharacters(in: .whitespaces)
        if !local.isEmpty, operatorName == "Desktop owner" {
            let words = local.split(separator: " ").compactMap(\.first)
            operatorName = local
            operatorInitials = words.count > 1 ? (String(words[0]) + String(words[1])).uppercased() : String(local.prefix(2)).uppercased()
        }
        guard let status = try? await client.status() else { return }
        appStatus = status
        // The Mac account's full name wins; the service reads the same one
        // (`id -F`) and falls back to the login name only when it can't.
        let full = NSFullUserName().trimmingCharacters(in: .whitespaces)
        let words = full.split(separator: " ").compactMap(\.first)
        if !full.isEmpty, words.count > 1 {
            operatorName = full
            operatorInitials = (String(words[0]) + String(words[1])).uppercased()
        } else if !full.isEmpty {
            operatorName = full
            operatorInitials = String(full.prefix(2)).uppercased()
        } else if let name = status.name, !name.isEmpty, let initials = status.initials, !initials.isEmpty {
            operatorName = name
            operatorInitials = initials
        }
    }

    // MARK: - Selection and reload

    /// - Parameter persist: false shows the chat without writing it as the
    /// store's selection (a forced first run lands without touching the
    /// owner's store). The idle poll leaves such a selection alone until the
    /// next real pick.
    /// Counts every pick of a bot, the one already open included, so a view
    /// covering the chat (the new-chat picker) can step aside for it.
    @Published private(set) var selectTick = 0

    func select(_ botId: String, persist: Bool = true) {
        selectTick &+= 1
        localOnlySelection = persist ? nil : botId
        guard botId != selectedBotId else {
            guard persist else { return }
            guard let store else { return }
            if store.bots.contains(where: { $0.id == botId }) {
                if store.selectedBotId != botId {
                    self.store?.selectedBotId = botId
                    persistSelection(botId)
                }
            } else {
                // The id no longer exists; repair instead of persisting it.
                reconcileSelection(store)
            }
            return
        }
        // Before the stash: leaving a long chat is part of the switch's cost.
        PerfHarness.shared?.mark("select_start", ["bot": botId])
        // Stash the outgoing turn so it keeps running. Switching used to
        // cancel the server session, which is why a bot stopped the moment
        // the owner opened another chat.
        stashCurrentThread()
        attachError = nil
        threadError = nil
        stickyThreadError = nil
        saveError = nil
        memoryNotes = nil
        memoryError = nil
        selectedBotId = botId
        clearRoutineState()
        // Clear the old thread synchronously so the new bot never flashes the
        // previous transcript while its state loads. Do not cancel the
        // outgoing send: that turn belongs to the bot we left.
        resetThread()
        restoreChat(botId)
        sendBotId = sendTasks[botId] != nil ? botId : nil
        sendTask = sendTasks[botId]
        // A turn that failed shows as its row once the replay is in; only a
        // failure with no turn to sit under is a note.
        if let err = sendErrors[botId], !err.resendable {
            stickyThreadError = err.message
            threadError = err.message
        }
        // A send that died before it reached the server gives its text and its
        // files back here, because the composer was cleared when the turn was
        // committed and this chat was not on screen to take them.
        if let unsent = unsentDrafts.removeValue(forKey: botId) {
            restoreUnsentDraft(unsent.text, sentAttachments: unsent.attachments)
        }
        startReload()
        if persist { persistSelection(botId) }
    }

    /// A selection shown but deliberately not stored; see `select(_:persist:)`.
    private var localOnlySelection: String?

    /// The bot a persistSelection write is still trying to store. While it is
    /// set the idle poll must not switch away from the locally chosen bot on
    /// the strength of the server's stale pointer.
    private var pendingSelectionBotId: String?

    /// Persist the selection through the select shell action, without
    /// applying the echoed store (that would re-enter this method).
    private func persistSelection(_ botId: String) {
        pendingSelectionBotId = botId
        enqueue { [weak self] in
            guard let self else { return }
            let action = ShellActions.select(botId: botId)
            do {
                _ = try await self.client.shellAction(action)
            } catch {
                // One retry covers a blip. If the select write never lands,
                // say so and stop fencing the poll, which then repairs the
                // selection from the server's pointer on the next read.
                do {
                    _ = try await self.client.shellAction(action)
                } catch {
                    // Only this write's fence: a newer select queued behind
                    // it owns the fence now, and clearing it would let the
                    // poll bounce back before that write lands.
                    if self.pendingSelectionBotId == botId {
                        self.pendingSelectionBotId = nil
                        self.saveError = "Could not save the selection."
                    }
                }
            }
        }
    }

    func reloadThread() async {
        loadGeneration += 1
        let generation = loadGeneration
        reloadTask?.cancel()
        followTask?.cancel()
        let task = Task { @MainActor [weak self] in
            guard let self else { return }
            await self.performReload(generation)
        }
        reloadTask = task
        await task.value
    }

    private func startReload() {
        loadGeneration += 1
        let generation = loadGeneration
        reloadTask?.cancel()
        followTask?.cancel()
        reloadTask = Task { @MainActor [weak self] in
            guard let self else { return }
            await self.performReload(generation)
        }
    }

    private func performReload(_ generation: Int) async {
        guard let bot = selectedBot else { return }
        // Taken once: a restore put this chat on screen and said how far its
        // session was read. Any later reload of it reads from zero.
        let resume = resumePoint
        resumePoint = nil
        do {
            // Which event is the newest one recorded, asked beside the durable
            // read. Everything up to it is history. eve's own answer to that,
            // the tail index, costs a pass over every chunk file of the
            // session before the first byte (1.25 s on a 12,554-event chat);
            // this reads one file. Nil falls back to the tail index.
            let probed = sendTasks[bot.id] == nil ? bot.sessionId ?? "" : ""
            let client = client
            async let newest: String? = probed.isEmpty ? nil : client.newestEventId(sessionId: probed)
            let state = try await client.threadState(botId: bot.id)
            let marker = await newest
            guard generation == loadGeneration else { return }
            // Durable rows render before the session replay starts, so a long
            // transcript appears at once instead of after the stream goes idle.
            durableEvents = state.events
            proposals = state.proposals
            // A send this app started still owns the live projection. Do not
            // wipe it and replay underneath: the send task is painting, and
            // the owner just came back to watch it.
            let localSend = sendTasks[bot.id] != nil
            // Whether a turn is actually running, which `pending` alone does
            // not say while the replay walks a settled conversation. Declared
            // out here because the working row below is decided on it too.
            var liveTurn = ReplayGate.LiveTurn()
            // True once the history burst has gone quiet. Out here with
            // `liveTurn` because the working row below is decided on both.
            var drained = false
            // Where the newest event sat against the end of the recorded
            // history, when the server says.
            var historyRemaining: Int?
            // A chat put back from its snapshot reads on from where the
            // snapshot stopped. It was taken at rest, so every event past its
            // cursor is one the projection has not seen, applied exactly as a
            // replay from zero would apply it; `ChatSnapshotTests` pins that.
            var resumed = false
            if !localSend, let resume, let marker, let sessionId = bot.sessionId,
               resume.sessionId == sessionId, resume.next > 0, let resumeLast = resume.lastEventId,
               !projection.pending {
                followCursor = (sessionId, resume.next, resume.lastEventId)
                if marker == resume.lastEventId {
                    // Nothing was recorded after the snapshot: the rows on
                    // screen are the whole session, and nothing is read.
                    resumed = true
                } else {
                    let durableIds = Set(state.events.map(\.id))
                    // The read starts one event early, on the event the
                    // snapshot ended on. Any other event there means the
                    // snapshot does not describe this session (its cursor is
                    // past the end, or the session is not the one it read),
                    // and waiting for the marker could then never end.
                    var anchored = false
                    do {
                        for try await event in client.stream(
                            sessionId: sessionId,
                            startIndex: resume.next - 1,
                            markHistory: true,
                            historyMarker: marker
                        ) {
                            guard generation == loadGeneration else { return }
                            if sendTasks[bot.id] != nil { return }
                            if !anchored {
                                guard event.index == resume.next - 1, event.id == resumeLast else {
                                    throw BackendError.streamInterrupted
                                }
                                anchored = true
                                continue
                            }
                            historyRemaining = event.historyRemaining
                            if let index = event.index { followCursor = (sessionId, index + 1, event.id) }
                            noteTurnId(event, sessionId: sessionId)
                            // A turn this app's own send painted to its end is
                            // already in the projection; the follower passes
                            // over it the same way.
                            if let turnId = event.turnId,
                               localTurnIds[sessionId]?.contains(turnId) == true,
                               event.type != "input.resolved" {
                                continue
                            }
                            let novel = event.id.map { !durableIds.contains($0) } ?? false
                            liveTurn.apply(event, atLiveTail: true, novel: novel)
                            projection.apply(event, live: true)
                        }
                        // A marker read that finished reached the marker, even
                        // one whose line this build could not decode.
                        historyRemaining = 0
                        resumed = true
                    } catch is CancellationError {
                        return
                    } catch {
                        // The read never reached the newest event: the
                        // snapshot is ahead of the session, or the read
                        // dropped. A replay from zero below is always right,
                        // and it rebuilds beside the rows on screen.
                        snapshotLog.notice("resume missed its marker, replaying from zero: \(String(describing: error), privacy: .public)")
                    }
                }
            }
            if !resumed, !localSend, let sessionId = bot.sessionId, !sessionId.isEmpty {
                // The durable rows already render the whole history, so the
                // replay is applied silently and only starts publishing once
                // `ReplayGate` says it reached the live tail. A turn still
                // running (a handoff, a routine, a send started before a
                // switch) publishes live from that point so coming back shows
                // the working row and the tokens as they arrive.
                let durable = ReplayGate.Durable(events: state.events)
                var atLiveTail = durable.startsLive
                // History arrives in one burst from the loopback server, so a
                // gap in it means the burst is over and whatever comes next is
                // happening now. Until then every event is the past being read
                // back, however recent: a card dismissed a second ago replays
                // exactly like one dismissed an hour ago.
                // Seeded on the first event, never before it: the wait for
                // the stream to open is not a gap inside the burst, and a slow
                // open would otherwise read as one.
                var lastEventAt: Date?
                // A replay is never applied over rows that are already on
                // screen. The projection forgets the oldest event ids it has
                // seen, so a session longer than that cache re-appended the
                // messages it no longer recognised, and the owner saw their
                // turn twice. It is rebuilt beside the old one instead and
                // swapped in once it holds as much, which keeps the chat from
                // blanking for the length of the replay.
                let baseline = projection.messages.count
                // Its trailing bubble too: during a live turn the replay
                // reaches the same message count while that bubble still holds
                // only its first delta, and swapping there would run the reply
                // backwards on screen until the rest arrived.
                let baselineTail = projection.messages.last?.text.count ?? 0
                var replay = StreamProjection()
                var swapped = false
                historyRemaining = nil
                // This replay starts at zero and ends holding the whole
                // session, so the follower's cursor is rebuilt with it.
                followCursor = (sessionId, 0, nil)
                localTurnIds[sessionId] = nil
                if baseline == 0, !projection.pending {
                    // Nothing to preserve: the reload owns the projection. A
                    // turn that has only started has no rows yet but is
                    // pending, and keeps its working state.
                    projection = StreamProjection()
                    rebuildTranscript()
                    backgroundWorking = false
                    swapped = true
                }
                var sawFirstReplayEvent = false
                for try await event in client.stream(sessionId: sessionId, markHistory: true, historyMarker: marker) {
                    guard generation == loadGeneration else { return }
                    if !sawFirstReplayEvent {
                        sawFirstReplayEvent = true
                        PerfHarness.shared?.mark("replay_first_event", ["bot": bot.id, "baselineRows": baseline])
                    }
                    historyRemaining = event.historyRemaining
                    // A send started while this replay was running. It owns the
                    // projection from that moment, and the row it painted must
                    // not be replaced by a replay that predates it.
                    if sendTasks[bot.id] != nil { return }
                    if let index = event.index { followCursor = (sessionId, index + 1, event.id) }
                    noteTurnId(event, sessionId: sessionId)
                    if !atLiveTail {
                        atLiveTail = ReplayGate.reachedLiveTail(durable: durable, event: event)
                    }
                    let now = Date()
                    if let last = lastEventAt, now.timeIntervalSince(last) > Self.replayBurstGap {
                        drained = true
                    }
                    lastEventAt = now
                    // An id the durable store never wrote arrived after this
                    // reload read the transcript, so the turn is now. The gap
                    // is the other half: a turn already durable when the replay
                    // started is proved live by the burst going quiet instead.
                    let novel = event.id.map { !durable.ids.contains($0) } ?? false
                    liveTurn.apply(event, atLiveTail: atLiveTail, novel: novel)
                    if swapped {
                        projection.apply(event, live: atLiveTail)
                    } else {
                        replay.apply(event, live: atLiveTail)
                        // Equal counts only settle it once there is a row to
                        // compare: with none on screen, the swap waits for the
                        // replay's first message rather than firing on the
                        // session's first event and dropping a kept turn's
                        // working state.
                        let caughtUp = replay.messages.count > baseline
                            || (baseline > 0
                                && replay.messages.count == baseline
                                && (replay.messages.last?.text.count ?? 0) >= baselineTail)
                        if caughtUp {
                            projection = replay
                            swapped = true
                        }
                    }
                    // Publish either way, so a turn that is running paints its
                    // tokens as they arrive. The working row waits for a turn
                    // that is in flight AND for the replay to have drained:
                    // mid-burst, a finished turn reads as pending for the
                    // stretch between its last reply and its terminal event,
                    // and that is what flashed a working row on a settled chat.
                    if swapped, atLiveTail {
                        let working = ReplayGate.mayShowWorking(
                            historyRemaining: historyRemaining,
                            drained: drained,
                            novelStart: liveTurn.novelStart
                        )
                            && liveTurn.running
                            && projection.pending
                        if backgroundWorking != working { backgroundWorking = working }
                        markWorking(bot.id, working)
                        // Nothing is painted while the read is still inside
                        // the history the server counted out. A chat whose rows
                        // live in the session starts "live" from its first
                        // event, so every one of several thousand old events
                        // published, each publish laid the whole chat out
                        // again, and opening a long chat held the main thread
                        // for minutes. The forced publish after the loop paints
                        // the history once; a server that sends no count keeps
                        // the old behaviour.
                        if (historyRemaining ?? 0) <= 0 { publishTranscript() }
                    }
                }
                if marker != nil { historyRemaining = 0 }
                PerfHarness.shared?.mark("replay_done", ["bot": bot.id])
                if !swapped, sendTasks[bot.id] == nil {
                    // The session holds fewer messages than the rows on screen
                    // (it was cleared or replaced elsewhere). The replay is
                    // still the authority on what this chat is.
                    projection = replay
                }
            }
            guard generation == loadGeneration else { return }
            // A send of this app's is painting over a history that never
            // finished loading: the chat was left before its first replay was
            // in, and came back while the send ran. Those rows are not the
            // chat, so it is not marked loaded and the transcript does not land
            // on them; the follower replays from zero once the send is done.
            if localSend, !loadSucceeded, !readyStashes.contains(bot.id) {
                pending = true
                followTask?.cancel()
                followTask = Task { @MainActor [weak self] in
                    guard let self else { return }
                    await self.followSession(generation: generation)
                }
                return
            }
            // Every row is in, so the transcript can be built and laid out once,
            // already at its newest turn. Marked ready first, so the publish
            // below is the one that counts as this chat's loaded state.
            transcriptReady = true
            loadSucceeded = true
            completedLoad = generation
            publishTranscript(force: true)
            PerfHarness.shared?.mark("publish_done", ["bot": bot.id])
            if sendTasks[bot.id] != nil {
                pending = true
            } else {
                // A replay that simply ran out of events is not a turn in
                // flight. eve parks a session between turns, and its terminal
                // event can be written after this read, which left `pending`
                // true on a chat where nothing was happening.
                // Same two signals as inside the loop. A card turn leaves the
                // durable tail on the owner's own message, so `running` alone
                // is true at the end of a replay eve has parked without writing
                // its terminal event yet, and the row would stay up on a chat
                // where nothing is happening.
                let working = ReplayGate.mayShowWorking(
                    historyRemaining: historyRemaining,
                    drained: drained,
                    novelStart: liveTurn.novelStart
                )
                    && liveTurn.running
                    && projection.pending
                backgroundWorking = working
                markWorking(bot.id, working)
            }
            // A send's own failure banner belongs to the bot that sent it; a
            // switch in the meantime must not show it on the new bot. A
            // recorded background error wins over the replay's generic line.
            // A failed turn is a row in the replayed transcript, so only a
            // failure with no turn to sit under becomes the note.
            // A failure the replay answers (a turn failure it no longer ends
            // on, a reply that could not be read and is here now) goes.
            if let recorded = sendErrors[bot.id], !recorded.survivesReload,
               !projection.failed, sendTasks[bot.id] == nil {
                sendErrors[bot.id] = nil
            }
            if let recorded = sendErrors[bot.id], !recorded.resendable {
                // The rest stay said until the owner dismisses them or sends
                // again: a send that never arrived put its draft back, and
                // without this the note went with the reload that followed.
                stickyThreadError = recorded.message
                threadError = recorded.message
            } else {
                let sticky = selectedBotId == sendBotId ? stickyThreadError : nil
                // A drawing that could not be saved while this chat was in
                // the background says so when the owner comes back.
                threadError = sticky ?? widgetSaveErrors[bot.id]
            }
            // The replay above ends once the stream has been idle a few
            // seconds, and nothing reopened it. Hand the transcript over to
            // the session follower, so a turn started elsewhere for this bot
            // (a routine run, a handoff delivery, a send from the phone)
            // still reaches it while the chat stays open.
            followTask?.cancel()
            followTask = Task { @MainActor [weak self] in
                guard let self else { return }
                await self.followSession(generation: generation)
            }
            scheduleSnapshot()
        } catch is CancellationError {
            return
        } catch {
            guard generation == loadGeneration else { return }
            transcriptReady = true
            // A send that failed says why on its own; the reload it triggers
            // failing for the same reason must not replace that with this.
            threadError = stickyThreadError ?? (error as? LocalizedError)?.errorDescription ?? "Thread failed to load."
            // No replay ran to confirm a restored turn is still going, so do
            // not leave its working row and rail pulse up on a guess.
            if sendTasks[bot.id] == nil {
                backgroundWorking = false
                markWorking(bot.id, false)
            }
        }
    }

    /// Keep the open bot's session followed after the load's replay stream has
    /// ended. The stream finishes about three seconds after its last event, so
    /// this reopens it in a loop with a short backoff, keeping the stream alive
    /// across reconnects. A turn started
    /// elsewhere for this bot (a routine run, a handoff delivery, a send from
    /// the phone) then reaches the transcript as it happens instead of
    /// waiting for the bot to be re-selected.
    ///
    /// Each read starts at `followCursor`, so it carries only events the
    /// projection has not seen, however long the session is.
    ///
    /// The loop only runs while this bot stays selected; a switch bumps
    /// `loadGeneration`, which cancels it here. While a local send is pending
    /// it parks instead of following: the send's own stream owns the session
    /// for that stretch. A local send does not reload when it succeeds, so the
    /// pointer is re-read every cycle rather than captured once.
    private func followSession(generation: Int) async {
        while generation == loadGeneration,
              let live = selectedBot,
              live.id == selectedBotId {
            if pending {
                try? await Task.sleep(nanoseconds: 500_000_000)
                continue
            }
            guard let sessionId = live.sessionId, !sessionId.isEmpty else {
                // A fresh chat has no session yet; a send will make one.
                try? await Task.sleep(nanoseconds: 2_000_000_000)
                continue
            }
            guard let cursor = followCursor, cursor.sessionId == sessionId else {
                // No position in this session: the pointer moved to one made
                // elsewhere (a web send or a routine run minted it), or the
                // load came back to a send in flight and replayed nothing.
                // Only a load from zero can say what the projection holds, and
                // it starts the next follower itself.
                startReload()
                return
            }
            do {
                var handedOff = false
                for try await event in client.stream(sessionId: sessionId, startIndex: cursor.next) {
                    guard generation == loadGeneration,
                          let current = selectedBot, current.id == selectedBotId else { return }
                    // Checked before the cursor moves: an event left unapplied
                    // here is read again on the next cycle.
                    if pending || current.sessionId != sessionId {
                        handedOff = true
                        break
                    }
                    if let index = event.index { followCursor = (sessionId, index + 1, event.id) }
                    noteTurnId(event, sessionId: sessionId)
                    // A local send painted its own turn. An answer to a
                    // question carries the asking turn's id but arrives after
                    // that turn completed, and skipping it with the rest left
                    // an answered question on screen.
                    if let turnId = event.turnId,
                       localTurnIds[sessionId]?.contains(turnId) == true,
                       event.type != "input.resolved" {
                        continue
                    }
                    projection.apply(event, live: true)
                    if backgroundWorking != projection.pending { backgroundWorking = projection.pending }
                    markWorking(current.id, projection.pending)
                    // A background turn that fails (a routine run, a handoff,
                    // a web send) must show the same banner a local one does,
                    // or it leaves a truncated reply with no explanation.
                    if event.type == "turn.failed" || event.type == "session.failed", projection.failed {
                        recordSendError(
                            current.id,
                            projection.failure?.message ?? "The turn failed.",
                            // A sub-agent's report turn has no owner message to resend.
                            resendable: projection.retryableMarkId != nil,
                            retryAfter: projection.failure?.coolDownSeconds
                        )
                    } else if ["turn.started", "turn.completed", "turn.cancelled"].contains(event.type),
                              !projection.failed {
                        sendErrors[current.id] = nil
                        if selectedBotId == current.id {
                            stickyThreadError = nil
                            threadError = nil
                        }
                    }
                    publishTranscript()
                    if Self.restingEvents.contains(event.type), !projection.pending { scheduleSnapshot() }
                }
                if handedOff { continue }
            } catch is CancellationError {
                return
            } catch {
                // A dropped follow stream is not a thread failure: the idle
                // poll keeps the durable rows fresh and the next cycle
                // reopens from the same cursor.
            }
            guard generation == loadGeneration,
                  let after = selectedBot, after.id == selectedBotId else { return }
            // The pointer can move while the stream sat idle (a web send or a
            // routine run minted a new session); the next cycle sees a cursor
            // for the wrong session and reloads.
            if after.sessionId != sessionId { continue }
            try? await Task.sleep(nanoseconds: 2_000_000_000)
        }
    }

    private func pollOnce(displayReads: Bool = true) async {
        guard phase == .ready else { return }
        // Handoffs and the rail keep pumping during a turn; the web ticks on
        // the same cadence as its stream rather than waiting for it to end.
        pumpHandoffs()
        guard displayReads else { return }
        let generation = loadGeneration
        let polledBotId = selectedBotId
        do {
            // The rail keeps refreshing during a turn, so a section or bot a
            // tool changes shows up while the reply is still streaming. The
            // send still owns its bot's session echo: touchChat may not have
            // landed yet, and the fresh copy must not revert the optimistic
            // pointer and preview stamped by updateSession. Only the idle poll
            // repairs the selection; a server-driven switch mid-turn would
            // cancel the turn, and the poll after it settles does that work.
            var fresh = try await client.shell()
            guard generation == loadGeneration, polledBotId == selectedBotId else { return }
            // Every in-flight send owns its session echo, selected or not:
            // touchChat may not have landed yet, and the fresh copy must not
            // revert the pointer a background turn is still writing.
            for (botId, sessionId) in inflightSessions {
                guard let local = store?.bots.first(where: { $0.id == botId }),
                      let index = fresh.bots.firstIndex(where: { $0.id == botId }) else { continue }
                fresh.bots[index].sessionId = sessionId
                fresh.bots[index].lastPreview = local.lastPreview
                fresh.bots[index].lastAt = local.lastAt
            }
            // A chat whose session was cleared or replaced somewhere else (the
            // phone, a bot, a routine) has nothing in common with what this
            // app holds for it. Without this the old messages stayed up until
            // the owner switched chats and back.
            let moved = movedSessions(from: store, to: fresh)
            for botId in moved {
                backgroundProjections[botId] = nil
                transcriptCache[botId] = nil
                stashSnapshots[botId] = nil
                forgetTurnIds(of: store?.bots.first { $0.id == botId }?.sessionId)
            }
            // Only a real change is published. Every view observes this whole
            // model, so assigning an identical store redrew the window, and
            // re-laid out the transcript, every 2.5 s with nothing happening.
            let storeChanged = fresh != store
            if storeChanged { store = fresh }
            if let current = polledBotId, moved.contains(current), !pending {
                resetThread()
                rebuildTranscript()
                startReload()
                return
            }
            if !pending {
                // A poll can be the first to see a server-side delete; repair
                // the selection the same way an action echo does. A send on
                // this bot still fences that, so a stale pointer cannot yank
                // the owner off a live turn.
                reconcileSelection(fresh)
            }
            guard let bot = selectedBot, bot.id == polledBotId else { return }
            let state = try await client.threadState(botId: bot.id)
            guard generation == loadGeneration, polledBotId == selectedBotId else { return }
            // A card also closes by the clock (its TTL), with no change on the
            // wire, so the open set is compared as well as the list.
            let openIds = Set(state.proposals.filter { $0.isOpen() }.map(\.id))
            if proposals != state.proposals || openIds != polledOpenProposalIds {
                proposals = state.proposals
            }
            polledOpenProposalIds = openIds
            pruneBusyProposals()
            if !pending {
                // The rows depend on the durable events, on the roster (group
                // attribution reads names from the store) and on today's date
                // (the day dividers say Today and Yesterday). Live text comes
                // through publishTranscript, not through here.
                let day = Calendar.current.startOfDay(for: Date())
                if durableEvents != state.events || storeChanged || day != polledTranscriptDay {
                    durableEvents = state.events
                    polledTranscriptDay = day
                    rebuildTranscript()
                }
                // A sticky turn-failure banner is cleared by send/select, not
                // by an idle poll that knows nothing new.
            }
            await refreshComposer()
            // Only while the pane is open: a routine run that lands mid-poll
            // has to show up without the owner reopening the pane.
            if pane == .details { await loadRoutines(botId: bot.id) }
            pollAuthFailures = 0
        } catch let error as BackendError where error == .unauthorized {
            // Never leave the shell silently stuck on a rejected session.
            pollAuthFailures += 1
            if pollAuthFailures >= 2 {
                threadError = "The local server rejected this app. Reload, or restart the app."
            }
        } catch {
            pollAuthFailures = 0
            /* keep the last view; the next poll retries */
        }
    }

    /// What the last poll saw, for the two things that change a published
    /// value without changing the wire: a proposal reaching its TTL and the
    /// calendar day the dividers are labelled against.
    private var polledOpenProposalIds: Set<String> = []
    private var polledTranscriptDay: Date?
    private var polledRoutinesDay: Date?

    /// Bots whose last session pointer this app could not save.
    private var unsavedSessionBots: Set<String> = []

    /// Bots whose session pointer differs between two copies of the store, not
    /// counting any this app is sending on: a send writes its own pointer and
    /// the poll must not mistake that for a change made elsewhere.
    private func movedSessions(from old: ShellStore?, to fresh: ShellStore) -> Set<String> {
        guard let old else { return [] }
        var moved: Set<String> = []
        for bot in fresh.bots {
            guard let before = old.bots.first(where: { $0.id == bot.id }) else { continue }
            if (before.sessionId ?? "") == (bot.sessionId ?? "") { continue }
            if sendTasks[bot.id] != nil || inflightSessions[bot.id] != nil { continue }
            // The pointer this app holds never reached the server, so the
            // server's older one is a failed save, not a change made elsewhere.
            // The reply on screen must survive that.
            if unsavedSessionBots.remove(bot.id) != nil { continue }
            moved.insert(bot.id)
        }
        return moved
    }

    private func pumpHandoffs() {
        guard !tickInFlight else { return }
        tickInFlight = true
        Task { @MainActor [weak self] in
            guard let self else { return }
            let polled = await self.client.tick()
            if let ids = polled {
                let next = Set(ids)
                // Handoffs and routines run without a local stream, so their
                // end is only seen here. The poll can't tell a reply from a
                // failure, so a finished turn counts as a reply. An empty set
                // right after failed ticks is the service restarting, not
                // replies, so that marks nothing.
                let ended = self.handoffWorkingIds.subtracting(next)
                let reset = next.isEmpty && self.lastTickFailed
                if !reset {
                    for botId in ended where botId != self.selectedBotId
                        && botId != self.selectedAtLastTick
                        && !self.workingBotIds.contains(botId) {
                        self.markReplyReady(botId)
                    }
                }
                if next != self.handoffWorkingIds { self.handoffWorkingIds = next }
            }
            self.lastTickFailed = polled == nil
            self.selectedAtLastTick = self.selectedBotId
            self.tickInFlight = false
        }
    }

    private func pruneBusyProposals() {
        // Open cards keep their busy mark, except a connect card the poll now
        // renders in Waiting: its Authorize or Reopen was applied, so the mark
        // has done its job.
        let live = Set(proposals.filter { $0.isOpen() && !(($0.kind == .connectApp || $0.kind == .connectServer) && $0.phase == .waiting) }.map(\.id))
        let next = busyProposals.intersection(live)
        if next != busyProposals { busyProposals = next }
    }

    func refreshComposer() async {
        if let next = try? await client.composer(), next != composer {
            composer = next
        }
    }

    func saveComposer(modelId: String? = nil, effort: String? = nil, speed: String? = nil) async {
        if let next = try? await client.updateComposer(modelId: modelId, effort: effort, speed: speed) {
            composer = next
            composerError = nil
        } else {
            await refreshComposer()
            composerError = "That setting did not save."
        }
    }

    // MARK: - Send

    func send(_ text: String) {
        // The starter prompts are for before the first message.
        UserDefaults.standard.set(true, forKey: StarterPrompt.sentKey)
        send(text, retrying: false)
    }

    /// Send the owner's last message again after a turn failed.
    ///
    /// The banner's button used to reload the thread, which re-read the same
    /// failure and put the same banner straight back, so it read as dead. A
    /// failed turn is retried by sending it again; with nothing to resend
    /// (a handoff or a routine failed here, not the owner) the reload is
    /// still the best this button can do.
    func retryLastTurn() {
        guard !pending else { return }
        // The router stopped calling the provider for a few seconds. Sending
        // now is refused before it reaches a model, so the only thing a resend
        // achieves is another copy of the owner's message in the chat. Say how
        // long is left instead, and let them press it again after that.
        // The row counts the pause down and holds its button until then.
        if let until = failureRetryUntil, until > Date() { return }
        // Only a turn that never ran may be sent again. "The reply could not be
        // read" and "The session pointer could not be saved" both leave the
        // turn with the server, and resending those files a second copy of a
        // turn that already answered.
        let neverRan = SendFailure.mayResend(
            failure: selectedBotId.flatMap { sendErrors[$0] },
            replayEndedFailed: projection.failed
        )
        guard neverRan, let text = resendableLastMessage() else {
            Task { await reloadThread() }
            return
        }
        // A session whose history holds a tool call with no result refuses
        // every turn, so resending into it put the same banner straight back
        // and Retry looked dead. The message goes to a fresh session instead.
        send(text, retrying: true, freshSession: projection.failure?.historyBroken == true)
    }

    /// The owner's last message, when sending it again is the right thing to
    /// do. A turn the pump sent is not the owner's to repeat, and a turn that
    /// carried pictures cannot be repeated at all: the composer gave those
    /// files up with the send, and the row that is left names them in text
    /// that would go out as literal `[file: ...]` lines.
    private func resendableLastMessage() -> String? {
        guard let last = projection.messages.last(where: { $0.role == .user }) else { return nil }
        let text = last.text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !EveStream.isHandoffEnvelope(last.text) else { return nil }
        guard !Attachments.namesEchoedFile(last.text) else { return nil }
        return text
    }

    /// `retrying` resends a message the composer does not hold, so it must not
    /// consume the draft or the files waiting there.
    private func send(_ text: String, retrying: Bool, freshSession: Bool = false) {
        // The draft is capped in the composer; never clip the formatted
        // message here or attachment bodies and their fences get severed.
        let message = text.trimmingCharacters(in: .whitespacesAndNewlines)
        // The composer can fall back to the first bot before a selection is
        // stored; adopt it so the turn belongs to a real bot.
        if selectedBotId == nil, let fallback = selectedBot {
            selectedBotId = fallback.id
            persistSelection(fallback.id)
        }
        // Never send through the selectedBot fallback: the turn must belong to
        // the bot the composer is showing.
        guard !message.isEmpty, !pending, let bot = selectedBot else { return }
        // A server-side delete can leave the selection on the first bot until
        // the next poll repairs it, and the Send button is enabled on the
        // draft alone. Keep the draft and say why the tap did nothing rather
        // than swallowing it silently.
        guard bot.id == selectedBotId else {
            threadError = "That chat is gone. Pick another bot."
            return
        }
        // Only this bot's previous send. A teammate still working in the
        // background must not be cancelled because the owner sent here.
        cancelSend(for: bot.id)
        pending = true
        // The local send owns the working row from here; a background flag
        // left over from the follower must not outlive it.
        backgroundWorking = false
        activity = .thinking
        threadError = nil
        stickyThreadError = nil
        sendErrors[bot.id] = nil
        widgetSaveErrors[bot.id] = nil
        sendGenerations[bot.id] = (sendGenerations[bot.id] ?? 0) + 1
        let generation = sendGenerations[bot.id] ?? 1
        let chatGen = chatGenerations[bot.id] ?? 0
        sendBotId = bot.id
        markWorking(bot.id, true)
        let draftSnapshot = retrying ? "" : draft
        // Only this chat's reply rides with this send; one started in
        // another chat stays there.
        let quoteSnapshot = retrying ? nil : replyQuotes[bot.id]
        let sentAttachments = retrying ? [] : attachments
        let sentAttachmentIds = Set(sentAttachments.map(\.id))
        // Pictures ride beside the text as file parts; the composed string
        // already names each one. eve echoes such a turn as the text plus one
        // `[file: ...]` line per image, and that echo is what the optimistic
        // row, the rail preview and the stream arming have to match.
        let images = sentAttachments.filter(\.isImage)
        SentImageStore.keep(images, botId: bot.id)
        let echo = Attachments.echoedMessage(message, images: images)
        // Appended to the projection that is already on screen, never a fresh
        // one built from the durable rows. The durable store holds only the
        // side channel (notes, proposals, handoffs) while the conversation
        // itself lives in the eve session and reaches us by replay, so
        // rebuilding from durable rows erased every message the reader could
        // see and left them alone with the line they had just sent until the
        // turn finished and the replay put it all back.
        // A new turn owns its own outcome: whatever the last one did, this one
        // has not failed yet.
        projection.beginTurn()
        projection.apply(EveEvent(
            type: "message.received",
            id: "\(EveStream.optimisticUserPrefix)\(UUID().uuidString)",
            message: echo
        ), live: true)
        rebuildTranscript()
        // The composer empties the moment the turn is committed, not when the
        // server answers. Waiting for the round trip left the sent text sitting
        // in the field for as long as the network took, which reads as a send
        // that did not happen. `draftSnapshot` is what puts it back if the
        // send fails below.
        if !retrying {
            clearSentComposer(draft: draftSnapshot, attachmentIds: sentAttachmentIds)
            if let quoteSnapshot, replyQuotes[bot.id] == quoteSnapshot { replyQuotes[bot.id] = nil }
        }
        // An explicit send is an explicit request to watch the answer, so the
        // transcript follows it whatever the reader was doing before.
        sendTick &+= 1
        let task = Task { @MainActor [weak self] in
            guard let self else { return }
            // True once the POST answered: the server has the turn, so a
            // later failure lost the reply, not the send.
            var delivered = false
            do {
                // Snapshot the turn ids first so a resend of identical text
                // cannot arm on the earlier turn. A snapshot that cannot be
                // fetched is not the same as an empty one: start a fresh
                // session instead of risking a mis-armed stream.
                var history = Set<String>()
                // Where this send's stream starts reading. Taken with the
                // snapshot, before the turn is posted, so the new turn cannot
                // sit behind it; zero when the server did not report a tail.
                var streamStart = 0
                // Whether a message with no turn id may be taken for this
                // send's turn. Only when the whole session was read and showed
                // no turn ids at all, which is what an empty set used to mean.
                var untaggedMayArm = true
                var sendSessionId = bot.sessionId
                // The session a fresh one carries over from. The proxy folds a
                // brief of it into the new session's first turn, so the bot
                // keeps the thread instead of starting over empty.
                var continueFrom: String?
                if freshSession {
                    // Posted as a new session. The old pointer stays until the
                    // new one replaces it, so a post that fails leaves the
                    // broken chat readable rather than gone.
                    continueFrom = sendSessionId
                    sendSessionId = nil
                }
                if let sessionId = sendSessionId, !sessionId.isEmpty {
                    do {
                        // The follower has already read this session up to its
                        // cursor, so the snapshot only needs what came after,
                        // but only for a session this app has seen tag its
                        // turns: those ids, not the short read, are what rule
                        // out an old turn, and they let the untagged arm stay
                        // shut. Anything else is read whole, as it always was.
                        let known = self.seenTurnIds[sessionId] ?? []
                        let held = known.isEmpty || self.tailUnreported
                            ? 0
                            : (self.followCursor.flatMap { $0.sessionId == sessionId ? $0.next : nil } ?? 0)
                        let snapshot = try await self.client.historySnapshot(sessionId: sessionId, readFrom: held)
                        if snapshot.nextIndex == nil { self.tailUnreported = true }
                        history = snapshot.turnIds.union(known)
                        untaggedMayArm = held == 0 && history.isEmpty
                        streamStart = snapshot.nextIndex ?? 0
                    } catch BackendError.http(404) {
                        // eve no longer has the session at all: there is
                        // nothing to join or carry over, so a fresh one starts.
                        sendSessionId = nil
                    }
                    // Any other read failure is not a reason to leave the
                    // session: it may be alive and holding the whole
                    // conversation, and starting a new one here dropped all of
                    // it without a word. It throws, the send fails before
                    // delivery and the draft comes back.
                }
                guard self.sendStillCurrent(bot.id, generation: generation, chatGen: chatGen) else {
                    self.finishSend(botId: bot.id, generation: generation)
                    return
                }
                let sessionId: String
                // True when this send makes the session rather than joining
                // one, which is the only case where nothing older exists.
                var createdSession = (sendSessionId ?? "").isEmpty
                do {
                    sessionId = try await self.postSession(
                        botId: bot.id,
                        sessionId: sendSessionId,
                        message: message,
                        images: images,
                        continueFrom: continueFrom,
                        retry: retrying
                    )
                } catch BackendError.sessionEnded where sendSessionId != nil {
                    // eve retires a session whose turn failed, and the stored
                    // pointer kept sending every later message to it: 409 on
                    // each, a chat that looked dead. Start a fresh session
                    // with this same message, carried over from the retired
                    // one. The pointer is not dropped first: the proxy checks
                    // the carry-over against it, and the new session replaces
                    // it below. The turn ids snapshot belongs to the old
                    // session, so it is cleared too.
                    guard self.sendStillCurrent(bot.id, generation: generation, chatGen: chatGen) else {
                        self.finishSend(botId: bot.id, generation: generation)
                        return
                    }
                    history = []
                    streamStart = 0
                    untaggedMayArm = true
                    createdSession = true
                    sessionId = try await self.postSession(
                        botId: bot.id,
                        sessionId: nil,
                        message: message,
                        images: images,
                        continueFrom: sendSessionId,
                        retry: retrying
                    )
                }
                delivered = true
                if createdSession, self.selectedBotId == bot.id {
                    // A session this send created holds nothing older than the
                    // send, so the follower can start at its first event. Asked
                    // of the send itself, not of the stored pointer: that can
                    // be re-stamped by a poll between the snapshot and here.
                    self.followCursor = (sessionId, 0, nil)
                }
                guard self.sendStillCurrent(bot.id, generation: generation, chatGen: chatGen) else {
                    // The turn was stopped (Stop or New Chat) while it was
                    // being created: the session exists now, so cancel it
                    // best-effort instead of leaving it burning with no UI.
                    // A switch to another bot does not land here: that does
                    // not bump this bot's send generation.
                    Task { [weak self] in
                        _ = try? await self?.client.cancel(sessionId: sessionId)
                    }
                    self.finishSend(botId: bot.id, generation: generation)
                    return
                }
                self.inflightSessions[bot.id] = sessionId
                if self.selectedBotId == bot.id {
                    self.activeSession = (bot.id, sessionId)
                }
                // The turn is accepted: clear only what this send owned, so
                // text or files added while it was in flight survive.
                // A reply's preview is what the owner wrote, not the quote.
                await self.updateSession(botId: bot.id, sessionId: sessionId, preview: Self.previewText(ReplyQuote.split(echo)?.body ?? echo))
                guard self.sendStillCurrent(bot.id, generation: generation, chatGen: chatGen) else {
                    self.finishSend(botId: bot.id, generation: generation)
                    return
                }
                var sawUserTurn = false
                for try await event in self.client.stream(
                    sessionId: sessionId,
                    expectedSuffix: echo,
                    historyTurnIds: history,
                    startIndex: streamStart,
                    allowUntaggedTurn: untaggedMayArm
                ) {
                    guard self.sendStillCurrent(bot.id, generation: generation, chatGen: chatGen) else {
                        self.finishSend(botId: bot.id, generation: generation)
                        return
                    }
                    if event.type == "message.received" { sawUserTurn = true }
                    self.noteTurnId(event, sessionId: sessionId)
                    // Only a turn this stream painted to its end is the
                    // follower's to pass over. One it lost part-way (Stop, a
                    // dropped connection) still has events to show, and the
                    // follower reads them from its cursor; the ones already
                    // applied here fall to the projection's id dedupe.
                    if let turnId = event.turnId, !turnId.isEmpty,
                       ["turn.completed", "turn.cancelled", "turn.failed"].contains(event.type) {
                        self.localTurnIds[sessionId, default: []].insert(turnId)
                    }
                    self.applyLiveEvent(event, botId: bot.id)
                }
                if self.selectedBotId == bot.id {
                    self.publishTranscript(force: true)
                }
                guard self.sendStillCurrent(bot.id, generation: generation, chatGen: chatGen) else {
                    self.finishSend(botId: bot.id, generation: generation)
                    return
                }
                let live: StreamProjection? = self.selectedBotId == bot.id
                    ? self.projection
                    : self.backgroundProjections[bot.id]
                if live?.failed == true {
                    self.recordSendError(
                        bot.id,
                        live?.failure?.message ?? "The turn failed.",
                        resendable: true,
                        retryAfter: live?.failure?.coolDownSeconds
                    )
                } else if !sawUserTurn {
                    self.recordSendError(bot.id, "The turn did not start.", resendable: false)
                }
                self.finishSend(botId: bot.id, generation: generation)
                // Not a full reload. Rebuilding the thread here reset the
                // projection to empty, and since the durable store holds no
                // conversation rows the transcript briefly had none at all:
                // the view fell back to its empty state, the scroll view was
                // torn down, and the replay then rebuilt it row by row. That
                // teardown is what made even a one-line exchange jump. The
                // rows on screen are already the right ones, so only the side
                // channel needs refreshing.
                if self.selectedBotId == bot.id {
                    await self.refreshDurable()
                }
            } catch is CancellationError {
                self.finishSend(botId: bot.id, generation: generation)
                return
            } catch {
                guard self.sendStillCurrent(bot.id, generation: generation, chatGen: chatGen) else {
                    self.finishSend(botId: bot.id, generation: generation)
                    return
                }
                if delivered {
                    // The server has the turn, so the draft stays cleared and
                    // the transcript keeps what the stream already applied.
                    // Only the reply itself is missing, so say that, then let
                    // the reload resync with what eve stored.
                    self.recordSendError(
                        bot.id,
                        (error as? LocalizedError)?.errorDescription ?? "The reply could not be read.",
                        resendable: false
                    )
                } else {
                    // The composer was cleared when the turn was committed, so
                    // a send that never reached the server has to give the text
                    // and its files back. Anything typed or attached since is
                    // kept.
                    if self.selectedBotId == bot.id {
                        self.restoreUnsentDraft(draftSnapshot, sentAttachments: sentAttachments)
                        // The quote went with the text; it comes back with it.
                    } else if !draftSnapshot.isEmpty || !sentAttachments.isEmpty {
                        // The owner is in another chat, so there is no composer
                        // to put this back into yet. Hold it for their return.
                        self.unsentDrafts[bot.id] = (draftSnapshot, sentAttachments)
                    }
                    // The quote went with the text; it comes back with it. It
                    // names its chat, so it shows there whenever the owner is.
                    if let quoteSnapshot, self.replyQuotes[bot.id] == nil,
                       self.store?.bots.contains(where: { $0.id == bot.id }) == true {
                        self.replyQuotes[bot.id] = quoteSnapshot
                    }
                    // A connection that never opened has no description of
                    // its own, and "Send failed." left the owner guessing
                    // whether the message went anywhere.
                    self.recordSendError(
                        bot.id,
                        (error is URLError ? nil : (error as? LocalizedError)?.errorDescription)
                            ?? "Couldn't reach the local server. Your message is back in the composer.",
                        resendable: false,
                        survivesReload: true
                    )
                }
                self.finishSend(botId: bot.id, generation: generation)
                if case BackendError.sessionMoved = error {
                    // The chat went on in a newer session: pick up its pointer
                    // before the reload, so the next send joins it.
                    await self.pollOnce()
                }
                if self.selectedBotId == bot.id {
                    await self.reloadThread()
                }
            }
            if generation == (self.sendGenerations[bot.id] ?? 0) {
                self.finishSend(botId: bot.id, generation: generation)
            }
        }
        sendTasks[bot.id] = task
        sendTask = task
    }

    func cancel() {
        guard let bot = selectedBot else { return }
        // Nothing live to stop: never cancel a settled session or wipe a tail
        // the user is reading. Only this bot: a teammate working in the
        // background is not Stop's target.
        guard pending || inflightSessions[bot.id] != nil || sendTasks[bot.id] != nil else { return }
        let target = inflightSessions[bot.id] ?? (activeSession?.botId == bot.id ? activeSession?.sessionId : nil) ?? bot.sessionId
        cancelSend(for: bot.id)
        pending = false
        if activeSession?.botId == bot.id { activeSession = nil }
        // Keep the rows already on screen: the conversation lives in the eve
        // session and reaches the app by replay, so clearing the projection
        // here would erase the just-sent message and any partial reply until
        // a reload puts them back. The reload below resyncs the transcript
        // with what eve actually stored.
        rebuildTranscript()
        startReload()
        Task { @MainActor [weak self] in
            guard let self else { return }
            if let target, !target.isEmpty {
                _ = try? await self.client.cancel(sessionId: target)
            }
        }
    }

    /// A starter prompt: the text goes into the composer, the caret after
    /// it, and nothing is sent.
    func fillDraft(_ text: String) {
        draft = text
        draftWriteToken &+= 1
        composerFocusToken &+= 1
    }

    /// Reply to a bot message: the chip goes above the composer of this chat
    /// and the caret into the field.
    func reply(to text: String, author: String?, botId: String) {
        // The chat on screen, including the fallback the composer shows
        // before a selection is stored.
        guard botId == selectedBot?.id else { return }
        replyQuotes[botId] = ReplyQuote(botId: botId, text: text, author: author)
        composerFocusToken &+= 1
    }

    /// Clear the composer only for the text and files this send owned, so
    /// anything typed or attached while the turn was starting survives.
    private func clearSentComposer(draft draftSnapshot: String, attachmentIds: Set<String>) {
        draft = ComposerDraft.remainder(draft, afterSending: draftSnapshot)
        draftWriteToken &+= 1
        if !attachmentIds.isEmpty {
            attachments.removeAll { attachmentIds.contains($0.id) }
        }
    }

    /// Put an unsent draft back after a send that never reached the server.
    /// Whatever was typed in the meantime stays, and goes after the returned
    /// text, so the field reads in the order it was written.
    private func restoreUnsentDraft(_ draftSnapshot: String, sentAttachments: [Attachment] = []) {
        if !draftSnapshot.isEmpty {
            if draft.isEmpty {
                draft = draftSnapshot
                draftWriteToken &+= 1
            } else if !draft.hasPrefix(draftSnapshot) {
                draft = draftSnapshot + "\n" + draft
                draftWriteToken &+= 1
            }
        }
        // The failed send owned these files: they go back in front of
        // anything attached since, without duplicating ids. The composer's cap
        // still holds, or a restore on top of a full picker would send more
        // files than the server takes.
        let current = Set(attachments.map(\.id))
        let missing = sentAttachments.filter { !current.contains($0.id) }
        guard !missing.isEmpty else { return }
        let room = max(Attachments.maxFiles - attachments.count, 0)
        if missing.count > room {
            attachError = "You can attach up to \(Attachments.maxFiles) files, so \(missing.count - room) from the failed send did not come back."
        }
        if room > 0 {
            attachments = Array(missing.prefix(room)) + attachments
        }
    }

    private func cancelSend(for botId: String? = nil) {
        let ids: [String]
        if let botId {
            ids = [botId]
        } else {
            ids = Array(Set(sendTasks.keys).union(sendGenerations.keys).union(inflightSessions.keys))
        }
        for id in ids {
            sendGenerations[id] = (sendGenerations[id] ?? 0) + 1
            sendTasks[id]?.cancel()
            sendTasks[id] = nil
            inflightSessions[id] = nil
            backgroundProjections[id] = nil
            markWorking(id, false)
            if sendBotId == id { sendBotId = nil }
            if activeSession?.botId == id { activeSession = nil }
        }
        if botId == nil || botId == selectedBotId, pending { pending = false }
        if botId == nil || botId == selectedBotId { sendTask = nil }
    }

    private func sendStillCurrent(_ botId: String, generation: Int, chatGen: Int) -> Bool {
        generation == (sendGenerations[botId] ?? 0) && chatGen == (chatGenerations[botId] ?? 0)
    }

    private func bumpChatGeneration(for botId: String) -> Int {
        let next = (chatGenerations[botId] ?? 0) + 1
        chatGenerations[botId] = next
        return next
    }

    private func finishSend(botId: String, generation: Int) {
        // A cancelled older task must not wipe a newer send on the same bot.
        guard generation == (sendGenerations[botId] ?? 0) else { return }
        sendTasks[botId] = nil
        inflightSessions[botId] = nil
        markWorking(botId, false)
        if sendBotId == botId { sendBotId = nil }
        if selectedBotId == botId {
            backgroundProjections[botId] = nil
            pending = false
            sendTask = nil
            if activeSession?.botId == botId { activeSession = nil }
            scheduleSnapshot()
        }
    }

    private func recordSendError(
        _ botId: String,
        _ message: String,
        resendable: Bool,
        retryAfter: Int? = nil,
        survivesReload: Bool = false
    ) {
        sendErrors[botId] = SendFailure(message: message, resendable: resendable, survivesReload: survivesReload)
        // A router cool-down is the one failure with a time on it. Holding the
        // deadline keeps Retry from firing back into the closed window, where
        // it fails in milliseconds and leaves a second copy of the owner's
        // message in the chat for its trouble.
        //
        // Cleared by every other failure, or a deadline armed by a cool-down
        // would outlive it: the next failure inside that window is a different
        // one, and Retry would answer it with the pause wording instead of its
        // own reason.
        if let retryAfter {
            retryNotBefore[botId] = Date().addingTimeInterval(TimeInterval(retryAfter))
        } else {
            retryNotBefore.removeValue(forKey: botId)
        }
        // A turn that ran and failed is its own row in the transcript.
        if selectedBotId == botId, !resendable {
            stickyThreadError = message
            threadError = message
        }
        if selectedBotId == botId { publishFailureRetry() }
    }

    /// When the router's cool-down lifts, per bot. A deadline in the past is
    /// simply spent, so nothing has to clear these.
    private var retryNotBefore: [String: Date] = [:]

    private func markWorking(_ botId: String, _ running: Bool) {
        let wasWorking = workingBotIds.contains(botId)
        var next = workingBotIds
        if running { next.insert(botId) } else { next.remove(botId) }
        if next != workingBotIds { workingBotIds = next }
        if running {
            if replyReady.contains(botId) { replyReady.remove(botId) }
        } else {
            if backgroundActivities[botId] != nil { backgroundActivities[botId] = nil }
            // A turn that ended with an assistant message and no failure. A
            // stopped send drops its projection first, so it never counts; a
            // stream that died mid-turn is still pending, so it doesn't either.
            // A cancel that already streamed partial text still would.
            if wasWorking, botId != selectedBotId,
               let proj = backgroundProjections[botId],
               !proj.pending, !proj.failed, proj.messages.last?.role == .assistant {
                markReplyReady(botId)
            }
        }
    }

    /// A reply is waiting in a chat the owner isn't looking at: the rail face
    /// hops once and the row reads "REPLY READY" until the chat is opened.
    private func markReplyReady(_ botId: String) {
        // One hop per unread reply: a second one landing before the chat is
        // opened doesn't hop again.
        guard replyReady.insert(botId).inserted else { return }
        railHops[botId, default: 0] += 1
    }

    /// The chat on screen at the previous tick, cleared when the owner
    /// switches. A handoff that ends between two ticks was seen if its bot
    /// was open at the first and still is.
    private var selectedAtLastTick: String?
    /// Whether the previous tick failed. The service being down shows as
    /// failed ticks, and its in-flight set comes back empty after a restart.
    private var lastTickFailed = false

    /// The current step of a working bot, for the rail face and subtitle.
    /// Nil when it is not tracked; the face then reads as thinking.
    func railActivity(_ botId: String) -> TurnActivity? {
        guard isWorking(botId) else { return nil }
        if botId == selectedBotId { return activity }
        return backgroundActivities[botId] ?? backgroundProjections[botId]?.activity
    }

    func isWorking(_ botId: String) -> Bool {
        workingBotIds.contains(botId)
            || handoffWorkingIds.contains(botId)
            || (botId == selectedBotId && (pending || backgroundWorking))
    }

    /// Apply a live event to the bot it belongs to. If that bot is on screen
    /// the transcript updates now; if the owner switched away, the projection
    /// is kept so coming back shows the progress that happened in the background.
    private func applyLiveEvent(_ event: EveEvent, botId: String) {
        if selectedBotId == botId {
            projection.apply(event, live: true)
            markWorking(botId, projection.pending)
            publishTranscript()
            return
        }
        var proj = backgroundProjections[botId] ?? StreamProjection()
        proj.apply(event, live: true)
        backgroundProjections[botId] = proj
        cacheUse[botId] = Date()
        persistNewWidgets(proj.widgets, botId: botId)
        if proj.pending, backgroundActivities[botId] != proj.activity {
            backgroundActivities[botId] = proj.activity
        }
        markWorking(botId, proj.pending)
    }

    private func projectionForSend(_ message: String) -> StreamProjection {
        var fresh = StreamProjection()
        for event in durableEvents where event.kind == "user" || event.kind == "assistant" {
            fresh.apply(EveEvent(
                type: event.kind == "user" ? "message.received" : "message.completed",
                id: event.id,
                metaAt: event.at,
                message: event.text,
                messageDelta: nil,
                turnId: nil
            ))
        }
        fresh.apply(EveEvent(
            type: "message.received",
            id: "\(EveStream.optimisticUserPrefix)\(UUID().uuidString)",
            message: message
        ), live: true)
        return fresh
    }

    /// POST a turn on a task Stop cannot cancel. The detached task still
    /// answers with the session id it made when this send was stopped, and
    /// the generation guard at the call site then cancels that session
    /// best-effort instead of leaving it burning with no pointer and no Stop.
    private func postSession(
        botId: String,
        sessionId: String?,
        message: String,
        images: [Attachment] = [],
        continueFrom: String? = nil,
        retry: Bool = false
    ) async throws -> String {
        let client = client
        return try await Task.detached {
            try await client.send(
                botId: botId,
                sessionId: sessionId,
                message: message,
                images: images,
                continueFrom: continueFrom,
                retry: retry
            )
        }.value
    }

    /// What the rail and search show for a sent message: the owner's words,
    /// or "Image" for a picture sent on its own. Never the lines naming it.
    /// `PREVIEW_MAX` in shared/shell-store.ts.
    private static let previewClip = 160

    static func previewText(_ text: String) -> String {
        let sent = Attachments.sentImages(in: text)
        // The server clips at 160 UTF-16 units (JavaScript's own count), so
        // the clip is measured the same way here.
        let clipped = text.utf16.count >= previewClip
        let body = clipped ? dropClippedImageTail(sent.text) : sent.text
        let imageCount = sent.images.count + (body != sent.text ? 1 : 0)
        if imageCount == 0 { return text }
        return body.isEmpty ? (imageCount == 1 ? "Image" : "\(imageCount) images") : body
    }

    /// A clipped preview often ends inside its image lines. Only at its tail
    /// do lines that start like them go: an owner who typed one mid-message
    /// keeps it.
    private static func dropClippedImageTail(_ text: String) -> String {
        var lines = text.split(separator: "\n", omittingEmptySubsequences: false)
        var dropped = false
        while let last = lines.last {
            let line = last.trimmingCharacters(in: .whitespaces)
            guard line.hasPrefix("Attached image: ") || line.hasPrefix("[file: ") || line.isEmpty else { break }
            lines.removeLast()
            dropped = dropped || !line.isEmpty
        }
        guard dropped else { return text }
        return lines.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func updateSession(botId: String, sessionId: String, preview: String) async {
        guard var current = store,
              let index = current.bots.firstIndex(where: { $0.id == botId }) else { return }
        // Persist even if the owner has switched away: the turn is still
        // running on this bot, and coming back needs the live session pointer.
        if current.bots[index].sessionId != sessionId {
            forgetTurnIds(of: current.bots[index].sessionId)
        }
        current.bots[index].sessionId = sessionId
        // The optimistic rail preview must match the server's clip; the full
        // text still goes to touchChat for the stored copy.
        current.bots[index].lastPreview = String(
            preview.trimmingCharacters(in: .whitespacesAndNewlines).prefix(160)
        )
        current.bots[index].lastAt = RailClock.stamp(Date())
        store = current
        inflightSessions[botId] = sessionId
        let generation = sendGenerations[botId] ?? 0
        do {
            try await client.touchChat(botId: botId, preview: preview, sessionId: sessionId)
            unsavedSessionBots.remove(botId)
            guard generation == (sendGenerations[botId] ?? 0) else { return }
            // A later success supersedes the pointer-failure notice.
            if sendErrors[botId]?.message == "The session pointer could not be saved." {
                sendErrors[botId] = nil
            }
            if selectedBotId == botId, stickyThreadError == "The session pointer could not be saved." {
                stickyThreadError = nil
                threadError = nil
            }
        } catch {
            guard generation == (sendGenerations[botId] ?? 0) else { return }
            // The turn still runs; only the stored pointer failed. Surface it
            // so the next poll's revert is not a mystery.
            recordSendError(botId, "The session pointer could not be saved.", resendable: false, survivesReload: true)
            unsavedSessionBots.insert(botId)
        }
    }

    /// Throttled transcript publish: at most one view rebuild per 100ms while
    /// events stream in, with a forced rebuild when the turn settles. A delta
    /// that arrives inside the window is coalesced onto one trailing rebuild
    /// rather than dropped.
    /// Refresh the durable rows and proposals, leaving the projection alone.
    ///
    /// The replay a full reload performs would rebuild the very rows already on
    /// screen, with the same ids, after a stretch of showing none. This is the
    /// same work `pollOnce` does when idle.
    private func refreshDurable() async {
        guard let bot = selectedBot else { return }
        let generation = loadGeneration
        guard let state = try? await client.threadState(botId: bot.id),
              generation == loadGeneration, bot.id == selectedBotId else { return }
        durableEvents = state.events
        proposals = state.proposals
        rebuildTranscript()
    }

    /// Drawings whose save is settled: kept, refused for good, or given up on
    /// after its retries. Call ids are unique
    /// across chats, so this is never reset: a chat switch or a reload must
    /// not mark an unsaved drawing as saved, nor post a saved one again.
    private var persistedWidgets: Set<String> = []
    private var savingWidgets: Set<String> = []
    /// Drawings the server will not keep. They have no page to show, so they
    /// get no card either.
    private var refusedWidgets: Set<String> = []
    /// Per chat, until its next send: a save can give up while the chat is in
    /// the background, where a banner would land on the wrong thread.
    private var widgetSaveErrors: [String: String] = [:]

    private func persistNewWidgets() {
        guard let botId = selectedBotId else { return }
        persistNewWidgets(projection.widgets, botId: botId)
    }

    /// Also called for a bot in the background, so a drawing that lands while
    /// the owner is in another chat is saved then, not at the next replay.
    private func persistNewWidgets(_ widgets: [LiveWidget], botId: String) {
        for widget in widgets {
            let id = widget.id
            if persistedWidgets.contains(id) || savingWidgets.contains(id) { continue }
            savingWidgets.insert(id)
            let client = client
            Task { [weak self] in
                // The save owns its retries. It used to be tried again only
                // when something else published the transcript, so a drawing
                // that landed as its turn ended could fail once, never be
                // asked again, and vanish on reload without a word.
                let outcome = await WidgetSaveRetry.run {
                    try await client.persistWidget(botId: botId, widget: widget)
                }
                guard let self else { return }
                self.savingWidgets.remove(id)
                // Settled either way, so no later publish starts it over.
                self.persistedWidgets.insert(id)
                if outcome == .saved { return }
                if outcome == .refused {
                    self.refusedWidgets.insert(id)
                    if self.selectedBotId == botId { self.rebuildTranscript() }
                }
                let message = "This drawing could not be saved to the chat."
                self.widgetSaveErrors[botId] = message
                if self.selectedBotId == botId, self.threadError == nil {
                    self.threadError = message
                }
            }
        }
    }

    private func publishQuestions() {
        if openQuestions != projection.questions { openQuestions = projection.questions }
    }

    /// Answer a question by one of its options. It goes out as an ordinary
    /// owner message, so the answer reads in the chat like anything else the
    /// owner said; eve settles the open question with the follow-up.
    func answerQuestion(_ question: OwnerQuestion, option: OwnerQuestion.Option) {
        guard openQuestions.contains(where: { $0.id == question.id }) else { return }
        send(option.label)
    }

    /// Mount one more budget of history above the window: up to
    /// `TranscriptBlocks.historyCharacterBudget` of text and at most
    /// `windowMinimum` blocks, and always at least one message. A flat 60
    /// blocks put dozens of long answers back in one layout pass.
    /// `windowExpandedFrom` is the block that was first before this, so the
    /// transcript can hold it where the reader had it: a prepend leaves the
    /// scroll offset where it was, which is the top of the new rows.
    func showEarlierMessages() {
        // The published window can briefly outlive a reset that emptied the
        // blocks; a tap in that gap must not index past them.
        let hidden = min(transcriptWindow.hidden, transcriptBlocks.count)
        guard let selectedBotId, hidden > 0 else { return }
        var start = hidden
        var spent = 0
        var messages = 0
        while start > max(0, hidden - TranscriptBlocks.windowMinimum) {
            let weight = TranscriptBlocks.weight(transcriptBlocks[start - 1])
            if messages > 0, spent + weight > TranscriptBlocks.historyCharacterBudget { break }
            start -= 1
            spent += weight
            if transcriptBlocks[start].isMessage { messages += 1 }
        }
        windowExpandedFrom = transcriptWindow.startId
        windowStarts[selectedBotId] = transcriptBlocks[start].id
        republishWindow()
    }

    private var windowExpandedFrom: String?

    /// The block to hold after an expansion, once. A later shrink of the
    /// hidden count (a cleared or replaced session) must not chase it.
    func takeWindowExpandedFrom() -> String? {
        defer { windowExpandedFrom = nil }
        return windowExpandedFrom
    }

    private func republishWindow() {
        let window = TranscriptBlocks.window(
            transcriptBlocks,
            startId: selectedBotId.flatMap { windowStarts[$0] },
            minimum: slimFirstPaint ? Self.firstPaintBlocks : TranscriptBlocks.windowMinimum,
            historyBudget: slimFirstPaint ? Self.firstPaintHistory : TranscriptBlocks.historyCharacterBudget
        )
        if window != transcriptWindow { transcriptWindow = window }
    }

    /// How many blocks a restored chat mounts for its first frame. Building
    /// the full 60-block window is most of what a switch costs once the rows
    /// come from a snapshot (about 150 ms on Generalist); the newest turn is
    /// always whole whatever this says.
    private static let firstPaintBlocks = 14
    /// The first frame's share of history text: about one long answer above
    /// the newest turn, whatever the block count says.
    private static let firstPaintHistory = 6_000
    /// True from a restore until the transcript has landed: the window holds
    /// only the newest `firstPaintBlocks`, and the rest mounts above the fold
    /// once the first frame is on screen, where the bottom anchor keeps the
    /// reader's rows still.
    private(set) var slimFirstPaint = false

    /// Mounts the rest of the window after a restored chat's first frame.
    /// With a bot, only while that chat is still the open one.
    func finishFirstPaint(for botId: String? = nil) {
        guard slimFirstPaint, botId == nil || botId == selectedBotId else { return }
        slimFirstPaint = false
        republishWindow()
    }

    private func publishTranscript(force: Bool = false) {
        let now = Date()
        let since = now.timeIntervalSince(lastTranscriptPublish)
        if force || since >= Self.publishInterval {
            pendingPublish?.cancel()
            pendingPublish = nil
            lastTranscriptPublish = now
            persistNewWidgets()
            rebuildTranscript()
            return
        }
        guard pendingPublish == nil else { return }
        let wait = Self.publishInterval - since
        pendingPublish = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(wait * 1_000_000_000))
            guard let self, !Task.isCancelled else { return }
            self.pendingPublish = nil
            self.lastTranscriptPublish = Date()
            self.persistNewWidgets()
            self.rebuildTranscript()
        }
    }

    private func rebuildTranscript() {
        if continuationRowId != projection.continuationRowId { continuationRowId = projection.continuationRowId }
        var rows = Transcript.merge(
            events: durableEvents,
            messages: projection.messages,
            failures: projection.failureMarks
        )
        publishFailureRetry()
        let seenWidgets = Set(rows.filter { $0.kind == .widget }.compactMap { $0.text })
        for widget in projection.widgets where !seenWidgets.contains(widget.id) && !refusedWidgets.contains(widget.id) {
            rows.append(TranscriptRow(id: "live-\(widget.id)", kind: .widget, text: widget.id, at: Date()))
        }
        if let bot = selectedBot, bot.isGroup, let store {
            let roster = Threads.groupMembers(
                Threads.speakers(from: store.bots),
                memberIds: bot.memberIds
            )
            rows = Transcript.attributeGroupReplies(rows, roster: roster)
        }
        // Nothing has loaded for this chat yet: a store echo that lands in
        // that window must not wipe the rows the switch put back.
        if rows.isEmpty, !transcriptReady, let selectedBotId, let cached = transcriptCache[selectedBotId] {
            transcript = cached.rows
            transcriptBlocks = cached.blocks
            if searchHits != projection.searchHits { searchHits = projection.searchHits }
            publishQuestions()
            publishActivity()
            return
        }
        // A reload that confirmed the rows already on screen (a chat switch
        // back, a durable echo of what the stream painted) publishes nothing:
        // each of these two writes invalidates the whole window and lays the
        // transcript out again. The blocks are compared too, not only the
        // rows, because a day label moves at midnight with no row changing.
        let blocks = TranscriptBlocks.build(rows: rows, selectedBotId: selectedBotId)
        if rows != transcript || blocks != transcriptBlocks {
            transcript = rows
            transcriptBlocks = blocks
        }
        if searchHits != projection.searchHits { searchHits = projection.searchHits }
        publishQuestions()
        publishActivity()
        // An empty result only replaces the cache once the load has finished
        // and said so; before that it is the blank the switch just cleared.
        if let selectedBotId, transcriptReady || !rows.isEmpty {
            transcriptCache[selectedBotId] = (rows, transcriptBlocks, durableEvents)
        }
    }

    private func publishFailureRetry() {
        let mark = projection.retryableMarkId.flatMap { id in projection.failureMarks.first { $0.id == id } }
        let rowId = mark?.rowId
        if retryableFailureRowId != rowId { retryableFailureRowId = rowId }
        // The router said how long its cool-down lasts. A send that hit it
        // armed the deadline here; a replay reads it off the failure's time.
        var until: Date?
        if let mark, let seconds = mark.failure.coolDownSeconds {
            let fromSend = selectedBotId.flatMap { retryNotBefore[$0] }
            let fromMark = mark.at.map { $0.addingTimeInterval(TimeInterval(seconds)) }
            until = [fromSend, fromMark].compactMap { $0 }.max()
        }
        // A deadline already past is no deadline: published as one, the
        // row's once-a-second timeline kept running on an idle chat.
        if let deadline = until, deadline <= Date() { until = nil }
        if failureRetryUntil != until { failureRetryUntil = until }
        coolDownTask?.cancel()
        if let deadline = until {
            coolDownTask = Task { @MainActor [weak self] in
                // Bounded: a stamp from a skewed clock must not overflow this.
                let wait = min(86_400, max(0, deadline.timeIntervalSinceNow))
                try? await Task.sleep(nanoseconds: UInt64(wait * 1_000_000_000) + 50_000_000)
                guard !Task.isCancelled else { return }
                self?.publishFailureRetry()
            }
        }
    }
    private var coolDownTask: Task<Void, Never>?

    /// The note's Reload: read the chat again, the way the banner's Retry did
    /// for a failure it could not resend.
    func reloadFromNote() {
        dismissNote()
        Task { await reloadThread() }
    }

    /// The owner closed the note over the composer.
    /// Only the one on screen: a save error behind a thread note shows next.
    func dismissNote() {
        guard threadError != nil else {
            saveError = nil
            return
        }
        threadError = nil
        stickyThreadError = nil
        if let botId = selectedBotId, sendErrors[botId]?.resendable == false { sendErrors[botId] = nil }
        if let botId = selectedBotId { widgetSaveErrors[botId] = nil }
    }

    /// Only on a real change: the label is read off every streamed event, and
    /// republishing the same one would redraw the transcript on each delta.
    private func publishActivity() {
        // A task that never reported back (eve lost it) must not keep the
        // row up forever: after a few hours it is taken as gone.
        let cutoff = Date().addingTimeInterval(-Self.subagentPatience)
        let since = projection.runningTasks.values.filter { $0 > cutoff }.min()
        if since != runningTaskSince || (since != nil && taskExpiry == nil) {
            runningTaskSince = since
            // A quiet chat publishes nothing more, so the row is taken down
            // at the cutoff itself rather than at the next event.
            taskExpiry?.cancel()
            if let since {
                // A little past the cutoff, so the check on waking is past it too.
                let wait = max(1, since.addingTimeInterval(Self.subagentPatience).timeIntervalSinceNow + 0.1)
                taskExpiry = Task { @MainActor [weak self] in
                    try? await Task.sleep(nanoseconds: UInt64(wait * 1_000_000_000))
                    guard !Task.isCancelled else { return }
                    self?.taskExpiry = nil
                    self?.publishActivity()
                }
            } else {
                taskExpiry = nil
            }
        }
        // The turn's own start, so the timer survives leaving the chat.
        if let started = projection.turnStartedAt, pending || backgroundWorking, activitySince != started {
            activitySince = started
        }
        guard projection.activity != activity else { return }
        activity = projection.activity
        // A connector step names its app and shows its logo; the list of
        // connected apps is otherwise only read when the pane opens.
        if case .tool("connector_execute", _) = activity, !connectorAppsFetched, !connectorAppsLoading {
            Task { await loadConnectorApps() }
        }
    }

    /// The connected apps, for a connector step's logo and name. Read on its
    /// own, not through the Connectors pane's list: that one pages, filters
    /// by the pane's search and reports its errors to the owner.
    @Published private(set) var connectorApps: [ConnectorToolkit] = []
    private var connectorAppsLoading = false
    /// Read once, and again after the Connectors pane has loaded (an app
    /// connected there shows its logo on the next step). Zero connected apps
    /// is an answer too, not a reason to ask on every step.
    private var connectorAppsFetched = false

    private func loadConnectorApps() async {
        connectorAppsLoading = true
        defer { connectorAppsLoading = false }
        guard let payload = try? await client.connectors(search: "", limit: 200) else { return }
        connectorApps = payload.toolkits.filter(\.connected)
        connectorAppsFetched = true
    }

    private static let subagentPatience: TimeInterval = 3 * 3600
    private var taskExpiry: Task<Void, Never>?

    // MARK: - Approvals

    /// Approve or deny one pending action. The card disappears on success.
    func decideApproval(_ item: ApprovalItem, decision: ApprovalDecision) {
        guard !item.actionSha256.isEmpty else {
            approvalError = "That approval is missing its hash. Refresh and try again."
            return
        }
        guard !busyApprovals.contains(item.id) else { return }
        busyApprovals.insert(item.id)
        approvalError = nil
        Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                try await self.client.decideApproval(
                    id: item.id,
                    decision: decision,
                    hash: item.actionSha256
                )
                self.approvals.removeAll { $0.id == item.id }
                self.decidedApprovals[item.id] = Date()
                self.approvalError = nil
            } catch {
                self.approvalError = (error as? LocalizedError)?.errorDescription ?? "Approval failed"
            }
            self.busyApprovals.remove(item.id)
        }
    }

    // MARK: - App settings

    func openAppSettings(_ tab: AppSettingsTab) {
        appSettingsTab = tab
        appSettingsOpen = true
    }

    /// One read at a time: a caller that arrives while one is running waits
    /// for it instead of sending a second GET (launch used to send three).
    /// The read runs outside the caller's task, so a view that goes away
    /// (a closed settings tab) does not cancel it into an error.
    func loadProviders() async {
        if let running = providersRead {
            await running.value
            return
        }
        let read = Task { @MainActor [weak self] () -> Void in
            guard let self else { return }
            await self.readProviders()
        }
        providersRead = read
        await read.value
        if providersRead == read { providersRead = nil }
    }

    private var providersRead: Task<Void, Never>?
    /// Bumped by every payload applied. A read that started before a newer
    /// payload landed (a connect's or a model pick's own answer) is dropped,
    /// so an older list can never overwrite a newer one.
    private var providersGeneration = 0

    private func readProviders() async {
        let started = providersGeneration
        providersError = nil
        do {
            let payload = try await client.providersPayload()
            guard started == providersGeneration else { return }
            applyProviders(payload)
            providersLoadFailed = false
        } catch {
            if error is CancellationError || (error as? URLError)?.code == .cancelled { return }
            guard started == providersGeneration else { return }
            providersError = "Could not load providers."
            if !providersLoaded { providersLoadFailed = true }
        }
    }

    private func applyProviders(_ payload: ProvidersPayload) {
        providersGeneration &+= 1
        providerCatalog = payload.catalog
        providerConnections = payload.connections
        providersLoaded = true
        defaultRole = payload.defaultRole
        reviewerRole = payload.reviewerRole
        imageRole = payload.imageRole
        providers = payload.legacyProviders
        if let next = payload.composer, next != composer {
            composer = next
        }
    }

    /// The server error code in plain words for the connect sheet.
    static func connectCopy(_ code: String?, name: String? = nil) -> String {
        switch code {
        case "provider_key":
            return "That key looks invalid."
        case "upstream_auth_failed":
            if let name { return "\(name) didn't accept this key. Check that it's copied in full." }
            return "The provider rejected this key."
        default:
            return "Could not connect."
        }
    }

    func clearConnectError() {
        connectError = nil
    }

    func connectProvider(providerId: String, mode: String, key: String?, fields: [String: String]?, label: String? = nil) async {
        providerBusy = "\(providerId):\(mode)"
        connectError = nil
        providersError = nil
        do {
            applyProviders(try await client.connect(providerId: providerId, mode: mode, key: key, fields: fields))
        } catch {
            connectError = Self.connectCopy((error as? BackendError)?.providerCode, name: label)
        }
        providerBusy = nil
    }

    func setActiveConnection(_ connectionId: String) async {
        providerBusy = connectionId
        providersError = nil
        do {
            applyProviders(try await client.setActiveConnection(connectionId))
        } catch {
            providersError = "Could not switch provider."
        }
        providerBusy = nil
    }

    func disconnectConnection(_ connectionId: String) async {
        providerBusy = connectionId
        providersError = nil
        do {
            applyProviders(try await client.disconnectConnection(connectionId))
        } catch {
            providersError = "Could not disconnect."
        }
        providerBusy = nil
    }

    func saveRole(_ role: String, connectionId: String?, modelId: String?, effort: String?) async {
        providerBusy = "role-\(role)"
        providersError = nil
        do {
            applyProviders(try await client.setRole(role, connectionId: connectionId, modelId: modelId, effort: effort))
        } catch {
            providersError = "That model did not save."
        }
        providerBusy = nil
    }

    func saveDefaultModel(connectionId: String?, modelId: String, effort: String?) async {
        providerBusy = "role-default"
        providersError = nil
        do {
            applyProviders(try await client.setDefaultModel(connectionId: connectionId, modelId: modelId, effort: effort))
        } catch {
            providersError = "That model did not save."
        }
        providerBusy = nil
    }

    /// Bumped by every start and cancel. A code that arrives after the flow
    /// it was asked for was cancelled (Back while the code loads) is thrown
    /// away and cancelled on the server, so nothing polls in the background.
    private var oauthGeneration = 0

    func startOAuth(providerId: String, label: String) async {
        oauthPoll?.cancel()
        oauthGeneration &+= 1
        let generation = oauthGeneration
        providerBusy = "\(providerId):oauth"
        oauthError = nil
        oauthDone = false
        oauthErrorStreak = 0
        providersError = nil
        do {
            let flow = try await client.startOAuth(providerId: providerId)
            guard generation == oauthGeneration else {
                try? await client.cancelOAuth(pollId: flow.pollId)
                if providerBusy == "\(providerId):oauth" { providerBusy = nil }
                return
            }
            oauth = OAuthPending(
                pollId: flow.pollId,
                providerId: providerId,
                label: label,
                userCode: flow.userCode,
                verificationUrl: flow.verificationUrl,
                verificationUrlComplete: flow.verificationUrlComplete,
                expiresAt: flow.expiresAt,
                intervalMs: flow.intervalMs
            )
            startOAuthPoll()
        } catch {
            if generation == oauthGeneration {
                providersError = Self.connectCopy((error as? BackendError)?.providerCode)
            }
        }
        if generation == oauthGeneration { providerBusy = nil }
    }

    private func startOAuthPoll() {
        oauthPoll?.cancel()
        oauthPoll = Task { [weak self] in
            while !Task.isCancelled {
                // The server sets the pace, at least a second between polls.
                let interval = max(self?.oauth?.intervalMs ?? 2000, 1000)
                try? await Task.sleep(nanoseconds: UInt64(interval) * 1_000_000)
                guard !Task.isCancelled else { return }
                await self?.pollOAuthOnce()
                guard self?.oauth != nil, self?.oauthDone == false else { return }
            }
        }
    }

    /// True once the pending entry's expiry (epoch milliseconds, like the
    /// server counts them) has passed. A zero expiry means the start response
    /// carried none, so the server's own terminal answer ends the flow.
    private var oauthExpired: Bool {
        guard let pending = oauth, pending.expiresAt > 0 else { return false }
        let nowMs = Date().timeIntervalSince1970 * 1000
        return nowMs >= pending.expiresAt
    }

    private func pollOAuthOnce() async {
        guard let pending = oauth, !oauthDone else { return }
        do {
            let (status, intervalMs, payload) = try await client.pollOAuth(pollId: pending.pollId)
            // Cancelled or replaced while this poll was out: its answer is stale.
            guard oauth?.pollId == pending.pollId else { return }
            if let intervalMs, intervalMs > 0 {
                oauth?.intervalMs = intervalMs
            }
            switch status {
            case "complete":
                if let payload {
                    applyProviders(payload)
                    providersError = nil
                } else {
                    await loadProviders()
                }
                oauthPoll?.cancel()
                oauth = nil
                oauthError = nil
                oauthCompletions &+= 1
            case "pending", "slow_down":
                oauthErrorStreak = 0
                oauthError = nil
                if oauthExpired {
                    oauthPoll?.cancel()
                    oauthDone = true
                    oauthError = "That sign-in expired. Try again."
                }
            case "error":
                // One vendor or transport hiccup keeps polling like "pending",
                // with a note so the wait is not silent. A run of them ends the
                // flow: the code is still valid, so Try again just restarts it.
                oauthErrorStreak += 1
                if oauthErrorStreak >= Self.oauthErrorLimit || oauthExpired {
                    oauthPoll?.cancel()
                    oauthDone = true
                    oauthError = oauthExpired ? "That sign-in expired. Try again." : "The sign-in server is not answering. Try again."
                } else {
                    oauthError = "The sign-in server did not answer. Still waiting."
                }
            case "expired":
                oauthPoll?.cancel()
                oauthDone = true
                oauthError = "That sign-in expired. Try again."
            case "denied":
                oauthPoll?.cancel()
                oauthDone = true
                oauthError = "That sign-in was denied."
            default:
                oauthPoll?.cancel()
                oauthDone = true
                oauthError = "Could not finish sign-in."
            }
        } catch {
            // A failed poll never kills the flow. The next tick retries.
        }
    }

    /// Clears the flow at once, before the server hears about it, so a start
    /// made right after (Back, then the same row again) is never undone by
    /// this cancel finishing late.
    func cancelOAuth() async {
        oauthPoll?.cancel()
        oauthGeneration &+= 1
        let pending = oauth
        oauth = nil
        oauthError = nil
        oauthDone = false
        oauthErrorStreak = 0
        if let busy = providerBusy, busy.hasSuffix(":oauth") { providerBusy = nil }
        if let pending {
            try? await client.cancelOAuth(pollId: pending.pollId)
        }
    }

    func connectProvider(id: String, key: String) async {
        providerBusy = id
        providersError = nil
        do {
            providers = try await client.connectProvider(id: id, key: key)
        } catch {
            let code = (error as? BackendError)?.providerCode
            providersError = code == "provider_key" ? "That key looks invalid." : "Could not save the key."
        }
        providerBusy = nil
    }

    func activateProvider(id: String) async {
        providerBusy = id
        providersError = nil
        do {
            providers = try await client.activateProvider(id: id)
        } catch {
            let code = (error as? BackendError)?.providerCode
            providersError = code == "provider_incompatible"
                ? "This build routes OpenAI-compatible APIs. Use OpenRouter for Claude."
                : "Could not switch provider."
        }
        providerBusy = nil
    }

    func disconnectProvider(id: String) async {
        providerBusy = id
        providersError = nil
        do {
            providers = try await client.disconnectProvider(id: id)
        } catch {
            providersError = "Could not disconnect."
        }
        providerBusy = nil
    }

    // MARK: - Connectors

    /// A quiet load (poll, debounce) never replaces a message from Connect or
    /// Disconnect with a load error, and clears only a load error on success.
    static let connectorPageSize = 30
    @Published private(set) var connectorMoreBusy = false

    /// A quiet reload keeps however many rows are on screen, so a poll never
    /// collapses a list the owner expanded.
    func loadConnectors(search: String = "", quiet: Bool = false) async {
        if !quiet { connectorsError = nil }
        // The server caps a page at 200; a quiet reload never asks for more.
        let limit = quiet ? min(max(Self.connectorPageSize, connectors?.toolkits.count ?? 0), 200) : Self.connectorPageSize
        do {
            let payload = try await client.connectors(search: search, limit: limit)
            // Fast typing on a slow answer: a quiet result for a query that is
            // no longer in the box is dropped rather than shown over the
            // current one. An explicit load (open, key saved, retry) always
            // lands and resets the live query to what it loaded.
            if quiet {
                guard search == connectorSearch else { return }
            } else {
                connectorSearch = search
            }
            connectors = payload
            // The pane saw the latest list; the working row reads it afresh.
            connectorAppsFetched = false
            if let code = payload.error {
                let message = code == "key_rejected" ? Self.connectorKeyRejected : Self.connectorUpstreamError
                if !quiet || connectorsError == nil || Self.connectorLoadErrors.contains(connectorsError ?? "") {
                    connectorsError = message
                }
            } else if !quiet || Self.connectorLoadErrors.contains(connectorsError ?? "") {
                connectorsError = nil
            }
        } catch {
            if !quiet || connectorsError == nil {
                connectorsError = "Could not load connectors."
            }
        }
    }

    func loadMoreConnectors(search: String) async {
        guard let offset = connectors?.nextOffset, !connectorMoreBusy else { return }
        connectorMoreBusy = true
        do {
            let page = try await client.connectors(search: search, offset: offset, limit: Self.connectorPageSize)
            // The search may have moved on while the page was in flight; a
            // page for an old query is dropped, and rows on screen never repeat.
            if connectorSearch == search, var current = connectors {
                let seen = Set(current.toolkits.map(\.slug))
                current.toolkits.append(contentsOf: page.toolkits.filter { !seen.contains($0.slug) })
                current.nextOffset = page.nextOffset
                current.total = page.total
                connectors = current
            }
        } catch {
            connectorsError = "Could not load connectors."
        }
        connectorMoreBusy = false
    }

    func saveConnectorsKey(_ key: String) async {
        connectorBusy = "key"
        connectorsError = nil
        do {
            try await client.setConnectorsKey(key)
            await loadConnectors()
        } catch {
            switch (error as? BackendError)?.providerCode {
            case "connectors_key_consumer":
                connectorsError = "That is a Composio For You key. This app needs a Platform project key, which starts with ak_."
            case "connectors_key":
                connectorsError = "That key looks invalid."
            default:
                connectorsError = "Could not save the key."
            }
        }
        connectorBusy = nil
    }

    func removeConnectorsKey() async {
        connectorBusy = "key"
        connectorsError = nil
        stopConnectorPoll()
        do {
            try await client.setConnectorsKey(nil)
            await loadConnectors()
        } catch {
            connectorsError = "Could not remove the key."
        }
        connectorBusy = nil
    }

    /// Opens Composio's hosted sign-in for one app in the default browser and
    /// polls until the account is active, or gives up after two minutes. An
    /// app Composio has no OAuth app for opens the own-app form instead.
    func connectConnector(_ row: ConnectorToolkit, search: String) async {
        connectorBusy = row.slug
        connectorsError = nil
        connectorTimedOut = nil
        connectorOwnApp = nil
        do {
            let target = try await client.authorizeConnector(slug: row.slug)
            if openHostedSignIn(target) { startConnectorPoll(slug: row.slug) }
        } catch BackendError.provider("connector_needs_own_app") {
            do {
                connectorOwnApp = try await client.connectorOwnAppForm(slug: row.slug)
            } catch BackendError.provider("key_rejected") {
                connectorsError = Self.connectorKeyRejected
            } catch {
                connectorsError = "\(row.name) needs your own OAuth app, and Composio would not say which details it takes. Create an auth config for it at platform.composio.dev, then try again."
            }
        } catch {
            connectorsError = Self.connectFailureCopy(error, name: row.name)
        }
        connectorBusy = nil
    }

    /// Hands the owner's own OAuth app to Composio and opens the sign-in.
    func connectOwnApp(_ row: ConnectorToolkit, credentials: [String: String]) async {
        connectorBusy = row.slug
        connectorsError = nil
        connectorTimedOut = nil
        do {
            let target = try await client.connectOwnApp(slug: row.slug, credentials: credentials)
            connectorOwnApp = nil
            if openHostedSignIn(target) { startConnectorPoll(slug: row.slug) }
        } catch {
            connectorsError = Self.connectFailureCopy(error, name: row.name)
        }
        connectorBusy = nil
    }

    func dismissOwnApp() {
        connectorOwnApp = nil
    }

    /// Only an https page on Composio's own hosts is handed to the browser.
    private func openHostedSignIn(_ target: String) -> Bool {
        guard let url = URL(string: target), url.scheme?.lowercased() == "https",
              let host = url.host?.lowercased(), host == "composio.dev" || host.hasSuffix(".composio.dev") else {
            connectorsError = "Composio sent a sign-in link this app will not open."
            return false
        }
        guard NSWorkspace.shared.open(url) else {
            connectorsError = "The sign-in page could not be opened in the browser."
            return false
        }
        return true
    }

    /// What went wrong, in the owner's terms, never a bare "could not". An
    /// unknown code is shown rather than hidden; it is not pinned on Composio,
    /// since the local service refuses with codes of its own (csrf, no key).
    static func connectFailureCopy(_ error: Error, name: String) -> String {
        guard case BackendError.provider(let code) = error else {
            return "Could not reach the local service to connect \(name)."
        }
        switch code {
        case "key_rejected":
            return connectorKeyRejected
        case "rate_limited":
            return "Too many requests. Wait a moment, then try again."
        case "authorize_no_redirect":
            return "Composio accepted \(name) but sent no sign-in link. Try again."
        case "own_app_fields":
            return "Fill in every field."
        case "own_app_rejected":
            return "Composio rejected those details. Check each one against your \(name) developer app."
        case "own_app_unsupported":
            return "\(name) cannot take your own app through this dialog. Create an auth config for it at platform.composio.dev, then try again."
        case "connector_needs_own_app":
            return "\(name) needs your own OAuth app."
        default:
            return "Could not connect \(name): \(code)."
        }
    }

    func disconnectConnector(_ row: ConnectorToolkit, search: String) async {
        guard let accountId = row.accountId else { return }
        connectorBusy = row.slug
        connectorsError = nil
        do {
            try await client.disconnectConnector(accountId: accountId)
            await loadConnectors(search: search, quiet: true)
        } catch {
            connectorsError = "Could not disconnect \(row.name)."
        }
        connectorBusy = nil
    }

    func stopConnectorPoll() {
        connectorPoll?.cancel()
        connectorPoll = nil
        connectorPending = nil
    }

    private func startConnectorPoll(slug: String) {
        stopConnectorPoll()
        connectorPending = slug
        let started = Date()
        connectorPoll = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(3))
                guard let self, !Task.isCancelled else { return }
                await self.loadConnectors(search: self.connectorSearch, quiet: true)
                if self.connectors?.toolkits.first(where: { $0.slug == slug })?.connected == true {
                    self.connectorPending = nil
                    self.connectorPoll = nil
                    return
                }
                if Date().timeIntervalSince(started) > 120 {
                    self.connectorPending = nil
                    self.connectorTimedOut = slug
                    self.connectorPoll = nil
                    return
                }
            }
        }
    }

    func loadUsage() async {
        // The pane polls every few seconds while the owner can also be moving
        // the limit. A poll that started before the write must not land after
        // it: the pane would show a budget the router is not enforcing.
        let generation = usageGeneration
        do {
            let fresh = try await client.usage()
            guard generation == usageGeneration else { return }
            usage = fresh
            usageError = nil
        } catch {
            guard generation == usageGeneration else { return }
            usageError = "Could not load usage."
        }
    }

    /// A limit the pane refused before it ever reached the server.
    func reportUsageError(_ message: String) {
        usageError = message
    }

    /// Move the router's daily token budget. The answer carries the budget the
    /// server stored, so a refused number never sticks on screen.
    func setDailyTokenBudget(_ tokens: Int?) {
        guard !usageBusy else { return }
        usageBusy = true
        usageError = nil
        // Any poll already in flight belongs to the budget before this write.
        usageGeneration &+= 1
        Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                let confirmed = try await self.client.setDailyTokenBudget(tokens)
                // And any poll started while the write was in flight.
                self.usageGeneration &+= 1
                self.usage = confirmed
            } catch BackendError.provider(let code) where code == "budget_range" {
                self.usageError = "That budget is outside the range this router accepts."
            } catch {
                self.usageError = "Could not change the limit."
            }
            self.usageBusy = false
        }
    }

    // MARK: - Profile and shell actions

    /// Serialise every shell mutation on one chain so rapid actions cannot
    /// land out of order and a stale echo cannot overwrite newer state.
    private func enqueue(_ work: @escaping @MainActor () async -> Void) {
        let previous = saveChain
        saveChain = Task { @MainActor in
            _ = await previous?.value
            guard !Task.isCancelled else { return }
            await work()
        }
    }

    func patchBot(botId: String, _ patch: [String: Any?]) {
        enqueue { [weak self] in
            guard let self else { return }
            let epoch = self.storeEpoch
            do {
                let next = try await self.client.shellAction(ShellActions.updateBot(botId: botId, patch: patch))
                guard !Task.isCancelled, epoch == self.storeEpoch else { return }
                self.applyStore(next)
                self.saveError = nil
            } catch {
                // The pane shows one saveError for whichever bot is open, so a
                // save that fails after a switch must not land on the new one.
                guard epoch == self.storeEpoch, botId == self.selectedBotId else { return }
                self.saveError = (error as? LocalizedError)?.errorDescription ?? "Save failed."
            }
        }
    }

    func perform(_ action: [String: Any], onSuccess: (@MainActor () -> Void)? = nil) {
        // Captured at the call, not when the queued work runs: a switch that
        // lands ahead of it in the chain would otherwise make the action's
        // outcome belong to the new bot.
        let botId = selectedBotId
        enqueue { [weak self] in
            guard let self else { return }
            let epoch = self.storeEpoch
            do {
                let result = try await self.client.shellActionResult(action)
                // The server's word is what counts, whatever the view has
                // moved on to since.
                onSuccess?()
                guard !Task.isCancelled, epoch == self.storeEpoch else { return }
                self.applyStore(result.store)
                // The roster change stood; something hanging off it did not.
                // The tick sweeps the rest, so this says so and moves on
                // rather than presenting a completed action as a failure.
                // Scoped like the failure below: a late outcome must not
                // clear or overwrite the banner of a bot it did not run for.
                guard botId == self.selectedBotId else { return }
                self.saveError = result.detachError == nil
                    ? nil
                    : "Saved, but some of its data is still being cleared up."
            } catch {
                // The banner now shows in the chat column too, so a save
                // that fails after a switch must not land on the new bot,
                // the way patchBot guards the same thing above.
                guard epoch == self.storeEpoch, botId == self.selectedBotId else { return }
                self.saveError = (error as? LocalizedError)?.errorDescription ?? "Save failed."
            }
        }
    }

    /// Apply a store the server echoed and keep the local selection honest.
    /// Never echoes a select back: the store already carries the selection.
    private func applyStore(_ next: ShellStore) {
        // A reply started in a chat the server has since removed goes with it.
        if !replyQuotes.isEmpty {
            let live = Set(next.bots.map(\.id))
            replyQuotes = replyQuotes.filter { live.contains($0.key) }
        }
        store = next
        reconcileSelection(next)
        rebuildTranscript()
    }

    /// Repair the local selection against a fresh store: the rail, the polls
    /// and the action echoes all funnel here so a server-side delete or a
    /// server-driven switch can never strand `selectedBotId`.
    private func reconcileSelection(_ next: ShellStore) {
        if let selected = next.selectedBotId, next.bots.contains(where: { $0.id == selected }) {
            if selected == pendingSelectionBotId {
                // The store caught up with the locally chosen bot, so the
                // fence can go.
                pendingSelectionBotId = nil
            }
            // A local selection that has not been confirmed yet wins over the
            // server's stale pointer; otherwise a failed select write would
            // let the next idle poll switch straight back to the last bot.
            if selected != selectedBotId, pendingSelectionBotId == nil,
               localOnlySelection == nil || localOnlySelection != selectedBotId {
                // A select write that failed twice is why this repair runs at
                // all; the switch clears per-thread state, so the explanation
                // has to survive it or the bounce looks unexplained.
                let selectFailure = saveError == "Could not save the selection." ? saveError : nil
                switchToBot(selected)
                if let selectFailure { saveError = selectFailure }
            }
        } else if let current = selectedBotId, !next.bots.contains(where: { $0.id == current }) {
            if let first = next.bots.first?.id {
                switchToBot(first)
            } else {
                selectedBotId = nil
                cancelSend(for: current)
                resetThread()
                clearPerThreadState()
            }
        }
    }

    /// The server-driven equivalent of a rail click. The outgoing bot's turn
    /// keeps running; only the visible thread is swapped.
    private func switchToBot(_ id: String) {
        stashCurrentThread()
        resetThread()
        selectedBotId = id
        clearRoutineState()
        clearPerThreadState()
        restoreChat(id)
        sendBotId = sendTasks[id] != nil ? id : nil
        sendTask = sendTasks[id]
        // A turn that failed shows as its row; only a failure with no turn
        // to sit under is a note (the same rule `select` keeps).
        if let err = sendErrors[id], !err.resendable {
            stickyThreadError = err.message
            threadError = err.message
        }
        if let unsent = unsentDrafts.removeValue(forKey: id) {
            restoreUnsentDraft(unsent.text, sentAttachments: unsent.attachments)
        }
        startReload()
    }

    /// Errors and memory belong to one bot; a switch must not show them on
    /// the next bot's pane or chat.
    private func clearPerThreadState() {
        attachError = nil
        threadError = nil
        stickyThreadError = nil
        saveError = nil
        memoryNotes = nil
        memoryError = nil
    }

    func createBot(name: String, petname: String, label: String, description: String, sectionId: String?) {
        enqueue { [weak self] in
            guard let self else { return }
            let epoch = self.storeEpoch
            let action = ShellActions.createBot(
                name: name,
                petname: petname,
                label: label,
                description: description,
                sectionId: sectionId
            )
            do {
                let next = try await self.client.shellAction(action)
                guard !Task.isCancelled, epoch == self.storeEpoch else { return }
                // applyStore selects the new bot; switchToBot stashes any
                // outgoing send so it keeps running.
                self.applyStore(next)
            self.saveError = nil
            } catch {
                self.saveError = (error as? LocalizedError)?.errorDescription ?? "Create failed."
            }
        }
    }

    func createGroup(name: String, memberIds: [String], sectionId: String?) {
        enqueue { [weak self] in
            guard let self else { return }
            let epoch = self.storeEpoch
            let action = ShellActions.createGroup(name: name, memberIds: memberIds, sectionId: sectionId)
            do {
                let next = try await self.client.shellAction(action)
                guard !Task.isCancelled, epoch == self.storeEpoch else { return }
                self.applyStore(next)
                self.saveError = nil
                self.settingsOpen = true
            } catch {
                self.saveError = (error as? LocalizedError)?.errorDescription ?? "Create failed."
            }
        }
    }

    func createSection(name: String) {
        perform(ShellActions.createSection(name: name))
    }

    func rename(botId: String, name: String) {
        perform(ShellActions.rename(botId: botId, name: name))
    }

    func delete(botId: String) {
        replyQuotes[botId] = nil
        transcriptCache[botId] = nil
        // Gone from disk now; blocked for good once the store drops the bot,
        // so a delete the server refuses leaves the chat able to save again.
        removeSnapshot(botId, blockWrites: false)
        sendErrors[botId] = nil
        unsentDrafts[botId] = nil
        forgetTurnIds(of: store?.bots.first { $0.id == botId }?.sessionId)
        let running = inflightSessions[botId]
        cancelSend(for: botId)
        if let running, !running.isEmpty {
            Task { @MainActor [weak self] in
                _ = try? await self?.client.cancel(sessionId: running)
            }
        }
        // Its pictures go only once the server has dropped the bot: a
        // refused delete leaves the chat, pictures and all.
        perform(ShellActions.deleteBot(botId: botId)) { SentImageStore.forget(botId: botId) }
    }

    /// New Bot from the rail: clear the thread server-side and start fresh.
    func startNewChat(botId: String? = nil) {
        guard let id = botId ?? selectedBotId else { return }
        // Any in-flight turn on this bot would repopulate the cleared thread.
        // Other bots keep working.
        let runningSession = inflightSessions[id] ?? (activeSession?.botId == id ? activeSession?.sessionId : nil)
        cancelSend(for: id)
        sendErrors[id] = nil
        let generation = bumpChatGeneration(for: id)
        enqueue { [weak self] in
            guard let self else { return }
            let epoch = self.storeEpoch
            if let runningSession, !runningSession.isEmpty {
                _ = try? await self.client.cancel(sessionId: runningSession)
            }
            guard generation == (self.chatGenerations[id] ?? 0) else { return }
            if self.store?.selectedBotId != id {
                if let next = try? await self.client.shellAction(ShellActions.select(botId: id)) {
                    guard generation == (self.chatGenerations[id] ?? 0) else { return }
                    self.applyStore(next)
                }
            }
            // A failed clear must not wipe the visible thread; surface it and
            // let the next poll re-sync.
            do {
                let cleared = try await self.client.shellAction(ShellActions.clearThread(botId: id))
                guard generation == (self.chatGenerations[id] ?? 0) else { return }
                self.forgetTurnIds(of: self.store?.bots.first { $0.id == id }?.sessionId)
                self.applyStore(cleared)
            } catch {
                self.threadError = (error as? LocalizedError)?.errorDescription ?? "Could not start a new chat."
                return
            }
            guard generation == (self.chatGenerations[id] ?? 0), epoch == self.storeEpoch else { return }
            self.resetThread()
            // Cleared means empty, which is already known: nothing is left to
            // load for its rows. Left unready, the loading mascot flashed for
            // a frame between the old rows and the empty chat.
            self.transcriptReady = true
            // The old conversation is gone server-side; it must not come back
            // from the cache on the next switch.
            self.transcriptCache[id] = nil
            self.removeSnapshot(id, blockWrites: false)
            self.selectedBotId = id
            self.attachError = nil
            self.approvalError = nil
            self.threadError = nil
            self.stickyThreadError = nil
            self.memoryNotes = nil
            self.memoryError = nil
            self.rebuildTranscript()
            self.settingsOpen = false
            self.detailsOpen = false
            self.clearRoutineState()
            // Reload outside the chain: an SSE replay must not block writes.
            self.startReload()
        }
    }

    func openRecent(_ recentId: String) {
        // Opening an old session replaces the live one for this bot; other
        // bots keep working.
        if let id = selectedBotId {
            cancelSend(for: id)
            sendErrors[id] = nil
        }
        let fenceId = selectedBotId
        let generation = fenceId.map { bumpChatGeneration(for: $0) } ?? 0
        enqueue { [weak self] in
            guard let self else { return }
            let epoch = self.storeEpoch
            do {
                let next = try await self.client.shellAction(ShellActions.openRecent(recentId: recentId))
                guard !Task.isCancelled, epoch == self.storeEpoch else { return }
                if let fenceId, generation != (self.chatGenerations[fenceId] ?? 0) { return }
                let switched = next.selectedBotId != self.selectedBotId
                // A recent that swaps the bot's session pointer displaces a
                // session this app will not read again; its turn ids go too.
                for bot in next.bots {
                    if let old = self.store?.bots.first(where: { $0.id == bot.id })?.sessionId, old != bot.sessionId {
                        self.forgetTurnIds(of: old)
                    }
                }
                self.applyStore(next)
                self.saveError = nil
                if !switched {
                    // Same bot, different stored session: reset the thread and
                    // reload outside the chain so a replay cannot block writes.
                    self.resetThread()
                    self.startReload()
                }
            } catch {
                self.saveError = (error as? LocalizedError)?.errorDescription ?? "Open failed."
            }
        }
    }

    func toggleSection(_ sectionId: String) {
        perform(ShellActions.toggleSection(sectionId: sectionId))
    }

    private func stashCurrentThread() {
        guard let old = selectedBotId else { return }
        // A drawing that arrived inside the publish throttle has not been
        // saved yet, and the reset that follows cancels that publish.
        persistNewWidgets()
        // A chat left at rest is kept as a snapshot, in memory and on disk,
        // so coming back reads on from its cursor. One left mid-turn is not:
        // only a read from zero sees where its turn began.
        snapshotTimer?.cancel()
        snapshotTimer = nil
        if let snapshot = openChatSnapshot() {
            if isNewSnapshot(snapshot) {
                stashSnapshots[old] = snapshot
                writeSnapshot(snapshot)
            }
        } else if stashSnapshots[old]?.sessionId != selectedBot?.sessionId {
            // One not at rest now keeps the snapshot it was opened from: the
            // session only grows, so that is still a point a resume can read
            // on from. One for another session is no use.
            stashSnapshots[old] = nil
        }
        // Do not clobber a live stash with an empty post-reset projection.
        if !projection.messages.isEmpty || backgroundProjections[old] == nil {
            backgroundProjections[old] = projection
        }
        if transcriptReady || !transcript.isEmpty {
            transcriptCache[old] = (transcript, transcriptBlocks, durableEvents)
        }
        if loadSucceeded { readyStashes.insert(old) } else { readyStashes.remove(old) }
        if sendTasks[old] == nil { markWorking(old, false) }
        cacheUse[old] = Date()
        trimCaches()
    }

    /// Puts a chat back on screen before its reload runs, from the fullest
    /// copy this app has: the snapshot of it left at rest this session, the
    /// projection a turn still running kept, the snapshot on disk, the rows
    /// alone. Only a snapshot also says where the reload resumes the session;
    /// the other two are confirmed by a replay from zero, as before.
    private func restoreChat(_ botId: String) {
        let sessionId = store?.bots.first { $0.id == botId }?.sessionId ?? ""
        let resumable = sendTasks[botId] == nil && !sessionId.isEmpty && !snapshotsBlocked.contains(botId)
        restoreSource = "none"
        if resumable, let snapshot = stashSnapshots[botId], snapshot.sessionId == sessionId {
            restoreSource = "stash_snapshot"
            restore(snapshot)
        } else if let stored = backgroundProjections[botId] {
            restoreSource = "background_projection"
            projection = stored
            pending = sendTasks[botId] != nil
            // The stash is a snapshot from when this chat was left, and a
            // turn nobody here sent may have ended since. Only a send this
            // app still holds is known to be running; for anything else the
            // reload below reads the session and decides.
            backgroundWorking = false
            activity = stored.activity
            markWorking(botId, sendTasks[botId] != nil)
            durableEvents = transcriptCache[botId]?.events ?? []
            rebuildTranscript()
            restoredFromCache = !transcript.isEmpty && readyStashes.contains(botId)
        } else if resumable, let snapshot = snapshots.load(botId: botId, sessionId: sessionId) {
            restoreSource = "disk_snapshot"
            restore(snapshot)
        } else if let cached = transcriptCache[botId] {
            restoreSource = "row_cache"
            // A chat already opened this session comes back with its rows on
            // screen while the reload confirms them. The events come too: a
            // second switch before the reload lands stashes this chat again,
            // and rows paired with no events would lose them.
            transcript = cached.rows
            transcriptBlocks = cached.blocks
            durableEvents = cached.events
            restoredFromCache = !cached.rows.isEmpty && readyStashes.contains(botId)
        }
    }

    /// Which of `restoreChat`'s paths put the open chat on screen, for the
    /// performance guard: a case that took another path measured another thing.
    private var restoreSource = "none"

    /// What the performance guard records with each landing.
    var perfStats: [String: Any] {
        [
            "source": restoreSource,
            "rows": transcript.count,
            "blocks": transcriptBlocks.count,
            "events": followCursor?.next ?? -1,
            "fromSnapshot": restoredFromSnapshot,
            "fromCache": restoredFromCache,
        ]
    }

    private func restore(_ snapshot: ChatSnapshot) {
        // A reader who expanded this chat's window keeps it: the held start
        // wins over a slim first frame anyway.
        // macOS 14 has no scroll geometry to land a slim window by.
        if #available(macOS 15.0, *) {
            slimFirstPaint = windowStarts[snapshot.botId] == nil
        }
        projection = snapshot.projection
        durableEvents = snapshot.durableEvents
        pending = false
        backgroundWorking = false
        activity = snapshot.projection.activity
        markWorking(snapshot.botId, false)
        seenTurnIds[snapshot.sessionId, default: []].formUnion(snapshot.seenTurnIds)
        // Exactly the snapshot's: its projection holds these turns and no
        // others, and a turn skipped that it does not hold would be lost.
        localTurnIds[snapshot.sessionId] = Set(snapshot.localTurnIds)
        rebuildTranscript()
        restoredFromCache = !transcript.isEmpty
        restoredFromSnapshot = restoredFromCache
        resumePoint = (snapshot.sessionId, snapshot.cursor, snapshot.lastEventId)
        // Kept as this chat's stash: if it is left before it comes to rest
        // again (a send, a turn, a reload in flight), coming back still has a
        // point to read on from instead of a replay from zero.
        stashSnapshots[snapshot.botId] = snapshot
    }

    /// The events a turn or a session comes to rest on.
    private static let restingEvents: Set<String> = [
        "turn.completed", "turn.cancelled", "turn.failed", "session.waiting",
    ]

    /// The open chat as a snapshot, or nil when it is not at rest: a load
    /// still running or failed, a send of this app's in flight, a turn still
    /// going, or a projection that is not one session's replay.
    private func openChatSnapshot() -> ChatSnapshot? {
        guard let bot = selectedBot, bot.id == selectedBotId,
              let sessionId = bot.sessionId, !sessionId.isEmpty,
              !snapshotsBlocked.contains(bot.id),
              loadSucceeded, transcriptReady, completedLoad == loadGeneration,
              sendTasks[bot.id] == nil, !pending, !projection.pending,
              let cursor = followCursor, cursor.sessionId == sessionId, cursor.next > 0,
              projection.soleSession == sessionId,
              // A turn a local send painted is in the projection but not folded
              // the way a replay folds it (its events are passed over), so it is
              // not saved; the chat keeps the snapshot it had before the send.
              (localTurnIds[sessionId] ?? []).isEmpty else { return nil }
        return ChatSnapshot(
            botId: bot.id,
            sessionId: sessionId,
            cursor: cursor.next,
            lastEventId: cursor.lastEventId,
            projection: projection,
            durableEvents: durableEvents,
            seenTurnIds: seenTurnIds[sessionId] ?? [],
            localTurnIds: localTurnIds[sessionId] ?? []
        )
    }

    /// Saves the open chat shortly, once whatever brought it to rest has
    /// settled. A switch away saves it at once instead.
    private func scheduleSnapshot() {
        snapshotTimer?.cancel()
        snapshotTimer = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 400_000_000)
            guard let self, !Task.isCancelled, let snapshot = self.openChatSnapshot() else { return }
            self.snapshotTimer = nil
            guard self.isNewSnapshot(snapshot) else { return }
            self.stashSnapshots[snapshot.botId] = snapshot
            self.writeSnapshot(snapshot)
        }
    }

    /// Whether this snapshot says anything the stash of its chat does not.
    /// A reload that read nothing, or a switch away from a chat unchanged
    /// since it opened, would otherwise encode and write the same file again.
    private func isNewSnapshot(_ snapshot: ChatSnapshot) -> Bool {
        guard let kept = stashSnapshots[snapshot.botId] else { return true }
        return kept.sessionId != snapshot.sessionId
            || kept.cursor != snapshot.cursor
            || kept.lastEventId != snapshot.lastEventId
            || kept.durableEvents != snapshot.durableEvents
            || kept.projection != snapshot.projection
    }

    /// Encoded and written off the main thread, strictly in order.
    private func writeSnapshot(_ snapshot: ChatSnapshot) {
        let store = snapshots
        let previous = snapshotWrite
        snapshotWrite = Task.detached(priority: .utility) {
            await previous?.value
            do {
                try store.save(snapshot)
            } catch {
                snapshotLog.error("could not save a chat snapshot: \(String(describing: error), privacy: .public)")
            }
        }
    }

    /// A chat's snapshot leaves memory and the disk, after any write still
    /// queued. A deleted bot's also blocks every later write for it.
    private func removeSnapshot(_ botId: String, blockWrites: Bool = true) {
        if blockWrites { snapshotsBlocked.insert(botId) }
        stashSnapshots[botId] = nil
        if selectedBotId == botId {
            snapshotTimer?.cancel()
            snapshotTimer = nil
        }
        let store = snapshots
        let previous = snapshotWrite
        snapshotWrite = Task.detached(priority: .utility) {
            await previous?.value
            store.remove(botId: botId)
        }
    }

    /// Clears the files of bots that no longer exist, deleted while the app
    /// was closed. In the write chain, so it never meets a write half done.
    private func pruneSnapshots() {
        guard let bots = store?.bots else { return }
        let kept = Set(bots.map(\.id))
        let store = snapshots
        let previous = snapshotWrite
        snapshotWrite = Task.detached(priority: .utility) {
            await previous?.value
            store.prune(keeping: kept)
        }
    }

    /// Builds the snapshot of every chat that has none yet, one at a time and
    /// off the main thread, so its first open is as quick as a return to it.
    /// Costs eve one read of each such session, once: a chat with a snapshot
    /// is skipped, and one the owner opens in the meantime is left to the
    /// open itself.
    private func startPrewarm() {
        prewarmTask?.cancel()
        prewarmTask = Task { @MainActor [weak self] in
            // Out of the way of the launch and the first chat's own load.
            try? await Task.sleep(nanoseconds: 3_000_000_000)
            guard let self else { return }
            PerfHarness.shared?.mark("prewarm_start")
            defer { PerfHarness.shared?.mark("prewarm_end") }
            self.pruneSnapshots()
            for bot in self.store?.bots ?? [] {
                guard !Task.isCancelled else { return }
                await self.prewarm(botId: bot.id)
            }
        }
    }

    private func prewarm(botId: String) async {
        guard prewarmNeeded(botId),
              let sessionId = store?.bots.first(where: { $0.id == botId })?.sessionId else { return }
        let client = client
        let store = snapshots
        let build = Task.detached(priority: .utility) { () -> PrewarmOutcome in
            // Read off the main thread: a snapshot, or a note that this
            // session could not have one and has not moved since, means there
            // is nothing to build.
            if store.load(botId: botId, sessionId: sessionId) != nil { return .skipped }
            guard let marker = await client.newestEventId(sessionId: sessionId) else { return .unread }
            if store.isMarkedUnbuildable(botId: botId, sessionId: sessionId, newestEventId: marker) {
                return .skipped
            }
            return await Self.buildSnapshot(client: client, botId: botId, sessionId: sessionId, marker: marker)
        }
        // Detached work does not inherit cancellation; a cancelled prewarm
        // stops its read instead of finishing a replay nobody will write.
        let outcome = await withTaskCancellationHandler {
            await build.value
        } onCancel: {
            build.cancel()
        }
        // Checked again: the owner may have opened, sent to or deleted this
        // chat while it was read, and then the open owns its snapshot. A
        // prewarm cancelled meanwhile writes nothing either.
        guard !Task.isCancelled, prewarmNeeded(botId),
              self.store?.bots.first(where: { $0.id == botId })?.sessionId == sessionId else { return }
        switch outcome {
        case .built(let snapshot):
            writeSnapshot(snapshot)
        case .unbuildable(let marker):
            let previous = snapshotWrite
            snapshotWrite = Task.detached(priority: .utility) {
                await previous?.value
                do {
                    try store.markUnbuildable(botId: botId, sessionId: sessionId, newestEventId: marker)
                } catch {
                    snapshotLog.error("could not note an unbuildable chat: \(String(describing: error), privacy: .public)")
                }
            }
        case .skipped, .unread:
            break
        }
    }

    private func prewarmNeeded(_ botId: String) -> Bool {
        guard botId != selectedBotId, sendTasks[botId] == nil, !snapshotsBlocked.contains(botId),
              stashSnapshots[botId] == nil, !workingBotIds.contains(botId),
              let sessionId = store?.bots.first(where: { $0.id == botId })?.sessionId,
              !sessionId.isEmpty else { return false }
        return true
    }

    private enum PrewarmOutcome: Sendable {
        case built(ChatSnapshot)
        /// Read to its newest event and it ends on a turn still open, or on
        /// more than one session's rows: no snapshot can be taken at rest.
        case unbuildable(newestEventId: String)
        /// Already has one, or is known not to.
        case skipped
        /// Could not be read this time; tried again next launch.
        case unread
    }

    /// One chat's snapshot, read the way a reload reads it: the durable rows,
    /// then the session up to its newest event. Nil when the session could
    /// not be read to that event or ends with a turn still running.
    private nonisolated static func buildSnapshot(
        client: BackendClient,
        botId: String,
        sessionId: String,
        marker: String
    ) async -> PrewarmOutcome {
        guard let state = try? await client.threadState(botId: botId) else { return .unread }
        let durable = ReplayGate.Durable(events: state.events)
        var atLiveTail = durable.startsLive
        var projection = StreamProjection()
        var turnIds = Set<String>()
        var cursor = 0
        var lastEventId: String?
        do {
            for try await event in client.stream(sessionId: sessionId, markHistory: true, historyMarker: marker) {
                if let index = event.index {
                    cursor = index + 1
                    lastEventId = event.id
                }
                if let turnId = event.turnId, !turnId.isEmpty { turnIds.insert(turnId) }
                if !atLiveTail { atLiveTail = ReplayGate.reachedLiveTail(durable: durable, event: event) }
                projection.apply(event, live: atLiveTail)
            }
        } catch {
            return .unread
        }
        guard cursor > 0 else { return .unread }
        guard !projection.pending, projection.soleSession == sessionId else { return .unbuildable(newestEventId: marker) }
        return .built(ChatSnapshot(
            botId: botId,
            sessionId: sessionId,
            cursor: cursor,
            lastEventId: lastEventId,
            projection: projection,
            durableEvents: state.events,
            seenTurnIds: turnIds,
            localTurnIds: []
        ))
    }

    private func trimCaches() {
        let ids = Set(transcriptCache.keys).union(backgroundProjections.keys)
        let entries = ids.map { id in
            let cached = transcriptCache[id]
            let rows = cached?.rows.reduce(0) { $0 + $1.text.utf8.count + 96 } ?? 0
            let events = cached?.events.reduce(0) { $0 + $1.text.utf8.count + 128 } ?? 0
            return CacheBudget.Entry(
                id: id,
                bytes: rows + events + (backgroundProjections[id]?.estimatedBytes ?? 0)
                    + (stashSnapshots[id]?.projection.estimatedBytes ?? 0),
                lastUsed: cacheUse[id] ?? .distantPast,
                // The open chat, a send this app holds, or a turn the follower
                // is painting into the stash: all still in use.
                pinned: id == selectedBotId || sendTasks[id] != nil || isWorking(id)
            )
        }
        for id in CacheBudget.evictions(entries, budget: Self.cacheBudgetBytes) {
            transcriptCache[id] = nil
            backgroundProjections[id] = nil
            // The file on disk stays: it is what the next open reads.
            stashSnapshots[id] = nil
            cacheUse[id] = nil
        }
    }

    private func resetThread() {
        // Clears the visible thread only. Stop, New Chat and delete cancel
        // the server turn at their call sites; switching must not.
        loadGeneration += 1
        reloadTask?.cancel()
        followTask?.cancel()
        followCursor = nil
        resumePoint = nil
        sendTickAtOpen = sendTick
        slimFirstPaint = false
        // A snapshot of the old thread still owed would be taken of the next.
        snapshotTimer?.cancel()
        snapshotTimer = nil
        // A trailing publish queued for the old thread would rebuild over the
        // cleared transcript.
        pendingPublish?.cancel()
        pendingPublish = nil
        transcriptReady = false
        restoredFromCache = false
        restoredFromSnapshot = false
        loadSucceeded = false
        // A switch to a shorter chat also shrinks the hidden count, and the
        // re-anchor must not chase a block of the chat just left.
        windowExpandedFrom = nil
        durableEvents = []
        proposals = []
        projection = StreamProjection()
        transcript = []
        transcriptBlocks = []
        searchHits = []
        openQuestions = []
        activity = .thinking
        memoryNotes = nil
        memoryError = nil
        pending = false
        backgroundWorking = false
    }

    // MARK: - Proposals

    func decideProposal(_ proposal: Proposal, confirmed: Bool, secret: String? = nil) {
        guard !busyProposals.contains(proposal.id) else { return }
        busyProposals.insert(proposal.id)
        enqueue { [weak self] in
            guard let self else { return }
            let epoch = self.storeEpoch
            do {
                if confirmed {
                    guard var action = ProposalActions.confirm(proposal) else {
                        // Never mark an action confirmed that this build could
                        // not build; the card offers dismiss for those.
                        self.busyProposals.remove(proposal.id)
                        self.threadError = "This proposal cannot be confirmed by this app. Dismiss it instead."
                        return
                    }
                    if proposal.kind == .connectServer, let secret, !secret.isEmpty {
                        action["secret"] = secret
                    }
                    let result = try await self.client.shellActionResult(
                        action,
                        proposalId: proposal.id,
                        proposalStatus: "confirmed"
                    )
                    guard !Task.isCancelled, epoch == self.storeEpoch else {
                        self.busyProposals.remove(proposal.id)
                        return
                    }
                    self.applyStore(result.store)
                    if proposal.kind == .connectApp || proposal.kind == .connectServer {
                        // The card stays: the sign-in finishes in the browser
                        // and the poll moves it through waiting and connected.
                        // A good Authorize clears any earlier banner; the two
                        // failures below set their own.
                        self.threadError = nil
                        self.stickyThreadError = nil
                        if let raw = result.redirectUrl {
                            let expectedHost = proposal.kind == .connectServer
                                ? (result.redirectHost ?? proposal.redirectHost)
                                : nil
                            let allowed = Proposal.connectRedirectAllowed(
                                raw,
                                kind: proposal.kind,
                                expectedHost: expectedHost
                            )
                            if allowed, let url = URL(string: raw) {
                                if !NSWorkspace.shared.open(url) {
                                    self.stickyThreadError = "The sign-in page could not be opened in the browser. Use Reopen."
                                    self.threadError = self.stickyThreadError
                                }
                            } else if result.redirectUrl != nil && !(raw.isEmpty) {
                                self.stickyThreadError = proposal.kind == .connectApp
                                    ? "Composio sent a sign-in link this app will not open."
                                    : "The server sent a sign-in link this app will not open."
                                self.threadError = self.stickyThreadError
                            }
                        }
                        if proposal.phase == .waiting {
                            self.busyProposals.remove(proposal.id)
                        }
                        self.startReload()
                        return
                    }
                } else {
                    let next = try await self.client.resolveProposal(
                        proposalId: proposal.id,
                        status: "dismissed"
                    )
                    guard !Task.isCancelled, epoch == self.storeEpoch else {
                        self.busyProposals.remove(proposal.id)
                        return
                    }
                    self.applyStore(next)
                }
                guard !Task.isCancelled else {
                    self.busyProposals.remove(proposal.id)
                    return
                }
                self.threadError = nil
                self.stickyThreadError = nil
                // The card leaves at once: waiting for the reload kept its
                // buttons live after a success, and a second tap double-sent.
                self.proposals.removeAll { $0.id == proposal.id }
                self.busyProposals.remove(proposal.id)
                // Reload outside the chain: a replay must not block writes.
                self.startReload()
            } catch {
                self.busyProposals.remove(proposal.id)
                self.threadError = (error as? LocalizedError)?.errorDescription ?? "Proposal failed."
            }
        }
    }

    /// Reopen the sign-in for a waiting or timed-out connect card. The busy
    /// guard in decideProposal keeps a double click from starting two.
    func reopenConnect(_ proposal: Proposal) {
        guard proposal.kind == .connectApp || proposal.kind == .connectServer else { return }
        decideProposal(proposal, confirmed: true)
    }

    // MARK: - Onboarding

    func onboardingDismissed(for botId: String) -> Bool {
        onboardingDismissedFor.contains(botId)
            || UserDefaults.standard.bool(forKey: "ub-onboarding:\(botId)")
    }

    func dismissOnboarding(botId: String) {
        onboardingDismissedFor.insert(botId)
        UserDefaults.standard.set(true, forKey: "ub-onboarding:\(botId)")
    }

    var showOnboarding: Bool {
        guard let bot = selectedBot, !onboardingDismissed(for: bot.id) else { return false }
        guard bot.kind == "bot", bot.id != Threads.defaultBotId else { return false }
        return bot.label.trimmingCharacters(in: .whitespaces).isEmpty
            && bot.description.trimmingCharacters(in: .whitespaces).isEmpty
            && durableEvents.isEmpty
            && transcript.isEmpty
            && openProposals.isEmpty
    }

    var openProposals: [Proposal] {
        proposals.filter { $0.isOpen() }
    }

    var hasThreadContent: Bool {
        !transcript.isEmpty || !openProposals.isEmpty || showOnboarding
    }

    /// The first reply row of the newest turn, or nil if the turn has none.
    ///
    /// A finished answer is read from its first line, not its last, so the
    /// transcript settles with the top of the reply in view rather than its
    /// tail. Anything the bot said before the owner's most recent message
    /// belongs to an older turn and is not the anchor.
    var latestReplyAnchor: String? {
        var anchor: String?
        var awaitingReply = false
        for block in transcriptBlocks {
            guard case .message(let row, _) = block else { continue }
            switch row.kind {
            case .user, .post:
                awaitingReply = true
                anchor = nil
            case .assistant:
                // A sub-agent's report turn has no owner row above its reply.
                if projection.taskReplyRowIds.contains(row.id) { awaitingReply = true }
                if awaitingReply {
                    anchor = row.id
                    awaitingReply = false
                }
            case .handoff, .note, .widget, .image, .page, .failure:
                continue
            }
        }
        return anchor
    }

    // MARK: - Memory

    func loadMemory(botId: String) async {
        do {
            let notes = try await client.memoryNotes(botId: botId)
            // A slow response from the previous bot must not land on this one.
            guard botId == selectedBotId else { return }
            memoryNotes = notes
            memoryError = nil
        } catch is CancellationError {
            return
        } catch {
            // Keep the last notes and show the failure instead of pretending
            // this bot remembers nothing.
            guard botId == selectedBotId else { return }
            memoryError = "Could not load memory."
        }
    }

    // MARK: - Routines

    /// The routine the pane has drilled into, resolved against the live list so
    /// a poll that renamed it does not strand the detail view on a stale copy.
    var openRoutine: Routine? {
        guard let openRoutineId else { return nil }
        return routines.first { $0.id == openRoutineId }
    }

    func closeRoutineDetail() {
        openRoutineId = nil
        routineCreating = false
    }

    private func clearRoutineState() {
        closeRoutineDetail()
        routines = []
        routinesError = nil
        routineBusy = []
        // A pane left open on a bot switch would sit empty until the next poll.
        if pane == .details, let botId = selectedBotId {
            Task { @MainActor [weak self] in await self?.loadRoutines(botId: botId) }
        }
    }

    func loadRoutines(botId: String) async {
        do {
            let next = try await client.routines(botId: botId)
            // A slow response from the previous bot must not land on this one.
            guard botId == selectedBotId else { return }
            // The run labels say Today and Yesterday, so a new day republishes
            // an unchanged list.
            let day = Calendar.current.startOfDay(for: Date())
            if routines != next || day != polledRoutinesDay { routines = next }
            polledRoutinesDay = day
            if routinesError != nil { routinesError = nil }
            if let openRoutineId, !next.contains(where: { $0.id == openRoutineId }) {
                // The routine was deleted elsewhere; fall back to the list
                // instead of showing an empty detail view.
                closeRoutineDetail()
            }
        } catch {
            guard botId == selectedBotId else { return }
            routinesError = (error as? LocalizedError)?.errorDescription ?? "Could not load routines."
        }
    }

    /// Apply one routine write and fold the server's row back into the list.
    private func routineWrite(
        id: String?,
        _ work: @escaping @MainActor (BackendClient) async throws -> Void
    ) {
        if let id {
            guard !routineBusy.contains(id) else { return }
            routineBusy.insert(id)
        }
        let botId = selectedBotId
        enqueue { [weak self] in
            guard let self else { return }
            do {
                try await work(self.client)
                self.routinesError = nil
            } catch {
                self.routinesError = (error as? LocalizedError)?.errorDescription ?? "That routine change failed."
            }
            if let id { self.routineBusy.remove(id) }
            // Re-read rather than trusting the local copy: a scheduled run may
            // have appended history while this write was in flight.
            if let botId, botId == self.selectedBotId { await self.loadRoutines(botId: botId) }
        }
    }

    func createRoutine(name: String, instruction: String, schedules: [RoutineSchedule]) {
        guard let botId = selectedBotId, !routineCreateBusy else { return }
        routineCreateBusy = true
        routineWrite(id: nil) { [weak self] client in
            defer { self?.routineCreateBusy = false }
            let created = try await client.createRoutine(
                botId: botId,
                name: name,
                instruction: instruction,
                schedules: schedules
            )
            guard let self, botId == self.selectedBotId else { return }
            self.routineCreating = false
            self.openRoutineId = created.id
        }
    }

    func updateRoutine(
        id: String,
        name: String? = nil,
        instruction: String? = nil,
        schedules: [RoutineSchedule]? = nil,
        active: Bool? = nil
    ) {
        routineWrite(id: id) { client in
            try await client.updateRoutine(
                id: id,
                name: name,
                instruction: instruction,
                schedules: schedules,
                active: active
            )
        }
    }

    func deleteRoutine(id: String) {
        routineWrite(id: id) { [weak self] client in
            try await client.deleteRoutine(id: id)
            guard let self else { return }
            if self.openRoutineId == id { self.closeRoutineDetail() }
        }
    }

    /// Test run. The server answers as soon as the turn is queued, so the
    /// outcome shows up in run history on the next poll, not in this call.
    func runRoutine(id: String) {
        routineWrite(id: id) { client in
            try await client.runRoutine(id: id)
        }
    }

    // MARK: - Composer attachments

    func addAttachments(_ urls: [URL]) {
        guard !urls.isEmpty else { return }
        attachError = nil
        // Serialise uploads so two picks cannot race the attachment list, and
        // re-check the cap after every completion instead of up front.
        let previous = uploadChain
        uploadChain = Task { @MainActor [weak self] in
            _ = await previous?.value
            guard !Task.isCancelled, let self else { return }
            for url in urls {
                guard !Task.isCancelled else { return }
                guard self.attachments.count < Attachments.maxFiles else {
                    self.attachError = "You can attach up to \(Attachments.maxFiles) files."
                    return
                }
                let outcome = await self.uploadOne(url)
                if let attachment = outcome.attachment {
                    self.attachments.append(SentImageStore.named(attachment))
                } else if let message = outcome.error {
                    self.attachError = message
                }
            }
        }
    }

    /// One pick: own its security scope for exactly this call, check the size
    /// before reading, and let the client stream the read with a hard cap.
    private func uploadOne(_ url: URL) async -> (attachment: Attachment?, error: String?) {
        let isDirectory = (try? url.resourceValues(forKeys: [.isDirectoryKey]))?.isDirectory
            ?? url.hasDirectoryPath
        if isDirectory {
            return (nil, "Folders cannot be attached.")
        }
        let accessing = url.startAccessingSecurityScopedResource()
        defer { if accessing { url.stopAccessingSecurityScopedResource() } }
        let size = (try? url.resourceValues(forKeys: [.fileSizeKey]))?.fileSize
        if let size, size > Attachments.maxBytes {
            return (nil, "That file is larger than \(Attachments.maxBytes / 1024) KB.")
        }
        let type = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType
            ?? "application/octet-stream"
        do {
            return (try await client.uploadAttachment(fileURL: url, mimeType: type), nil)
        } catch is Attachments.NameError {
            return (nil, "That file name is not allowed.")
        } catch let error as BackendError {
            return (nil, Self.attachmentCopy(error))
        } catch {
            return (nil, "Attach failed.")
        }
    }

    private static func attachmentCopy(_ error: BackendError) -> String {
        switch error.attachmentCode {
        case "attachment_size":
            return "That file is larger than \(Attachments.maxBytes / 1024) KB."
        case "attachment_missing":
            return "That file could not be read."
        case "csrf":
            return "The local server rejected the upload. Try again."
        default:
            return "Attach failed."
        }
    }

    func removeAttachment(id: String) {
        attachments.removeAll { $0.id == id }
    }

    func clearAttachments() {
        attachments = []
        attachError = nil
    }

    // MARK: - Working folder

    @Published private(set) var workspaceProjects: [ProjectEntry] = []
    @Published var workspaceError: String?

    /// Attach a folder the bot works in. The owner picked it in a native
    /// picker, so the absolute path is the grant; the permission carries over
    /// from an earlier pick or starts at Auto.
    func setWorkspaceFolder(_ url: URL) {
        guard let bot = selectedBot else { return }
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: url.path, isDirectory: &isDirectory),
              isDirectory.boolValue else {
            workspaceError = "That folder could not be read."
            return
        }
        workspaceError = nil
        // The folder takes the bot's own permission: a Read only bot that
        // attaches a folder stays Read only, and a Full access one stays
        // Full access. Reading it off the previous folder reset it to Auto.
        let permission = liveBot(bot).permission
        // The init is failable, and a nil here would reach dispatchWorkspace as
        // a detach: the owner would see their folder vanish instead of an
        // error. The picker only ever hands back absolute paths, so this is
        // belt and braces, but a silent detach is the wrong belt.
        guard let workspace = BotWorkspace(
            path: url.path,
            permission: permission
        ) else {
            workspaceError = "That folder could not be attached."
            return
        }
        dispatchWorkspace(workspace, botId: bot.id) { [weak self] in
            // Recents are best effort: a missed write only loses a menu entry.
            _ = try? await self?.client.addWorkspaceProject(path: url.path)
            await self?.loadWorkspaceProjects()
        }
    }

    func clearWorkspaceFolder() {
        guard let bot = selectedBot else { return }
        workspaceError = nil
        dispatchWorkspace(nil, botId: bot.id)
    }

    /// The permission is the bot's, with or without a folder: it covers the
    /// attached folder when there is one, the owner's home otherwise, and
    /// everything the bot does inside the app and in connected apps.
    func setWorkspacePermission(_ permission: String) {
        guard let bot = selectedBot else { return }
        workspaceError = nil
        let epoch = storeEpoch
        enqueue { [weak self] in
            guard let self else { return }
            do {
                let next = try await self.client.shellAction(
                    ShellActions.setPermission(botId: bot.id, permission: permission)
                )
                guard !Task.isCancelled, epoch == self.storeEpoch else { return }
                self.applyStore(next)
            } catch {
                self.workspaceError = (error as? LocalizedError)?.errorDescription ?? "That permission change failed."
            }
        }
    }

    private func dispatchWorkspace(
        _ workspace: BotWorkspace?,
        botId: String,
        onSuccess: (@MainActor () async -> Void)? = nil,
    ) {
        let epoch = storeEpoch
        enqueue { [weak self] in
            guard let self else { return }
            do {
                let next = try await self.client.shellAction(
                    ShellActions.setWorkspace(botId: botId, workspace: workspace)
                )
                guard !Task.isCancelled, epoch == self.storeEpoch else { return }
                self.applyStore(next)
                // Only once the grant actually landed. A rejected folder that
                // still showed up under Recents would offer the owner a pick
                // that fails again every time.
                await onSuccess?()
            } catch {
                self.workspaceError = (error as? LocalizedError)?.errorDescription ?? "That folder change failed."
            }
        }
    }

    func loadWorkspaceProjects() async {
        if let projects = try? await client.workspaceProjects() {
            workspaceProjects = projects
        }
    }

    func removeWorkspaceProject(id: String) {
        enqueue { [weak self] in
            guard let self else { return }
            do {
                _ = try await self.client.removeWorkspaceProject(id: id)
                self.workspaceError = nil
            } catch {
                self.workspaceError = (error as? LocalizedError)?.errorDescription ?? "That folder could not be removed."
            }
            await self.loadWorkspaceProjects()
        }
    }
}

/// The bot message a reply points at, and how it rides in the sent text: a
/// markdown quote above what the owner wrote, which the model reads as
/// context and the transcript shows as a quote line.
struct ReplyQuote: Equatable {
    let botId: String
    let text: String
    /// The member who wrote it, in a group; nil for the chat's own bot.
    var author: String?

    /// How much of the message goes into the quote. A long reply is quoted
    /// by its opening; the whole of it is already in the conversation.
    static let maxQuoted = 600

    /// The quoted text, clipped. In a group every @ becomes a full-width ＠:
    /// routing and attribution read @name anywhere in a message, and a name
    /// inside the quote must not send the reply to that bot. Elsewhere the
    /// quote stays exactly as the bot wrote it.
    func quoted(guardingMentions: Bool) -> String {
        let flat = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let clipped = flat.count > Self.maxQuoted ? String(flat.prefix(Self.maxQuoted)) + "…" : flat
        return guardingMentions ? clipped.replacingOccurrences(of: "@", with: "＠") : clipped
    }

    /// The line that marks a message as a reply, so a message the owner
    /// simply starts with a blockquote is never taken for one. In a group it
    /// names the member who wrote the quoted message.
    var marker: String {
        guard let author, !author.isEmpty else { return "Replying to your message:" }
        return "Replying to \(author.replacingOccurrences(of: "@", with: "＠"))'s message:"
    }

    static func isMarker(_ line: String) -> Bool {
        line.hasPrefix("Replying to ") && line.hasSuffix("message:")
    }

    func wrap(_ message: String, group: Bool) -> String {
        let lines = quoted(guardingMentions: group).split(separator: "\n", omittingEmptySubsequences: false).map { "> \($0)" }
        return marker + "\n" + lines.joined(separator: "\n") + "\n\n" + message
    }

    /// One line of the message as it reads, for the chip and the quote line:
    /// markdown marks and line breaks dropped.
    static func preview(_ text: String) -> String {
        var line = text.replacingOccurrences(of: "\n", with: " ")
        for mark in ["**", "__", "`", "~~"] {
            line = line.replacingOccurrences(of: mark, with: "")
        }
        line = line.replacingOccurrences(of: #"(^|\s)#{1,6}\s"#, with: "$1", options: .regularExpression)
        return line.replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespaces)
    }

    /// A sent message that opens with a quote, split into the quote and the
    /// rest, so the bubble can show the quote as a quote.
    static func split(_ text: String) -> (quote: String, body: String)? {
        let lines = text.components(separatedBy: "\n")
        guard lines.count > 1, isMarker(lines[0]), lines[1].hasPrefix(">") else { return nil }
        var quote: [String] = []
        var index = 1
        while index < lines.count, lines[index].hasPrefix(">") {
            quote.append(String(lines[index].dropFirst(lines[index].hasPrefix("> ") ? 2 : 1)))
            index += 1
        }
        let body = lines[index...].joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !quote.isEmpty, !body.isEmpty else { return nil }
        return (quote.joined(separator: "\n"), body)
    }
}
