import Foundation
import CryptoKit
import Security

@main
struct KeyVaultTests {
    static var passed = 0
    static func check(_ name: String, _ body: () throws -> Void) throws {
        try body(); passed += 1; print("PASS " + name)
    }
    static func require(_ value: Bool) throws {
        if !value { throw TestFailure.assertion }
    }
    enum TestFailure: Error { case assertion }
    static func rejectsAuthentication(_ body: () throws -> Void) throws {
        do { try body(); throw TestFailure.assertion }
        catch CryptoKitError.authenticationFailure { return }
    }
    static func rejectsInput(_ body: () throws -> Void) throws {
        do { try body(); throw TestFailure.assertion }
        catch LocalFirstCryptoFailure.invalidInput { return }
    }

    static func main() throws {
        let service = "com.bridge.tests.local-first." + UUID().uuidString
        let vault = LocalFirstCryptoVault(service: service)
        let scope = "user:alice:draft:channel%3Aserver%3Achannel"
        do {
            try check("absent key lookup is read-only") { try require(!vault.hasKey("alice")) }
            try vault.ensureKey("alice")
            let sealed = try vault.encrypt(userId: "alice", plaintext: "private fixture 🔐", scope: scope)
            try check("Keychain survives a new vault instance") {
                let reopened = LocalFirstCryptoVault(service: service)
                try require(reopened.hasKey("alice"))
                try require(reopened.decrypt(userId: "alice", envelope: sealed, scope: scope) == "private fixture 🔐")
            }
            try check("every write gets a fresh nonce") {
                var nonces = Set<String>()
                for _ in 0..<32 { nonces.insert(try vault.encrypt(userId: "alice", plaintext: "fixture", scope: scope).iv) }
                try require(nonces.count == 32)
            }
            try check("record scope tampering is authenticated") {
                try rejectsAuthentication { _ = try vault.decrypt(userId: "alice", envelope: sealed, scope: scope + "-other") }
            }
            try vault.ensureKey("bob")
            try check("another existing account key cannot decrypt") {
                try rejectsAuthentication { _ = try vault.decrypt(userId: "bob", envelope: sealed, scope: scope) }
            }
            try check("ciphertext tampering is authenticated") {
                var bytes = Data(base64Encoded: sealed.ct)!
                bytes[0] ^= 1
                let changed = LocalFirstCryptoEnvelope(v: 1, alg: "AES-GCM", iv: sealed.iv, ct: bytes.base64EncodedString())
                try rejectsAuthentication { _ = try vault.decrypt(userId: "alice", envelope: changed, scope: scope) }
            }
            try check("nonce tampering is authenticated") {
                var bytes = Data(base64Encoded: sealed.iv)!
                bytes[0] ^= 1
                let changed = LocalFirstCryptoEnvelope(v: 1, alg: "AES-GCM", iv: bytes.base64EncodedString(), ct: sealed.ct)
                try rejectsAuthentication { _ = try vault.decrypt(userId: "alice", envelope: changed, scope: scope) }
            }
            try check("invalid version and algorithm fail closed") {
                for value in [LocalFirstCryptoEnvelope(v: 2, alg: "AES-GCM", iv: sealed.iv, ct: sealed.ct),
                              LocalFirstCryptoEnvelope(v: 1, alg: "other", iv: sealed.iv, ct: sealed.ct)] {
                    try rejectsInput { _ = try vault.decrypt(userId: "alice", envelope: value, scope: scope) }
                }
            }
            try check("malformed base64 and nonce lengths fail closed") {
                for value in [LocalFirstCryptoEnvelope(v: 1, alg: "AES-GCM", iv: "AA==", ct: sealed.ct),
                              LocalFirstCryptoEnvelope(v: 1, alg: "AES-GCM", iv: sealed.iv, ct: "not base64")] {
                    try rejectsInput { _ = try vault.decrypt(userId: "alice", envelope: value, scope: scope) }
                }
            }
            try check("scope and payload bounds are enforced") {
                try rejectsInput { _ = try vault.encrypt(userId: "alice", plaintext: "fixture", scope: String(repeating: "x", count: 1025)) }
                try rejectsInput { _ = try vault.encrypt(userId: "alice", plaintext: String(repeating: "x", count: LocalFirstCryptoVault.maxCiphertextBytes), scope: scope) }
                try rejectsInput { _ = try vault.ensureKey("") }
            }
            try vault.deleteKey("alice")
            try check("erasure is idempotent and decrypt never recreates a key") {
                try vault.deleteKey("alice")
                do { _ = try vault.decrypt(userId: "alice", envelope: sealed, scope: scope); throw TestFailure.assertion }
                catch LocalFirstCryptoFailure.keyUnavailable { }
                try require(!vault.hasKey("alice"))
            }
            try check("a stale encrypt cannot recreate an erased key") {
                do { _ = try vault.encrypt(userId: "alice", plaintext: "late fixture", scope: scope); throw TestFailure.assertion }
                catch LocalFirstCryptoFailure.keyUnavailable { }
                try require(!vault.hasKey("alice"))
            }
            try vault.ensureKey("alice")
            try check("a replacement key cannot resurrect erased ciphertext") {
                try rejectsAuthentication { _ = try vault.decrypt(userId: "alice", envelope: sealed, scope: scope) }
            }

            // A public, deterministic test key only. No production key is exported.
            let interop = "interop"
            let alias = SHA256.hash(data: Data(interop.utf8)).map { String(format: "%02x", $0) }.joined()
            let attributes: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
                kSecAttrService as String: service, kSecAttrAccount as String: alias,
                kSecAttrSynchronizable as String: false, kSecValueData as String: Data((0..<32).map { UInt8($0) })]
            try require(SecItemAdd(attributes as CFDictionary, nil) == errSecSuccess)
            let interopScope = "user:interop:draft:channel%3Aserver%3Achannel"
            let vector = LocalFirstCryptoEnvelope(v: 1, alg: "AES-GCM", iv: "AQIDBAUGBwgJCgsM",
                ct: "fsgs99al3KQ4xxszMinIWyoik5vzTTWr1zqVS+7TVLiMcwTQwSAqyapzLd1hDUo5")
            try check("existing WebCrypto envelope decrypts with CryptoKit") {
                try require(vault.decrypt(userId: interop, envelope: vector, scope: interopScope) == "{\"v\":1,\"text\":\"shared envelope\"}")
            }
            if let output = ProcessInfo.processInfo.environment["LOCAL_CRYPTO_VECTOR_PATH"] {
                let generated = try vault.encrypt(userId: interop, plaintext: "{\"v\":1,\"text\":\"shared envelope\"}", scope: interopScope)
                try JSONEncoder().encode(generated).write(to: URL(fileURLWithPath: output))
            } else { throw TestFailure.assertion }
            for user in ["alice", "bob", interop] { try vault.deleteKey(user) }
            try require(passed == 14)
            print("TOTAL pass=\(passed) fail=0 skipped=0 — real CryptoKit and Keychain (macOS)")
        } catch {
            for user in ["alice", "bob", "interop"] { try? vault.deleteKey(user) }
            throw error
        }
    }
}
