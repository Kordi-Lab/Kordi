import Foundation

struct ShareExtensionAPIClient {
    private let baseURL: URL
    private let session: URLSession
    private let decoder = JSONDecoder()
    private let encoder = JSONEncoder()

    init(configuration: KordiShareConfiguration) {
        baseURL = configuration.baseURL
        let sessionConfiguration = URLSessionConfiguration.ephemeral
        sessionConfiguration.timeoutIntervalForRequest = 15
        sessionConfiguration.timeoutIntervalForResource = 30
        session = URLSession(configuration: sessionConfiguration)
    }

    func conversations(credential: ShareExtensionCredential) async throws -> [ShareConversation] {
        let response: BootstrapResponse = try await request(
            path: "v2/chat/sync/bootstrap",
            method: "GET",
            credential: credential
        )
        guard response.protocolVersion == 2 else { throw ShareExtensionAPIError.unsupportedProtocol }
        let latestByConversation = Dictionary(
            response.latestMessages.map { ($0.conversationID, $0.content.body) },
            uniquingKeysWith: { first, _ in first }
        )
        return response.conversations.compactMap { conversation in
            guard ["direct", "group", "ai"].contains(conversation.kind) else { return nil }
            let otherMembers = conversation.members.filter {
                $0.membershipState == "active" && $0.accountID != credential.accountID
            }
            let memberNames = otherMembers.compactMap(\.displayName).filter { !$0.isEmpty }
            let fallbackTitle: String
            switch conversation.kind {
            case "group": fallbackTitle = memberNames.prefix(3).joined(separator: ", ").nonEmpty ?? "Group"
            case "ai": fallbackTitle = "My Kordi"
            default: fallbackTitle = memberNames.first ?? "Conversation"
            }
            let title = conversation.preferences.personalTitle?.nonEmpty
                ?? conversation.sharedTitle?.nonEmpty
                ?? fallbackTitle
            return ShareConversation(
                id: conversation.id,
                title: title,
                subtitle: latestByConversation[conversation.id]?.nonEmpty ?? kindLabel(conversation.kind),
                kind: conversation.kind,
                updatedAt: shareExtensionDate(conversation.updatedAt) ?? .distantPast
            )
        }.sorted {
            $0.updatedAt > $1.updatedAt || ($0.updatedAt == $1.updatedAt && $0.title < $1.title)
        }
    }

    func send(
        body: String,
        to conversationID: String,
        clientMessageID: UUID,
        credential: ShareExtensionCredential
    ) async throws {
        let requestBody = SendMessageRequest(
            clientMessageID: clientMessageID.uuidString.lowercased(),
            kind: "text",
            content: MessageContent(
                schema: 1,
                blocks: [TextBlock(type: "text", text: body)],
                legacyAttachments: []
            ),
            replyToMessageID: nil,
            attachmentIDs: []
        )
        let _: MessageResponse = try await request(
            path: "v2/chat/conversations/\(conversationID)/messages",
            method: "POST",
            credential: credential,
            body: requestBody
        )
    }

    private func request<Response: Decodable>(
        path: String,
        method: String,
        credential: ShareExtensionCredential
    ) async throws -> Response {
        try await request(path: path, method: method, credential: credential, bodyData: nil)
    }

    private func request<Response: Decodable, Body: Encodable>(
        path: String,
        method: String,
        credential: ShareExtensionCredential,
        body: Body
    ) async throws -> Response {
        try await request(
            path: path,
            method: method,
            credential: credential,
            bodyData: try encoder.encode(body)
        )
    }

