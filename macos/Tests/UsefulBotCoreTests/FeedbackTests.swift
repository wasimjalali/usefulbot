import Foundation
import Testing
@testable import UsefulBotCore

/// How sending feedback can go wrong, written before the client:
/// - a message the Worker counts as over 4,000 code points passes the app's
///   check because `String.count` counts graphemes, not scalars;
/// - a message of only spaces is sent;
/// - an empty reply email goes out as "" instead of null and the Worker
///   refuses the whole send;
/// - an unchecked context box still sends the Mac's details;
/// - one odd context value (a chip name with a non-ASCII mark, an overlong
///   string) fails the send instead of dropping to null;
/// - a 429 reads as a generic failure, so the owner retries into the limit;
/// - a 5xx, a garbled body or no connection loses the typed text;
/// - a 400 hides which field was wrong.
@Suite struct FeedbackTests {
    @Test func lengthCountsScalarsAfterTrimming() {
        let family = "\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}"
        #expect(family.count == 1)
        #expect(Feedback.length("  \(family)\n") == 5)
        #expect(Feedback.length("   \n\t") == 0)
        #expect(Feedback.canSend(String(repeating: "a", count: 4_000)))
        #expect(!Feedback.canSend(String(repeating: "a", count: 4_001)))
        #expect(!Feedback.canSend(String(repeating: family, count: 801)))
        #expect(!Feedback.canSend("   "))
    }

    @Test func bodyCarriesNullsNotEmptyStrings() throws {
        let submission = FeedbackSubmission(kind: .idea, message: "  [test] hi  ", replyEmail: "  ", installId: "abc", context: nil)
        let json = try JSONSerialization.jsonObject(with: JSONEncoder().encode(submission)) as? [String: Any]
        #expect(json?["kind"] as? String == "idea")
        #expect(json?["message"] as? String == "[test] hi")
        #expect(json?["replyEmail"] is NSNull)
        #expect(json?["context"] is NSNull)
        #expect(json?["installId"] as? String == "abc")
    }

    @Test func contextDropsValuesTheWorkerWouldRefuse() throws {
        let context = FeedbackContext(appVersion: "0.3.0", build: "412", macosVersion: "15.6.1", chip: "Apple M1\u{2122}")
        #expect(context.chip == nil)
        #expect(FeedbackContext(appVersion: "", build: String(repeating: "9", count: 65), macosVersion: "15", chip: "Apple M1").appVersion == nil)
        #expect(FeedbackContext(appVersion: "", build: String(repeating: "9", count: 65), macosVersion: "15", chip: "Apple M1").build == nil)
        let json = try JSONSerialization.jsonObject(with: JSONEncoder().encode(context)) as? [String: Any]
        #expect(json?["chip"] is NSNull)
        #expect(json?["appVersion"] as? String == "0.3.0")
    }

    @Test func macOSVersionDropsAZeroPatch() {
        #expect(Feedback.macOSVersion(OperatingSystemVersion(majorVersion: 26, minorVersion: 6, patchVersion: 0)) == "26.6")
        #expect(Feedback.macOSVersion(OperatingSystemVersion(majorVersion: 15, minorVersion: 6, patchVersion: 1)) == "15.6.1")
    }

    @Test func answersMapToWhatTheOwnerIsTold() {
        #expect(Feedback.result(status: 201, body: Data(#"{"ok":true,"id":"f_1"}"#.utf8)) == .sent)
        #expect(Feedback.result(status: 429, body: Data(#"{"ok":false,"error":"rate_limited","scope":"network","message":"x"}"#.utf8)) == .rateLimited)
        #expect(Feedback.result(status: 429, body: Data("nope".utf8)) == .rateLimited)
        #expect(Feedback.result(status: 400, body: Data(#"{"ok":false,"error":"invalid","field":"replyEmail","message":"That email doesn't look right."}"#.utf8))
            == .invalid(field: "replyEmail", message: "That email doesn't look right."))
        #expect(Feedback.result(status: 400, body: Data("garbled".utf8)) == .server)
        #expect(Feedback.result(status: 500, body: Data(#"{"ok":false,"error":"server"}"#.utf8)) == .server)
        #expect(Feedback.result(status: 502, body: Data()) == .server)
        #expect(Feedback.result(status: 200, body: Data("<html>".utf8)) == .server)
    }

    @Test func emailCheckIsLooseButCatchesTypos() {
        #expect(Feedback.plausibleEmail("you@example.com"))
        #expect(Feedback.plausibleEmail(" first.last+tag@sub.example.co "))
        #expect(!Feedback.plausibleEmail("you@example"))
        #expect(!Feedback.plausibleEmail("you example.com"))
        #expect(!Feedback.plausibleEmail("@example.com"))
    }
}
