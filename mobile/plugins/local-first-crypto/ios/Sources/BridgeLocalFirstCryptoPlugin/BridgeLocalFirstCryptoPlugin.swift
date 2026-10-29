import Foundation
import Capacitor

@objc(BridgeLocalFirstCryptoPlugin)
public class BridgeLocalFirstCryptoPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "BridgeLocalFirstCryptoPlugin"
    public let jsName = "BridgeLocalFirstCrypto"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "hasKey", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "ensureKey", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "encrypt", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "decrypt", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "deleteKey", returnType: CAPPluginReturnPromise)
    ]
    private let queue = DispatchQueue(label: "com.bridge.local-first.crypto", qos: .userInitiated)
    private let vault = LocalFirstCryptoVault(service: (Bundle.main.bundleIdentifier ?? "com.bridge.app") + ".local-first.v1")

    private func perform(_ call: CAPPluginCall, action: @escaping (String) throws -> JSObject) {
        guard let userId = call.getString("userId"), !userId.isEmpty, userId.utf8.count <= 2048 else {
            call.reject("Invalid local encryption request", "LOCAL_CRYPTO_INVALID"); return
        }
        queue.async {
            do {
                let result = try action(userId)
                DispatchQueue.main.async { call.resolve(result) }
            } catch LocalFirstCryptoFailure.keychainFailure(let status) {
                // Numeric Security.framework status only; never a provider
                // description, account alias, key bytes or request payload.
                DispatchQueue.main.async { call.reject("Local encryption unavailable", "LOCAL_CRYPTO_KEYCHAIN", nil, ["status": Int(status)]) }
            } catch {
                // No user identifiers, plaintext, key data or provider errors.
                DispatchQueue.main.async { call.reject("Local encryption unavailable", "LOCAL_CRYPTO_UNAVAILABLE") }
            }
        }
    }

    @objc func hasKey(_ call: CAPPluginCall) {
        perform(call) { userId in ["exists": try self.vault.hasKey(userId)] }
    }

    @objc func ensureKey(_ call: CAPPluginCall) {
        perform(call) { userId in
            try self.vault.ensureKey(userId)
            return ["persistent": true]
        }
    }

    @objc func deleteKey(_ call: CAPPluginCall) {
        perform(call) { userId in try self.vault.deleteKey(userId); return [:] }
    }

    @objc func encrypt(_ call: CAPPluginCall) {
        guard let plaintext = call.getString("plaintext"), let scope = call.getString("scope") else {
            call.reject("Invalid local encryption request", "LOCAL_CRYPTO_INVALID"); return
        }
        perform(call) { userId in
            let value = try self.vault.encrypt(userId: userId, plaintext: plaintext, scope: scope)
            return ["v": value.v, "alg": value.alg, "iv": value.iv, "ct": value.ct]
        }
    }

    @objc func decrypt(_ call: CAPPluginCall) {
        guard let envelope = call.getObject("envelope"), let scope = call.getString("scope"),
              let iv = envelope["iv"] as? String, iv.count <= 16,
              let ct = envelope["ct"] as? String, ct.utf8.count <= ((LocalFirstCryptoVault.maxCiphertextBytes + 2) / 3) * 4 else {
            call.reject("Invalid local encryption request", "LOCAL_CRYPTO_INVALID"); return
        }
        perform(call) { userId in
            // Codable rejects e.g. Boolean version fields rather than coercing.
            let value = try JSONDecoder().decode(LocalFirstCryptoEnvelope.self,
                from: JSONSerialization.data(withJSONObject: envelope))
            return ["plaintext": try self.vault.decrypt(userId: userId, envelope: value, scope: scope)]
        }
    }
}
