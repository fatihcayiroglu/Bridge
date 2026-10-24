// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "BridgeLocalFirstCrypto",
    platforms: [.iOS(.v15)],
    products: [.library(name: "BridgeLocalFirstCrypto", targets: ["BridgeLocalFirstCryptoPlugin"])],
    dependencies: [.package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", from: "8.0.0")],
    targets: [.target(
        name: "BridgeLocalFirstCryptoPlugin",
        dependencies: [.product(name: "Capacitor", package: "capacitor-swift-pm"), .product(name: "Cordova", package: "capacitor-swift-pm")],
        path: "ios/Sources/BridgeLocalFirstCryptoPlugin",
        linkerSettings: [.linkedFramework("Security"), .linkedFramework("CryptoKit")]
    )]
)
