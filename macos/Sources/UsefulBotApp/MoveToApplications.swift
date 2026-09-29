import AppKit
import UsefulBotCore

/// Offers to move a release build into Applications when it was opened from
/// the DMG, Downloads or anywhere else. Runs before the first window, so no
/// service has started from the copy that is about to go away. Dev builds
/// (no runtime payload) never ask. The decisions are in `AppPlacement`.
@MainActor
enum MoveToApplications {
    static func offerIfNeeded() {
        guard RuntimeInstall.bundledRuntime() != nil else { return }
        removeStaleStaging()
        let defaults = UserDefaults.standard
        let bundle = Bundle.main.bundleURL
        let (translocated, original) = Translocation.original(of: bundle)
        // hdiutil is only asked when the app could be on a volume.
        let candidate = (translocated ? original?.path : bundle.path) ?? ""
        let mounts = candidate.hasPrefix("/Volumes/") ? attachedDiskImageMounts() : []
        let location = AppPlacement.classify(
            bundlePath: bundle.path,
            translocated: translocated,
            originalPath: original?.path,
            home: NSHomeDirectory(),
            diskImageMounts: mounts
        )
        guard AppPlacement.shouldOffer(
            isRelease: true,
            suppressed: defaults.bool(forKey: AppPlacement.suppressedKey),
            location: location
        ) else { return }

        // Opened from Finder the app is not frontmost yet, and the alert
        // would sit behind the window that launched it.
        NSApp.activate()
        let alert = NSAlert()
        alert.messageText = "Move Useful Bot to Applications?"
        alert.showsSuppressionButton = true
        alert.suppressionButton?.title = "Don't ask again"
        guard case .translocatedUnresolved = location else {
            alert.informativeText = "It works best from your Applications folder. Useful Bot will move itself there and reopen."
            alert.addButton(withTitle: "Move to Applications")
            alert.addButton(withTitle: "Not now")
            let answer = alert.runModal()
            if alert.suppressionButton?.state == .on { defaults.set(true, forKey: AppPlacement.suppressedKey) }
            if answer == .alertFirstButtonReturn { move(location: location, running: bundle, original: original) }
            return
        }
        // macOS runs this copy from a hidden read-only place and would not
        // say where the original is, so the user moves it.
        alert.informativeText = "Quit Useful Bot, drag it into your Applications folder, then open it from there."
        alert.addButton(withTitle: "Not now")
        alert.runModal()
        if alert.suppressionButton?.state == .on { defaults.set(true, forKey: AppPlacement.suppressedKey) }
    }

