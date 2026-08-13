import Foundation
import CryptoKit
import Security

struct KeychainSessionStore {
    private let service: String
    private let account = "cloud-session-token"
    private let deviceIdentityAccount = "cloud-device-identity-p256"

    init(service: String = KordiAppEnvironment.current.keychainService) {
        self.service = service
    }

    func loadToken() throws -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data, let token = String(data: data, encoding: .utf8) else {
            throw KeychainError(status: status)
        }
        return token
    }

    func saveToken(_ token: String) throws {
        guard let data = token.data(using: .utf8) else { return }
        try? deleteToken()
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
            kSecValueData as String: data
        ]
        let status = SecItemAdd(query as CFDictionary, nil)
        guard status == errSecSuccess else { throw KeychainError(status: status) }
    }

    func deleteToken() throws {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account
        ]
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw KeychainError(status: status)
        }
    }

    /// Returns the stable public identity for this app installation. The P-256
    /// private key is device-only Keychain material and deliberately survives
    /// account sign-out; only its public X9.63 representation leaves the app.
    func loadOrCreateDevicePublicKey() throws -> Data {
        let identityQuery: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: deviceIdentityAccount
        ]
        var loadQuery = identityQuery
        loadQuery.merge([
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]) { _, new in new }
        var result: CFTypeRef?
        let status = SecItemCopyMatching(loadQuery as CFDictionary, &result)
        if status == errSecSuccess,
           let data = result as? Data,
           let privateKey = try? P256.Signing.PrivateKey(rawRepresentation: data) {
            return privateKey.publicKey.x963Representation
        }
        guard status == errSecItemNotFound || status == errSecSuccess else {
            throw KeychainError(status: status)
        }

        let privateKey = P256.Signing.PrivateKey()
        let privateData = privateKey.rawRepresentation
        SecItemDelete(identityQuery as CFDictionary)
        var insert = identityQuery
        insert.merge([
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
            kSecValueData as String: privateData
        ]) { _, new in new }
        let insertStatus = SecItemAdd(insert as CFDictionary, nil)
        guard insertStatus == errSecSuccess else { throw KeychainError(status: insertStatus) }
        return privateKey.publicKey.x963Representation
    }
}

private struct KeychainError: LocalizedError {
    let status: OSStatus
    var errorDescription: String? { "Could not access the secure session store (\(status))." }
}
