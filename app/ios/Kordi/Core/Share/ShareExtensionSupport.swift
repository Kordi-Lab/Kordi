import Foundation
@preconcurrency import Security
@preconcurrency import UIKit
@preconcurrency import UniformTypeIdentifiers

enum SharePayload: Equatable, Sendable {
    private static let maximumByteCount = 16 * 1024

    case url(URL)
    case text(String)

    var messageBody: String {
        switch self {
        case let .url(url): url.absoluteString
        case let .text(text): text
        }
    }

    var displayText: String { messageBody }

    static func normalizedURL(_ value: String) -> SharePayload? {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.utf8.count <= maximumByteCount,
              let components = URLComponents(string: trimmed),
              let scheme = components.scheme?.lowercased(),
              scheme == "http" || scheme == "https",
              components.host?.isEmpty == false,
              components.user == nil,
              components.password == nil,
              let url = URL(string: trimmed) else { return nil }
        return .url(url)
    }

    static func normalizedText(_ value: String) -> SharePayload? {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed.utf8.count <= maximumByteCount else { return nil }
        return normalizedURL(trimmed) ?? .text(trimmed)
    }

    func body(with note: String) -> String {
        let note = note.trimmingCharacters(in: .whitespacesAndNewlines)
        return note.isEmpty ? messageBody : "\(note)\n\n\(messageBody)"
    }
}

enum SharePayloadError: LocalizedError {
    case unsupported

    var errorDescription: String? {
        "Kordi can share one web link or plain-text item at a time."
    }
}

enum SharePayloadLoader {
    private struct LoadedItem: @unchecked Sendable {
        // NSItemProvider completes production before this value crosses the
        // continuation, and Kordi only reads immutable URL/text representations.
        let value: NSSecureCoding?
    }

    static func load(from context: NSExtensionContext) async throws -> SharePayload {
        let providers = context.inputItems
            .compactMap { $0 as? NSExtensionItem }
            .flatMap { $0.attachments ?? [] }

        return try await load(from: providers)
    }

    static func load(from providers: [NSItemProvider]) async throws -> SharePayload {
        if let provider = providers.first(where: {
            $0.hasItemConformingToTypeIdentifier(UTType.url.identifier)
        }), let payload = await loadURL(from: provider) {
            return payload
        }
        if let provider = providers.first(where: {
            $0.hasItemConformingToTypeIdentifier(UTType.plainText.identifier)
        }), let payload = await loadText(from: provider) {
            return payload
        }
        throw SharePayloadError.unsupported
    }

    private static func loadURL(from provider: NSItemProvider) async -> SharePayload? {
        let item = await loadItem(from: provider, typeIdentifier: UTType.url.identifier).value
        if let url = item as? URL { return SharePayload.normalizedURL(url.absoluteString) }
        if let url = item as? NSURL { return SharePayload.normalizedURL(url.absoluteString ?? "") }
        if let value = item as? String { return SharePayload.normalizedURL(value) }
        if let data = item as? Data,
           let value = String(data: data, encoding: .utf8) {
            return SharePayload.normalizedURL(value)
        }
        return nil
    }

    private static func loadText(from provider: NSItemProvider) async -> SharePayload? {
        let item = await loadItem(from: provider, typeIdentifier: UTType.plainText.identifier).value
        if let value = item as? String { return SharePayload.normalizedText(value) }
        if let value = item as? NSString { return SharePayload.normalizedText(value as String) }
        if let data = item as? Data,
           let value = String(data: data, encoding: .utf8) {
            return SharePayload.normalizedText(value)
        }
        return nil
    }

    private static func loadItem(
        from provider: NSItemProvider,
        typeIdentifier: String
    ) async -> LoadedItem {
        await withCheckedContinuation { continuation in
            provider.loadItem(forTypeIdentifier: typeIdentifier, options: nil) { item, _ in
                continuation.resume(returning: LoadedItem(value: item))
            }
        }
    }
}

struct ShareConversation: Identifiable, Hashable, Sendable {
    let id: String
    let title: String
    let subtitle: String
    let kind: String
    let updatedAt: Date
}

func filteredShareConversations(
    _ conversations: [ShareConversation],
    query: String
) -> [ShareConversation] {
    let query = query.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !query.isEmpty else { return conversations }
    return conversations.filter {
        $0.title.localizedCaseInsensitiveContains(query)
            || $0.subtitle.localizedCaseInsensitiveContains(query)
    }
}

struct ShareSendAttemptIDs {
    private var values: [String: UUID] = [:]

    mutating func id(for conversationID: String) -> UUID {
        if let existing = values[conversationID] { return existing }
        let id = UUID()
        values[conversationID] = id
        return id
    }
}

func shareExtensionDate(_ value: String) -> Date? {
    let fractional = ISO8601DateFormatter()
    fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return fractional.date(from: value) ?? ISO8601DateFormatter().date(from: value)
}