    private static func move(location: AppPlacement.Location, running: URL, original: URL?) {
        let fm = FileManager.default
        // A translocated app is copied from where the user put it.
        let source = original ?? running
        let shared = "/Applications/\(AppPlacement.appName)"
        let folder: URL
        switch AppPlacement.destination(
            applicationsWritable: fm.isWritableFile(atPath: "/Applications"),
            sharedCopyExists: fm.fileExists(atPath: shared),
            home: NSHomeDirectory()
        ) {
        case .openSharedCopy(let path):
            inform("Useful Bot is already in Applications", "This account can't replace that copy, so Useful Bot will open it instead.")
            switchTo(URL(fileURLWithPath: path))
        case .folder(let path):
            folder = URL(fileURLWithPath: path, isDirectory: true)
        }
        let destination = folder.appendingPathComponent(AppPlacement.appName, isDirectory: true)
        let staging = folder.appendingPathComponent(AppPlacement.stagingName, isDirectory: true)

        // Already running from there: bring that one forward instead of
        // starting a second set of services.
        if isRunning(from: destination) { switchTo(destination) }
        // The destination is this very copy under another spelling (or that
        // cannot be ruled out): nothing to move, and trashing it could lose
        // the only copy.
        guard AppPlacement.mayTrash(destination.path, keeping: [source.path, running.path]) else {
            inform("Useful Bot is already in Applications", "This copy is the one in \(folder.path), so there's nothing to move.")
            return
        }

        // Copied into a fresh staging folder beside the destination first, so
        // a copy cut short (a full disk, Cancel) leaves any installed copy as it was.
        let staged = staging.appendingPathComponent(AppPlacement.appName, isDirectory: true)
        do {
            try fm.createDirectory(at: folder, withIntermediateDirectories: true)
            try claim(staging)
        } catch {
            inform("Couldn't move Useful Bot", error.localizedDescription)
            return
        }
        switch copyShowingProgress(from: source, to: staged) {
        case .copied:
            break
        case .cancelled:
            try? fm.removeItem(at: staging)
            return
        case .failed(let error):
            try? fm.removeItem(at: staging)
            inform("Couldn't move Useful Bot", error.localizedDescription)
            return
        }
        // Checked again: a copy may have been opened from there meanwhile.
        if isRunning(from: destination) {
            try? fm.removeItem(at: staging)
            switchTo(destination)
        }
        var trashed: NSURL?
        do {
            if fm.fileExists(atPath: destination.path) {
                try fm.trashItem(at: destination, resultingItemURL: &trashed)
            }
            try fm.moveItem(at: staged, to: destination)
        } catch {
            try? fm.removeItem(at: staging)
            var message = error.localizedDescription
            // Put the old copy back rather than leave Applications empty.
            if let old = trashed as URL? {
                do {
                    try fm.moveItem(at: old, to: destination)
                } catch {
                    message += " Your earlier copy is in the Trash as \(old.lastPathComponent). Put it back from there."
                }
            }
            inform("Couldn't move Useful Bot", message)
            return
        }
        try? fm.removeItem(at: staging)

        var volume = ""
        switch AppPlacement.cleanup(after: location) {
        case .trash(let path):
            if AppPlacement.mayTrash(path, keeping: [destination.path]) {
                do {
                    try fm.trashItem(at: URL(fileURLWithPath: path), resultingItemURL: nil)
                } catch {
                    NSLog("Useful Bot: moved, but the old copy at %@ stays: %@", path, error.localizedDescription)
                }
            }
        case .eject(let path):
            volume = path
        case .none:
            break
        }
        relaunch(destination, ejecting: volume)
    }

    private static func isRunning(from app: URL) -> Bool {
        let current = NSRunningApplication.current
        return NSRunningApplication.runningApplications(withBundleIdentifier: Bundle.main.bundleIdentifier ?? "")
            .contains { $0 != current && AppPlacement.sameItem($0.bundleURL?.path ?? "", app.path) == true }
    }

    private enum CopyOutcome {
        case copied
        case cancelled
        case failed(Error)
    }

