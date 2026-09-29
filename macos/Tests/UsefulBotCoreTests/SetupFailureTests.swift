#if os(macOS)
import Foundation
import Testing
@testable import UsefulBotCore

/// How a first-run setup failure can reach the owner wrongly:
/// - raw JSON from setup-local lands in the startup error;
/// - a Node warning printed before the JSON hides the error code;
/// - a locked Keychain gets the generic sentence instead of the fix;
/// - a timeout or a non-JSON crash has no code and shows nothing useful;
/// - a message carries an em dash or the raw detail.
struct SetupFailureTests {
    @Test func readsTheErrorCodeAfterNodeWarnings() {
        let output = """
        (node:123) ExperimentalWarning: something
        {"error":"keychain_write_failed","item":"com.usefulbot.router.ops"}
        """
        #expect(RuntimeInstall.setupErrorCode(output) == "keychain_write_failed")
    }

    @Test func noCodeWithoutJSON() {
        #expect(RuntimeInstall.setupErrorCode("") == nil)
        #expect(RuntimeInstall.setupErrorCode("setup refuses Node 22.0.0, need >=24.11.1 <25") == nil)
        #expect(RuntimeInstall.setupErrorCode("{not json") == nil)
    }

    @Test func lockedKeychainGetsItsOwnSentence() {
        let failure = RuntimeInstall.Failure(
            description: "node exited 1: …",
            status: 1,
            output: #"{"error":"keychain_write_failed","item":"com.usefulbot.device.desktop"}"#
        )
        let setup = RuntimeInstall.SetupFailure(failure)
        #expect(setup.code == "keychain_write_failed")
        #expect(setup.message == "Useful Bot couldn't save its keys in your Keychain. Unlock the Keychain and try again.")
        #expect(setup.detail.contains("node exited 1"))
    }

    @Test func everythingElseIsGenericAndPointsAtConsole() {
        let cases: [Error] = [
            RuntimeInstall.Failure(description: "node exited 1: {...}", status: 1,
                                   output: #"{"error":"config_exists","config":"/Users/x/.useful-bot/config.json"}"#),
            RuntimeInstall.Failure(description: "node did not finish in 60 s"),
            RuntimeInstall.Failure(description: "node exited 2: setup refuses Node", status: 2, output: "setup refuses Node 22.0.0"),
        ]
        for error in cases {
            let message = RuntimeInstall.SetupFailure(error).message
            #expect(message == "Useful Bot couldn't set up its local services. Details are in Console.")
            #expect(!message.contains("—"))
            #expect(!message.contains("{"))
        }
    }
}
#endif
