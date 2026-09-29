import Foundation
import Testing
@testable import UsefulBotCore

/// How the move-to-Applications offer can go wrong, written before the code:
/// - a dev build (no runtime payload) asks to move, and moves the checkout's build;
/// - an app already in /Applications, a subfolder of it or ~/Applications is asked again;
/// - "/Applications Old/..." or "~/Applications-backup" passes a naive prefix check;
/// - a different letter case ("/applications/...") is taken as elsewhere on a
///   case-insensitive disk and offered a move onto itself;
/// - a translocated copy is classified by its random read-only path instead of
///   where the user put it, so a copy that is in /Applications is asked to move;
/// - a translocated copy whose original cannot be found is offered a move it
///   cannot do, instead of asking the user to drag it;
/// - an app on a mounted DMG is taken for "elsewhere" and its source trashed
///   (a read-only volume) instead of the volume being ejected;
/// - a volume whose name is a prefix of another ("/Volumes/Useful Bot" and
///   "/Volumes/Useful Bot 1") picks the wrong one to eject;
/// - an app on an external drive that is not a disk image is taken for a DMG
///   and the whole drive is ejected;
/// - a copy in Downloads is left behind after the move, so there are two;
/// - a user who cannot write /Applications gets a failed copy instead of ~/Applications;
/// - "Don't ask again" still asks;
/// - hdiutil's report is misread, or an image with no mounted volume (or a
///   malformed report) crashes the launch;
/// - the app in /Applications, reached by another spelling (the Data volume
///   firmlink, a symlinked parent), is "elsewhere": Move trashes the running
///   bundle as the old destination, then the cleanup trashes the new copy;
/// - any trash in a move hits the only copy left (source is destination);
/// - a non-admin user with an admin-installed copy gets a second one in
///   ~/Applications;
/// - a force-quit copy leaves a hidden staging folder forever, or a launch
///   deletes another launch's copy in progress;
/// - an identity that cannot be read is taken for "different" and the only
///   copy is trashed.
@Suite struct AppPlacementTests {
    private let home = "/Users/ada"

    /// Other spellings of /Applications, as the disk would report them.
    private static let aliases: [String: String] = [
        "/System/Volumes/Data/Applications": "/Applications",
        "/Users/ada/Apps": "/Applications",
    ]
    private static func fakeSame(_ a: String, _ b: String) -> Bool? {
        let canon = { (p: String) in aliases[p] ?? p }
        return canon(a) == canon(b)
    }

    private func classify(
        _ path: String,
        translocated: Bool = false,
        original: String? = nil,
        mounts: [String] = []
    ) -> AppPlacement.Location {
        AppPlacement.classify(
            bundlePath: path,
            translocated: translocated,
            originalPath: original,
            home: home,
            diskImageMounts: mounts,
            sameItem: Self.fakeSame
        )
    }

    @Test func applicationsFoldersAreHome() {
        #expect(classify("/Applications/Useful Bot.app") == .applications)
        #expect(classify("/Applications/Utilities/Useful Bot.app") == .applications)
        #expect(classify("/Users/ada/Applications/Useful Bot.app") == .applications)
        #expect(classify("/Applications/Useful Bot.app/") == .applications)
        #expect(classify("/applications/Useful Bot.app") == .applications)
    }

    @Test func otherSpellingsOfApplicationsAreHome() {
        #expect(classify("/System/Volumes/Data/Applications/Useful Bot.app") == .applications)
        #expect(classify("/Users/ada/Apps/Useful Bot.app") == .applications)
        #expect(classify("/Users/ada/Apps/Tools/Useful Bot.app") == .applications)
        #expect(classify("/Users/ada/Apps2/Useful Bot.app") == .elsewhere(path: "/Users/ada/Apps2/Useful Bot.app"))
    }

