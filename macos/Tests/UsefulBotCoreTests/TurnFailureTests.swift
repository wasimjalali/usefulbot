import Foundation
import Testing
@testable import UsefulBotCore

@Suite struct TurnFailureTests {
    /// The router stops calling a provider that failed three times in a
    /// minute. A half-minute pause read as a dead app until the copy said how
    /// long was left.
    @Test func aRouterCoolDownSaysHowLongIsLeft() {
        let timed = TurnFailure(code: "circuit_open", detail: "", retryAfterMs: 21_500)
        #expect(timed.retryAfterSeconds == 22)
        #expect(timed.coolDownSeconds == 22)
        #expect(timed.reason
            == "The model provider failed repeatedly, so sending is paused for 22 more seconds. Retry after that.")
        #expect(timed.rowMessage == "The model provider failed repeatedly, so sending was paused.")

        // No number: still named, just without the countdown.
        let bare = TurnFailure(code: "circuit_open", detail: "")
        #expect(bare.retryAfterSeconds == nil)
        #expect(bare.reason == "The model provider failed repeatedly, so sending is paused briefly. Retry in a moment.")

        // A caller rate limit carries a retry delay of its own. It must not
        // arm the cool-down gate, or Retry would hold with the wrong reason.
        let limited = TurnFailure(code: "caller_rate_limit", detail: "", retryAfterMs: 4000)
        #expect(limited.retryAfterSeconds == 4)
        #expect(limited.coolDownSeconds == nil)
        #expect(limited.reason == "The router is rate limiting. Wait a moment and send again.")

        // A garbled delay never holds Retry for years.
        #expect(TurnFailure(code: "circuit_open", detail: "", retryAfterMs: Int.max / 4).retryAfterSeconds == 86_400)
    }

    @Test func aConcurrencyRefusalNeverReadsAsTheDailyLimit() {
        let full = TurnFailure(code: "global_concurrency_limit", detail: "")
        #expect(full.reason == "Too many turns are running at once. Try again in a moment.")
        for code in ["caller_budget_exhausted", "global_budget_exhausted"] {
            #expect(TurnFailure(code: code, detail: "").reason
                == "The daily token limit is used up. Raise it in Settings, under Usage.")
        }
    }

    @Test func providerLimitsSayWhatRanOut() {
        let resets = Date().addingTimeInterval(3600)
        let used = TurnFailure(code: "upstream_usage_limit", detail: "", resetsAt: resets)
        #expect(used.reason?.hasPrefix("Your plan's usage limit for this model is used up. It resets at ") == true)
        #expect(used.reason?.hasSuffix("Pick another model to keep going.") == true)
        #expect(TurnFailure(code: "upstream_usage_limit", detail: "").reason
            == "Your plan's usage limit for this model is used up. Pick another model to keep going.")
        // A reset already past (a failure reopened days later) names no time.
        let past = Date().addingTimeInterval(-86_400)
        #expect(TurnFailure(code: "upstream_usage_limit", detail: "", resetsAt: past).reason
            == "Your plan's usage limit for this model is used up. Pick another model to keep going.")
        #expect(TurnFailure(code: "upstream_chatgpt_usage_limit", detail: "").reason
            == "You've reached the ChatGPT plan limit for Useful Bot. Manage usage at chatgpt.com/settings/usage, or pick another model.")
        #expect(TurnFailure(code: "upstream_unavailable", detail: "").reason
            == "Couldn't reach ChatGPT just now. Send again in a moment.")
        #expect(TurnFailure(code: "upstream_chatgpt_not_permitted", detail: "").reason
            == "ChatGPT didn't allow this request from Useful Bot. Check Useful Bot in ChatGPT settings, or pick another model.")
        #expect(TurnFailure(code: "upstream_chatgpt_model_not_in_plan", detail: "").reason
            == "Your ChatGPT plan can't use this model in Useful Bot. Pick another model.")
        #expect(TurnFailure(code: "upstream_chatgpt_not_eligible", detail: "").reason
            == "This ChatGPT account can't use its plan in Useful Bot. Pick another model.")
        #expect(TurnFailure(code: "upstream_usage_not_included", detail: "").reason
            == "Your plan doesn't include this model. Pick another model.")
        #expect(TurnFailure(code: "upstream_quota_exhausted", detail: "").reason
            == "The provider account is out of credit or over its spend limit. Top it up, or pick another model.")
        #expect(TurnFailure(code: "upstream_rate_limited", detail: "").reason
            == "The model provider is rate limiting. Wait a minute and send again.")
    }

    @Test func providerRefusalsNameWhatTheProviderSaid() {
        let refused = TurnFailure(code: "upstream_protocol_error", detail: "upstream_protocol_error (400 invalid_request_error)")
        #expect(refused.reason
            == "The model provider refused the request (400 invalid_request_error). Send again, or pick another model.")
        // A 5xx is the provider not answering.
        #expect(TurnFailure(code: "upstream_protocol_error", detail: "upstream_protocol_error (502)").reason
            == "The model provider did not answer. Check its status or your usage limit, then send again.")
        #expect(TurnFailure(code: "upstream_timeout", detail: "").reason
            == "The model provider did not answer. Check its status or your usage limit, then send again.")
    }

    @Test func theEnginesOwnCodesHaveCopy() {
        #expect(TurnFailure(code: "interrupted", detail: "").reason
            == "Useful Bot stopped before this reply was finished. Retry picks it up from your message.")
        #expect(TurnFailure(code: "unreadable", detail: "").reason == "This chat's file couldn't be read.")
        #expect(TurnFailure(code: "engine_error", detail: "boom").reason
            == "Something went wrong while the bot was working. Retry, or send a new message.")
        // A code this build does not know still reads as a failure.
        #expect(TurnFailure(code: "refused", detail: "").reason == nil)
        #expect(TurnFailure(code: "refused", detail: "").message == "The turn failed.")
        // Wording for failures the engine cannot have is gone.
        #expect(TurnFailure(code: "session_busy", detail: "").reason == nil)
        #expect(TurnFailure(code: "messages_count", detail: "").reason == nil)
    }

    @Test func routeAndSelectionRefusalsKeepTheirSentences() {
        let retired = TurnFailure(
            code: "provider_route_retired",
            detail: "provider_route_retired: Anthropic no longer allows this route."
        )
        #expect(retired.reason == "Anthropic no longer allows this route.")
        #expect(TurnFailure(code: "provider_route_retired", detail: "").reason
            == "Useful Bot can't use this provider connection any more. Pick another model.")
        #expect(TurnFailure(code: "model_selection_unavailable", detail: "").reason
            == TurnFailure.modelSelectionUnavailableCopy)
    }

    @Test func resetTimesReadAsAClockTime() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Europe/Berlin")!
        let now = Date(timeIntervalSince1970: 1_790_150_000) // Wed 23 Sep 2026, 09:53 Berlin
        #expect(TurnFailure.resetCopy(now.addingTimeInterval(3600), now: now, calendar: calendar) == "10:53")
        #expect(TurnFailure.resetCopy(now.addingTimeInterval(86_400), now: now, calendar: calendar) == "Thu 09:53")
    }
}

