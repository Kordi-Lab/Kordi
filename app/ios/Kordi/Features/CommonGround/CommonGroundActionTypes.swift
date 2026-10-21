import Foundation

// Request and response shapes of the person and group actions.

struct CommonGroundMeetInput: Encodable, Hashable {
    var title: String?
    var startAt: String
    var endAt: String?
    var location: String?
}

struct CommonGroundCreatedGroup: Decodable, Hashable {
    let group: CommonGroundGroup
    let added: [CommonGroundPerson]
    let invited: [CommonGroundPerson]
}

struct CommonGroundJoinedGroup: Decodable, Hashable {
    let status: String?
    let groupSpaceId: String
    let conversationId: String?
    let name: String?
}

struct CommonGroundRelationshipResponse: Decodable, Hashable { let relationship: CommonGroundRelationship }

struct CommonGroundChatResponse: Decodable, Hashable {
    let conversationId: String
    let sessionId: String?
    let relationship: CommonGroundRelationship?
}

struct CommonGroundMeetResponse: Decodable, Hashable {
    let conversationId: String
    let planCardId: String?
    let relationship: CommonGroundRelationship?
}
