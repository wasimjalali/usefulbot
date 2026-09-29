import Foundation

/// Whether a rail row's ellipsis is on screen.
///
/// The control only appears on hover, so the pointer has to travel from the row
/// into it. Hiding it the instant the row's own tracking area ends makes that
/// trip impossible: the button vanishes on the way and the click lands on the
/// row instead. Three things keep it up, and a short grace period covers the
/// gap between them.
public struct RowActionsVisibility: Equatable, Sendable {
    /// Long enough for a deliberate diagonal trip into the button, short enough
    /// that the control does not linger once the pointer has really left.
    public static let hideGrace: TimeInterval = 0.35

    public var rowHovering: Bool
    public var controlHovering: Bool
    public var menuOpen: Bool

    public init(rowHovering: Bool = false, controlHovering: Bool = false, menuOpen: Bool = false) {
        self.rowHovering = rowHovering
        self.controlHovering = controlHovering
        self.menuOpen = menuOpen
    }

    /// The pointer is on the row or the control, or the menu is pinned open.
    public var isEngaged: Bool {
        rowHovering || controlHovering || menuOpen
    }

    /// True once nothing holds the control up any more, which is when the
    /// grace timer starts rather than when the control disappears.
    public var shouldStartHiding: Bool { !isEngaged }
}
