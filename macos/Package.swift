// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "UsefulBot",
    platforms: [.macOS(.v14), .iOS(.v17)],
    products: [
        // Explicit so the iOS Xcode project can link it; implicit products do
        // not resolve outside SwiftPM.
        .library(name: "UsefulBotCore", targets: ["UsefulBotCore"]),
    ],
    dependencies: [
        // In-app updates for release builds (see build-app.sh and scripts/release-mac.mjs).
        .package(url: "https://github.com/sparkle-project/Sparkle", exact: "2.10.0"),
    ],
    targets: [
        .target(name: "UsefulBotCore"),
        .executableTarget(
            name: "UsefulBotApp",
            dependencies: [
                "UsefulBotCore",
                .product(name: "Sparkle", package: "Sparkle", condition: .when(platforms: [.macOS])),
            ],
            // Sparkle.framework ships in Contents/Frameworks.
            linkerSettings: [.unsafeFlags(["-Xlinker", "-rpath", "-Xlinker", "@executable_path/../Frameworks"])]
        ),
        .testTarget(name: "UsefulBotCoreTests", dependencies: ["UsefulBotCore"]),
    ]
)
