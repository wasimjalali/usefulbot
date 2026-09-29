import Foundation
import Testing
@testable import UsefulBotCore

@Suite struct DesignTokensTests {
    @Test func coreCanvasTokensMatchGlobalsCSS() {
        #expect(DesignTokens.Hex.canvas == "#F3F3F3")
        #expect(DesignTokens.Hex.rail == "#F3F3F3")
        #expect(DesignTokens.Hex.surface == "#FFFFFF")
        #expect(DesignTokens.Hex.sunken == "#F0F0F0")
        #expect(DesignTokens.Hex.ink == "#171717")
        #expect(DesignTokens.Hex.inkMuted == "#5C5C5C")
        #expect(DesignTokens.Hex.inkFaint == "#A3A3A3")
        #expect(DesignTokens.Hex.border == "#EBEBEB")
        #expect(DesignTokens.Hex.borderStrong == "#E0E0E0")
        #expect(DesignTokens.Hex.warning == "#8A5300")
        #expect(DesignTokens.Hex.warningSoft == "#FBF1DE")
        #expect(DesignTokens.Hex.danger == "#B23C22")
        #expect(DesignTokens.Hex.dangerSoft == "#FBEAE5")
    }

    @Test func layoutTokensMatchTheWebShell() {
        #expect(DesignTokens.Space.railWidth == 248)
        #expect(DesignTokens.Space.settingsPaneWidth == 320)
        #expect(DesignTokens.Space.chatColumnMax == 768)
        #expect(DesignTokens.Space.chatHead == 52)
        #expect(DesignTokens.Space.botRow == 36)
        #expect(DesignTokens.Radius.stage == 24)
        #expect(DesignTokens.Radius.field == 14)
        #expect(DesignTokens.Control.switchWidth == 36)
        #expect(DesignTokens.Control.switchHeight == 22)
        #expect(DesignTokens.Control.switchKnob == 16)
        #expect(DesignTokens.Control.switchTravel == 14)
    }

    @Test func typeScaleMatchesTheWebShell() {
        #expect(DesignTokens.FontSize.chatName == 15)
        #expect(DesignTokens.FontSize.chatBody == 15)
        #expect(DesignTokens.FontSize.railName == 13)
        #expect(DesignTokens.FontSize.railPreview == 11)
        #expect(DesignTokens.FontSize.sectionHead == 11)
        #expect(DesignTokens.FontSize.proposalTitle == 11)
        #expect(DesignTokens.FontSize.memoryNote == 13)
    }

    @Test func hexParsesToNormalizedComponents() throws {
        let white = try #require(RGBColor(hex: DesignTokens.Hex.surface))
        #expect(white.red == 1)
        #expect(white.green == 1)
        #expect(white.blue == 1)
        let ink = try #require(RGBColor(hex: DesignTokens.Hex.ink))
        #expect(abs(ink.red - 23.0 / 255) < 0.0001)
        #expect(RGBColor(hex: "17171") == nil)
        #expect(RGBColor(hex: "zzzzzz") == nil)
    }

    @Test func cssWeightsMapOntoTheSemiboldLadder() {
        #expect(FontWeightToken(css: 400) == .regular)
        #expect(FontWeightToken(css: 500) == .medium)
        #expect(FontWeightToken(css: 550) == .semibold)
        #expect(FontWeightToken(css: 600) == .semibold)
        #expect(FontWeightToken(css: 700) == .bold)
    }
}
