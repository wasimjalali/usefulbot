import Foundation
import Testing
@testable import UsefulBotCore

private let epoch = "e7a1c0de-0000-4000-8000-000000000001"

@Suite struct LiveWidgetTests {
    private func loaded() -> ChatProjection {
        var projection = ChatProjection()
        projection.load(RowsPage(rows: [], tailSeq: 0, epoch: epoch))
        return projection
    }

    private func call(_ seq: Int, callId: String, name: String, widget: String? = nil) -> ChatEvent {
        let tail = widget.map { #","widget":\#($0)"# } ?? ""
        return ChatEvent.parse(line: #"{"seq":\#(seq),"epoch":"\#(epoch)","chatId":"c","turnId":"t1","type":"tool.call","callId":"\#(callId)","name":"\#(name)"\#(tail)}"#)!
    }

    private let drawing = #"{"connectionId":"excalidraw","toolName":"create_view","arguments":{"elements":"[]"}}"#

    @Test func aDrawingCallIsOneDrawingKeyedByItsCallId() {
        var projection = loaded()
        projection.apply(call(1, callId: "call_00_dYLmxRXOghZw1140", name: "excalidraw__create_view", widget: drawing))
        // The same call again (a reconnect's overlap) is the same drawing.
        projection.apply(call(1, callId: "call_00_dYLmxRXOghZw1140", name: "excalidraw__create_view", widget: drawing))
        #expect(projection.widgets.count == 1)
        let widget = projection.widgets[0]
        #expect(widget.id == "call_00_dYLmxRXOghZw1140")
        #expect(widget.connectionId == "excalidraw")
        #expect(widget.arguments["elements"]?.stringValue == "[]")
        // The server reads the name qualified with its connection.
        #expect(widget.toolName == "create_view")
        #expect(widget.qualifiedToolName == "excalidraw__create_view")
    }

    @Test func aCallWithoutADrawingMakesNone() {
        var projection = loaded()
        projection.apply(call(1, callId: "call_01_abcdefgh", name: "bash"))
        #expect(projection.widgets.isEmpty)
    }

    @Test func aCallWithTooShortAnIdIsSkipped() {
        var projection = loaded()
        projection.apply(call(1, callId: "short", name: "excalidraw__create_view", widget: drawing))
        #expect(projection.widgets.isEmpty)
    }

    @Test func theIdIsCleanedAndClippedTheWayTheServerReadsIt() {
        var projection = loaded()
        let long = String(repeating: "a", count: 100)
        projection.apply(call(1, callId: "call.01/abcdefgh!\(long)", name: "excalidraw__create_view", widget: drawing))
        #expect(projection.widgets.first?.id.count == 80)
        #expect(projection.widgets.first?.id.hasPrefix("call01abcdefgh") == true)
    }

    @Test func aQualifiedNameIsLeftAlone() {
        let widget = LiveWidget(id: "x", connectionId: "excalidraw", toolName: "excalidraw__create_view", arguments: [:], callId: "x")
        #expect(widget.qualifiedToolName == "excalidraw__create_view")
    }
}
