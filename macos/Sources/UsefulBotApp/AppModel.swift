import AppKit
import Foundation
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
    /// "browser" opens the authorization URL; "device" shows a code.
    let flow: String
    /// The saved ChatGPT account this sign-in continues with, if any.
    let account: String?
    let accounts: [SavedChatGptAccount]
    let reusesSaved: Bool
    /// The issued client this attempt uses; nil when it registers a new account.
    let clientId: String?
    let userCode: String
    let verificationUrl: String
    let verificationUrlComplete: String?
    let expiresAt: Double
    var intervalMs: Int
}

struct InstructionDraft: Equatable {
    let base: String
    let text: String
}

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
    /// Shown when an older service would not exit, so the runtime is not replaced under it.
    static let oldServiceWouldNotStop = "An older Useful Bot service would not stop. Quit it in Activity Monitor and open the app again."
    @Published private(set) var store: ShellStore?
    @Published private(set) var selectedBotId: String? {
        didSet {
            // The chip is per bot: show this bot's last read at once (or the
            // placeholder) and read the server's, never keep the last bot's.
            if selectedBotId != oldValue {
                composerSelection.select(selectedBotId)
                composer = composerSelection.shown
                composerError = nil
                Task { @MainActor [weak self] in await self?.refreshComposer() }
            }
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
            latestReplyRunIds = TranscriptBlocks.latestReplyRunIds(transcriptBlocks)
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
    /// Per chat, the first block the reader expanded the window back to. Held
    /// for the session so a chat comes back the way it was left.
    private var windowStarts: [String: String] = [:]
    /// Derived with the blocks, not in the view: the chat body re-evaluates on
    /// every composer keystroke.
    private(set) var continuationIds = Set<String>()
    private(set) var latestReplyRunIds = Set<String>()
    /// A turn is running in the open chat (whoever started it), or a message
    /// just sent is waiting for the engine to start one. Drives the working
    /// row and the stop button.
    @Published private(set) var pending = false {
        didSet {
            // A reopened chat whose turn is already running keeps the turn's
            // own start, so the working row does not replay the arrival or
            // restart its timer.
            if pending, !oldValue { activitySince = projection.turnStartedAt ?? Date() }
        }
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
    /// What a connect card looked like when its button was tapped, so busy
    /// clears only once the card has moved on (or a short cap after the request returned).
    private var proposalTapState: [String: (phase: Proposal.ConnectPhase, waitingSince: String?, requestFinishedAt: Date?)] = [:]
    @Published private(set) var operatorName = "Desktop owner"
    @Published private(set) var operatorInitials = "DO"
    /// The bot's own model chip: every read and write names the bot and lands
    /// here only while that bot is selected.
    @Published private(set) var composer: ComposerState?
    /// The per-bot chip cache and its stale-answer guards.
    private var composerSelection = ComposerSelection()
    /// The chip label each bot's running turn started on, by bot id. A pick
    /// made while the turn runs applies to the next turn; the working row says
    /// which model this one is still on.
    @Published private(set) var runningModelLabels: [String: String] = [:]
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
    /// The question the open chat's bot is waiting on the owner to answer.
    @Published private(set) var openQuestions: [OwnerQuestion] = []

    /// The bot's chats, newest first, as the sidebar lists them.
    @Published private(set) var chats: [ChatListItem] = []
    @Published private(set) var chatsLoaded = false
    @Published private(set) var chatsLoadingMore = false
    private(set) var chatsNextBefore: String?
    /// The open chat. Nil is the empty chat a New chat opens, which has no id
    /// until its first message makes one.
    @Published private(set) var currentChatId: String?
    /// Every chat that works, waits on the owner, holds a reply or failed
    /// (`GET /api/engine/status`).
    @Published private(set) var chatMarks: [String: ChatStatus] = [:]
    /// More rows exist above the ones loaded.
    @Published private(set) var hasEarlierRows = false
    /// The row a search hit points at: the chat scrolls to it and marks it for a moment.
    @Published private(set) var highlightRowId: String?
    /// The chat the owner asked to delete, until they confirm in the dialog.
    @Published var chatPendingDelete: String?

    /// What the live turn is doing, shown in the working row until the reply
    /// takes its place.
    @Published private(set) var activity: TurnActivity = .thinking
    /// The running step's call id, so the working mark can tell one command
    /// step from the next even when the command line is the same.
    @Published private(set) var activityCall: String?
    /// When the running turn began, for the working row's timer. It counts
    /// the whole turn, from the send to the reply, through every step: a
    /// timer that went back to 0 at each tool read as the bot starting over.
    @Published private(set) var activitySince = Date()
    /// Operator identity plus build info for the settings dialog.
    @Published private(set) var appStatus: AppStatus?
    /// App settings dialog, opened from the rail account row or the composer.
    @Published var appSettingsOpen = false {
        didSet { if appSettingsOpen { searchOpen = false } }
    }
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
    /// Connections turned off because the vendor doesn't allow Useful Bot on that route. Listed in Providers so they can be removed.
    @Published private(set) var providerRetired: [ConnectionPublic] = []
    var providerRows: [ConnectionPublic] { providerConnections + providerRetired }
    /// With no usable connection, the sentence of the turned-off one that explains why.
    var noModelRetiredSentence: String? {
        noModelConnected ? ConnectionPublic.retiredReason(connected: providerConnections, retired: providerRetired) : nil
    }
    @Published private(set) var defaultRole: RolePublic?
    @Published private(set) var imageRole: RolePublic?
    /// A connect-sheet failure, shown under the field it belongs to.
    @Published private(set) var connectError: String?
    /// A device flow the Providers pane is waiting on, with its poll.
    @Published private(set) var oauth: OAuthPending?
    @Published private(set) var oauthError: String?
    /// The poll's error code behind `oauthError`, which drives what the sheet offers.
    @Published private(set) var oauthErrorCode: String?
    /// How the last ChatGPT attempt was started, so Try again repeats it.
    private var oauthLastAttempt: (newAccount: Bool, clientId: String?) = (false, nil)
    /// The client a failed attempt offered for a retry, if the server gave one.
    private var oauthRetryClientId: String?
    /// True once the flow ended in an error the sheet shows. The pending entry
    /// stays so the sheet stays up with the error; the spinner and the
    /// sign-in button hide, and Close clears everything.
    @Published private(set) var oauthDone = false
    /// Bumped each time a device sign-in completes, so a screen waiting on
    /// one can tell it finished rather than was cancelled.
    @Published private(set) var oauthCompletions = 0
    /// The one-time "You're using your ChatGPT plan" dialog, shown after the
    /// first ChatGPT sign-in on this install (first run or the Providers pane).
    @Published var showChatGptPlanWelcome = false
    private static let chatgptPlanWelcomeKey = "chatgptPlanWelcomeShown"
    /// Consecutive poll errors; the flow ends at the limit rather than waiting out the code.
    private var oauthErrorStreak = 0
    private static let oauthErrorLimit = 6
    private var oauthPoll: Task<Void, Never>?
    @Published private(set) var usage: UsagePayload?
    @Published var usageError: String?
    @Published var budgetMessages = BudgetMessages()
    /// A budget change in flight, so the stepper cannot fire twice.
    @Published private(set) var usageBusy = false
    private var pendingBudgetWrites = PendingBudgetWrites<(BackendClient) async throws -> UsagePayload>()
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
    /// Direct MCP and OpenAPI connections, shown above the catalogue.
    @Published private(set) var directConnections: [DirectConnection] = []
    @Published private(set) var directConnectionBusy: Set<String> = []
    @Published var directConnectionsError: String?
    private var directConnectionPoll: Task<Void, Never>?
    /// Which poll owns `directConnectionPoll`, so a finished or cancelled task
    /// never clears a newer one's handle.
    private var directConnectionPollId = 0
    /// True from the Connectors dialog's first load until it closes; a load
    /// still in flight after that starts no poll.
    private var directConnectionsOpen = false
    private var directLoadSeq = 0
    private var directLoadApplied = 0
    private var quietLoadFailures = 0
    /// True while the running directConnectionPoll is the sign-in one.
    private var directConnectionPollIsSignIn = false
    private static let directLoadFailedCopy = "Couldn't load servers."
    private static let connectorUpstreamError = "Composio did not answer. Try again in a moment."
    private static let connectorKeyRejected = "Composio rejected this key. Remove it and paste a fresh one from platform.composio.dev."
    private static let connectorLoadErrors: Set<String> = [
        "Could not load connectors.",
        connectorUpstreamError,
        connectorKeyRejected,
    ]

    /// What the stage shows: a chat, or the Routines, Library or Connectors page.
    enum Stage: Equatable {
        case chat
        case routines
        case library
        case connectors
    }

    /// A Library item the search palette picked: the page opens on its detail.
    /// Published so a Library page already open picks it up too.
    @Published var libraryFocusId: String?

    @Published var stage: Stage = .chat {
        didSet {
            // Every write is a navigation (a sidebar row, a page, a chat, New
            // chat), the same stage included: the palette gives way to it.
            searchOpen = false
            guard stage != oldValue else { return }
            // The page opens on the list, never on the row it showed last time.
            if oldValue == .routines { closeRoutineDetail() }
            if stage == .routines, let botId = selectedBotId {
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

    /// Unsaved instruction edits per bot, with the stored text each started
    /// from. They outlive the editor and the window until saved or discarded.
    var instructionDrafts: [String: InstructionDraft] = [:]

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
    /// A focus was asked for and no composer has taken it yet. A composer that
    /// mounts afterwards (New chat from a page) reads it and takes the caret.
    private var composerFocusPending = false

    /// Ask for the caret in the composer, whether it is on screen yet or not.
    func requestComposerFocus() {
        composerFocusToken &+= 1
        composerFocusPending = true
    }

    func takeComposerFocusPending() -> Bool {
        defer { composerFocusPending = false }
        return composerFocusPending
    }
    /// The composer's text view is the focused control (set by the composer).
    @Published var composerFocused = false

    /// ⌘↑ and ⌘↓ switch chats only from an empty, focused composer on the chat
    /// stage. Anywhere else (another text field, a composer with text) the key
    /// goes to the field and moves its caret. A turn keeps running in its chat
    /// whichever chat is open.
    var chatSwitchKeysEnabled: Bool {
        stage == .chat && composerFocused && draft.isEmpty
    }
    @Published var attachments: [Attachment] = []
    @Published var attachError: String?

    private let config: ServerConfig
    private let services = LocalServices()
    private let poller = HealthPoller(probe: URLSessionHealthProbe())
    private let client: BackendClient
    private var startAttempt = 0
    /// The start in flight, so a retry can cancel it before starting another.
    private var bootTask: Task<Void, Never>?
    /// A retry already tearing down and restarting the stack.
    private var retrying = false
    /// Set by `retry()` for the boot it starts, so a service that hung without
    /// binding is replaced rather than waited on again.
    private var ownerRetried = false

    init() {
        let config = ServerConfig.resolved()
        self.config = config
        // DesktopEndpointPolicy never rejects; the throws exists so iOS
        // policies can refuse an endpoint (spec 4.7).
        self.client = try! BackendClient(base: config.baseURL)
        TurnNotifier.shared.onOpenChat = { [weak self] chatId in self?.openChat(chatId) }
        TurnNotifier.shared.start()
    }

    private var projection = ChatProjection()
    private var pollTask: Task<Void, Never>?
    private var approvalPollTask: Task<Void, Never>?
    private var followTask: Task<Void, Never>?
    /// Bumped whenever the open chat changes or is read again, so the task of
    /// an older read stops.
    private var followGeneration = 0
    private var saveChain: Task<Void, Never>?
    private var uploadChain: Task<Void, Never>?
    /// One tick at a time; a slow server must not stack them.
    private var tickInFlight = false
    /// Consecutive unauthorized polls, surfaced after the second failure.
    private var pollAuthFailures = 0
    /// Bumped by retry so a shell write that was already in flight cannot
    /// land its echo over the fresh reload.
    private var storeEpoch = 0
    /// A send's own failure banner, preserved across a reload.
    private var stickyThreadError: String?
    /// Bumped once per owner-initiated send. The transcript watches it to jump
    /// to the newest turn: sending is an explicit request to watch the answer,
    /// so it overrides whatever the reader's scroll position was.
    @Published private(set) var sendTick: UInt64 = 0
    /// `sendTick` when the open chat was put on screen.
    private var sendTickAtOpen: UInt64 = 0
    /// Whether the owner sent in this chat since opening it. The transcript
    /// lands on a send's rows only then.
    var sentSinceOpen: Bool { sendTick != sendTickAtOpen }
    /// False from the moment a chat is opened until its first page of rows is
    /// in. The transcript is not built at all until this is true, so its first
    /// layout is the finished one and `defaultScrollAnchor(.bottom)` puts it
    /// on the newest turn with nothing to animate.
    @Published private(set) var transcriptReady = false
    /// Whether the open chat's rows were read at least once.
    private var loadSucceeded = false
    /// A message was sent and the engine has not started its turn yet.
    private var awaitingStart = false
    /// Sends whose answer has not come back. While one is out, the first rows
    /// load of a new chat must not drop `awaitingStart`.
    private var sendsInFlight = 0
    /// Consecutive failed engine status reads.
    private var statusFailures = 0
    /// Status chat ids the list has already been refreshed for (see `pollEngineStatus`).
    private var refreshedForUnknown: Set<String> = []
    /// Files of messages this app sent, by client id, so Send again / Edit on a
    /// message the engine handed back unsent (text only) can restore them. A row
    /// left from before a restart comes back text only.
    private var sentFilesByClient: [String: [Attachment]] = [:]
    /// The chat creation the first message started; a second message waits on it.
    private var chatCreation: Task<String, Error>?
    /// The load error text on screen, so a later good load clears only that one.
    private var loadErrorText: String?
    /// When the router's cool-down lifts, for the failed turn's Retry.
    private var retryNotBefore: Date?
    /// Chats the engine said it does not have.
    private var goneChatIds: Set<String> = []
    /// Chats whose delete was sent and not yet answered.
    private var deletingChatIds: Set<String> = []
    /// Each chat's newest turn id as of the last status read, for the
    /// notification. Nil until the first read, which only sets the baseline.
    private var lastTurnIds: [String: String]?
    /// Messages the engine handed back unsent that the owner dismissed.
    /// Oldest first, no repeats: the newest 200 are kept.
    private var hiddenEngineUnsentOrder = (UserDefaults.standard.stringArray(forKey: "hiddenUnsentClientIds") ?? []).suffix(200).map { $0 }
    private var hiddenEngineUnsent: Set<String> { Set(hiddenEngineUnsentOrder) }
    /// A send that never reached the engine, on a chat the owner had already
    /// left. The composer was cleared when the message was committed, so the
    /// text and its files wait here and go back when that chat is opened again.
    private var unsentDrafts: [String: (text: String, attachments: [Attachment])] = [:]
    /// Messages the server refused before the engine took the turn, per chat.
    /// Kept here and on disk because the engine never stored them: the failed
    /// bubble they draw has to survive a reload, a chat switch and a relaunch.
    private var unsentLists: [String: UnsentList] = [:]
    private let unsentStore: UnsentStore = {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return UnsentStore(directory: AppVariant.current.appSupportDirectory(support: base)
            .appendingPathComponent("Unsent Messages", isDirectory: true))
    }()
    /// The refused message each chat is sending again right now. It stays in
    /// the list and on disk until the engine takes the turn; the transcript
    /// just hides its bubble so the resend shows once.
    private var retryingUnsent: [String: String] = [:]
    private var started = false
    /// Rebuilding the transcript on every streamed event re-parses markdown
    /// for every row, so publishes are throttled and the final state is forced.
    private var lastTranscriptPublish = Date.distantPast
    /// The trailing edge of the throttle. Without it a burst of deltas that
    /// ends inside the window leaves the newest text unrendered until the next
    /// event, which is what made a reply arrive in visible steps.
    private var pendingPublish: Task<Void, Never>?
    private static let publishInterval: TimeInterval = 0.1

    /// What the performance guard records with each landing.
    var perfStats: [String: Any] {
        ["rows": transcript.count, "blocks": transcriptBlocks.count, "loaded": projection.rows.count]
    }

    /// The dev stack's synthetic fixture chats the harness opened, by id. The
    /// engine leaves them out of the sidebar's list.
    private var fixtureTitles: [String: String] = [:]

    /// A chat's title, for the harness: the list's, or a fixture's.
    func chatTitle(_ chatId: String?) -> String? {
        guard let chatId else { return nil }
        return chats.first { $0.chatId == chatId }?.title ?? fixtureTitles[chatId]
    }

    /// Opens one of the perf fixture chats by title. Only the harness calls it.
    func openFixtureChat(title: String) async -> String? {
        guard PerfHarness.shared != nil, let botId = selectedBotId,
              let page = try? await client.chats(botId: botId, limit: 200, includeFixtures: true),
              let chat = page.chats.first(where: { $0.title == title }) else { return nil }
        fixtureTitles[chat.chatId] = chat.title
        openChat(chat.chatId)
        return chat.chatId
    }

    var selectedBot: ShellBot? {
        store?.bot
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
        // Consumed here, not at `ensure`: a retry whose setup fails first would
        // otherwise leave the flag set for an unrelated later start.
        let replaceHung = ownerRetried
        ownerRetried = false
        // A Retry or a stack switch boots again: the watch from the last boot
        // must not start services while this one stops and starts them.
        services.stopWatching()
        startAttempt += 1
        let attempt = startAttempt
        phase = .starting
        startupError = nil
        threadError = nil
        stickyThreadError = nil
        saveError = nil
        // A build with a payload (the release, and the dev app) first lays out
        // the services it carries (a copy only after an update) and refreshes
        // the local credentials.
        // Only into its own folder: the copy deletes what the payload does not
        // carry, so a checkout set as `repoPath` must never be its target.
        if AppVariant.current == .dev, RuntimeInstall.bundledRuntime() == nil {
            // The dev app never runs the checkout: a bundle built before it carried
            // a payload has nothing to run.
            startupError = "This Useful Bot Dev build carries no services. Rebuild it with npm run build:dev-app and install it with npm run install:dev-app."
            phase = .unavailable
            return
        }
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
                let stopped = await services.stopOwnServices(config: config)
                guard !Task.isCancelled, attempt == startAttempt else { return }
                // An old-version process still running would write into the
                // files the copy replaces: leave them alone and say so.
                if stopped.didNotStop {
                    NSLog("Useful Bot: old services would not stop: %@", String(describing: stopped))
                    startupError = Self.oldServiceWouldNotStop
                    phase = .unavailable
                    return
                }
            }
            let prepared = await Task.detached { () -> Result<Bool, Error> in
                Result { try RuntimeInstall.prepare(bundled: bundled, root: root, holding: lock) }
            }.value
            // New credentials replace ones a running router, engine or web still
            // holds (each reads them once at boot). The stop happens even for
            // a cancelled attempt: the next launch sees a config and would
            // keep the stale services.
            var staleServicesRemain = false
            if case .success(true) = prepared {
                staleServicesRemain = await services.stopOwnServices(config: config).didNotStop
            }
            guard !Task.isCancelled, attempt == startAttempt else { return }
            if staleServicesRemain {
                NSLog("Useful Bot: old services would not stop after the runtime copy")
                startupError = Self.oldServiceWouldNotStop
                phase = .unavailable
                return
            }
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
        let outcome = await services.ensure(config: config, replaceHung: replaceHung)
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
        // Something healthy answers on this app's ports as another stack. It is
        // never adopted, started over or stopped: say so and stay out of it.
        if outcome == .foreignStack {
            var message = "A service on this app's ports belongs to another Useful Bot stack, so \(AppVariant.current.displayName) won't use or stop it. Quit the other stack and try again."
            if let detail = await services.foreignListenerDetail(config: config) { message += " " + detail + "." }
            startupError = message
            phase = .unavailable
            return
        }
        // A process this app started is still alive but never opened its port.
        // It is named and left running: starting another would only stack.
        if case .neverBound(let modes) = outcome {
            startupError = LocalServices.neverBoundMessage(modes, variant: AppVariant.current)
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
        // The stack is up: from here a service that dies is started again.
        services.startWatching(config: config)
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
            selectedBotId = loaded.bot?.id
            PerfHarness.shared?.mark("initial_selection", ["bot": selectedBotId ?? ""])
            phase = .ready
            // The chat the app opens on is read while the operator and composer
            // are: they share nothing with it.
            let opening = Task { @MainActor [weak self] in await self?.loadInitialChat() }
            await loadOperator()
            await refreshComposer()
            await opening.value
            // Started once the launch chat is open: before it, the harness saw
            // no chat and its first select raced the launch chat's open.
            PerfHarness.shared?.run(model: self)
            await pollApprovals()
            // The first-run gate and the skipped-setup bar read these. Not
            // awaited: a cold live-model refresh can take seconds.
            Task { await self.loadProviders() }
            startPolling()
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
        followTask?.cancel()
        // Let the serialised shell writes drain instead of forking a second
        // chain: cancellation is cooperative and a tail could still land.
        await saveChain?.value
        // Anything that was in flight from before this retry must not paint
        // over the fresh state.
        storeEpoch += 1
        uploadChain?.cancel()
        uploadChain = nil
        pollTask = nil
        approvalPollTask = nil
        followTask = nil
        followGeneration += 1
        started = false
        ownerRetried = true
        await start()
    }

    private func startPolling() {
        pollTask?.cancel()
        pollTask = Task { @MainActor [weak self] in
            // With no window on screen there is nobody to show a fresh rail
            // or thread to, so those reads drop to every fourth tick.
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
        await pollEngineStatus()
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

    // MARK: - Chats

    /// The key a chat's per-chat state is filed under. The empty chat a New
    /// chat opens has no id until its first message makes one.
    var chatKey: String { currentChatId ?? Self.draftChatKey }
    static let draftChatKey = "new-chat"

    /// Show a page, or a chat. Picking another chat never stops a running
    /// turn: every chat runs on its own in the engine.
    func openChat(_ chatId: String?, highlight rowId: String? = nil) {
        // A notification click can launch the app: the chat opens once it is up.
        guard phase == .ready else {
            launchChatId = chatId
            return
        }
        stage = .chat
        searchOpen = false
        if chatId == currentChatId, chatId != nil || transcriptReady {
            if let rowId { Task { @MainActor in await focusRow(rowId) } }
            return
        }
        leaveOpenChat()
        // A New chat starts clean: refused messages of the empty chat go with it.
        if chatId == nil { clearUnsent(key: Self.draftChatKey) }
        currentChatId = chatId
        attachError = nil
        threadError = nil
        stickyThreadError = nil
        saveError = nil
        resetThread()
        if let unsent = unsentDrafts.removeValue(forKey: chatKey) {
            restoreUnsentDraft(unsent.text, sentAttachments: unsent.attachments)
        }
        if let chatId {
            clearReplyReady(chatId)
            let client = client
            Task { try? await client.openChat(chatId) }
            startFollow(chatId: chatId, highlight: rowId)
        } else {
            // A new chat is empty until the first message: there is nothing to load.
            transcriptReady = true
            rebuildTranscript()
        }
    }

    /// New chat (⌘N, the pencil). An empty chat already is one, so it only
    /// gets the caret.
    func newChatOrFocusComposer() {
        // A gone chat looks empty, but it refuses every send.
        let gone = currentChatId.map { goneChatIds.contains($0) } ?? false
        if stage == .chat, transcriptReady, !hasThreadContent, !pending, !gone {
            requestComposerFocus()
        } else {
            startNewChatNow()
        }
    }

    func startNewChatNow() {
        openChat(nil)
        requestComposerFocus()
    }

    /// What the chat on screen drops when another opens or it is deleted.
    private func leaveOpenChat() {
        persistNewWidgets()
        followGeneration += 1
        followTask?.cancel()
        followTask = nil
        pendingPublish?.cancel()
        pendingPublish = nil
    }

    /// Clears the visible thread only.
    private func resetThread() {
        sendTickAtOpen = sendTick
        transcriptReady = false
        loadSucceeded = false
        hasEarlierRows = false
        highlightRowId = nil
        awaitingStart = false
        windowExpandedFrom = nil
        proposals = []
        projection = ChatProjection()
        transcript = []
        transcriptBlocks = []
        openQuestions = []
        activity = .thinking
        activityCall = nil
        pending = false
        retryableFailureRowId = nil
        failureRetryUntil = nil
        memoryNotes = nil
        memoryError = nil
    }

    func reloadThread() async {
        guard let chatId = currentChatId else { return }
        startFollow(chatId: chatId)
    }

    // MARK: - Following the open chat

    private func startFollow(chatId: String, highlight rowId: String? = nil) {
        followGeneration += 1
        let generation = followGeneration
        followTask?.cancel()
        followTask = Task { @MainActor [weak self] in
            await self?.follow(chatId: chatId, generation: generation, highlight: rowId)
        }
    }

    /// Opens the chat's event stream first, then reads its rows, then applies
    /// only the events past the page's `tailSeq` (SPEC 6.2). A dropped stream
    /// reconnects after a backoff of 1 s doubling to 10 s, resuming from the
    /// last `seq`; a gap, a resync or a new engine epoch reads the rows again.
    private func follow(chatId: String, generation: Int, highlight: String?) async {
        var needRows = true
        var backoff = 1.0
        var focus = highlight
        var reloadedAt = Date.distantPast
        while !Task.isCancelled, generation == followGeneration {
            let after = needRows ? nil : projection.tailSeq
            let epoch = needRows ? nil : projection.epoch
            let stream = client.chatEvents(chatId: chatId, after: after, epoch: epoch)
            var delay = 0.0
            do {
                if needRows {
                    let page = try await client.chatRows(chatId: chatId)
                    guard generation == followGeneration else { return }
                    // Without a tail the stream cannot be lined up with the page.
                    guard page.tailSeq != nil else { throw BackendError.shell("rows_missing_tail") }
                    projection.load(page)
                    hasEarlierRows = projection.nextBefore != nil
                    needRows = false
                    reloadedAt = Date()
                    transcriptReady = true
                    loadSucceeded = true
                    if sendsInFlight == 0 { awaitingStart = false }
                    if let shown = loadErrorText {
                        if threadError == shown { threadError = nil }
                        loadErrorText = nil
                    }
                    publishTranscript(force: true)
                    PerfHarness.shared?.mark("rows_first_paint", ["chat": chatId, "rows": projection.rows.count])
                    loadProposalsSoon()
                    PerfHarness.shared?.mark("rows_done", ["chat": chatId, "rows": projection.rows.count])
                    if let target = focus {
                        focus = nil
                        await focusRow(target)
                    }
                }
                for try await event in stream {
                    guard generation == followGeneration else { return }
                    backoff = 1
                    if !receive(event, resumed: after != nil) {
                        needRows = true
                        // A gap right after a reload would loop: wait a second first.
                        if Date().timeIntervalSince(reloadedAt) < 1 { delay = 1 }
                        break
                    }
                }
                // The stream ended without an error being thrown: reconnect.
                if !needRows { delay = backoff }
            } catch is CancellationError {
                return
            } catch BackendError.chat(let code, _) where code == "chat_not_found" {
                guard generation == followGeneration else { return }
                goneChatIds.insert(chatId)
                // A gone chat refuses every send, and New chat on its empty
                // screen only focused the composer: the owner was stuck. The
                // screen becomes a new chat, so the next message starts one.
                // Not off the chat screen (that would pull the owner off
                // their page; New chat leaves a gone chat instead), and not
                // while a delete of it is in flight: the delete opens the
                // chat the engine picks next.
                if chatId == currentChatId, stage == .chat, !deletingChatIds.contains(chatId) { openChat(nil) }
                transcriptReady = true
                threadError = BackendError.chatCopy(code)
                return
            } catch {
                guard generation == followGeneration else { return }
                // A page that never loaded says so; a stream that dropped
                // under rows already on screen just reconnects.
                if needRows, !loadSucceeded {
                    transcriptReady = true
                    let message = stickyThreadError ?? (error as? LocalizedError)?.errorDescription ?? "Chat failed to load."
                    threadError = message
                    loadErrorText = stickyThreadError == nil ? message : nil
                }
                delay = backoff
            }
            guard generation == followGeneration, !Task.isCancelled else { return }
            if delay > 0 {
                try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
                backoff = min(backoff * 2, 10)
            }
        }
    }

    /// Applies one event. False when the rows have to be read again.
    private func receive(_ event: ChatEvent, resumed: Bool) -> Bool {
        switch projection.apply(event, resumed: resumed) {
        case .resync, .gap:
            return false
        case .ignored:
            return true
        case .applied:
            if event.type == "row", event.row?.kind == .card { loadProposalsSoon() }
            if event.type == "turn.started" {
                // A new turn owns its own outcome.
                stickyThreadError = nil
                threadError = nil
            }
            if event.type == "turn.failed" { armRetryClock(event) }
            // A queued send that ran normally no longer needs its files kept for Send again.
            if event.type == "message.user", let clientId = event.clientId { sentFilesByClient[clientId] = nil }
            if ["turn.started", "turn.completed", "turn.cancelled", "turn.failed"].contains(event.type) {
                awaitingStart = false
            }
            publishTranscript()
            return true
        }
    }

    /// The error a failed turn's Retry waits on, from the router's own
    /// `retryAfterMs`, held so the button comes back when the pause lifts.
    private func armRetryClock(_ event: ChatEvent) {
        guard let ms = event.retryAfterMs, ms > 0 else { retryNotBefore = nil; return }
        retryNotBefore = Date().addingTimeInterval(TimeInterval(ms) / 1000)
    }

    // MARK: - Chat list

    /// The first page of the bot's chats. The newest rows are replaced; older
    /// pages the sidebar already loaded stay below them.
    func refreshChats() async {
        guard let botId = selectedBotId, let page = try? await client.chats(botId: botId) else { return }
        applyChatList(page)
    }

    /// The engine's current chat at launch, or the one a notification asked for.
    /// A read that fails is tried again by the poll.
    private func loadInitialChat() async {
        guard let botId = selectedBotId else { return }
        do {
            let page = try await client.chats(botId: botId)
            applyChatList(page)
            initialChatPending = false
            let target = launchChatId ?? page.current
            launchChatId = nil
            openChat(target)
        } catch {
            initialChatPending = true
            transcriptReady = true
        }
    }

    private var launchChatId: String?
    /// The first read of the chats failed (the engine was still starting).
    private var initialChatPending = false

    private func applyChatList(_ page: ChatsPage) {
        var next = page.chats
        if let oldest = page.chats.last?.updatedAt, page.nextBefore != nil {
            // Older pages already on screen stay, below the fresh first page.
            let known = Set(page.chats.map(\.chatId))
            next += chats.filter { ($0.updatedAt ?? .distantPast) < oldest && !known.contains($0.chatId) }
        }
        // With older pages on screen the cursor stays where they left it.
        let keepsOlder = next.count > page.chats.count
        if next != chats { chats = next }
        if !keepsOlder, page.nextBefore != chatsNextBefore { chatsNextBefore = page.nextBefore }
        chatsLoaded = true
    }

    /// The next 60 chats, when the sidebar scrolls to its end.
    func loadMoreChats() {
        guard let botId = selectedBotId, let before = chatsNextBefore, !chatsLoadingMore else { return }
        chatsLoadingMore = true
        Task { @MainActor [weak self] in
            guard let self else { return }
            defer { self.chatsLoadingMore = false }
            guard let page = try? await self.client.chats(botId: botId, before: before) else { return }
            let known = Set(self.chats.map(\.chatId))
            self.chats += page.chats.filter { !known.contains($0.chatId) }
            self.chatsNextBefore = page.nextBefore
        }
    }

    /// Message-text hits for the search palette.
    func searchChatText(_ query: String) async -> [ChatSearchHit] {
        (try? await client.searchChats(query: query)) ?? []
    }

    func renameChat(_ chatId: String, to title: String) {
        let clean = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !clean.isEmpty, let index = chats.firstIndex(where: { $0.chatId == chatId }) else { return }
        let kept = String(clean.prefix(60))
        guard chats[index].title != kept else { return }
        chats[index].title = kept
        enqueue { [weak self] in
            guard let self else { return }
            do {
                try await self.client.renameChat(chatId, title: kept)
            } catch {
                self.saveError = (error as? LocalizedError)?.errorDescription ?? "That chat could not be renamed."
                await self.refreshChats()
            }
        }
    }

    /// Whether a chat can be deleted: not while it works. The tooltip on the
    /// disabled item says why.
    func canDeleteChat(_ chatId: String) -> Bool { !isWorking(chatId) }

    /// ⌘⌫ deletes the open chat after the confirm dialog. Not from a composer
    /// holding text, where the key deletes the text, and not while it works.
    var canDeleteCurrentChat: Bool {
        guard stage == .chat, let id = currentChatId else { return false }
        return canDeleteChat(id) && draft.isEmpty
    }

    func requestDeleteCurrentChat() {
        guard canDeleteCurrentChat else { return }
        chatPendingDelete = currentChatId
    }

    func deleteChat(_ chatId: String) {
        guard canDeleteChat(chatId) else { return }
        let wasOpen = chatId == currentChatId
        deletingChatIds.insert(chatId)
        enqueue { [weak self] in
            guard let self else { return }
            defer { self.deletingChatIds.remove(chatId) }
            do {
                let current = try await self.client.deleteChat(chatId)
                self.chats.removeAll { $0.chatId == chatId }
                self.chatMarks[chatId] = nil
                self.clearUnsent(key: chatId)
                if wasOpen, self.currentChatId == chatId { self.openChat(current) }
            } catch {
                self.saveError = (error as? LocalizedError)?.errorDescription ?? "That chat could not be deleted."
                await self.refreshChats()
            }
        }
    }

    /// ⌘↑ and ⌘↓: the previous or next chat in the sidebar's order. With no
    /// chat open (an empty new chat, or a page) either key lands on the newest.
    func openAdjacentChat(_ step: Int) {
        let entries = chatEntries
        guard !entries.isEmpty else { return }
        let index = stage == .chat ? entries.firstIndex { $0.id == currentChatId } : nil
        let target = index.map { $0 + step } ?? 0
        guard entries.indices.contains(target) else { return }
        openChat(entries[target].id)
    }

    /// The mark beside a chat's row, by the spec's priority.
    func mark(for chatId: String) -> ChatMark? {
        if let status = chatMarks[chatId], let mark = status.mark {
            // The open chat's own state is on screen: it never shows a
            // reply-ready mark, and its question or approval is right there.
            if chatId == currentChatId, mark == .replyReady { return nil }
            return mark
        }
        if chatId == currentChatId, pending { return .working }
        return nil
    }

    func isWorking(_ chatId: String) -> Bool {
        chatMarks[chatId]?.running != nil || (chatId == currentChatId && pending)
    }

    private func clearReplyReady(_ chatId: String) {
        guard chatMarks[chatId]?.replyReadySince != nil else { return }
        chatMarks[chatId]?.replyReadySince = nil
        updateDockBadge()
    }

    /// A routine's run points at its chat. Gone when the list is complete and
    /// does not hold it, or when opening it already failed.
    func chatIsGone(_ chatId: String) -> Bool {
        if goneChatIds.contains(chatId) { return true }
        return chatsLoaded && chatsNextBefore == nil && !chats.contains { $0.chatId == chatId } && chatId != currentChatId
    }

    // MARK: - Rows beyond the first page

    /// "Show earlier messages": the hidden blocks first, then the next older
    /// page of rows from the engine.
    func showEarlierMessages() {
        let hidden = min(transcriptWindow.hidden, transcriptBlocks.count)
        if hidden > 0 {
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
            windowStarts[chatKey] = transcriptBlocks[start].id
            republishWindow()
        } else if hasEarlierRows {
            Task { @MainActor [weak self] in await self?.loadEarlierRows() }
        }
    }

    private var loadingEarlier = false

    /// One older page of rows goes in front of the loaded ones. The block that
    /// was first stays where the reader had it.
    @discardableResult
    private func loadEarlierRows() async -> Bool {
        guard let chatId = currentChatId, let before = projection.nextBefore, !loadingEarlier else { return false }
        loadingEarlier = true
        defer { loadingEarlier = false }
        let generation = followGeneration
        guard let page = try? await client.chatRows(chatId: chatId, before: before),
              generation == followGeneration else { return false }
        let firstMounted = transcriptWindow.startId
        windowExpandedFrom = firstMounted
        projection.prepend(page)
        hasEarlierRows = projection.nextBefore != nil
        publishTranscript(force: true)
        // The older rows mount as soon as they are in, a window's worth above
        // the block the reader was looking at.
        if let firstMounted, let index = transcriptBlocks.firstIndex(where: { $0.holds(rowId: firstMounted) }) {
            windowStarts[chatKey] = transcriptBlocks[max(0, index - TranscriptBlocks.windowMinimum)].id
        }
        republishWindow()
        return true
    }

    /// Scrolls the chat to a row and marks it for a moment. A row older than
    /// the loaded pages is fetched first.
    private func focusRow(_ rowId: String) async {
        var steps = 0
        while !projection.contains(rowId: rowId), projection.nextBefore != nil, steps < 40 {
            guard await loadEarlierRows() else { break }
            steps += 1
        }
        guard projection.contains(rowId: rowId) else { return }
        // The window has to hold the row's block.
        if let index = transcriptBlocks.firstIndex(where: { $0.holds(rowId: rowId) }),
           index < transcriptWindow.hidden {
            windowStarts[chatKey] = transcriptBlocks[max(0, index - 2)].id
            republishWindow()
        }
        highlightRowId = rowId
        let marked = rowId
        try? await Task.sleep(nanoseconds: 2_500_000_000)
        if highlightRowId == marked { highlightRowId = nil }
    }

    // MARK: - Polling

    private func pollOnce(displayReads: Bool = true) async {
        guard phase == .ready else { return }
        pumpTick()
        guard displayReads else { return }
        do {
            let fresh = try await client.shell()
            // Only a real change is published. Every view observes this whole
            // model, so assigning an identical store redrew the window, and
            // re-laid out the transcript, every 2.5 s with nothing happening.
            let storeChanged = fresh != store
            if storeChanged {
                store = fresh
                reconcileSelection(fresh)
            }
            guard let bot = selectedBot else { return }
            if initialChatPending {
                await loadInitialChat()
            } else {
                await refreshChats()
            }
            if proposals.contains(where: { $0.isOpen() && $0.phase == .waiting }) { await loadProposals() }
            pruneBusyProposals()
            // The day dividers say Today and Yesterday.
            let day = Calendar.current.startOfDay(for: Date())
            if storeChanged || day != polledTranscriptDay {
                polledTranscriptDay = day
                rebuildTranscript()
            }
            await refreshComposer()
            // The sidebar's Routines badge reads it, so it stays fresh every
            // 30 seconds; with the page open, a run that lands mid-poll has to
            // show up on it without a reopen, so every tick.
            if stage == .routines || routinesTick % 12 == 0 { await loadRoutines(botId: bot.id) }
            routinesTick &+= 1
            pollConnectorStates()
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

    /// What the last poll saw, for the thing that changes a published value
    /// without changing the wire: the calendar day the dividers are labelled against.
    private var polledTranscriptDay: Date?
    private var polledRoutinesDay: Date?
    private var routinesTick = 0

    /// The connect pumps and the orphan sweep, one at a time.
    private func pumpTick() {
        guard !tickInFlight else { return }
        tickInFlight = true
        Task { @MainActor [weak self] in
            guard let self else { return }
            await self.client.tick()
            self.tickInFlight = false
        }
    }

    private func pruneBusyProposals() {
        // Open cards keep their busy mark, except a connect card the poll now
        // renders in Waiting: its Authorize or Reopen was applied, so the mark
        // has done its job.
        // A failed card is settled too: Try again was applied and the card is
        // failed again, so both buttons must come back.
        // A connect card's mark is capped at 10 s in any phase, counted from
        // when its confirm request returned (a slow request keeps its mark
        // until it does), and a waiting or failed one is settled sooner when
        // it differs from what it was at tap time (another phase, or a newer
        // waitingSince), so a busy mark can never stick (a card left proposed
        // after a refused redirect included).
        let live = Set(proposals.filter { card in
            guard card.isOpen() else { return false }
            guard card.kind == .connectApp || card.kind == .connectServer else { return true }
            guard let tap = proposalTapState[card.id] else { return false }
            return card.busyMarkHolds(tapPhase: tap.phase, tapWaitingSince: tap.waitingSince, requestFinishedAt: tap.requestFinishedAt)
        }.map(\.id))
        let next = busyProposals.intersection(live)
        if next != busyProposals { busyProposals = next }
        proposalTapState = proposalTapState.filter { next.contains($0.key) }
    }

    // MARK: - Engine status

    /// Every chat that is working, waiting on the owner, reply-ready or whose
    /// newest turn failed. Polled with the approvals, 1.5 s.
    private func pollEngineStatus() async {
        guard let status = try? await client.engineStatus() else {
            // Two misses in a row: the engine is down, so its marks are stale.
            statusFailures += 1
            if statusFailures >= 2, !chatMarks.isEmpty {
                chatMarks = [:]
                updateDockBadge()
            }
            return
        }
        statusFailures = 0
        var marks: [String: ChatStatus] = [:]
        for chat in status.chats { marks[chat.chatId] = chat }
        // Opening a chat clears its reply-ready mark here before the engine
        // has heard of it.
        if let open = currentChatId, marks[open]?.replyReadySince != nil, stage == .chat {
            marks[open]?.replyReadySince = nil
        }
        if marks != chatMarks { chatMarks = marks }
        updateDockBadge()
        notifyFinishedTurns(status)
        // A chat the list has not heard of yet (a routine's first run, a
        // reply to a message sent from elsewhere) shows up on the next read.
        // Only once per unknown id: a failed chat older than the loaded pages
        // stays in the status for good and must not refetch the list every poll.
        let unknown = Set(status.chats.map(\.chatId)).subtracting(chats.map(\.chatId)).subtracting([currentChatId].compactMap { $0 })
        if !unknown.subtracting(refreshedForUnknown).isEmpty {
            refreshedForUnknown.formUnion(unknown)
            await refreshChats()
        }
    }

    /// Chats waiting on the owner (UI.md 3.5). The Dock badge shows the count.
    private func updateDockBadge() {
        let count = chatMarks.values.filter { $0.mark == .waiting }.count
        let label = count > 0 ? String(count) : ""
        if NSApp.dockTile.badgeLabel != label { NSApp.dockTile.badgeLabel = label }
    }

    /// A notification when a chat's newest turn changed since the last read
    /// (the first read only sets the baseline): see `TurnNotifyPolicy`.
    private func notifyFinishedTurns(_ status: EngineStatus) {
        let baseline = lastTurnIds == nil
        var seen = lastTurnIds ?? [:]
        for chat in status.chats {
            guard let turn = chat.lastTurn, seen[chat.chatId] != turn.turnId else { continue }
            seen[chat.chatId] = turn.turnId
            guard !baseline, let bot = selectedBot else { continue }
            let screen = TurnNotifier.shared.appIsOnScreen
            guard TurnNotifyPolicy.shouldNotify(
                notifyOn: bot.notify,
                isSelected: chat.chatId == currentChatId && stage == .chat,
                appActive: screen.active,
                windowVisible: screen.windowVisible,
                failed: turn.outcome != "completed",
                hasAssistantReply: turn.outcome == "completed"
            ) else { continue }
            let title = chats.first { $0.chatId == chat.chatId }?.title ?? bot.name
            TurnNotifier.shared.post(chatId: chat.chatId, title: title)
        }
        lastTurnIds = seen
    }

    func refreshComposer() async {
        let botId = selectedBotId
        let token = composerSelection.readToken
        guard let next = try? await client.composer(botId: botId) else { return }
        applyComposer(next, for: botId, readToken: token)
    }

    /// Keep a bot's chip state, and show it only while that bot is open.
    private func applyComposer(_ next: ComposerState, for botId: String?, readToken: Int? = nil) {
        if composerSelection.apply(next, for: botId, readToken: readToken) {
            composer = composerSelection.shown
        }
    }

    func saveComposer(modelId: String? = nil, effort: String? = nil, speed: String? = nil) async {
        let botId = selectedBotId
        composerSelection.beginSave()
        if let next = try? await client.updateComposer(botId: botId, modelId: modelId, effort: effort, speed: speed) {
            applyComposer(next, for: botId)
            if botId == selectedBotId { composerError = nil }
        } else {
            if botId == selectedBotId {
                await refreshComposer()
                composerError = "That setting did not save."
            }
        }
    }

    /// What the working row adds when the owner has picked another model since
    /// this bot's turn started: the model the running turn is on.
    func runningModelNote(for botId: String) -> String? {
        guard let running = runningModelLabels[botId], let current = composerSelection.modelLabel(for: botId),
              running != current else { return nil }
        return running
    }

    // MARK: - Send

    /// A message the owner's click wrote (Send again on an unsent message).
    /// It is an ordinary owner message, and leaves the composer's draft and
    /// files alone.
    func sendFromCard(_ text: String) {
        send(text, keepsComposer: true)
    }

    func send(_ text: String) {
        // The starter prompts are for before the first message.
        UserDefaults.standard.set(true, forKey: StarterPrompt.sentKey)
        send(text, keepsComposer: false)
    }

    /// Send the failed turn's message again, under the id it had: the engine
    /// continues the chat from there and the owner's bubble stays one bubble.
    /// With nothing to send again the chat is read afresh.
    func retryLastTurn() {
        guard !pending else { return }
        // The router stopped calling the provider for a few seconds. Sending
        // now is refused before it reaches a model, so the row counts the
        // pause down and holds its button until then.
        if let until = failureRetryUntil, until > Date() { return }
        guard let chatId = currentChatId, let target = projection.retryTarget else {
            Task { await reloadThread() }
            return
        }
        awaitingStart = true
        threadError = nil
        stickyThreadError = nil
        let client = client
        Task { @MainActor [weak self] in
            do {
                _ = try await client.sendTurn(chatId: chatId, clientId: target.clientId, text: target.text, retry: true)
            } catch {
                guard let self else { return }
                self.awaitingStart = false
                if case BackendError.chat(let code, let ms) = error, code == "retry_too_soon", let ms {
                    self.retryNotBefore = Date().addingTimeInterval(TimeInterval(ms) / 1000)
                } else {
                    self.showSendNote((error as? LocalizedError)?.errorDescription ?? "Couldn't retry that message.")
                }
                self.publishTranscript(force: true)
            }
        }
    }

    /// A note over the composer for a send that went wrong. It stays until the
    /// owner closes it or the next turn starts.
    private func showSendNote(_ message: String) {
        stickyThreadError = message
        threadError = message
    }

    // MARK: - Refused sends

    private func unsentList(for key: String) -> UnsentList {
        if let held = unsentLists[key] { return held }
        let loaded = UnsentList(unsentStore.load(chatId: key))
        unsentLists[key] = loaded
        return loaded
    }

    /// Writes the list to disk, then holds it in memory. A failed write keeps
    /// the previous list and says so in the composer note; `force` is for a
    /// removal the server already made true (a delivered Send again): it tries
    /// the write once more, logs a second failure and holds the new list
    /// anyway, so a delivered message never shows as unsent.
    @discardableResult
    private func setUnsent(_ list: UnsentList, key: String, force: Bool = false) -> Bool {
        var saved = true
        do {
            try unsentStore.save(list.items, chatId: key)
        } catch {
            NSLog("Useful Bot: could not save unsent messages: \(error.localizedDescription)")
            saved = false
            if force {
                do {
                    try unsentStore.save(list.items, chatId: key)
                    saved = true
                } catch {
                    NSLog("Useful Bot: could not save unsent messages on the second try: \(error.localizedDescription)")
                }
            }
        }
        if saved || force {
            unsentLists[key] = list
        } else if key == chatKey {
            showSendNote("Couldn't save the unsent message on this Mac.")
        }
        if key == chatKey { rebuildTranscript() }
        return saved || force
    }

    private func recordUnsent(_ message: UnsentMessage, key: String) -> Bool {
        var list = unsentList(for: key)
        list.add(message)
        guard setUnsent(list, key: key) else {
            // The composer takes an open chat's message back. Another chat's
            // stays on its bubble in memory until the app quits, and its text
            // also waits in `unsentDrafts`, so it is never silently lost.
            if key != chatKey { unsentLists[key] = list }
            return false
        }
        return true
    }

    /// A refused message resent from its bubble and refused again: the same
    /// entry comes back with the new reason, never a second one.
    /// Returns whether the new reason was saved.
    private func refuseAgain(_ id: String, reason: String, key: String) -> Bool {
        if retryingUnsent[key] == id { retryingUnsent[key] = nil }
        var list = unsentList(for: key)
        guard var item = list.item(id) else {
            if key == chatKey { rebuildTranscript() }
            return true
        }
        item.reason = reason
        list.replace(item)
        return setUnsent(list, key: key)
    }

    /// The engine took a resent message: it is no longer unsent.
    private func completeUnsentRetry(_ id: String, key: String) {
        if retryingUnsent[key] == id { retryingUnsent[key] = nil }
        var list = unsentList(for: key)
        list.remove(id)
        setUnsent(list, key: key, force: true)
    }

    /// A chat's refused messages go with it.
    private func clearUnsent(key: String) {
        retryingUnsent[key] = nil
        unsentLists[key] = UnsentList()
        unsentStore.clear(chatId: key)
    }

    /// The open chat's refused messages, for the transcript. One being
    /// resent is hidden: its resend is on screen as the pending row.
    private var openUnsent: [UnsentMessage] {
        let key = chatKey
        let hidden = retryingUnsent[key]
        return unsentList(for: key).items.filter { $0.id != hidden }
    }

    /// Whether Edit may take the message into the composer right now.
    var canEditUnsent: Bool {
        UnsentMessage.canEdit(draft: draft, attachmentCount: attachments.count)
    }

    /// The held files with their bytes. Images are read back from the sent
    /// image store; one that is gone stops the action with a note rather
    /// than going out without it.
    /// `skippingMissingFiles` is Edit: a file whose body was never saved is
    /// left out and named in a note, since the owner can attach it again.
    /// Send again cannot go without it, so it stops there.
    private func heldFiles(of message: UnsentMessage, skippingMissingFiles: Bool = false) -> [Attachment]? {
        let botId = selectedBotId ?? Threads.defaultBotId
        var out: [Attachment] = []
        var missing: [String] = []
        defer {
            if !missing.isEmpty {
                attachError = missing.count == 1
                    ? "\(missing[0]) has to be attached again."
                    : "\(missing.joined(separator: ", ")) have to be attached again."
            }
        }
        for file in message.files {
            switch UnsentMessage.heldState(of: file) {
            case .ready:
                out.append(file)
            case .restoreImage:
                guard let restored = SentImageStore.restored(file, botId: botId) else {
                    attachError = "A picture from this message is no longer on this Mac."
                    return nil
                }
                out.append(restored)
            case .attachAgain:
                missing.append(file.name)
                if !skippingMissingFiles { return nil }
            }
        }
        return out
    }

    /// The text of a message the engine handed back unsent (a queued one a
    /// Stop dropped), by its client id.
    private func engineUnsentText(_ id: String) -> String? {
        projection.rows.first { $0.kind == .unsent && $0.clientId == id }?.text
    }

    /// Send a message that came back unsent again. A refused one stays saved
    /// until the engine takes the turn; if that fails too, the same bubble
    /// comes back.
    func retryUnsent(_ id: String) {
        if let text = engineUnsentText(id) {
            hideEngineUnsent(id)
            send(text, keepsComposer: true, files: sentFilesByClient.removeValue(forKey: id) ?? [])
            return
        }
        let key = chatKey
        guard let item = unsentList(for: key).item(id), let files = heldFiles(of: item) else { return }
        send(item.message, keepsComposer: true, files: files, rawDraft: item.draft, retryingUnsentId: id)
    }

    /// Discard a message that came back unsent and is no longer wanted.
    func dismissUnsent(_ id: String) {
        if engineUnsentText(id) != nil {
            hideEngineUnsent(id)
            return
        }
        let key = chatKey
        guard retryingUnsent[key] != id else { return }
        var list = unsentList(for: key)
        guard list.item(id) != nil else { return }
        list.remove(id)
        setUnsent(list, key: key)
    }

    /// Take a message that came back unsent into the composer, which has to be empty.
    func editUnsent(_ id: String) {
        guard canEditUnsent else { return }
        if let text = engineUnsentText(id) {
            hideEngineUnsent(id)
            draft = text
            if let files = sentFilesByClient.removeValue(forKey: id), attachments.isEmpty { attachments = files }
            draftWriteToken &+= 1
            requestComposerFocus()
            return
        }
        let key = chatKey
        var list = unsentList(for: key)
        guard let item = list.item(id),
              let files = heldFiles(of: item, skippingMissingFiles: true),
              list.edit(id, draft: draft, attachmentCount: attachments.count) != nil,
              setUnsent(list, key: key) else { return }
        draft = item.draft
        draftWriteToken &+= 1
        attachments = files
        if let quote = item.quote, replyQuotes[quote.botId] == nil {
            replyQuotes[quote.botId] = ReplyQuote(botId: quote.botId, text: quote.text)
        }
    }

    /// Dismiss for an engine-held unsent message is local: the engine keeps
    /// the row, this app stops drawing it.
    private func hideEngineUnsent(_ id: String) {
        hiddenEngineUnsentOrder.removeAll { $0 == id }
        hiddenEngineUnsentOrder.append(id)
        hiddenEngineUnsentOrder = Array(hiddenEngineUnsentOrder.suffix(200))
        UserDefaults.standard.set(hiddenEngineUnsentOrder, forKey: Self.hiddenUnsentKey)
        rebuildTranscript()
    }

    private static let hiddenUnsentKey = "hiddenUnsentClientIds"

    /// `keepsComposer` resends a message the composer does not hold, so it
    /// must not consume the draft or the files waiting there.
    ///
    /// `files` and `rawDraft` are for a refused message sent again from its
    /// failed bubble: the composer holds neither, so they come with it.
    private func send(
        _ text: String,
        keepsComposer: Bool,
        files: [Attachment] = [],
        rawDraft: String? = nil,
        retryingUnsentId: String? = nil
    ) {
        // The draft is capped in the composer; never clip the message here.
        let message = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let leavesComposer = !keepsComposer
        let sentAttachments = leavesComposer ? attachments : files
        guard !message.isEmpty || !sentAttachments.isEmpty, let bot = selectedBot else { return }
        let key = chatKey
        // A model pick made after this applies to the next message: the turn
        // runs on the model the chip shows now.
        if let label = composerSelection.modelLabel(for: bot.id), !label.isEmpty { runningModelLabels[bot.id] = label }
        threadError = nil
        stickyThreadError = nil
        widgetSaveErrors[key] = nil
        if let retryingUnsentId { retryingUnsent[key] = retryingUnsentId }
        let draftSnapshot = leavesComposer ? draft : ""
        // Only this chat's reply rides with this send.
        let quoteSnapshot = leavesComposer ? replyQuotes[bot.id] : nil
        let sentAttachmentIds = Set(sentAttachments.map(\.id))
        let keptImages = SentImageStore.keep(sentAttachments.filter(\.isImage), botId: bot.id)
        let clientId = UUID().uuidString.lowercased()
        // The row a refused send's failed bubble would sit under: the newest
        // one before this send, not another failed bubble.
        let anchorId = transcript.last { !UnsentMessage.isUnsentRowId($0.id) }?.id
        // It shows at once, at the end of the chat. A message sent while a
        // turn runs waits behind it (the engine says so with `message.queued`).
        projection.addPending(ChatProjection.PendingSend(
            clientId: clientId,
            text: message,
            attachments: sentAttachments.map {
                RowAttachment(name: $0.name, mediaType: $0.mediaType ?? "text/plain", size: $0.bytes)
            }
        ))
        if !projection.pending { awaitingStart = true }
        rebuildTranscript()
        // The composer empties the moment the message is committed, not when
        // the server answers. Waiting for the round trip left the sent text
        // sitting in the field for as long as the network took, which reads as
        // a send that did not happen. `draftSnapshot` is what puts it back if
        // the send fails below.
        if leavesComposer {
            clearSentComposer(draft: draftSnapshot, attachmentIds: sentAttachmentIds)
            if let quoteSnapshot, replyQuotes[bot.id] == quoteSnapshot { replyQuotes[bot.id] = nil }
        }
        // An explicit send is an explicit request to watch the answer, so the
        // transcript follows it whatever the reader was doing before.
        sendTick &+= 1
        sendsInFlight += 1
        if !sentAttachments.isEmpty { sentFilesByClient[clientId] = sentAttachments }
        Task { @MainActor [weak self] in
            guard let self else { return }
            defer { self.sendsInFlight -= 1 }
            var recordKey = key
            do {
                let chatId = try await self.ensureChat(title: message)
                recordKey = chatId
                let ack = try await self.client.sendTurn(
                    chatId: chatId, clientId: clientId, text: message, attachments: sentAttachments
                )
                if ack.queued {
                    self.projection.markQueued(clientId: clientId)
                    self.awaitingStart = false
                } else {
                    // Only a queued message can come back unsent.
                    self.sentFilesByClient[clientId] = nil
                }
                if let retryId = retryingUnsentId { self.completeUnsentRetry(retryId, key: recordKey) }
                self.publishTranscript(force: true)
                await self.refreshChats()
            } catch {
                // The engine never took the message. The text does not go back
                // into the composer: it stays on a failed bubble in the chat,
                // with Send again and Edit, so a second message cannot stack
                // on it.
                self.projection.removePending(clientId: clientId)
                self.sentFilesByClient[clientId] = nil
                self.awaitingStart = false
                // The server says this bot's model is gone: re-read the chip
                // now so it shows as unavailable, rather than at the next poll.
                if case BackendError.modelSelectionUnavailable = error { Task { await self.refreshComposer() } }
                let reason = UnsentMessage.reason(for: error)
                var kept = true
                // The failed bubble reads its pictures back from disk, so
                // their copies have to have landed before it is saved.
                await keptImages?.value
                if let retryId = retryingUnsentId {
                    kept = self.refuseAgain(retryId, reason: reason, key: recordKey)
                } else {
                    let draftBack = rawDraft ?? (leavesComposer ? draftSnapshot : message)
                    kept = self.recordUnsent(
                        UnsentMessage(
                            id: UUID().uuidString,
                            message: message,
                            echo: message,
                            draft: draftBack,
                            files: sentAttachments,
                            reason: reason,
                            at: Date(),
                            anchorId: anchorId,
                            quote: quoteSnapshot.map { UnsentQuote(botId: $0.botId, text: $0.text) }
                        ),
                        key: recordKey
                    )
                    // A refusal that cannot be saved must not lose the text:
                    // it goes back in the composer, and the note from the
                    // failed save stays.
                    if !kept {
                        if self.chatKey == recordKey {
                            self.restoreUnsentDraft(draftBack, sentAttachments: sentAttachments)
                        } else {
                            self.unsentDrafts[recordKey] = (text: draftBack, attachments: sentAttachments)
                        }
                        if let quoteSnapshot, self.replyQuotes[bot.id] == nil { self.replyQuotes[bot.id] = quoteSnapshot }
                    }
                }
                if kept, self.chatKey == recordKey { self.showSendNote(UnsentMessage.note(reason: reason)) }
                self.publishTranscript(force: true)
            }
        }
    }

    /// The chat a message goes to. The empty chat a New chat opens makes its
    /// chat with the first message; the list shows it at once, titled by that
    /// message the way the engine will title it.
    private func ensureChat(title: String) async throws -> String {
        if let id = currentChatId { return id }
        if let creation = chatCreation { return try await creation.value }
        let creation = Task { @MainActor [self] in try await createFirstChat(title: title) }
        chatCreation = creation
        defer { chatCreation = nil }
        return try await creation.value
    }

    private func createFirstChat(title: String) async throws -> String {
        guard let botId = selectedBotId else { throw BackendError.shell("shell_bot_forbidden") }
        let id = try await client.createChat(botId: botId)
        if currentChatId == nil {
            currentChatId = id
            let first = String(title.trimmingCharacters(in: .whitespacesAndNewlines).prefix(60))
            chats.insert(ChatListItem(chatId: id, title: first.isEmpty ? ChatEntry.newChatTitle : first, updatedAt: Date()), at: 0)
            // The empty chat's refused messages move with it.
            let held = unsentList(for: Self.draftChatKey)
            if !held.items.isEmpty { setUnsent(held, key: id) }
            clearUnsent(key: Self.draftChatKey)
            startFollow(chatId: id)
        }
        return id
    }

    /// Stop (⌘.): the turn ends when the engine says so, on the stream.
    func cancel() {
        guard pending, let chatId = currentChatId else { return }
        // The engine expires this chat's cards before it aborts (SPEC 5.5.7),
        // so they go now rather than on the next 1.5 s approvals poll.
        approvals.removeAll { $0.chatId == chatId }
        let client = client
        Task { @MainActor [weak self] in
            do {
                try await client.cancelTurn(chatId: chatId)
            } catch {
                self?.showSendNote("Couldn't stop the turn. Try again.")
            }
        }
    }

    /// A starter prompt: the text goes into the composer, the caret after
    /// it, and nothing is sent.
    func fillDraft(_ text: String) {
        draft = text
        draftWriteToken &+= 1
        requestComposerFocus()
    }

    /// Reply to a bot message: the chip goes above the composer of this chat
    /// and the caret into the field.
    func reply(to text: String, botId: String) {
        // The chat on screen, including the fallback the composer shows
        // before a selection is stored.
        guard botId == selectedBot?.id else { return }
        replyQuotes[botId] = ReplyQuote(botId: botId, text: text)
        requestComposerFocus()
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

    /// Drawings whose save is settled: kept, refused for good, or given up on
    /// after its retries. Call ids are unique across chats, so this is never
    /// reset: a chat switch or a reload must not mark an unsaved drawing as
    /// saved, nor post a saved one again.
    private var persistedWidgets: Set<String> = []
    private var savingWidgets: Set<String> = []
    /// Drawings the server will not keep. They have no page to show, so they
    /// get no card either.
    private var refusedWidgets: Set<String> = []
    /// Per chat, until its next send: a save can give up while the chat is in
    /// the background, where a banner would land on the wrong chat.
    private var widgetSaveErrors: [String: String] = [:]

    private func persistNewWidgets() {
        guard let chatId = currentChatId, let botId = selectedBotId else { return }
        for widget in projection.widgets {
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
                    try await client.persistWidget(botId: botId, chatId: chatId, widget: widget)
                }
                guard let self else { return }
                self.savingWidgets.remove(id)
                // Settled either way, so no later publish starts it over.
                self.persistedWidgets.insert(id)
                if outcome == .saved { return }
                if outcome == .refused {
                    self.refusedWidgets.insert(id)
                    if self.currentChatId == chatId { self.rebuildTranscript() }
                }
                let message = "This drawing could not be saved to the chat."
                self.widgetSaveErrors[chatId] = message
                if self.currentChatId == chatId, self.threadError == nil {
                    self.threadError = message
                }
            }
        }
    }

    /// Answer a question by one of its options. It goes out as an ordinary
    /// owner message, so the answer reads in the chat like anything else the
    /// owner said; the engine settles the open question with the next turn.
    func answerQuestion(_ question: OwnerQuestion, option: OwnerQuestion.Option) {
        guard openQuestions.contains(where: { $0.id == question.id }) else { return }
        send(option.label)
    }

    /// The block to hold after an expansion, once. A later shrink of the
    /// hidden count (a cleared or replaced chat) must not chase it.
    func takeWindowExpandedFrom() -> String? {
        defer { windowExpandedFrom = nil }
        return windowExpandedFrom
    }

    private var windowExpandedFrom: String?

    private func republishWindow() {
        let window = TranscriptBlocks.window(
            transcriptBlocks,
            startId: windowStarts[chatKey],
            minimum: TranscriptBlocks.windowMinimum,
            historyBudget: TranscriptBlocks.historyCharacterBudget
        )
        if window != transcriptWindow { transcriptWindow = window }
    }

    /// Throttled transcript publish: at most one view rebuild per 100ms while
    /// events stream in, with a forced rebuild when the turn settles. A delta
    /// that arrives inside the window is coalesced onto one trailing rebuild
    /// rather than dropped.
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
        var rows = projection.transcript(localUnsent: openUnsent, hiddenUnsent: hiddenEngineUnsent)
        if !refusedWidgets.isEmpty {
            rows.removeAll { $0.id.hasPrefix("live-") && refusedWidgets.contains(String($0.id.dropFirst(5))) }
        }
        publishFailureRetry()
        // A reload that confirmed the rows already on screen publishes
        // nothing: each of these two writes invalidates the whole window and
        // lays the transcript out again. The blocks are compared too, not only
        // the rows, because a day label moves at midnight with no row changing.
        let blocks = TranscriptBlocks.build(rows: rows)
        if rows != transcript || blocks != transcriptBlocks {
            transcript = rows
            transcriptBlocks = blocks
        }
        let questions = projection.openQuestion.map { [$0] } ?? []
        if openQuestions != questions { openQuestions = questions }
        publishActivity()
    }

    private func publishFailureRetry() {
        let rowId = projection.retryableFailureRowId
        if retryableFailureRowId != rowId { retryableFailureRowId = rowId }
        // The router said how long its cool-down lasts. A retry that hit it
        // armed the deadline here; a reload reads it off the failure's time.
        var until: Date?
        if let rowId, let row = projection.rows.last(where: { $0.rowId == rowId }),
           let seconds = row.failure.coolDownSeconds {
            let fromRow = ChatClock.date(from: row.at).map { $0.addingTimeInterval(TimeInterval(seconds)) }
            until = [retryNotBefore, fromRow].compactMap { $0 }.max()
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

    /// The note's Reload: read the chat again.
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
        widgetSaveErrors[chatKey] = nil
    }

    /// Only on a real change: the label is read off every streamed event, and
    /// republishing the same one would redraw the transcript on each delta.
    private func publishActivity() {
        let running = projection.pending
        if running { awaitingStart = false }
        let now = running || awaitingStart
        if pending != now { pending = now }
        if !now, let botId = selectedBotId, runningModelLabels[botId] != nil { runningModelLabels[botId] = nil }
        // The turn's own start, so the timer survives leaving the chat.
        if running, let started = projection.turnStartedAt, activitySince != started { activitySince = started }
        if running {
            if projection.activityCall != activityCall { activityCall = projection.activityCall }
            if projection.activity != activity { activity = projection.activity }
        } else if activity != .thinking || activityCall != nil {
            activity = .thinking
            activityCall = nil
        }
    }

    // MARK: - Proposals of the bot

    /// The open connect cards, read when a chat opens, when a card row lands,
    /// and every poll while one is waiting on its sign-in.
    func loadProposals() async {
        guard let botId = selectedBotId, let list = try? await client.proposals(botId: botId) else { return }
        let open = Set(list.filter { $0.isOpen() }.map(\.id))
        // A card also closes by the clock (its TTL), with no change on the wire.
        if proposals != list || open != polledOpenProposalIds { proposals = list }
        polledOpenProposalIds = open
        pruneBusyProposals()
    }

    private var polledOpenProposalIds: Set<String> = []

    private func loadProposalsSoon() {
        Task { @MainActor [weak self] in await self?.loadProposals() }
    }

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
        providerRetired = payload.retired
        providersLoaded = true
        defaultRole = payload.defaultRole
        imageRole = payload.imageRole
        providers = payload.legacyProviders
        // The payload's composer is the last pick, not this bot's. The chip
        // reads its own bot's state; a connection change can alter whether
        // that model is available, so read it again.
        Task { @MainActor [weak self] in await self?.refreshComposer() }
    }

    /// The server error code in plain words for the connect sheet.
    static func connectCopy(_ code: String?, name: String? = nil) -> String {
        switch code {
        case "chatgpt_state_unreadable":
            return "Useful Bot couldn't read its saved ChatGPT sign-in details. Try again, or restart Useful Bot."
        case "chatgpt_account_unknown":
            return "That saved ChatGPT account isn't available anymore. Pick another account."
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
        } catch BackendError.providerNotice(_, let message) {
            providersError = message
        } catch {
            providersError = "Could not switch provider."
        }
        providerBusy = nil
    }

    func disconnectConnection(_ connectionId: String) async {
        providerBusy = connectionId
        providersError = nil
        do {
            let payload = try await client.disconnectConnection(connectionId)
            applyProviders(payload)
            if payload.notice == "chatgpt_revoke_unconfirmed" {
                providersError = "Signed out here. ChatGPT didn't confirm it, so you can also remove Useful Bot in ChatGPT settings."
            }
        } catch BackendError.providerNotice(_, let message) {
            // The bots that name this connection could not all be reset, so it
            // was not removed: re-read first (a read clears providersError),
            // then say so.
            await loadProviders()
            providersError = message
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
        } catch BackendError.providerNotice(_, let message) {
            providersError = message
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
        } catch BackendError.providerNotice(_, let message) {
            providersError = message
        } catch {
            providersError = "That model did not save."
        }
        providerBusy = nil
    }

    /// Bumped by every start and cancel. A code that arrives after the flow
    /// it was asked for was cancelled (Back while the code loads) is thrown
    /// away and cancelled on the server, so nothing polls in the background.
    private var oauthGeneration = 0

    func startOAuth(providerId: String, label: String, newAccount: Bool = false, clientId: String? = nil, retryClientId: String? = nil) async {
        oauthLastAttempt = (newAccount, clientId)
        // A retry that itself expires keeps the client it was retrying.
        oauthRetryClientId = retryClientId
        oauthPoll?.cancel()
        oauthGeneration &+= 1
        let generation = oauthGeneration
        providerBusy = "\(providerId):oauth"
        oauthError = nil
        oauthErrorCode = nil
        oauthDone = false
        oauthErrorStreak = 0
        providersError = nil
        do {
            let flow = try await client.startOAuth(providerId: providerId, newAccount: newAccount, clientId: clientId, retryClientId: retryClientId)
            guard generation == oauthGeneration else {
                try? await client.cancelOAuth(pollId: flow.pollId)
                if providerBusy == "\(providerId):oauth" { providerBusy = nil }
                return
            }
            oauth = OAuthPending(
                pollId: flow.pollId,
                providerId: providerId,
                label: label,
                flow: flow.flow,
                account: flow.account,
                accounts: flow.accounts,
                reusesSaved: flow.reusesSaved,
                clientId: flow.clientId,
                userCode: flow.userCode,
                verificationUrl: flow.verificationUrl,
                verificationUrlComplete: flow.verificationUrlComplete,
                expiresAt: flow.expiresAt,
                intervalMs: flow.intervalMs
            )
            startOAuthPoll()
        } catch {
            if generation == oauthGeneration {
                // A saved account that's gone must not be retried: Try again starts plain.
                if (error as? BackendError)?.providerCode == "chatgpt_account_unknown" {
                    oauthLastAttempt = (false, nil)
                }
                if case BackendError.providerNotice(_, let message) = error {
                    // A turned-off route comes with its own sentence.
                    providersError = message
                } else {
                    providersError = Self.connectCopy((error as? BackendError)?.providerCode)
                }
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
            let (status, intervalMs, errorCode, retryClientId, payload) = try await client.pollOAuth(pollId: pending.pollId)
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
                oauthErrorCode = nil
                oauthCompletions &+= 1
                if pending.providerId == "openai",
                   !UserDefaults.standard.bool(forKey: Self.chatgptPlanWelcomeKey) {
                    UserDefaults.standard.set(true, forKey: Self.chatgptPlanWelcomeKey)
                    showChatGptPlanWelcome = true
                }
            case "pending", "slow_down":
                oauthErrorStreak = 0
                oauthError = nil
                oauthErrorCode = nil
                if oauthExpired {
                    oauthPoll?.cancel()
                    oauthDone = true
                    oauthError = "That sign-in expired. Try again."
                }
            case "error" where pending.flow == "browser":
                // The browser flow reports a final code, so there is nothing to wait out.
                oauthPoll?.cancel()
                oauthDone = true
                oauthError = Self.chatgptSignInCopy(errorCode)
                oauthErrorCode = errorCode
                oauthRetryClientId = retryClientId
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
                oauthError = pending.flow == "browser"
                    ? Self.chatgptSignInCopy(errorCode ?? "denied")
                    : "That sign-in was denied."
                oauthErrorCode = errorCode
                oauthRetryClientId = retryClientId
            default:
                oauthPoll?.cancel()
                oauthDone = true
                oauthError = pending.flow == "browser"
                    ? Self.chatgptSignInCopy(errorCode)
                    : "Could not finish sign-in."
                oauthErrorCode = errorCode
                oauthRetryClientId = retryClientId
            }
        } catch {
            // A failed poll never kills the flow. The next tick retries.
        }
    }

    /// The ChatGPT sign-in poll error codes in plain words. The copy is the app's.
    static let chatgptMismatchCopy = "That's a different ChatGPT account. Use a different account to connect it."

    /// The sign-in ended on an account problem, so picking another account is the way forward.
    var oauthOffersNewAccount: Bool {
        oauthDone && (oauthErrorCode == "chatgpt_account_mismatch" || oauthErrorCode == "chatgpt_account_unknown")
    }

    /// Try again: starts the same way the failed attempt did.
    func retryOAuth(providerId: String, label: String) async {
        if let retry = oauthRetryClientId {
            await startOAuth(providerId: providerId, label: label, retryClientId: retry)
        } else {
            await startOAuth(providerId: providerId, label: label, newAccount: oauthLastAttempt.newAccount, clientId: oauthLastAttempt.clientId)
        }
    }

    static func chatgptSignInCopy(_ code: String?) -> String {
        switch code {
        case "chatgpt_plan_not_enabled":
            return "ChatGPT plan use wasn't allowed. Try again and allow it, or connect another provider."
        case "chatgpt_account_mismatch":
            return chatgptMismatchCopy
        case "chatgpt_account_unknown":
            return "That saved ChatGPT account isn't available anymore. Pick another account."
        case "denied":
            return "Sign-in was cancelled in the browser."
        default:
            return "Couldn't finish signing in to ChatGPT. Try again."
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
        oauthErrorCode = nil
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
        } catch BackendError.providerNotice(_, let message) {
            // Re-read first: a read clears providersError.
            await loadProviders()
            providersError = message
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
            connectorsError = "Composio sent a sign-in link this app won't open."
            return false
        }
        guard NSWorkspace.shared.open(url) else {
            connectorsError = "The sign-in page couldn't be opened in the browser."
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

    /// True when the disconnect call itself went through, whatever the reload after it did.
    @discardableResult
    func disconnectConnector(_ row: ConnectorToolkit, search: String) async -> Bool {
        let accountIds = row.accountIds.isEmpty ? (row.accountId.map { [$0] } ?? []) : row.accountIds
        guard !accountIds.isEmpty else { return false }
        connectorBusy = row.slug
        connectorsError = nil
        do {
            for accountId in accountIds { try await client.disconnectConnector(accountId: accountId) }
        } catch {
            connectorsError = "Could not disconnect \(row.name)."
            connectorBusy = nil
            return false
        }
        // The disconnect went through; loadConnectors reports its own load failure.
        await loadConnectors(search: search, quiet: true)
        connectorBusy = nil
        return true
    }

    /// The tools of one connected app, or nil when they couldn't be loaded.
    func connectorTools(_ row: ConnectorToolkit) async -> [DirectConnectionTool]? {
        try? await client.connectorTools(toolkit: row.slug)
    }

    func loadDirectConnections(quiet: Bool = false, countsTowardCheckingFailure: Bool = false) async {
        if !quiet { directConnectionsOpen = true }
        directLoadSeq += 1
        let seq = directLoadSeq
        do {
            let rows = try await client.directConnections()
            // A newer load already landed: this answer is older, drop it.
            guard seq > directLoadApplied else { return }
            directLoadApplied = seq
            directConnections = rows
            quietLoadFailures = 0
            if !quiet || directConnectionsError == Self.directLoadFailedCopy { directConnectionsError = nil }
            if rows.contains(where: { $0.state.isChecking }) { startCheckingPoll() }
        } catch is CancellationError {
            return
        } catch let error as URLError where error.code == .cancelled {
            return
        } catch {
            if !quiet {
                directConnectionsError = Self.directLoadFailedCopy
            } else {
                if countsTowardCheckingFailure {
                    quietLoadFailures += 1
                    if quietLoadFailures >= 3 { failCheckingPoll() }
                }
            }
        }
    }

    /// Gives up on a poll that can't get an answer: the error and its Retry
    /// replace an endless Checking.
    private func failCheckingPoll() {
        directConnectionsError = Self.directLoadFailedCopy
        quietLoadFailures = 0
        guard !directConnectionPollIsSignIn else { return }
        directConnectionPollId += 1
        directConnectionPoll?.cancel()
        directConnectionPoll = nil
    }

    func refreshDirectConnection(_ row: DirectConnection) async {
        guard !directConnectionBusy.contains(row.id) else { return }
        directConnectionBusy.insert(row.id)
        directConnectionsError = nil
        do {
            let updated = try await client.refreshDirectConnection(id: row.id)
            if let index = directConnections.firstIndex(where: { $0.id == updated.id }) {
                directConnections[index] = updated
            }
        } catch is CancellationError {
        } catch {
            directConnectionsError = "Couldn't refresh \(row.name)."
        }
        await loadDirectConnections(quiet: true)
        directConnectionBusy.remove(row.id)
    }

    /// Opens the server's sign-in in the default browser, then polls the list
    /// every 2 s for up to 2 minutes so the row updates when it finishes.
    func reconnectDirectConnection(_ row: DirectConnection) async {
        guard !directConnectionBusy.contains(row.id) else { return }
        directConnectionBusy.insert(row.id)
        directConnectionsError = nil
        do {
            let answer = try await client.reauthorizeDirectConnection(id: row.id)
            // Only a sanity check on what the server sent (https, a public
            // host, the host it named). The real gate is server-side: the
            // server pins the sign-in server and refuses a changed one.
            if Proposal.connectRedirectAllowed(answer.authorizeUrl, kind: .connectServer, expectedHost: answer.redirectHost),
               let url = URL(string: answer.authorizeUrl) {
                if NSWorkspace.shared.open(url) {
                    // Closed while awaiting the server: the browser still
                    // opened, but don't reopen the dialog or poll for it.
                    if directConnectionsOpen { startDirectConnectionPoll() }
                } else {
                    directConnectionsError = "The sign-in page couldn't be opened in the browser."
                }
            } else {
                directConnectionsError = "The server sent a sign-in link this app won't open."
            }
        } catch is CancellationError {
        } catch {
            var code: String?
            if case BackendError.provider(let value) = error { code = value }
            directConnectionsError = DirectConnection.reconnectFailureCopy(code: code, name: row.name)
        }
        await loadDirectConnections(quiet: true)
        directConnectionBusy.remove(row.id)
    }

    func removeDirectConnection(_ row: DirectConnection) async {
        guard row.canRemove, !directConnectionBusy.contains(row.id) else { return }
        directConnectionBusy.insert(row.id)
        directConnectionsError = nil
        do {
            try await client.removeDirectConnection(id: row.id)
        } catch is CancellationError {
        } catch {
            directConnectionsError = "Couldn't disconnect \(row.name)."
        }
        await loadDirectConnections(quiet: true)
        directConnectionBusy.remove(row.id)
    }

    private func startDirectConnectionPoll() {
        stopDirectConnectionPoll()
        directConnectionsOpen = true
        directConnectionPollIsSignIn = true
        let started = Date()
        directConnectionPollId += 1
        let id = directConnectionPollId
        directConnectionPoll = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(2))
                guard let self, !Task.isCancelled else { return }
                await self.loadDirectConnections(quiet: true, countsTowardCheckingFailure: true)
                guard !Task.isCancelled else { return }
                if Date().timeIntervalSince(started) > 120 {
                    if self.directConnectionPollId == id { self.directConnectionPoll = nil }
                    return
                }
            }
        }
    }

    /// A row still being checked: list again every 2 s, up to 60 s, until none
    /// is. A sign-in poll already running is left alone. If the cap passes
    /// with a row still checking, the load error and Retry replace the
    /// endless Checking.
    private func startCheckingPoll() {
        guard directConnectionsOpen, directConnectionPoll == nil else { return }
        directConnectionPollIsSignIn = false
        let started = Date()
        directConnectionPollId += 1
        let id = directConnectionPollId
        directConnectionPoll = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(2))
                guard let self, !Task.isCancelled else { return }
                await self.loadDirectConnections(quiet: true, countsTowardCheckingFailure: true)
                guard !Task.isCancelled, self.directConnectionPollId == id else { return }
                let checking = self.directConnections.contains(where: { $0.state.isChecking })
                if !checking {
                    self.directConnectionPoll = nil
                    return
                }
                if Date().timeIntervalSince(started) > 60 {
                    self.failCheckingPoll()
                    return
                }
            }
        }
    }

    func stopDirectConnectionPoll() {
        directConnectionsOpen = false
        directConnectionPollId += 1
        directConnectionPoll?.cancel()
        directConnectionPoll = nil
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
    func reportBudgetError(_ field: BudgetMessages.Field, _ message: String) {
        budgetMessages.set(field, message)
    }

    func clearBudgetError(_ field: BudgetMessages.Field) {
        budgetMessages.clear(field)
    }

    /// Move the router's daily token budget. The answer carries the budget the
    /// server stored, so a refused number never sticks on screen.
    func setDailyTokenBudget(_ tokens: Int?) {
        writeBudget(.tokens) { try await $0.setDailyTokenBudget(tokens) }
    }

    /// Move the daily request budget, independently of the token one.
    func setDailyRequestBudget(_ requests: Int?) {
        writeBudget(.requests) { try await $0.setDailyRequestBudget(requests) }
    }

    private func writeBudget(_ field: BudgetMessages.Field, _ send: @escaping (BackendClient) async throws -> UsagePayload) {
        // One write at a time, but a second one is held rather than dropped: the
        // newest per field goes out when the one in flight finishes.
        guard !usageBusy else {
            pendingBudgetWrites.hold(send, for: field)
            return
        }
        usageBusy = true
        usageError = nil
        // Any poll already in flight belongs to the budget before this write.
        usageGeneration &+= 1
        Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                let confirmed = try await send(self.client)
                // And any poll started while the write was in flight.
                self.usageGeneration &+= 1
                self.usage = confirmed
                self.budgetMessages.clear(field)
            } catch BackendError.provider(let code) {
                self.budgetMessages.set(field, BudgetInput.serverMessage(for: code) ?? "Could not change the limit.")
            } catch {
                self.budgetMessages.set(field, "Could not change the limit.")
            }
            self.usageBusy = false
            if let held = self.pendingBudgetWrites.next() {
                self.writeBudget(held.field, held.write)
            }
        }
    }

    // MARK: - Profile and shell actions

    /// Serialise every shell mutation on one chain so rapid actions cannot
    /// land out of order and a stale echo cannot overwrite newer state.
    private func enqueue(onSkip: (@MainActor () -> Void)? = nil, _ work: @escaping @MainActor () async -> Void) {
        let previous = saveChain
        saveChain = Task { @MainActor in
            _ = await previous?.value
            guard !Task.isCancelled else { onSkip?(); return }
            await work()
        }
    }

    /// `onResult` reports whether the server took the write, for a caller that
    /// keeps a draft until it did (the instructions editor).
    func patchBot(botId: String, _ patch: [String: Any?], onResult: (@MainActor (Bool) -> Void)? = nil) {
        enqueue { [weak self] in
            guard let self else { return }
            let epoch = self.storeEpoch
            do {
                let next = try await self.client.shellAction(ShellActions.updateBot(botId: botId, patch: patch))
                onResult?(true)
                guard !Task.isCancelled, epoch == self.storeEpoch else { return }
                self.applyStore(next)
                self.saveError = nil
            } catch {
                onResult?(false)
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
                // Scoped like the failure below: a late outcome must not
                // clear the banner of a bot it did not run for.
                guard botId == self.selectedBotId else { return }
                self.saveError = nil
            } catch {
                // The banner now shows in the chat column too, so a save
                // that fails after a switch must not land on the new bot,
                // the way patchBot guards the same thing above.
                guard epoch == self.storeEpoch, botId == self.selectedBotId else { return }
                self.saveError = (error as? LocalizedError)?.errorDescription ?? "Save failed."
            }
        }
    }

    /// Apply a store the server echoed.
    private func applyStore(_ next: ShellStore) {
        store = next
        reconcileSelection(next)
        rebuildTranscript()
    }

    /// There is one bot; its id follows the store.
    private func reconcileSelection(_ next: ShellStore) {
        let id = next.bot?.id
        if id != selectedBotId { selectedBotId = id }
    }

    func rename(botId: String, name: String) {
        perform(ShellActions.rename(botId: botId, name: name))
    }

    // MARK: - Proposals

    func decideProposal(_ proposal: Proposal, confirmed: Bool, secret: String? = nil) {
        guard !busyProposals.contains(proposal.id) else { return }
        busyProposals.insert(proposal.id)
        proposalTapState[proposal.id] = (proposal.phase, proposal.waitingSince, nil)
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
                    // The busy mark's 10 s cap runs from here, not from the tap.
                    self.proposalTapState[proposal.id]?.requestFinishedAt = Date()
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
                                    self.stickyThreadError = "The sign-in page couldn't be opened in the browser. Use Reopen."
                                    self.threadError = self.stickyThreadError
                                }
                            } else if result.redirectUrl != nil && !(raw.isEmpty) {
                                self.stickyThreadError = proposal.kind == .connectApp
                                    ? "Composio sent a sign-in link this app won't open."
                                    : "The server sent a sign-in link this app won't open."
                                self.threadError = self.stickyThreadError
                            }
                        }
                        // Busy stays until the card moves on from the phase it
                        // had at tap time; pruneBusyProposals clears it.
                        self.loadProposalsSoon()
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
                self.loadProposalsSoon()
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

    var openProposals: [Proposal] {
        proposals.filter { $0.isOpen() }
    }

    var hasThreadContent: Bool {
        !transcript.isEmpty || !openProposals.isEmpty
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
            guard case .message(let row) = block else { continue }
            switch row.kind {
            case .user:
                awaitingReply = true
                anchor = nil
            case .assistant:
                if awaitingReply {
                    anchor = row.id
                    awaitingReply = false
                }
            case .note, .widget, .image, .page, .failure, .unsent, .card:
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
            // The pane polls: an unchanged list must not redraw it.
            if memoryNotes != notes { memoryNotes = notes }
            if memoryError != nil { memoryError = nil }
        } catch is CancellationError {
            return
        } catch {
            // Keep the last notes and show the failure instead of pretending
            // this bot remembers nothing.
            guard botId == selectedBotId else { return }
            memoryError = "Could not load memory."
        }
    }

    /// The full text of a note the list shows cut short.
    func fullMemoryNote(botId: String, id: String) async -> MemoryNote? {
        try? await client.memoryNote(botId: botId, id: id)
    }

    /// Deletes one note, then re-reads the list. False when the server refused.
    func deleteMemoryNote(botId: String, note: MemoryNote) async -> Bool {
        do {
            try await client.deleteMemoryNote(botId: botId, id: note.id, revision: note.revision)
            await loadMemory(botId: botId)
            return true
        } catch {
            // The list may be why it failed (changed or gone): re-read it.
            await loadMemory(botId: botId)
            guard botId == selectedBotId else { return false }
            if case BackendError.http(409) = error {
                memoryError = "That note changed. Try again."
            } else if case BackendError.http(404) = error {
                memoryError = "That note is already gone."
            } else {
                memoryError = "Could not delete that note."
            }
            return false
        }
    }

    /// The instructions' cost and the shipped default, for the editor's Restore.
    func botContext(botId: String) async -> BotContextInfo? {
        try? await client.botContext(botId: botId)
    }

    // MARK: - Routines

    /// The routine the pane has drilled into, resolved against the live list so
    /// a poll that renamed it does not strand the detail view on a stale copy.
    var openRoutine: Routine? {
        guard let openRoutineId else { return nil }
        return routines.first { $0.id == openRoutineId }
    }

    /// What the owner has typed into the New routine form. It is kept while
    /// they look at another routine or page, and cleared by Create, Cancel or
    /// a bot switch. Not published: the form owns what it shows.
    struct RoutineDraft: Equatable {
        var name: String
        var instruction: String
        var schedules: [RoutineSchedule]
    }
    var routineDraft: RoutineDraft?

    func closeRoutineDetail() {
        openRoutineId = nil
        routineCreating = false
    }

    private func clearRoutineState() {
        routineDraft = nil
        closeRoutineDetail()
        routines = []
        routinesError = nil
        routineBusy = []
        queuedRoutineEdits = [:]
        // The Routines page and the sidebar badge would sit empty until the next poll.
        if let botId = selectedBotId {
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
        onResult: ((String?) -> Void)? = nil,
        _ work: @escaping @MainActor (BackendClient) async throws -> Void
    ) {
        if let id {
            guard !routineBusy.contains(id) else { return }
            routineBusy.insert(id)
        }
        let botId = selectedBotId
        enqueue { [weak self] in
            guard let self else { return }
            var failure: String?
            do {
                try await work(self.client)
                self.routinesError = nil
            } catch {
                failure = (error as? LocalizedError)?.errorDescription ?? "That routine change failed."
                self.routinesError = failure
            }
            if let id { self.routineBusy.remove(id) }
            // Re-read rather than trusting the local copy: a scheduled run may
            // have appended history while this write was in flight.
            if let botId, botId == self.selectedBotId { await self.loadRoutines(botId: botId) }
            // A good re-read clears the error; the failed write still says so.
            if let failure { self.routinesError = failure }
            // The caller hears its own write's outcome: a shared error string
            // can't tell a second identical refusal from the first.
            onResult?(failure)
            // An edit made while this write ran goes out now, unless the routine
            // is gone (this write deleted it, or it was deleted elsewhere).
            if let id, let queued = self.queuedRoutineEdits.removeValue(forKey: id) {
                if self.routines.contains(where: { $0.id == id }) {
                    self.updateRoutine(
                        id: id,
                        name: queued.name,
                        instruction: queued.instruction,
                        schedules: queued.schedules,
                        active: queued.active,
                        onResult: { result in queued.results.forEach { $0(result) } }
                    )
                } else {
                    queued.results.forEach { $0("That routine is gone.") }
                }
            }
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
            self.routineDraft = nil
            self.routineCreating = false
            self.openRoutineId = created.id
        }
    }

    /// Edits made while a write on the same routine was in flight, merged field
    /// by field (the newer value wins) and sent when that write lands.
    private struct QueuedRoutineEdit {
        var name: String?
        var instruction: String?
        var schedules: [RoutineSchedule]?
        var active: Bool?
        /// Whoever asked for these edits, told how the write went.
        var results: [(String?) -> Void] = []
    }
    private var queuedRoutineEdits: [String: QueuedRoutineEdit] = [:]

    func updateRoutine(
        id: String,
        name: String? = nil,
        instruction: String? = nil,
        schedules: [RoutineSchedule]? = nil,
        active: Bool? = nil,
        onResult: ((String?) -> Void)? = nil
    ) {
        if routineBusy.contains(id) {
            var queued = queuedRoutineEdits[id] ?? QueuedRoutineEdit()
            if let name { queued.name = name }
            if let instruction { queued.instruction = instruction }
            if let schedules { queued.schedules = schedules }
            if let active { queued.active = active }
            if let onResult { queued.results.append(onResult) }
            queuedRoutineEdits[id] = queued
            return
        }
        routineWrite(id: id, onResult: onResult) { client in
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

    /// Routines whose newest run failed, for the sidebar badge.
    var failedRoutineCount: Int {
        routines.filter { $0.runHistory.last.map { !$0.succeeded } ?? false }.count
    }

    /// Open the Routines page on one routine.
    func showRoutine(_ id: String) {
        stage = .routines
        routineCreating = false
        openRoutineId = id
    }

    // MARK: - Connector sign-in state

    /// True when any added app or server needs signing in again, for the
    /// sidebar's Connectors dot.
    var connectorsNeedSignIn: Bool {
        ConnectorTile.merge(apps: connectors?.toolkits ?? [], servers: directConnections).contains(where: \.needsSignIn)
    }

    private var connectorStateTick = 0

    /// The dot reads state the Connectors dialog normally loads, so it is read
    /// quietly here: on the first tick and then every two minutes.
    private func pollConnectorStates() {
        defer { connectorStateTick += 1 }
        guard connectorStateTick % 48 == 0 else { return }
        Task { @MainActor [weak self] in
            guard let self else { return }
            // The page's own query only while the page is open.
            await self.loadConnectors(search: self.stage == .connectors ? self.connectorSearch : "", quiet: true)
            await self.loadDirectConnections(quiet: true)
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

    /// How much of the message goes into the quote. A long reply is quoted
    /// by its opening; the whole of it is already in the conversation.
    static let maxQuoted = 600

    /// The quoted text, clipped, exactly as the bot wrote it.
    var quoted: String {
        let flat = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return flat.count > Self.maxQuoted ? String(flat.prefix(Self.maxQuoted)) + "…" : flat
    }

    /// The line that marks a message as a reply, so a message the owner
    /// simply starts with a blockquote is never taken for one.
    var marker: String { "Replying to your message:" }

    static func isMarker(_ line: String) -> Bool {
        line.hasPrefix("Replying to ") && line.hasSuffix("message:")
    }

    func wrap(_ message: String) -> String {
        let lines = quoted.split(separator: "\n", omittingEmptySubsequences: false).map { "> \($0)" }
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