    /// The copy runs in ditto (a release is some hundreds of MB, tens of
    /// seconds from a DMG) under a small modal panel with Cancel, so the app
    /// never hangs without a word. The quarantine flag is cleared in the same
    /// background pass: the user already opened this copy past Gatekeeper,
    /// and with it the moved copy would be translocated on every launch.
    /// (`ditto --noqtn` keeps the flag on macOS 26, checked 2026-09-29.)
    private static func copyShowingProgress(from source: URL, to target: URL) -> CopyOutcome {
        final class Job: @unchecked Sendable {
            let lock = NSLock()
            var cancelled = false
            /// Set by the worker only, once ditto has exited: nil is "not finished".
            var outcome: CopyOutcome?
        }
        let job = Job()
        let ditto = Process()
        ditto.executableURL = URL(fileURLWithPath: "/usr/bin/ditto")
        ditto.arguments = [source.path, target.path]
        let errors = Pipe()
        ditto.standardError = errors
        do {
            try ditto.run()
        } catch {
            return .failed(error)
        }

        let panel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: 340, height: 120),
            styleMask: [.titled],
            backing: .buffered,
            defer: false
        )
        panel.title = "Useful Bot"
        let label = NSTextField(labelWithString: "Moving Useful Bot to Applications…")
        let bar = NSProgressIndicator()
        bar.style = .bar
        bar.isIndeterminate = true
        bar.startAnimation(nil)
        let cancel = ButtonAction {
            job.lock.withLock { job.cancelled = true }
            ditto.terminate()
        }
        let button = NSButton(title: "Cancel", target: cancel, action: #selector(ButtonAction.fire))
        button.keyEquivalent = "\u{1b}"
        let row = NSStackView()
        row.addView(button, in: .trailing)
        let stack = NSStackView(views: [label, bar, row])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 12
        stack.edgeInsets = NSEdgeInsets(top: 18, left: 20, bottom: 16, right: 20)
        bar.widthAnchor.constraint(equalToConstant: 300).isActive = true
        row.widthAnchor.constraint(equalToConstant: 300).isActive = true
        panel.contentView = stack
        panel.center()

        DispatchQueue.global(qos: .userInitiated).async {
            let detail = String(decoding: errors.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
            ditto.waitUntilExit()
            let cancelled = job.lock.withLock { job.cancelled }
            let outcome: CopyOutcome
            if cancelled {
                outcome = .cancelled
            } else if ditto.terminationStatus == 0 && ditto.terminationReason == .exit {
                // -s: never follow the bundle's symlinks out of it. A file
                // without the flag makes xattr exit 1, which is fine.
                let xattr = Process()
                xattr.executableURL = URL(fileURLWithPath: "/usr/bin/xattr")
                xattr.arguments = ["-r", "-s", "-d", "com.apple.quarantine", target.path]
                do {
                    try xattr.run()
                    xattr.waitUntilExit()
                } catch {
                    NSLog("Useful Bot: xattr failed: %@", error.localizedDescription)
                }
                // Cancel pressed during the quarantine pass still cancels.
                outcome = job.lock.withLock { job.cancelled } ? .cancelled : .copied
            } else {
                let reason = detail.trimmingCharacters(in: .whitespacesAndNewlines)
                outcome = .failed(MoveError(reason.isEmpty ? "The copy stopped (ditto \(ditto.terminationStatus))." : reason))
            }
            // Runs inside the modal session below: the main queue is served
            // in the modal run loop mode, and not before runModal starts.
            DispatchQueue.main.async {
                job.outcome = outcome
                NSApp.stopModal()
            }
        }
        let response = withExtendedLifetime(cancel) { NSApp.runModal(for: panel) }
        panel.orderOut(nil)
        guard response == .stop, let outcome = job.outcome else {
            // Staging is removed next, so ditto must stop writing into it first.
            ditto.terminate()
            ditto.waitUntilExit()
            return .failed(MoveError("The copy did not finish."))
        }
        return outcome
    }

    /// Makes a fresh staging folder owned by this process. One whose owner
    /// still runs is another launch's move in progress and is left alone.
    private static func claim(_ staging: URL) throws {
        let fm = FileManager.default
        if fm.fileExists(atPath: staging.path) {
            guard verdict(on: staging) == .remove else {
                throw MoveError("Another Useful Bot is moving itself to \(staging.deletingLastPathComponent().path). Wait for it to finish.")
            }
            try fm.removeItem(at: staging)
        }
        try fm.createDirectory(at: staging, withIntermediateDirectories: false)
        try String(ProcessInfo.processInfo.processIdentifier)
            .write(to: staging.appendingPathComponent(AppPlacement.stagingOwnerName), atomically: true, encoding: .utf8)
    }

    private static func verdict(on staging: URL) -> AppPlacement.StagingVerdict {
        let created = (try? staging.resourceValues(forKeys: [.creationDateKey]))?.creationDate
        var ownerAlive: Bool?
        if let text = try? String(contentsOf: staging.appendingPathComponent(AppPlacement.stagingOwnerName), encoding: .utf8),
           let pid = pid_t(text.trimmingCharacters(in: .whitespacesAndNewlines)), pid > 0 {
            // EPERM: the process exists but belongs to another user.
            ownerAlive = kill(pid, 0) == 0 || errno == EPERM
        }
        return AppPlacement.stagingVerdict(ownerAlive: ownerAlive, created: created, now: Date())
    }

    /// A staging folder a force-quit or crashed move left behind, in either
    /// Applications folder. A live move's folder is kept.
    private static func removeStaleStaging() {
        let fm = FileManager.default
        for folder in ["/Applications", (NSHomeDirectory() as NSString).appendingPathComponent("Applications")] {
            let staging = URL(fileURLWithPath: folder).appendingPathComponent(AppPlacement.stagingName)
            guard fm.fileExists(atPath: staging.path), verdict(on: staging) == .remove else { continue }
            do {
                try fm.removeItem(at: staging)
            } catch {
                NSLog("Useful Bot: cannot remove the stale %@: %@", staging.path, error.localizedDescription)
            }
        }
    }

    private static func inform(_ title: String, _ body: String) {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = body
        alert.addButton(withTitle: "OK")
        alert.runModal()
    }

    /// Quits this copy and opens `app` instead.
    private static func switchTo(_ app: URL) -> Never {
        relaunch(app, ejecting: "")
    }

    /// Opens `app` once this copy has quit (opened any earlier, Launch
    /// Services could hand back this very instance), then ejects the DMG it
    /// ran from (a volume cannot be ejected while an app on it runs).
    private static func relaunch(_ app: URL, ejecting volume: String) -> Never {
        let script = """
        while /bin/kill -0 "$1" 2>/dev/null; do /bin/sleep 0.2; done
        /usr/bin/open "$2"
        if [ -n "$3" ]; then /usr/bin/hdiutil detach "$3" -quiet || true; fi
        """
        let waiter = Process()
        waiter.executableURL = URL(fileURLWithPath: "/bin/sh")
        waiter.arguments = ["-c", script, "sh", String(ProcessInfo.processInfo.processIdentifier), app.path, volume]
        do {
            try waiter.run()
        } catch {
            inform("Open Useful Bot from \(app.deletingLastPathComponent().path)", error.localizedDescription)
        }
        // Nothing has started yet (no window, no services), so there is
        // nothing to save or stop.
        exit(0)
    }

    /// Mount points of attached disk images. hdiutil can hang on a stuck
    /// image; after a few seconds the app gives up on the eject instead.
    private static func attachedDiskImageMounts() -> [String] {
        let pipe = Pipe()
        let hdiutil = Process()
        hdiutil.executableURL = URL(fileURLWithPath: "/usr/bin/hdiutil")
        hdiutil.arguments = ["info", "-plist"]
        hdiutil.standardOutput = pipe
        do {
            try hdiutil.run()
        } catch {
            NSLog("Useful Bot: hdiutil info failed: %@", error.localizedDescription)
            return []
        }
        final class Output: @unchecked Sendable { var data = Data() }
        let output = Output()
        let read = DispatchSemaphore(value: 0)
        DispatchQueue.global(qos: .userInitiated).async {
            output.data = pipe.fileHandleForReading.readDataToEndOfFile()
            read.signal()
        }
        guard read.wait(timeout: .now() + 3) == .success else {
            NSLog("Useful Bot: hdiutil info took over 3 s; not ejecting")
            hdiutil.terminate()
            return []
        }
        hdiutil.waitUntilExit()
        return AppPlacement.diskImageMounts(hdiutilInfo: output.data)
    }

    private struct MoveError: LocalizedError {
        let errorDescription: String?
        init(_ message: String) { errorDescription = message }
    }
}

