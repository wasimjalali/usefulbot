#if os(macOS)
import Foundation

/// Where a release build is running from, and what moving it to Applications
/// involves. The decisions live here so they can be tested; the alert, the
/// copy and the relaunch are in the app (MoveToApplications.swift).
public enum AppPlacement {
    /// UserDefaults key for "Don't ask again".
    public static let suppressedKey = "ub.moveToApplicationsSuppressed"
    public static let appName = "Useful Bot.app"
    /// The copy in progress, beside the destination: a folder made fresh for
    /// each move, holding the app and `stagingOwnerName` (the copying
    /// process's pid). Anything a copy cut short leaves is removed on a later
    /// launch once its owner is gone (`stagingVerdict`).
    public static let stagingName = ".Useful Bot.app.moving"
    public static let stagingOwnerName = "owner.pid"

    public enum Location: Equatable, Sendable {
        /// In /Applications or ~/Applications, at any depth.
        case applications
        /// On a mounted disk image, such as the downloaded DMG.
        case diskImage(volume: String, path: String)
        /// Anywhere else: Downloads, the Desktop, an external drive.
        case elsewhere(path: String)
        /// Run by macOS from a random read-only copy (App Translocation), and
        /// where the user put the original could not be found.
        case translocatedUnresolved
    }

    /// What to do with the copy that launched, once the move has succeeded.
    public enum Cleanup: Equatable, Sendable {
        case none
        /// Eject the disk image, after this copy has quit.
        case eject(volume: String)
        /// Put the old copy in the Trash, so there are not two.
        case trash(path: String)
    }

    /// Where Move puts the app.
    public enum Destination: Equatable, Sendable {
        case folder(String)
        /// The user cannot write /Applications and an admin already put a copy
        /// there: open that one rather than keep a second in ~/Applications.
        case openSharedCopy(String)
    }

    /// Whether both paths are the same file or folder on disk, whatever the
    /// spelling: a symlinked parent (`~/Apps -> /Applications`), the Data
    /// volume firmlink (`/System/Volumes/Data/Applications`) or letter case.
    /// False when either does not exist; nil when both exist and either's
    /// identity cannot be read, which callers must treat as "maybe".
    public static func sameItem(_ a: String, _ b: String) -> Bool? {
        func identity(_ path: String) -> NSObject?? {
            let url = URL(fileURLWithPath: path).resolvingSymlinksInPath()
            guard FileManager.default.fileExists(atPath: url.path) else { return .some(nil) }
            guard let id = (try? url.resourceValues(forKeys: [.fileResourceIdentifierKey]))?.fileResourceIdentifier as? NSObject
            else { return nil }
            return .some(id)
        }
        guard let left = identity(a), let right = identity(b) else {
            // An identity could not be read. Unknown only if both exist.
            let fm = FileManager.default
            let exists = { (p: String) in fm.fileExists(atPath: URL(fileURLWithPath: p).resolvingSymlinksInPath().path) }
            return exists(a) && exists(b) ? nil : false
        }
        guard let left, let right else { return false }
        return left.isEqual(right)
    }

    /// - Parameters:
    ///   - bundlePath: the running bundle.
    ///   - translocated: macOS runs it from a translocation mount.
    ///   - originalPath: where the translocated bundle really is, when known.
    ///   - home: the user's home folder.
    ///   - diskImageMounts: mount points of attached disk images (`diskImageMounts(hdiutilInfo:)`).
    ///   - sameItem: file identity, `sameItem(_:_:)` outside tests.
    public static func classify(
        bundlePath: String,
        translocated: Bool,
        originalPath: String?,
        home: String,
        diskImageMounts: [String],
        sameItem: (String, String) -> Bool? = AppPlacement.sameItem
    ) -> Location {
        let raw: String
        if translocated {
            guard let originalPath else { return .translocatedUnresolved }
            raw = originalPath
        } else {
            raw = bundlePath
        }
        let path = (raw as NSString).standardizingPath
        let applications = ["/Applications", (home as NSString).appendingPathComponent("Applications")]
        // The startup disk is case-insensitive unless formatted otherwise.
        if applications.contains(where: { isInside(path, folder: $0, caseInsensitive: true) }) {
            return .applications
        }
        // Another spelling of the same folder: judged by what is on disk.
        var ancestor = (path as NSString).deletingLastPathComponent
        while ancestor != "/" && !ancestor.isEmpty {
            if applications.contains(where: { sameItem(ancestor, $0) == true }) { return .applications }
            ancestor = (ancestor as NSString).deletingLastPathComponent
        }
        // The longest match, so "/Volumes/Useful Bot 1" never loses to "/Volumes/Useful Bot".
        let volume = diskImageMounts
            .map { ($0 as NSString).standardizingPath }
            .filter { isInside(path, folder: $0, caseInsensitive: false) }
            .max { $0.count < $1.count }
        if let volume { return .diskImage(volume: volume, path: path) }
        return .elsewhere(path: path)
    }

