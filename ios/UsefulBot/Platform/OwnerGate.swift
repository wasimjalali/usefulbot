import Foundation
import LocalAuthentication

/// The §4.4 gate: one `evaluatePolicy(.deviceOwnerAuthentication)` —
/// biometrics with passcode fallback — immediately before a class-A action
/// is sent. Cancel or failure means the UI returns to its pre-confirm state
/// and no server call is made. The server is never told about biometrics.
enum OwnerGate {
    /// §11 passcode-unavailable refusal copy, shown inline under the button.
    static let unavailableCopy = "Set a passcode on this iPhone to approve actions"

    enum Verdict {
        case approved
        case cancelledOrFailed
        /// Nothing to evaluate (passcodeNotSet, biometrics unavailable):
        /// the action is refused with `unavailableCopy`.
        case unavailable
    }

    /// Runs one evaluation. `reason` is the sheet's explanation, shown under
    /// the title; keep it action-specific.
    static func evaluate(reason: String) async -> Verdict {
        let context = LAContext()
        var failure: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &failure) else {
            return .unavailable
        }
        return ((try? await context.evaluatePolicy(
            .deviceOwnerAuthentication,
            localizedReason: reason
        )) ?? false) ? .approved : .cancelledOrFailed
    }
}