    /// The real identity check, on this Mac's disk.
    @Test func sameItemSeesThroughSymlinksAndFirmlinks() throws {
        let fm = FileManager.default
        let root = fm.temporaryDirectory.appendingPathComponent("AppPlacementTests-\(UUID().uuidString)")
        defer { try? fm.removeItem(at: root) }
        let real = root.appendingPathComponent("Real")
        try fm.createDirectory(at: real.appendingPathComponent("Useful Bot.app"), withIntermediateDirectories: true)
        let link = root.appendingPathComponent("Link")
        try fm.createSymbolicLink(at: link, withDestinationURL: real)
        #expect(AppPlacement.sameItem(link.appendingPathComponent("Useful Bot.app").path, real.appendingPathComponent("Useful Bot.app").path) == true)
        #expect(AppPlacement.sameItem(link.path, root.path) == false)
        #expect(AppPlacement.sameItem(root.appendingPathComponent("Missing").path, root.appendingPathComponent("Missing").path) == false)
        #expect(AppPlacement.sameItem("/System/Volumes/Data/Applications", "/Applications") == true)
        // The string fallback sees through the symlink too.
        #expect(!AppPlacement.mayTrash(link.appendingPathComponent("Useful Bot.app").path, keeping: [real.appendingPathComponent("Useful Bot.app").path], sameItem: { _, _ in false }))
        #expect(AppPlacement.classify(
            bundlePath: "/System/Volumes/Data/Applications/Useful Bot.app",
            translocated: false, originalPath: nil, home: NSHomeDirectory(), diskImageMounts: []
        ) == .applications)
    }

    @Test func noTrashEverHitsTheOnlyCopy() {
        let running = "/System/Volumes/Data/Applications/Useful Bot.app"
        let destination = "/Applications/Useful Bot.app"
        let same = { (a: String, b: String) -> Bool? in
            Self.fakeSame((a as NSString).deletingLastPathComponent, (b as NSString).deletingLastPathComponent) == true
                && (a as NSString).lastPathComponent == (b as NSString).lastPathComponent
        }
        // The old destination is the running app: keep it.
        #expect(!AppPlacement.mayTrash(destination, keeping: [running], sameItem: same))
        // The old copy is the new one: keep it.
        #expect(!AppPlacement.mayTrash(running, keeping: [destination], sameItem: same))
        #expect(!AppPlacement.mayTrash("/applications/Useful Bot.app/", keeping: [destination], sameItem: { _, _ in false }))
        #expect(AppPlacement.mayTrash("/Users/ada/Downloads/Useful Bot.app", keeping: [destination], sameItem: same))
        #expect(AppPlacement.mayTrash(destination, keeping: ["/Volumes/Useful Bot/Useful Bot.app"], sameItem: same))
        // Identity unreadable for two existing items: keep.
        #expect(!AppPlacement.mayTrash("/Users/ada/Downloads/Useful Bot.app", keeping: [destination], sameItem: { _, _ in nil }))
    }

    @Test func lookalikeFoldersAreNot() {
        #expect(classify("/Applications Old/Useful Bot.app") == .elsewhere(path: "/Applications Old/Useful Bot.app"))
        #expect(classify("/Users/ada/Applications-backup/Useful Bot.app") == .elsewhere(path: "/Users/ada/Applications-backup/Useful Bot.app"))
        #expect(classify("/Users/bob/Applications/Useful Bot.app") == .elsewhere(path: "/Users/bob/Applications/Useful Bot.app"))
    }

    @Test func downloadsIsElsewhere() {
        #expect(classify("/Users/ada/Downloads/Useful Bot.app") == .elsewhere(path: "/Users/ada/Downloads/Useful Bot.app"))
        #expect(classify("/Users/ada/Downloads/x/../Useful Bot.app") == .elsewhere(path: "/Users/ada/Downloads/Useful Bot.app"))
    }

    @Test func aMountedDiskImageIsNamedByItsVolume() {
        let mounts = ["/Volumes/Useful Bot 1", "/Volumes/Useful Bot"]
        #expect(classify("/Volumes/Useful Bot/Useful Bot.app", mounts: mounts) == .diskImage(volume: "/Volumes/Useful Bot", path: "/Volumes/Useful Bot/Useful Bot.app"))
        #expect(classify("/Volumes/Useful Bot 1/Useful Bot.app", mounts: mounts) == .diskImage(volume: "/Volumes/Useful Bot 1", path: "/Volumes/Useful Bot 1/Useful Bot.app"))
    }

    @Test func anExternalDriveIsNotADiskImage() {
        #expect(classify("/Volumes/Backup/Useful Bot.app", mounts: ["/Volumes/Useful Bot"]) == .elsewhere(path: "/Volumes/Backup/Useful Bot.app"))
    }

    @Test func translocationIsSeenThrough() {
        let random = "/private/var/folders/xy/T/AppTranslocation/1234-ABCD/d/Useful Bot.app"
        #expect(classify(random, translocated: true, original: "/Applications/Useful Bot.app") == .applications)
        #expect(classify(random, translocated: true, original: "/Users/ada/Downloads/Useful Bot.app") == .elsewhere(path: "/Users/ada/Downloads/Useful Bot.app"))
        #expect(classify(random, translocated: true, original: "/Volumes/Useful Bot/Useful Bot.app", mounts: ["/Volumes/Useful Bot"])
            == .diskImage(volume: "/Volumes/Useful Bot", path: "/Volumes/Useful Bot/Useful Bot.app"))
        #expect(classify(random, translocated: true, original: nil) == .translocatedUnresolved)
    }

    @Test func onlyAReleaseOutsideApplicationsIsAsked() {
        let downloads = AppPlacement.Location.elsewhere(path: "/Users/ada/Downloads/Useful Bot.app")
        #expect(AppPlacement.shouldOffer(isRelease: true, suppressed: false, location: downloads))
        #expect(!AppPlacement.shouldOffer(isRelease: false, suppressed: false, location: downloads))
        #expect(!AppPlacement.shouldOffer(isRelease: true, suppressed: true, location: downloads))
        #expect(!AppPlacement.shouldOffer(isRelease: true, suppressed: false, location: .applications))
        #expect(AppPlacement.shouldOffer(isRelease: true, suppressed: false, location: .translocatedUnresolved))
    }

    @Test func aUserWhoCannotWriteApplicationsGetsTheirOwn() {
        #expect(AppPlacement.destination(applicationsWritable: true, sharedCopyExists: true, home: home) == .folder("/Applications"))
        #expect(AppPlacement.destination(applicationsWritable: false, sharedCopyExists: false, home: home) == .folder("/Users/ada/Applications"))
        #expect(AppPlacement.destination(applicationsWritable: false, sharedCopyExists: true, home: home) == .openSharedCopy("/Applications/Useful Bot.app"))
    }

    @Test func aLiveLaunchKeepsItsStaging() {
        let now = Date()
        let ago = { (minutes: Double) in now.addingTimeInterval(-minutes * 60) }
        // Another launch is copying right now.
        #expect(AppPlacement.stagingVerdict(ownerAlive: true, created: ago(0.5), now: now) == .keep)
        #expect(AppPlacement.stagingVerdict(ownerAlive: true, created: ago(30), now: now) == .keep)
        // Its pid was reused by something else long after.
        #expect(AppPlacement.stagingVerdict(ownerAlive: true, created: ago(61), now: now) == .remove)
        // The copying launch is gone: force-quit or crashed.
        #expect(AppPlacement.stagingVerdict(ownerAlive: false, created: ago(0.5), now: now) == .remove)
        // No owner file yet: only age decides.
        #expect(AppPlacement.stagingVerdict(ownerAlive: nil, created: ago(0.5), now: now) == .keep)
        #expect(AppPlacement.stagingVerdict(ownerAlive: nil, created: ago(11), now: now) == .remove)
        #expect(AppPlacement.stagingVerdict(ownerAlive: nil, created: nil, now: now) == .remove)
    }

    @Test func whatHappensToTheCopyLeftBehind() {
        #expect(AppPlacement.cleanup(after: .diskImage(volume: "/Volumes/Useful Bot", path: "/Volumes/Useful Bot/Useful Bot.app")) == .eject(volume: "/Volumes/Useful Bot"))
        #expect(AppPlacement.cleanup(after: .elsewhere(path: "/Users/ada/Downloads/Useful Bot.app")) == .trash(path: "/Users/ada/Downloads/Useful Bot.app"))
        #expect(AppPlacement.cleanup(after: .applications) == .none)
        #expect(AppPlacement.cleanup(after: .translocatedUnresolved) == .none)
    }

    @Test func hdiutilInfoGivesEachMountedVolume() throws {
        let report: [String: Any] = [
            "framework": "1.0",
            "images": [
                [
                    "image-path": "/Users/ada/Downloads/Useful-Bot-macOS.dmg",
                    "system-entities": [
                        ["content-hint": "GUID_partition_scheme", "dev-entry": "/dev/disk4"],
                        ["content-hint": "Apple_HFS", "dev-entry": "/dev/disk4s1", "mount-point": "/Volumes/Useful Bot"],
                    ],
                ],
                // Attached with nothing mounted.
                ["image-path": "/tmp/other.dmg", "system-entities": [["dev-entry": "/dev/disk5"]]],
            ],
        ]
        let data = try PropertyListSerialization.data(fromPropertyList: report, format: .xml, options: 0)
        #expect(AppPlacement.diskImageMounts(hdiutilInfo: data) == ["/Volumes/Useful Bot"])
        #expect(AppPlacement.diskImageMounts(hdiutilInfo: Data("not a plist".utf8)) == [])
        #expect(AppPlacement.diskImageMounts(hdiutilInfo: Data()) == [])
    }
}