    public static func shouldOffer(isRelease: Bool, suppressed: Bool, location: Location) -> Bool {
        isRelease && !suppressed && location != .applications
    }

    /// /Applications, or the user's own Applications folder when they cannot
    /// write the shared one (a standard, non-admin account), unless an admin
    /// already installed it there.
    public static func destination(applicationsWritable: Bool, sharedCopyExists: Bool, home: String) -> Destination {
        if applicationsWritable { return .folder("/Applications") }
        if sharedCopyExists { return .openSharedCopy("/Applications/\(appName)") }
        return .folder((home as NSString).appendingPathComponent("Applications"))
    }

    public static func cleanup(after location: Location) -> Cleanup {
        switch location {
        case .diskImage(let volume, _): return .eject(volume: volume)
        case .elsewhere(let path): return .trash(path: path)
        case .applications, .translocatedUnresolved: return .none
        }
    }

    /// Whether `item` may go to the Trash while every path in `keep` must
    /// survive. False when it is one of them under any spelling, or when that
    /// cannot be told, so a move can never trash the only copy: the running
    /// app when it already is the destination, or the new copy when the old
    /// one turns out to be it.
    public static func mayTrash(_ item: String, keeping keep: [String], sameItem: (String, String) -> Bool? = AppPlacement.sameItem) -> Bool {
        let spelled = { (p: String) in URL(fileURLWithPath: p).resolvingSymlinksInPath().standardized.path.lowercased() }
        return !keep.contains { other in
            spelled(item) == spelled(other) || sameItem(item, other) != false
        }
    }

    public enum StagingVerdict: Equatable, Sendable {
        case keep
        case remove
    }

    /// What a launch does with a staging folder it finds. A folder whose
    /// owner still runs is another launch's copy in progress: kept, unless it
    /// is older than any copy takes (the pid was reused). Without an owner
    /// file (a copy that died before writing it) only age decides.
    public static func stagingVerdict(ownerAlive: Bool?, created: Date?, now: Date) -> StagingVerdict {
        let age = created.map { now.timeIntervalSince($0) } ?? .infinity
        switch ownerAlive {
        case .some(true): return age > 60 * 60 ? .remove : .keep
        case .some(false): return .remove
        case nil: return age > 10 * 60 ? .remove : .keep
        }
    }

    /// Mount points in `hdiutil info -plist`. A report that does not parse
    /// gives none: the app is then treated as "elsewhere", which only costs
    /// the eject.
    public static func diskImageMounts(hdiutilInfo data: Data) -> [String] {
        guard let report = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any],
              let images = report["images"] as? [[String: Any]]
        else { return [] }
        return images.flatMap { image in
            (image["system-entities"] as? [[String: Any]] ?? []).compactMap { $0["mount-point"] as? String }
        }
    }

    private static func isInside(_ path: String, folder: String, caseInsensitive: Bool) -> Bool {
        let prefix = folder.hasSuffix("/") ? folder : folder + "/"
        if caseInsensitive { return path.lowercased().hasPrefix(prefix.lowercased()) }
        return path.hasPrefix(prefix)
    }
}
#endif
