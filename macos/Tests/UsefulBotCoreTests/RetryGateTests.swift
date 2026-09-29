import Foundation
import Testing
@testable import UsefulBotCore

/// The failure banner's Retry sends the owner's last message again. A turn the
/// server already accepted must never take that path: the turn ran, and a
/// resend files a second copy of it.
@Suite struct RetryGateTests {
    @Test func aFailedTurnMayBeSentAgain() {
        #expect(SendFailure.mayResend(failure: nil, replayEndedFailed: true))
        #expect(SendFailure.mayResend(
            failure: SendFailure(message: "The turn failed.", resendable: true),
            replayEndedFailed: false
        ))
    }

    @Test func aTurnThatNeverEchoedIsReloadedNotResent() {
        // The POST was accepted, so the server may be running the turn; the
        // arming just never saw its echo. And a send that died before delivery
        // puts its own text back in the composer, so the newest row in the
        // transcript belongs to the turn before it. Resending from there
        // repeats a turn the server already answered.
        #expect(!SendFailure.mayResend(
            failure: SendFailure(message: "The turn did not start.", resendable: false),
            replayEndedFailed: false
        ))
        #expect(!SendFailure.mayResend(
            failure: SendFailure(message: "Send failed.", resendable: false),
            replayEndedFailed: false
        ))
    }

    @Test func aTurnTheServerTookIsReloadedNotResent() {
        // The server has the turn and is answering it; only this app lost the
        // stream. Sending it again would run it twice.
        #expect(!SendFailure.mayResend(
            failure: SendFailure(message: "The reply could not be read.", resendable: false),
            replayEndedFailed: false
        ))
        #expect(!SendFailure.mayResend(
            failure: SendFailure(message: "The session pointer could not be saved.", resendable: false),
            replayEndedFailed: false
        ))
    }

    @Test func aBannerWithNoSendBehindItReloads() {
        // A thread load error, a proposal error, a drawing that would not save:
        // none of them is a turn to send again.
        #expect(!SendFailure.mayResend(failure: nil, replayEndedFailed: false))
    }

    @Test func aReplayThatEndedFailedWinsOverAnAcceptedTurn() {
        // The replay is the newer evidence: it read the session to the end and
        // found the turn failed there, whatever this app recorded earlier.
        #expect(SendFailure.mayResend(
            failure: SendFailure(message: "The reply could not be read.", resendable: false),
            replayEndedFailed: true
        ))
    }
}
