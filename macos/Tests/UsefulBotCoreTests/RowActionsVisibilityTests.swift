import Foundation
import Testing
@testable import UsefulBotCore

@Suite struct RowActionsVisibilityTests {
    @Test func theControlStaysUpWhileThePointerIsOnEitherHalf() {
        // The bug: the row and the button own separate tracking areas, so the
        // pointer leaves the row before it reaches the button.
        #expect(RowActionsVisibility(rowHovering: true).isEngaged)
        #expect(RowActionsVisibility(controlHovering: true).isEngaged)
        #expect(RowActionsVisibility(rowHovering: false, controlHovering: true).isEngaged)
        #expect(!RowActionsVisibility().isEngaged)
    }

    @Test func anOpenMenuPinsTheControlEvenWithThePointerElsewhere() {
        #expect(RowActionsVisibility(menuOpen: true).isEngaged)
        #expect(!RowActionsVisibility(menuOpen: true).shouldStartHiding)
    }

    @Test func hidingOnlyStartsOnceNothingHoldsTheControlUp() {
        #expect(RowActionsVisibility().shouldStartHiding)
        #expect(!RowActionsVisibility(rowHovering: true).shouldStartHiding)
        #expect(!RowActionsVisibility(controlHovering: true).shouldStartHiding)
        // Long enough to cross the gap, short enough not to linger.
        #expect(RowActionsVisibility.hideGrace >= 0.2)
        #expect(RowActionsVisibility.hideGrace <= 0.6)
    }
}
