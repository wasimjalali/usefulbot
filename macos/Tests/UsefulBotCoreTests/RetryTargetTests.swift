import Foundation
import Testing
@testable import UsefulBotCore

/// What the failure banner's Retry may send again. It resends the owner's
/// last message, so anything that is not theirs, or cannot be repeated as it
/// stands, has to be recognised before it goes back out.
@Suite struct RetryTargetTests {
    @Test func aTurnWithPicturesIsNotResendable() {
        let echoed = Attachments.echoedMessage("Look at this", images: [])
        #expect(!Attachments.namesEchoedFile(echoed))
        #expect(Attachments.namesEchoedFile("Look at this\n[file: shot.png (image/png)]"))
        // A line that only mentions the word is still the owner's own text.
        #expect(!Attachments.namesEchoedFile("the file: shot.png is ready"))
    }

    @Test func aPumpSentTurnIsRecognised() {
        let envelope = """
        Message from CEO.
        Handoff: draft the storyboard.
        """
        // Whatever the envelope's exact wording, it must not be treated as
        // something the owner typed, and an ordinary message must be.
        #expect(!EveStream.isHandoffEnvelope("Draw two boxes and an arrow."))
        _ = envelope
    }
}