@Suite struct TurnActivityTests {
    @Test func theEnginesLabelWinsAndTheToolTableBacksItUp() {
        #expect(TurnActivity.tool("bash", detail: "Running a command").label == "Running a command")
        #expect(TurnActivity.tool("bash").label == "Running a command")
        #expect(TurnActivity.tool("web_search").label == "Searching the web")
        #expect(TurnActivity.thinking.label == "Thinking")
        #expect(TurnActivity.compacting.label == "Compacting the conversation")
        #expect(TurnActivity.retrying.label == "Trying again")
    }

    @Test func everyDeclaredToolHasAnEnglishLabel() {
        let tools = [
            "bash", "read_file", "write_file", "list_dir", "web_search", "web_fetch", "memory", "routine", "apps",
            "connect_server", "find_tools", "generate_image", "install_cli", "todo", "ask", "load_skill",
        ]
        for tool in tools {
            let label = TurnActivity.toolLabel(tool)
            #expect(!label.hasPrefix("Using ") || tool == "apps" || tool == "memory", "\(tool) reads as \(label)")
            #expect(!label.contains("_"))
        }
    }

    @Test func aConnectedServersToolReadsAsTheConnection() {
        #expect(TurnActivity.toolLabel("excalidraw__create_view") == "Using Excalidraw")
        #expect(TurnActivity.toolLabel("my-server__list_items") == "Using My server")
        #expect(TurnActivity.toolLabel("") == "Working")
    }

    @Test func onlyBashRunsACommand() {
        #expect(TurnActivity.tool("bash", detail: "Running a command").runsCommand)
        #expect(!TurnActivity.tool("install_cli").runsCommand)
        #expect(!TurnActivity.thinking.runsCommand)
    }

    @Test func aWireActivityBecomesTheCase() {
        #expect(TurnActivity(kind: "thinking", tool: nil, detail: nil) == .thinking)
        #expect(TurnActivity(kind: "tool", tool: "bash", detail: "Running a command") == .tool("bash", detail: "Running a command"))
        #expect(TurnActivity(kind: "compacting", tool: nil, detail: nil) == .compacting)
        #expect(TurnActivity(kind: "retrying", tool: nil, detail: nil) == .retrying)
        #expect(TurnActivity(kind: "something new", tool: nil, detail: nil) == .thinking)
    }
}