    private func request<Response: Decodable>(
        path: String,
        method: String,
        credential: ShareExtensionCredential,
        bodyData: Data?
    ) async throws -> Response {
        var request = URLRequest(
            url: endpoint(path),
            timeoutInterval: 15
        )
        request.httpMethod = method
        request.httpBody = bodyData
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("Bearer \(credential.token)", forHTTPHeaderField: "Authorization")
        if bodyData != nil { request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        do {
            let (data, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse else { throw ShareExtensionAPIError.network }
            guard (200..<300).contains(http.statusCode) else {
                if http.statusCode == 401 { throw ShareExtensionAPIError.sessionExpired }
                let server = try? decoder.decode(ServerError.self, from: data)
                throw ShareExtensionAPIError.server(server?.message?.nonEmpty)
            }
            guard let decoded = try? decoder.decode(Response.self, from: data) else {
                throw ShareExtensionAPIError.invalidResponse
            }
            return decoded
        } catch let error as ShareExtensionAPIError {
            throw error
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            throw ShareExtensionAPIError.network
        }
    }

    private func endpoint(_ path: String) -> URL {
        path.split(separator: "/").reduce(baseURL) {
            $0.appendingPathComponent(String($1))
        }
    }

    private func kindLabel(_ kind: String) -> String {
        switch kind {
        case "group": "Group conversation"
        case "ai": "Agent conversation"
        default: "Direct conversation"
        }
    }
}

enum ShareExtensionAPIError: LocalizedError, Equatable {
    case invalidResponse
    case network
    case server(String?)
    case sessionExpired
    case unsupportedProtocol

    var errorDescription: String? {
        switch self {
        case .invalidResponse, .unsupportedProtocol:
            "Kordi returned an unexpected response. Update the app and try again."
        case .network:
            "Kordi is unavailable. Check your connection and try again."
        case let .server(message):
            message ?? "Kordi could not send this item. Try again."
        case .sessionExpired:
            "Your Kordi session expired. Open Kordi and sign in again."
        }
    }
}

private struct BootstrapResponse: Decodable {
    let protocolVersion: Int
    let conversations: [Conversation]
    let latestMessages: [Message]

    enum CodingKeys: String, CodingKey {
        case protocolVersion = "protocol_version"
        case conversations
        case latestMessages = "latest_messages"
    }
}

private struct Conversation: Decodable {
    let id: String
    let kind: String
    let sharedTitle: String?
    let updatedAt: String
    let members: [Member]
    let preferences: Preferences

    enum CodingKeys: String, CodingKey {
        case id, kind, members, preferences
        case sharedTitle = "shared_title"
        case updatedAt = "updated_at"
    }
}

private struct Member: Decodable {
    let accountID: String
    let displayName: String?
    let membershipState: String

    enum CodingKeys: String, CodingKey {
        case accountID = "account_id"
        case displayName = "display_name"
        case membershipState = "membership_state"
    }
}

private struct Preferences: Decodable {
    let personalTitle: String?

    enum CodingKeys: String, CodingKey {
        case personalTitle = "personal_title"
    }
}

private struct Message: Decodable {
    let conversationID: String
    let content: MessageContent

    enum CodingKeys: String, CodingKey {
        case conversationID = "conversation_id"
        case content
    }
}

private struct MessageContent: Codable {
    let schema: Int
    let blocks: [TextBlock]
    let legacyAttachments: [String]

    var body: String { blocks.compactMap(\.text).joined() }

    enum CodingKeys: String, CodingKey {
        case schema, blocks
        case legacyAttachments = "legacy_attachments"
    }
}

private struct TextBlock: Codable {
    let type: String
    let text: String?

    init(type: String, text: String) {
        self.type = type
        self.text = text
    }
}

private struct SendMessageRequest: Encodable {
    let clientMessageID: String
    let kind: String
    let content: MessageContent
    let replyToMessageID: String?
    let attachmentIDs: [String]

    enum CodingKeys: String, CodingKey {
        case clientMessageID = "client_message_id"
        case kind, content
        case replyToMessageID = "reply_to_message_id"
        case attachmentIDs = "attachment_ids"
    }
}

private struct MessageResponse: Decodable {
    let message: Message
}

private struct ServerError: Decodable {
    let message: String?
}

private extension String {
    var nonEmpty: String? {
        let trimmed = trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}