struct KordiShareConfiguration: Equatable, Sendable {
    let baseURL: URL
    let appGroupIdentifier: String
    let credentialService: String
    let hostAppURLScheme: String

    static func current(bundle: Bundle = .main) throws -> KordiShareConfiguration {
        try configured(infoDictionary: bundle.infoDictionary ?? [:])
    }

    static func configured(infoDictionary info: [String: Any]) throws -> KordiShareConfiguration {
        let baseURLValue = try setting("KordiCloudBaseURL", in: info)
        let appGroup = try setting("KordiShareAppGroup", in: info)
        let service = try setting("KordiShareCredentialService", in: info)
        let scheme = try setting("KordiHostAppURLScheme", in: info)
        let channel = try setting("KordiDistributionChannel", in: info)
        guard let baseURL = URL(string: baseURLValue),
              validEnvironment(
                channel: channel,
                baseURL: baseURL,
                appGroup: appGroup,
                service: service,
                scheme: scheme
              ) else {
            throw ShareExtensionCredentialError.invalidConfiguration
        }
        return KordiShareConfiguration(
            baseURL: baseURL,
            appGroupIdentifier: appGroup,
            credentialService: service,
            hostAppURLScheme: scheme
        )
    }

    var hostAppURL: URL? { URL(string: "\(hostAppURLScheme)://share") }

    private static func validEnvironment(
        channel: String,
        baseURL: URL,
        appGroup: String,
        service: String,
        scheme: String
    ) -> Bool {
        let hasNoExtraURLComponents = (baseURL.path.isEmpty || baseURL.path == "/")
            && baseURL.user == nil
            && baseURL.password == nil
            && baseURL.query == nil
            && baseURL.fragment == nil
        switch channel {
        case "production":
            return baseURL.scheme?.lowercased() == "https"
                && baseURL.host?.lowercased() == "kordi.ai"
                && baseURL.port == nil
                && hasNoExtraURLComponents
                && appGroup == "group.ai.kordi.share"
                && service == "ai.kordi.share-session"
                && scheme == "kordi"
        case "beta":
            #if BETA
            return baseURL.scheme?.lowercased() == "http"
                && baseURL.host?.lowercased() == "127.0.0.1"
                && baseURL.port != nil
                && hasNoExtraURLComponents
                && appGroup == "group.ai.kordi.beta.share"
                && service == "ai.kordi.beta.share-session"
                && scheme == "kordi-beta"
            #else
            return false
            #endif
        default:
            return false
        }
    }

    private static func setting(_ key: String, in dictionary: [String: Any]) throws -> String {
        guard let value = dictionary[key] as? String else {
            throw ShareExtensionCredentialError.invalidConfiguration
        }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !trimmed.contains("$(") else {
            throw ShareExtensionCredentialError.invalidConfiguration
        }
        return trimmed
    }
}

struct ShareExtensionCredential: Codable, Equatable, Sendable {
    let token: String
    let accountID: String
    let expiresAt: String?

    var isExpired: Bool {
        guard let expiresAt else { return false }
        guard let date = shareExtensionDate(expiresAt) else { return true }
        return date <= Date()
    }
}

struct ShareExtensionCredentialStore {
    private let configuration: KordiShareConfiguration?
    private let account = "share-extension-session"

    init(configuration: KordiShareConfiguration? = try? .current()) {
        self.configuration = configuration
    }

    func load() throws -> ShareExtensionCredential? {
        guard let configuration else { throw ShareExtensionCredentialError.invalidConfiguration }
        var query = baseQuery(configuration: configuration)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess,
              let data = result as? Data,
              let credential = try? JSONDecoder().decode(ShareExtensionCredential.self, from: data)
        else { throw ShareExtensionCredentialError.keychain(status) }
        return credential
    }

    func save(_ credential: ShareExtensionCredential) throws {
        guard let configuration else { throw ShareExtensionCredentialError.invalidConfiguration }
        let data = try JSONEncoder().encode(credential)
        try? delete()
        var query = baseQuery(configuration: configuration)
        query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        query[kSecValueData as String] = data
        let status = SecItemAdd(query as CFDictionary, nil)
        guard status == errSecSuccess else { throw ShareExtensionCredentialError.keychain(status) }
    }

    func delete() throws {
        guard let configuration else { throw ShareExtensionCredentialError.invalidConfiguration }
        let status = SecItemDelete(baseQuery(configuration: configuration) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw ShareExtensionCredentialError.keychain(status)
        }
    }

    private func baseQuery(configuration: KordiShareConfiguration) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: configuration.credentialService,
            kSecAttrAccount as String: account,
            kSecAttrAccessGroup as String: configuration.appGroupIdentifier
        ]
    }
}

enum ShareExtensionCredentialError: LocalizedError {
    case invalidConfiguration
    case keychain(OSStatus)

    var errorDescription: String? {
        switch self {
        case .invalidConfiguration:
            "Kordi sharing is not configured for this build."
        case .keychain:
            "Kordi could not read the shared session securely."
        }
    }
}
