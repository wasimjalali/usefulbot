#if os(macOS)
import Testing
@testable import UsefulBotCore

@Suite struct ServiceSupervisorTests {
    private let repo = "/Users/wasim/Desktop/useful-bot"

    @Test func commandsPointAtRepoServiceScript() {
        let supervisor = ServiceSupervisor()
        let cmd = supervisor.command(mode: .web, repoPath: repo)
        #expect(cmd.executable == ServiceSupervisor.resolveNodePath())
        #expect(cmd.arguments == ["\(repo)/scripts/service.mjs", "web"])
        #expect(cmd.workingDirectory == repo)
    }

    @Test func resolvesNodeFromCandidatesInOrder() {
        #expect(ServiceSupervisor.resolveNodePath(exists: { _ in false }) == "/usr/local/bin/node")
        #expect(ServiceSupervisor.resolveNodePath(exists: { $0 == "/usr/local/bin/node" }) == "/usr/local/bin/node")
        #expect(ServiceSupervisor.resolveNodePath(exists: { $0 == "/opt/homebrew/bin/node" }) == "/opt/homebrew/bin/node")
    }

    @Test func eveServerChildOfThisInstallIsOwnAndAnotherInstallsIsNot() {
        let supervisor = ServiceSupervisor(nodeExists: { _ in true })
        let child = "node \(repo)/node_modules/eve/dist/src/cli/dev/local-server-child.js"
        #expect(supervisor.isOwnNodeProcess(child, repoPath: repo))
        #expect(!supervisor.isOwnNodeProcess(child, repoPath: "/Users/wasim/Desktop/other"))
        // The same file name outside this repo is not ours.
        #expect(!supervisor.isOwnNodeProcess("node /elsewhere/eve/dist/src/cli/dev/local-server-child.js", repoPath: repo))
    }

    @Test func dailyOnlyRefusesAnEveRunningFromTheDevRuntime() {
        let supervisor = ServiceSupervisor(nodeExists: { _ in true })
        let devRoot = "/Users/x/Library/Application Support/Useful Bot Dev/app"
        let release = "/Users/x/Library/Application Support/Useful Bot/app"
        let checkout = "/Users/x/Desktop/useful-bot"
        func own(_ line: String, _ variant: AppVariant, _ repoPath: String) -> Bool {
            supervisor.isOwnEveProcess(
                line, variant: variant, repoPath: repoPath, devRuntimeRoot: devRoot,
                releaseRuntimeRoot: release, checkoutRoot: checkout)
        }
        let devEve = "node \(devRoot)/node_modules/eve/bin/eve.js dev"
        let releaseEve = "node \(release)/node_modules/eve/dist/src/cli/dev/local-server-child.js"
        let checkoutEve = "node \(checkout)/node_modules/eve/bin/eve.js dev"
        // Daily: a release build and a checkout build adopt each other's eve.
        #expect(own(releaseEve, .daily, checkout))
        #expect(own(checkoutEve, .daily, release))
        // Not an eve at all: foreign for daily too.
        #expect(!own("node something-unrelated", .daily, release))
        #expect(!own("python3 -m http.server 4321", .daily, release))
        #expect(!own(devEve, .daily, release))
        #expect(!own("node child.js \(devRoot)", .daily, checkout))
        // Neither is it one of daily's roots: only the checkout, the release root and repoPath count.
        #expect(!own("node \(devRoot)-old/node_modules/eve/bin/eve.js", .daily, release))
        // The eve path needs a path boundary and has to sit under one of those roots.
        #expect(!own("node /x/steve/bin/eve.js", .daily, release))
        #expect(!own("node /Users/x/Desktop/other/node_modules/eve/bin/eve.js dev", .daily, release))
        #expect(!own("node /Users/x/Desktop/other/node_modules/eve/dist/src/cli/dev/local-server-child.js", .daily, checkout))
        #expect(!own("node /elsewhere\(checkout)/node_modules/eve/bin/eve.js", .daily, release))
        #expect(!own("node \(checkout)-2/node_modules/eve/bin/eve.js", .daily, release))
        // Parent argv carried after the child's still counts.
        #expect(own("node child.js /bin/zsh \(checkoutEve)", .daily, release))
        // A stored repoPath elsewhere is adopted too.
        #expect(own("node /srv/ub/node_modules/eve/bin/eve.js", .daily, "/srv/ub"))
        // Dev stays strict: only its own repoPath.
        #expect(own(devEve, .dev, devRoot))
        #expect(!own(releaseEve, .dev, devRoot))
        #expect(!own(checkoutEve, .dev, devRoot))
    }

    @Test func ownsUsefulBotNodeProcessesOnly() {
        let supervisor = ServiceSupervisor()
        #expect(supervisor.isOwnNodeProcess("/usr/local/bin/node \(repo)/scripts/service.mjs web", repoPath: repo))
        #expect(supervisor.isOwnNodeProcess(
            "/usr/local/bin/node \(repo)/node_modules/next/dist/bin/next dev \(repo)/web --port 4320",
            repoPath: repo
        ))
        #expect(supervisor.isOwnNodeProcess(
            "node --experimental-strip-types \(repo)/router/src/index.ts",
            repoPath: repo
        ))
        #expect(supervisor.isOwnNodeProcess(
            "node \(repo)/node_modules/eve/bin/eve.js dev",
            repoPath: repo
        ))
        // The built web server, as launched and before it renames itself.
        #expect(supervisor.isOwnNodeProcess(
            "/usr/local/bin/node \(repo)/web/.next/standalone/web/server.js",
            repoPath: repo
        ))
        #expect(!supervisor.isOwnNodeProcess(
            "/usr/local/bin/node \(repo)-2/web/.next/standalone/web/server.js",
            repoPath: repo
        ))
        #expect(!supervisor.isOwnNodeProcess("next-server (v16.2.1)", repoPath: repo))
        // The runner appends the parent command line, so a title-rewritten
        // Next child is still recognized through its service.mjs launcher.
        #expect(supervisor.isOwnNodeProcess(
            "next-server (v16.2.1) /usr/local/bin/node \(repo)/scripts/service.mjs web",
            repoPath: repo
        ))
        #expect(!supervisor.isOwnNodeProcess(
            "/usr/local/bin/node /other/checkout/node_modules/next/dist/bin/next dev",
            repoPath: repo
        ))
        #expect(!supervisor.isOwnNodeProcess("node some-other-app", repoPath: repo))
        #expect(!supervisor.isOwnNodeProcess("Chrome", repoPath: repo))
    }

    @Test func aSiblingCheckoutWithALongerPathIsNotOurs() {
        // A sibling checkout (`useful-bot-2`) extends this repo's path, so a
        // raw substring match would count its processes as our own and
        // signal them.
        let supervisor = ServiceSupervisor()
        let sibling = "\(repo)-2"
        #expect(!supervisor.isOwnNodeProcess(
            "/usr/local/bin/node \(sibling)/node_modules/next/dist/bin/next dev \(sibling)/web --port 4320",
            repoPath: repo
        ))
        #expect(!supervisor.isOwnNodeProcess(
            "node --experimental-strip-types \(sibling)/router/src/index.ts",
            repoPath: repo
        ))
        #expect(!supervisor.isOwnNodeProcess(
            "/usr/local/bin/node \(sibling)/scripts/service.mjs web",
            repoPath: repo
        ))
    }
}
#endif