/// An AppKit button target that runs a closure.
private final class ButtonAction: NSObject {
    private let action: () -> Void
    init(_ action: @escaping () -> Void) { self.action = action }
    @objc func fire() { action() }
}

/// App Translocation: macOS runs a quarantined app that was not moved by
/// Finder from a random read-only mount. The calls that see through it are
/// not in the public headers, so they are looked up at run time, as LetsMove
/// does; a macOS without them reads as "translocated, original unknown" when
/// the path gives it away.
enum Translocation {
    private typealias IsTranslocated = @convention(c) (CFURL, UnsafeMutablePointer<DarwinBoolean>, UnsafeMutablePointer<Unmanaged<CFError>?>?) -> DarwinBoolean
    private typealias OriginalPath = @convention(c) (CFURL, UnsafeMutablePointer<Unmanaged<CFError>?>?) -> Unmanaged<CFURL>?

    static func original(of bundle: URL) -> (translocated: Bool, original: URL?) {
        let pathSaysSo = bundle.path.contains("/AppTranslocation/")
        guard let security = dlopen("/System/Library/Frameworks/Security.framework/Security", RTLD_LAZY) else {
            return (pathSaysSo, nil)
        }
        defer { dlclose(security) }
        guard let isSym = dlsym(security, "SecTranslocateIsTranslocatedURL"),
              let originalSym = dlsym(security, "SecTranslocateCreateOriginalPathForURL")
        else { return (pathSaysSo, nil) }
        let isTranslocated = unsafeBitCast(isSym, to: IsTranslocated.self)
        let originalPath = unsafeBitCast(originalSym, to: OriginalPath.self)

        var translocated: DarwinBoolean = false
        guard isTranslocated(bundle as CFURL, &translocated, nil).boolValue else { return (pathSaysSo, nil) }
        guard translocated.boolValue else { return (false, nil) }
        guard let url = originalPath(bundle as CFURL, nil)?.takeRetainedValue() else { return (true, nil) }
        return (true, url as URL)
    }
}
