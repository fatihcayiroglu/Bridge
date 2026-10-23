import Foundation
import CryptoKit
import Security

enum LocalFirstCryptoFailure: Error {
    case invalidInput
    case keyUnavailable
    case keychainFailure
}

struct LocalFirstCryptoEnvelope: Codable {
    let v: Int
    let alg: String
    let iv: String
    let ct: String
}

// Local at-rest AES-256-GCM, matching the existing WebCrypto v1 envelope. Key
// material never crosses the Capacitor bridge. This is not an E2EE protocol.
final class LocalFirstCryptoVault {
    static let maxCiphertextBytes = 4 * 1024 * 1024
    private let service: String

    init(service: String) { self.service = service }

    private func keyQuery(_ userId: String) throws -> [String: Any] {
        guard !userId.isEmpty, userId.utf8.count <= 2048 else { throw LocalFirstCryptoFailure.invalidInput }
        let account = SHA256.hash(data: Data(userId.utf8)).map { String(format: "%02x", $0) }.joined()
        return [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrSynchronizable as String: false
        ]
    }

    private func existingKey(_ userId: String) throws -> SymmetricKey? {
        var query = try keyQuery(userId)
        query[kSecReturnData as String] = true
        query[kSecReturnAttributes as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess,
              let record = result as? [String: Any],
              let data = record[kSecValueData as String] as? Data,
              data.count == 32 else { throw LocalFirstCryptoFailure.keychainFailure }
        #if os(iOS)
        guard record[kSecAttrAccessible as String] as? String == kSecAttrAccessibleWhenUnlockedThisDeviceOnly as String,
              (record[kSecAttrSynchronizable as String] as? Bool ?? false) == false else {
            throw LocalFirstCryptoFailure.keychainFailure
        }
        #endif
        return SymmetricKey(data: data)
    }

    func hasKey(_ userId: String) throws -> Bool { try existingKey(userId) != nil }

    @discardableResult
    func ensureKey(_ userId: String) throws -> SymmetricKey {
        if let existing = try existingKey(userId) { return existing }
        let candidate = SymmetricKey(size: .bits256)
        var attributes = try keyQuery(userId)
        attributes[kSecValueData as String] = candidate.withUnsafeBytes { Data($0) }
        attributes[kSecAttrLabel as String] = "Bridge local storage key"
        #if os(iOS)
        attributes[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        #endif
        let status = SecItemAdd(attributes as CFDictionary, nil)
        // Another bridge/extension can win between the lookup and atomic Add.
        // Never overwrite it: every writer must use that same canonical key.
        guard status == errSecSuccess || status == errSecDuplicateItem,
              let stored = try existingKey(userId) else { throw LocalFirstCryptoFailure.keychainFailure }
        return stored
    }

    func deleteKey(_ userId: String) throws {
        let status = SecItemDelete(try keyQuery(userId) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw LocalFirstCryptoFailure.keychainFailure }
    }

    private func aad(_ scope: String) throws -> Data {
        let data = Data(("bridge-local-first:v1:" + scope).utf8)
        guard !scope.isEmpty, data.count <= 1024 else { throw LocalFirstCryptoFailure.invalidInput }
        return data
    }

    func encrypt(userId: String, plaintext: String, scope: String) throws -> LocalFirstCryptoEnvelope {
        let bytes = Data(plaintext.utf8)
        guard bytes.count <= Self.maxCiphertextBytes - 16 else { throw LocalFirstCryptoFailure.invalidInput }
        let associated = try aad(scope)
        // Provider initialization is explicit. A stale write after account
        // erasure must not silently recreate the deleted key.
        guard let key = try existingKey(userId) else { throw LocalFirstCryptoFailure.keyUnavailable }
        // CryptoKit generates the fresh 96-bit nonce; no caller can supply one.
        let sealed = try AES.GCM.seal(bytes, using: key, authenticating: associated)
        let iv = sealed.nonce.withUnsafeBytes { Data($0) }
        guard iv.count == 12 else { throw LocalFirstCryptoFailure.invalidInput }
        return LocalFirstCryptoEnvelope(v: 1, alg: "AES-GCM", iv: iv.base64EncodedString(),
            ct: (sealed.ciphertext + sealed.tag).base64EncodedString())
    }

    func decrypt(userId: String, envelope: LocalFirstCryptoEnvelope, scope: String) throws -> String {
        guard envelope.v == 1, envelope.alg == "AES-GCM", envelope.iv.count == 16,
              envelope.ct.utf8.count <= ((Self.maxCiphertextBytes + 2) / 3) * 4,
              let iv = Data(base64Encoded: envelope.iv), iv.count == 12, iv.base64EncodedString() == envelope.iv,
              let ciphertext = Data(base64Encoded: envelope.ct), ciphertext.count >= 16,
              ciphertext.count <= Self.maxCiphertextBytes, ciphertext.base64EncodedString() == envelope.ct else {
            throw LocalFirstCryptoFailure.invalidInput
        }
        let associated = try aad(scope)
        // Reading lost/erased data must not generate a replacement key.
        guard let key = try existingKey(userId) else { throw LocalFirstCryptoFailure.keyUnavailable }
        let sealed = try AES.GCM.SealedBox(nonce: AES.GCM.Nonce(data: iv),
            ciphertext: ciphertext.dropLast(16), tag: ciphertext.suffix(16))
        let plaintext = try AES.GCM.open(sealed, using: key, authenticating: associated)
        guard let string = String(data: plaintext, encoding: .utf8) else { throw LocalFirstCryptoFailure.invalidInput }
        return string
    }
}
