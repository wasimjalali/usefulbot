#if os(macOS)
import Foundation
import Testing
@testable import UsefulBotCore

/// The real runner against real processes: the stray scan and the listener
/// ownership check parse `ps` and `lsof`, which the fakes cannot cover.
@Suite(.serialized) struct ProcessRunnerRealTests {
    @Test func theStrayScanFindsAPortlessProcessAndTerminateStopsIt() async throws {
        let marker = "\(Int.random(in: 100_000...999_999))"
        let child = Process()
        child.executableURL = URL(fileURLWithPath: "/bin/sleep")
        child.arguments = [marker]
        try child.run()
        defer { if child.isRunning { child.terminate() } }
        let runner = FoundationProcessRunner(strayMinAge: 0)
        let matching: @Sendable (String) -> Bool = { $0.hasSuffix("sleep \(marker)") }
        #expect(runner.strayServicePids(matching: matching) == [child.processIdentifier])
        runner.terminate(pids: [child.processIdentifier], force: false)
        child.waitUntilExit()
        #expect(runner.strayServicePids(matching: matching).isEmpty)
    }

    @Test func ownedProcessesAreFoundWithoutASocketAndSignalledOnlyWhileTheyAreTheSameProcess() async throws {
        let marker = "\(Int.random(in: 100_000...999_999))"
        let child = Process()
        child.executableURL = URL(fileURLWithPath: "/bin/sh")
        // A launcher with a child under it, neither holding a port.
        child.arguments = ["-c", "sleep \(marker) & wait"]
        try child.run()
        defer { if child.isRunning { child.terminate() } }
        let runner = FoundationProcessRunner()
        let owns: @Sendable (String) -> Bool = { $0.contains("sleep \(marker)") }
        // The shell and its sleep may take a moment to appear.
        var found: [OwnedProcess] = []
        for _ in 0..<40 where found.count < 2 {
            try await Task.sleep(nanoseconds: 50_000_000)
            found = runner.ownServiceProcesses(owns: owns)
        }
        #expect(found.count >= 2, "the launcher and its child are both found, with no listener")
        #expect(found.contains { $0.pid == child.processIdentifier })
        #expect(found.allSatisfy { !$0.started.isEmpty })
        let shell = try #require(found.first { $0.pid == child.processIdentifier })
        #expect(runner.isStillRunning(shell))
        // The same pid with another start time or command line is another process.
        let reusedStart = OwnedProcess(pid: shell.pid, args: shell.args, started: "Mon Jan 1 00:00:00 2001")
        let reusedCommand = OwnedProcess(pid: shell.pid, args: "something else", started: shell.started)
        #expect(!runner.isStillRunning(reusedStart))
        #expect(!runner.isStillRunning(reusedCommand))
        #expect(!runner.signalProcess(reusedStart, force: true))
        #expect(!runner.signalProcess(reusedCommand, force: true))
        #expect(child.isRunning, "a look-alike identity must not signal the real process")
        for process in found.reversed() { _ = runner.signalProcess(process, force: true) }
        child.waitUntilExit()
        #expect(!runner.isStillRunning(shell))
        #expect(runner.ownServiceProcesses(owns: owns).isEmpty)
    }

