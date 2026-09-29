import Foundation
import Testing
@testable import UsefulBotCore

@Suite struct LiveWidgetTests {
    private func line(_ json: String) throws -> EveEvent {
        try #require(EveStream.parseLine(json))
    }

    private let requested = """
    {"type":"actions.requested","data":{"actions":[{"callId":"call_00_dYLmxRXOghZw1140","input":{"elements":"[]"},"kind":"tool-call","toolName":"excalidraw__create_view"}],"turnId":"turn_0"}}
    """

    @Test func aValidatedCallIsOneDrawingKeyedByItsCallId() throws {
        var projection = StreamProjection()
        projection.apply(try line(requested))
        // A replay delivers the same call again.
        projection.apply(try line(requested))
        #expect(projection.widgets.count == 1)
        #expect(projection.widgets[0].id == "call_00_dYLmxRXOghZw1140")
        #expect(projection.widgets[0].connectionId == "excalidraw")
        #expect(projection.widgets[0].arguments["elements"]?.stringValue == "[]")
    }

    @Test func inputChunksAndResultsMakeNoDrawing() throws {
        var projection = StreamProjection()
        for chunk in ["{", "elements", ":"] {
            projection.apply(try line("""
            {"type":"action.input.appended","data":{"callId":"call_00_dYLmxRXOghZw1140","inputTextDelta":"\(chunk)","toolName":"excalidraw__create_view","turnId":"turn_0"}}
            """))
        }
        projection.apply(try line("""
        {"type":"action.result","data":{"result":{"callId":"call_00_dYLmxRXOghZw1140","kind":"tool-result","output":{},"toolName":"excalidraw__create_view"},"status":"completed","turnId":"turn_0"}}
        """))
        #expect(projection.widgets.isEmpty)
    }

    @Test func otherToolsAndUnkeyedCallsAreSkipped() throws {
        let widgets = EveStream.parseLiveWidgets(try JSONDecoder().decode(JSONValue.self, from: Data("""
        {"actions":[
          {"callId":"call_01_abcdefgh","input":{},"toolName":"excalidraw__read_me"},
          {"callId":"call_02_abcdefgh","input":{"command":"ls"},"toolName":"bash"},
          {"callId":"short","input":{"elements":"[]"},"toolName":"excalidraw__create_view"}
        ]}
        """.utf8)))
        #expect(widgets.isEmpty)
    }
}
