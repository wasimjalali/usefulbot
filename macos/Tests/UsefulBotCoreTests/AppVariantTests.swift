import Testing
import Foundation
@testable import UsefulBotCore

/// The "dev" build runs next to the daily app and must never share anything
/// with it. Every value that tells the two apart comes from one `AppVariant`,
/// so these tests pin both tables and every way the pairing can go wrong.
@Suite struct AppVariantTests {
    private let home = URL(fileURLWithPath: "/Users/test", isDirectory: true)

    // MARK: - Which variant a bundle is

    @Test func noVariantKeyIsTheDailyApp() throws {
        #expect(try AppVariant.resolve(infoDictionary: [:]) == .daily)
        #expect(try AppVariant.resolve(infoDictionary: nil) == .daily)
        #expect(try AppVariant.resolve(infoDictionary: ["CFBundleIdentifier": "ai.useful.bot"]) == .daily)
    }

    @Test func devIsSelectedOnlyByTheExactValue() throws {
        #expect(try AppVariant.resolve(infoDictionary: ["UBVariant": "dev"]) == .dev)
    }

    @Test func anythingElseIsAnErrorNeverQuietlyDaily() {
        // A typo must not run the daily app's state under a dev build.
        for junk in ["", "Dev", "DEV", " dev", "dev ", "daily", "prod", "ai.useful.bot.dev"] {
            #expect(throws: AppVariant.ResolveError.unknownVariant(junk)) {
                try AppVariant.resolve(infoDictionary: ["UBVariant": junk])
            }
        }
        // Present but not a string.
        for value: Any in [true, 1, ["dev"], NSNull()] {
            #expect(throws: AppVariant.ResolveError.notAString) {
                try AppVariant.resolve(infoDictionary: ["UBVariant": value])
            }
        }
    }

    // MARK: - Bundle id and variant must agree

    @Test func matchingIdentityPasses() throws {
        try AppVariant.daily.validateIdentity(bundleIdentifier: "ai.useful.bot", executableName: "UsefulBotApp", isAppBundle: true)
        try AppVariant.dev.validateIdentity(bundleIdentifier: "ai.useful.bot.dev", executableName: "UsefulBotDevApp", isAppBundle: true)
    }

    @Test func aDevVariantUnderTheDailyIdIsRefused() {
        #expect(throws: AppVariant.IdentityError.bundleIdentifier(expected: "ai.useful.bot.dev", found: "ai.useful.bot")) {
            try AppVariant.dev.validateIdentity(bundleIdentifier: "ai.useful.bot", executableName: "UsefulBotDevApp", isAppBundle: true)
        }
    }

    @Test func aDailyVariantUnderTheDevIdIsRefused() {
        #expect(throws: AppVariant.IdentityError.bundleIdentifier(expected: "ai.useful.bot", found: "ai.useful.bot.dev")) {
            try AppVariant.daily.validateIdentity(bundleIdentifier: "ai.useful.bot.dev", executableName: "UsefulBotApp", isAppBundle: true)
        }
    }

    @Test func aMissingIdInsideAnAppBundleIsRefused() {
        #expect(throws: AppVariant.IdentityError.bundleIdentifier(expected: "ai.useful.bot", found: nil)) {
            try AppVariant.daily.validateIdentity(bundleIdentifier: nil, executableName: "UsefulBotApp", isAppBundle: true)
        }
        #expect(throws: AppVariant.IdentityError.bundleIdentifier(expected: "ai.useful.bot.dev", found: nil)) {
            try AppVariant.dev.validateIdentity(bundleIdentifier: nil, executableName: "UsefulBotDevApp", isAppBundle: true)
        }
    }

    @Test func aWrongExecutableIsRefused() {
        // The dev plist copied next to the daily binary (or the reverse).
        #expect(throws: AppVariant.IdentityError.executable(expected: "UsefulBotDevApp", found: "UsefulBotApp")) {
            try AppVariant.dev.validateIdentity(bundleIdentifier: "ai.useful.bot.dev", executableName: "UsefulBotApp", isAppBundle: true)
        }
        #expect(throws: AppVariant.IdentityError.executable(expected: "UsefulBotApp", found: "UsefulBotDevApp")) {
            try AppVariant.daily.validateIdentity(bundleIdentifier: "ai.useful.bot", executableName: "UsefulBotDevApp", isAppBundle: true)
        }
    }

    @Test func aBareBinaryIsOnlyEverTheDailyVariant() throws {
        // `swift run` has no bundle: no id and no plist, so no variant key.
        try AppVariant.daily.validateIdentity(bundleIdentifier: nil, executableName: "UsefulBotApp", isAppBundle: false)
        // A dev variant outside an app bundle cannot be told apart from a
        // misconfiguration, so it never runs.
        #expect(throws: AppVariant.IdentityError.notAnAppBundle) {
            try AppVariant.dev.validateIdentity(bundleIdentifier: nil, executableName: "UsefulBotApp", isAppBundle: false)
        }
    }

    // MARK: - Daily is exactly what it was

    @Test func dailyValuesAreTodaysLiterals() {
        let v = AppVariant.daily
        #expect(v.stackName == "daily")
        #expect(v.bundleIdentifier == "ai.useful.bot")
        #expect(v.displayName == "Useful Bot")
        #expect(v.executableName == "UsefulBotApp")
        #expect(v.appBundleName == "Useful Bot.app")
        #expect(v.routerPort == 4319)
        #expect(v.webPort == 4320)
        #expect(v.evePort == 4321)
        #expect(v.webBaseURL.absoluteString == "http://127.0.0.1:4320")
        #expect(v.routerHealthURL.absoluteString == "http://127.0.0.1:4319/health/live")
        #expect(v.eveHealthURL.absoluteString == "http://127.0.0.1:4321/eve/v1/health")
        #expect(v.keychainPrefix == "com.usefulbot")
        #expect(v.deviceTokenService == "com.usefulbot.device.desktop")
        #expect(v.stateRoot(home: home).path == "/Users/test/.useful-bot")
        #expect(v.mediaDirectory(home: home).path == "/Users/test/Documents/Useful Bot")
        #expect(v.logsDirectory(home: home).path == "/Users/test/Library/Logs/UsefulBot")
        let caches = home.appendingPathComponent("Library/Caches", isDirectory: true)
        #expect(v.snapshotsCacheDirectory(caches: caches).path == "/Users/test/Library/Caches/UsefulBot/chat-snapshots")
        #expect(v.pagesCacheDirectory(caches: caches).path == "/Users/test/Library/Caches/ai.useful.bot/pages")
        let support = home.appendingPathComponent("Library/Application Support", isDirectory: true)
        #expect(v.appSupportDirectory(support: support).path == "/Users/test/Library/Application Support/Useful Bot")
        #expect(v.logSubsystem == "com.usefulbot.app")
        #expect(v.usesRuntimePayload)
        #expect(v.allowsMoveToApplications)
        #expect(v.allowsUpdater)
        #expect(v.allowsFeedback)
    }

    @Test func dailyPassesNoStackEnvironmentToServices() {
        // Daily keeps today's environment: nothing is added.
        #expect(AppVariant.daily.serviceEnvironment(home: home).isEmpty)
    }

    // MARK: - Dev matches the contract table

    @Test func devValuesMatchTheContract() {
        let v = AppVariant.dev
        #expect(v.stackName == "dev")
        #expect(v.bundleIdentifier == "ai.useful.bot.dev")
        #expect(v.displayName == "Useful Bot Dev")
        #expect(v.executableName == "UsefulBotDevApp")
        #expect(v.appBundleName == "Useful Bot Dev.app")
        #expect(v.routerPort == 4419)
        #expect(v.webPort == 4420)
        #expect(v.evePort == 4421)
        #expect(v.webBaseURL.absoluteString == "http://127.0.0.1:4420")
        #expect(v.routerHealthURL.absoluteString == "http://127.0.0.1:4419/health/live")
        #expect(v.eveHealthURL.absoluteString == "http://127.0.0.1:4421/eve/v1/health")
        #expect(v.keychainPrefix == "com.usefulbot.dev")
        #expect(v.deviceTokenService == "com.usefulbot.dev.device.desktop")
        #expect(v.stateRoot(home: home).path == "/Users/test/.useful-bot-dev-app")
        #expect(v.mediaDirectory(home: home).path == "/Users/test/Documents/Useful Bot Dev")
        #expect(v.logsDirectory(home: home).path == "/Users/test/Library/Logs/UsefulBotDev")
        let caches = home.appendingPathComponent("Library/Caches", isDirectory: true)
        #expect(v.snapshotsCacheDirectory(caches: caches).path == "/Users/test/Library/Caches/ai.useful.bot.dev/chat-snapshots")
        #expect(v.pagesCacheDirectory(caches: caches).path == "/Users/test/Library/Caches/ai.useful.bot.dev/pages")
        let support = home.appendingPathComponent("Library/Application Support", isDirectory: true)
        #expect(v.appSupportDirectory(support: support).path == "/Users/test/Library/Application Support/Useful Bot Dev")
        #expect(v.logSubsystem == "com.usefulbot.app.dev")
        // Dev runs a runtime payload from its own Application Support folder,
        // like the release, but never offers to move itself or updates itself.
        #expect(v.usesRuntimePayload)
        #expect(!v.allowsMoveToApplications)
        #expect(!v.allowsUpdater)
        #expect(!v.allowsFeedback)
    }

    @Test func devServiceEnvironmentIsExactlyTheContractKeys() {
        let env = AppVariant.dev.serviceEnvironment(home: home)
        #expect(env == [
            "UB_STACK": "dev",
            "UB_STATE_ROOT": "/Users/test/.useful-bot-dev-app",
            "UB_ROUTER_PORT": "4419",
            "UB_WEB_PORT": "4420",
            "UB_EVE_PORT": "4421",
            "UB_KEYCHAIN_PREFIX": "com.usefulbot.dev",
            "UB_MEDIA_DIR": "/Users/test/Documents/Useful Bot Dev",
            "UB_WEB_BASE_URL": "http://127.0.0.1:4420",
        ])
    }

    // MARK: - Nothing is shared

    @Test func devNeverSharesAPathPortOrNameWithDaily() {
        let daily = AppVariant.daily
        let dev = AppVariant.dev
        let caches = home.appendingPathComponent("Library/Caches", isDirectory: true)
        let support = home.appendingPathComponent("Library/Application Support", isDirectory: true)
        let pairs: [(String, String)] = [
            (daily.stateRoot(home: home).path, dev.stateRoot(home: home).path),
            (daily.mediaDirectory(home: home).path, dev.mediaDirectory(home: home).path),
            (daily.logsDirectory(home: home).path, dev.logsDirectory(home: home).path),
            (daily.snapshotsCacheDirectory(caches: caches).path, dev.snapshotsCacheDirectory(caches: caches).path),
            (daily.pagesCacheDirectory(caches: caches).path, dev.pagesCacheDirectory(caches: caches).path),
            (daily.appSupportDirectory(support: support).path, dev.appSupportDirectory(support: support).path),
        ]
        for (a, b) in pairs {
            #expect(a != b)
            // Not nested either: a dev folder inside a daily one (or the
            // reverse) would be swept up by the other's cleanup.
            #expect(!(a + "/").hasPrefix(b + "/"))
            #expect(!(b + "/").hasPrefix(a + "/"))
        }
        #expect(Set([daily.routerPort, daily.webPort, daily.evePort]).isDisjoint(with: [dev.routerPort, dev.webPort, dev.evePort]))
        #expect(daily.deviceTokenService != dev.deviceTokenService)
        #expect(daily.bundleIdentifier != dev.bundleIdentifier)
        #expect(daily.logSubsystem != dev.logSubsystem)
        #expect(daily.executableName != dev.executableName)
    }

    @Test func devStateRootIsNotTheOldOwnerDataFolder() {
        // ~/.useful-bot-dev holds earlier owner data and is never touched.
        #expect(AppVariant.dev.stateRoot(home: home).path != "/Users/test/.useful-bot-dev")
    }

    @Test func installPathsAreBesideTheirOwnAppNames() {
        #expect(AppVariant.daily.installURL(home: home).path == "/Applications/Useful Bot.app")
        #expect(AppVariant.dev.installURL(home: home).path == "/Users/test/Applications/Useful Bot Dev.app")
    }

    // MARK: - Readiness: a healthy answer from another stack is never ours

    @Test func aDownServiceIsDown() {
        #expect(AppVariant.daily.readiness(of: nil) == .down)
        #expect(AppVariant.dev.readiness(of: nil) == .down)
    }

    @Test func dailyAcceptsItsOwnStackOrNoStackField() {
        #expect(AppVariant.daily.readiness(of: HealthReading(stack: "daily")) == .ready)
        // Today's services answer without a stack field.
        #expect(AppVariant.daily.readiness(of: HealthReading(stack: nil)) == .ready)
    }

    @Test func dailyRefusesADevStack() {
        #expect(AppVariant.daily.readiness(of: HealthReading(stack: "dev")) == .foreign(found: "dev"))
        #expect(AppVariant.daily.readiness(of: HealthReading(stack: "other")) == .foreign(found: "other"))
    }

    @Test func devAcceptsOnlyItsOwnStack() {
        #expect(AppVariant.dev.readiness(of: HealthReading(stack: "dev")) == .ready)
    }

    @Test func devRefusesADailyStackAndAMissingStackField() {
        #expect(AppVariant.dev.readiness(of: HealthReading(stack: "daily")) == .foreign(found: "daily"))
        // A service from before the stack field existed answers like this.
        #expect(AppVariant.dev.readiness(of: HealthReading(stack: nil)) == .foreign(found: nil))
        #expect(AppVariant.dev.readiness(of: HealthReading(stack: "")) == .foreign(found: ""))
    }

    @Test func theStackFieldIsReadFromTheHealthBody() {
        #expect(HealthReading(body: Data(#"{"ok":true,"stack":"dev"}"#.utf8)) == HealthReading(stack: "dev"))
        #expect(HealthReading(body: Data(#"{"ok":true}"#.utf8)) == HealthReading(stack: nil))
        #expect(HealthReading(body: Data("not json".utf8)) == HealthReading(stack: nil))
        #expect(HealthReading(body: Data(#"{"stack":7}"#.utf8)) == HealthReading(stack: nil))
        #expect(HealthReading(body: Data()) == HealthReading(stack: nil))
    }
}