    @Test func aListenerIsForeignUnlessTheOwnsRuleClaimsIt() throws {
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        #expect(fd >= 0)
        var address = sockaddr_in()
        address.sin_family = sa_family_t(AF_INET)
        address.sin_addr.s_addr = inet_addr("127.0.0.1")
        address.sin_port = 0
        let bound = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
        }
        #expect(bound == 0)
        #expect(listen(fd, 1) == 0)
        var length = socklen_t(MemoryLayout<sockaddr_in>.size)
        withUnsafeMutablePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { _ = getsockname(fd, $0, &length) }
        }
        let port = Int(UInt16(bigEndian: address.sin_port))
        let runner = FoundationProcessRunner()
        #expect(runner.hasForeignListener(port: port, owns: { _ in false }))
        #expect(!runner.hasForeignListener(port: port, owns: { _ in true }))
        // Nothing listening is not foreign.
        close(fd)
        #expect(!runner.hasForeignListener(port: port, owns: { _ in false }))
    }

    // MARK: - Process trees (M1) and stray age (L2)

    private func alive(_ pid: pid_t) -> Bool { kill(pid, 0) == 0 }

    private func waitUntil(_ seconds: Double = 3, _ condition: () -> Bool) async -> Bool {
        let deadline = Date().addingTimeInterval(seconds)
        while Date() < deadline {
            if condition() { return true }
            try? await Task.sleep(nanoseconds: 50_000_000)
        }
        return condition()
    }

    private func launcher(script: String) throws -> Process {
        let launcher = Process()
        launcher.executableURL = URL(fileURLWithPath: "/bin/sh")
        launcher.arguments = ["-c", script]
        try launcher.run()
        return launcher
    }

    @Test func terminatingALauncherAlsoStopsItsChildren() async throws {
        let marker = "\(Int.random(in: 100_000...999_999))"
        let parent = try launcher(script: "sleep \(marker) & wait")
        defer { if parent.isRunning { parent.terminate() } }
        let runner = FoundationProcessRunner(strayMinAge: 0)
        var childPid: pid_t?
        _ = await waitUntil {
            childPid = ProcessTable.read().first { $0.ppid == parent.processIdentifier && $0.args.hasSuffix("sleep \(marker)") }?.pid
            return childPid != nil
        }
        let child = try #require(childPid)
        runner.terminate(pids: [parent.processIdentifier], force: false)
        #expect(await waitUntil { !alive(child) })
        #expect(await waitUntil { !parent.isRunning })
    }

    @Test func aStrayLauncherWithAListeningChildIsNotStray() async throws {
        let marker = "\(Int.random(in: 100_000...999_999))"
        // The launcher holds no port itself; its child does, as in the real stack.
        let perl = "perl -MIO::Socket::INET -e '$s=IO::Socket::INET->new(Listen=>1,LocalAddr=>\"127.0.0.1\",LocalPort=>0) or die; sleep 30'"
        let parent = try launcher(script: "# \(marker)\n\(perl) & wait")
        defer { if parent.isRunning { parent.terminate() } }
        let runner = FoundationProcessRunner(strayMinAge: 0)
        let matching: @Sendable (String) -> Bool = { $0.contains("/bin/sh") && $0.contains(marker) }
        let bound = await waitUntil(5) {
            ProcessTable.read().filter { $0.ppid == parent.processIdentifier }.contains { runner.holdsListeningPort(pid: $0.pid) }
        }
        #expect(bound)
        #expect(runner.strayServicePids(matching: matching).isEmpty)
        for kid in ProcessTable.read().filter({ $0.ppid == parent.processIdentifier }) { kill(kid.pid, SIGKILL) }
        #expect(await waitUntil { !parent.isRunning })
    }

    @Test func aYoungLauncherIsNotStrayUntilItOutlivesTheStartupBudget() throws {
        let marker = "\(Int.random(in: 100_000...999_999))"
        let child = Process()
        child.executableURL = URL(fileURLWithPath: "/bin/sleep")
        child.arguments = [marker]
        try child.run()
        defer { if child.isRunning { child.terminate() } }
        let matching: @Sendable (String) -> Bool = { $0.hasSuffix("sleep \(marker)") }
        #expect(FoundationProcessRunner(strayMinAge: 90).strayServicePids(matching: matching).isEmpty)
        #expect(FoundationProcessRunner(strayMinAge: 0).strayServicePids(matching: matching) == [child.processIdentifier])
    }

    @Test func theProcessTableParsesElapsedTimeAndDescendants() {
        #expect(ProcessTable.seconds(fromElapsed: "05") == 5)
        #expect(ProcessTable.seconds(fromElapsed: "01:05") == 65)
        #expect(ProcessTable.seconds(fromElapsed: "02:01:05") == 7265)
        #expect(ProcessTable.seconds(fromElapsed: "3-02:01:05") == 266_465)
        #expect(ProcessTable.seconds(fromElapsed: "junk") == nil)
        let rows = ProcessTable.parse("""
          10     1       00:10 node launcher.mjs web
          11    10       00:09 node child.js a b
          12    11       00:08 deep
          20     1       00:07 other
        """)
        #expect(rows.count == 4)
        #expect(rows[1].args == "node child.js a b")
        #expect(rows[1].elapsed == 9)
        #expect(Set(ProcessTable.descendants(of: 10, in: rows)) == [11, 12])
        #expect(ProcessTable.descendants(of: 20, in: rows).isEmpty)
    }

    @Test func aDescendantThatIgnoresSigtermIsKilledAfterTheLauncherExits() async throws {
        let marker = "\(Int.random(in: 100_000...999_999))"
        // The launcher dies on SIGTERM; its child ignores it and is reparented.
        let parent = try launcher(script: "# \(marker)\n(trap '' TERM; exec sleep \(marker)) & wait")
        defer { if parent.isRunning { parent.terminate() } }
        let runner = FoundationProcessRunner(strayMinAge: 0)
        var childPid: pid_t?
        _ = await waitUntil {
            childPid = ProcessTable.read().first { $0.ppid == parent.processIdentifier && $0.args.hasSuffix("sleep \(marker)") }?.pid
            return childPid != nil
        }
        let child = try #require(childPid)
        defer { kill(child, SIGKILL) }
        let matching: @Sendable (String) -> Bool = { $0.contains("/bin/sh") && $0.contains(marker) }
        #expect(runner.strayServicePids(matching: matching) == [parent.processIdentifier])
        runner.terminate(pids: [parent.processIdentifier], force: false)
        #expect(await waitUntil { !parent.isRunning })
        // The launcher is gone and nothing ever sends it SIGKILL, but the child is still up.
        #expect(alive(child))
        runner.killTermedSurvivors()
        #expect(await waitUntil { !alive(child) })
    }

    @Test func aPidWhoseCommandLineChangedSinceTheScanIsNotSignalled() async throws {
        let marker = "\(Int.random(in: 100_000...999_999))"
        let stdin = Pipe()
        let parent = Process()
        parent.executableURL = URL(fileURLWithPath: "/bin/sh")
        parent.arguments = ["-c", "# \(marker)\nread x; exec sleep \(marker)"]
        parent.standardInput = stdin
        try parent.run()
        defer { if parent.isRunning { kill(parent.processIdentifier, SIGKILL) } }
        let runner = FoundationProcessRunner(strayMinAge: 0)
        let matching: @Sendable (String) -> Bool = { $0.contains("/bin/sh") && $0.contains(marker) }
        #expect(runner.strayServicePids(matching: matching) == [parent.processIdentifier])
        // The same pid now runs something else, as a reused pid would.
        stdin.fileHandleForWriting.write(Data("go\n".utf8))
        #expect(await waitUntil { ProcessTable.read().first { $0.pid == parent.processIdentifier }?.args.hasSuffix("sleep \(marker)") == true })
        runner.terminate(pids: [parent.processIdentifier], force: false)
        runner.terminate(pids: [parent.processIdentifier], force: true)
        try await Task.sleep(nanoseconds: 300_000_000)
        #expect(parent.isRunning)
    }

    @Test func aTreeIsOrderedDeepestFirst() {
        let rows = ProcessTable.parse("""
          10     1       00:10 launcher
          11    10       00:09 child
          12    11       00:08 deep
          13    10       00:08 sibling
          20     1       00:07 other
        """)
        let order = ProcessTable.treeDeepestFirst(of: 10, in: rows).map(\.pid)
        #expect(order.first == 12 && order.last == 10)
        #expect(Set(order) == [10, 11, 12, 13])
        #expect(order.firstIndex(of: 12)! < order.firstIndex(of: 11)!)
    }
}
#endif
