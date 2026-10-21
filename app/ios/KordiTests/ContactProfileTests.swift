import SwiftUI
import UIKit
import XCTest
@testable import Kordi

@MainActor
final class ContactProfileTests: XCTestCase {
    // Shape from the issue #1945 contract.
    static let personJSON = #"""
    {
      "accountId": "acct_nadia",
      "kordiId": "482731906",
      "displayName": "Nadia",
      "avatarUrl": null,
      "about": "Robotics PhD. Building a tabletop manipulation lab.",
      "kind": "person",
      "isSelf": false,
      "isContact": true,
      "presence": { "status": "online", "lastSeenAt": "2026-10-20T10:09:00Z" },
      "defaultAgent": { "agentId": "agent_n", "displayName": "Nadia's agent", "avatarUrl": null, "accountId": "acct_nagent" },
      "owner": null,
      "contactSince": "2026-08-12T09:30:00Z",
      "shared": {
        "mediaCount": 24, "linkCount": 9, "documentCount": 3,
        "groups": [ { "groupId": "g1", "title": "Robotics reading group", "avatarUrl": null } ]
      },
      "commonGround": { "workingOn": ["tabletop manipulation"], "canHelp": ["grant writing"], "lookingFor": [] }
    }
    """#

    private let subject = ContactProfileSubject(accountId: "acct_nadia", name: "Nadia", kordiId: "482731906")

    private func decode(_ json: String) throws -> CloudContactProfile {
        try JSONDecoder().decode(CloudContactProfile.self, from: Data(json.utf8))
    }

    func testDecodesTheContractShape() throws {
        let profile = try decode(Self.personJSON)
        XCTAssertEqual(profile.kind, .person)
        XCTAssertEqual(profile.presence?.status, .online)
        XCTAssertEqual(profile.defaultAgent?.accountId, "acct_nagent")
        XCTAssertEqual(profile.shared?.mediaCount, 24)
        XCTAssertEqual(profile.shared?.groups.first?.title, "Robotics reading group")
        XCTAssertEqual(profile.commonGround?.workingOn, ["tabletop manipulation"])
        XCTAssertNil(profile.owner)
    }

    func testDecodesAnAgentAndToleratesMissingParts() throws {
        let profile = try decode(#"""
        {"accountId":"acct_a","kind":"agent","owner":{"accountId":"acct_o","kordiId":"1","displayName":"Nadia","avatarUrl":null},"shared":{"mediaCount":2},"presence":"bogus"}
        """#)
        XCTAssertEqual(profile.kind, .agent)
        XCTAssertEqual(profile.owner?.displayName, "Nadia")
        XCTAssertEqual(profile.shared?.linkCount, 0)
        XCTAssertNil(profile.presence)
    }

    func testToleratesTheServerShapeForAgentsAndGroups() throws {
        let agent = try decode(#"""
        {"accountId":"acct_agent","kordiId":null,"displayName":"Nadia's agent","avatarUrl":null,"about":null,
         "kind":"agent","isSelf":false,"isContact":false,"presence":null,"defaultAgent":null,
         "owner":{"accountId":"acct_o","kordiId":"482731906","displayName":"Nadia","avatarUrl":null},
         "contactSince":null,"shared":{"mediaCount":0,"linkCount":0,"documentCount":0,"groups":[]},"commonGround":null}
        """#)
        XCTAssertNil(agent.kordiId)
        XCTAssertNil(agent.presence)
        XCTAssertEqual(agent.shared?.isEmpty, true)
        let agentView = ContactProfilePresentation(
            subject: ContactProfileSubject(accountId: "acct_agent", name: "Nadia's agent", kind: .agent),
            profile: agent,
            isFallback: false
        )
        XCTAssertFalse(agentView.showsKordiId)
        XCTAssertNil(agentView.commonGround)
        XCTAssertEqual(agentView.statusLine(), "Agent · owned by Nadia")

        let person = try decode(#"""
        {"accountId":"acct_n","kordiId":"482731906","displayName":"Nadia","kind":"person",
         "defaultAgent":{"agentId":"agent_n","displayName":"Kordi","avatarUrl":null,"accountId":"acct_na",
                         "avatar":{"style":"bottts","seed":"agent_n"}},
         "shared":{"mediaCount":1,"linkCount":0,"documentCount":0,"groups":[
           {"groupId":"g1","title":null,"avatarUrl":"kordi-avatar://uploaded/ava_0123456789abcdef0123456789abcdef"},
           {"groupId":"g2","title":"Lab","avatarUrl":null},
           {"title":"broken"}]}}
        """#)
        XCTAssertEqual(person.defaultAgent?.accountId, "acct_na")
        XCTAssertEqual(CloudDefaultAgentProfile.displayName(person.defaultAgent?.displayName, ownerName: "Nadia"), "Nadia's Kordi")
        XCTAssertEqual(person.shared?.groups.map(\.title), ["Group", "Lab"])
        XCTAssertEqual(person.shared?.groups.first?.avatarUrl, "kordi-avatar://uploaded/ava_0123456789abcdef0123456789abcdef")
    }

    func testSupportContactWithNullIdAndPresence() throws {
        let support = try decode(#"""
        {"accountId":"acct_kordi_support","kordiId":null,"displayName":"Kordi Support","kind":"system","presence":null,
         "shared":{"mediaCount":0,"linkCount":0,"documentCount":0,"groups":[]},"commonGround":null}
        """#)
        let view = ContactProfilePresentation(
            subject: ContactProfileSubject(accountId: "acct_kordi_support", name: "Kordi Support", kind: .system),
            profile: support,
            isFallback: false
        )
        XCTAssertEqual(view.statusLine(), "Kordi")
        XCTAssertFalse(view.showsKordiId)
        XCTAssertNil(view.shared)
    }

    func testCapabilityFlagGatesTheRequest() throws {
        let caps = try JSONDecoder().decode(
            CloudAuthCapabilities.self,
            from: Data(#"{"password":true,"oauthProviders":[],"contactProfileVersion":1}"#.utf8)
        )
        XCTAssertEqual(caps.contactProfileVersion, 1)
        XCTAssertTrue(ContactProfileAvailability.isEnabled(caps))
        XCTAssertFalse(ContactProfileAvailability.isEnabled(CloudAuthCapabilities(password: true)))
        XCTAssertFalse(ContactProfileAvailability.isEnabled(nil))
    }

    func testFetchUsesTheProfileRoute() async throws {
        ContactProfileURLProtocol.body = Self.personJSON
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ContactProfileURLProtocol.self]
        let api = CloudAPIClient(baseURL: URL(string: "http://127.0.0.1:17082")!, session: URLSession(configuration: configuration))
        let profile = try await api.fetchContactProfile(token: "session-value", accountId: "acct_nadia")
        XCTAssertEqual(profile.displayName, "Nadia")
        XCTAssertEqual(ContactProfileURLProtocol.lastPath, "GET /v1/cloud/contacts/acct_nadia/profile")
    }

    func testPersonPresentation() throws {
        let presentation = ContactProfilePresentation(subject: subject, profile: try decode(Self.personJSON), isFallback: false, canDelete: true)
        XCTAssertEqual(presentation.tiles, [.message, .mute, .share, .more])
        XCTAssertEqual(presentation.statusLine(), "online")
        XCTAssertEqual(presentation.statusTone, .online)
        XCTAssertEqual(presentation.theirAgent?.displayName, "Nadia's agent")
        XCTAssertNotNil(presentation.contactSince)
        XCTAssertNotNil(presentation.shared)
        XCTAssertNotNil(presentation.commonGround)
        XCTAssertTrue(presentation.showsDelete)
    }

    func testFallbackHidesTheDeleteRowWithoutTheFlag() {
        let presentation = ContactProfilePresentation(subject: subject, profile: nil, isFallback: true)
        XCTAssertTrue(presentation.showsKordiId)
        XCTAssertNil(presentation.about)
        XCTAssertNil(presentation.shared)
        XCTAssertNil(presentation.commonGround)
        XCTAssertNil(presentation.theirAgent)
        XCTAssertTrue(presentation.tiles.contains(.message))
        XCTAssertFalse(presentation.showsDelete)
        XCTAssertTrue(presentation.offersDelete)
        XCTAssertFalse(ContactProfileModel(loader: nil).canDelete)

        var withFlag = presentation
        withFlag.canDelete = true
        XCTAssertTrue(withFlag.showsDelete)
    }

    func testDeleteCallsTheRemoverAndReportsErrors() async throws {
        var calls = 0
        let model = ContactProfileModel(loader: nil, profile: try decode(Self.personJSON)) { calls += 1 }
        XCTAssertTrue(model.canDelete)
        try await model.removeContact()
        XCTAssertEqual(calls, 1)
        XCTAssertFalse(model.isDeleting)

        let failing = ContactProfileModel(loader: nil, profile: nil) {
            throw CloudAPIError(code: "not_found", message: "Not a contact.", statusCode: 404)
        }
        do {
            try await failing.removeContact()
            XCTFail("Expected the server error")
        } catch let error as CloudAPIError {
            XCTAssertEqual(error.statusCode, 404)
        }
    }

    func testRemoveContactUsesTheDeleteRoute() async throws {
        ContactProfileURLProtocol.status = 204
        ContactProfileURLProtocol.body = ""
        defer { ContactProfileURLProtocol.status = 200 }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ContactProfileURLProtocol.self]
        let api = CloudAPIClient(baseURL: URL(string: "http://127.0.0.1:17082")!, session: URLSession(configuration: configuration))
        try await api.removeContact(token: "session-value", accountId: "acct_nadia")
        XCTAssertEqual(ContactProfileURLProtocol.lastPath, "DELETE /v1/cloud/contacts/acct_nadia")
    }

    func testAgentOwnAgentAndSystemPresentations() {
        let owner = CloudContactProfile.Owner(accountId: "acct_me", kordiId: "1", displayName: "Me", avatarUrl: nil)
        let other = CloudContactProfile.Owner(accountId: "acct_nadia", kordiId: "2", displayName: "Nadia", avatarUrl: nil)
        let agentSubject = ContactProfileSubject(accountId: "acct_agent", name: "Agent", kind: .agent)

        let agent = ContactProfilePresentation(
            subject: agentSubject,
            profile: CloudContactProfile(accountId: "acct_agent", kind: .agent, owner: other, shared: .init()),
            isFallback: false,
            selfAccountId: "acct_me"
        )
        XCTAssertEqual(agent.statusLine(), "Agent · owned by Nadia")
        XCTAssertEqual(agent.tiles, [.message, .share, .more])
        XCTAssertEqual(agent.owner?.displayName, "Nadia")
        XCTAssertTrue(agent.showsType)

        let mine = ContactProfilePresentation(
            subject: agentSubject,
            profile: CloudContactProfile(accountId: "acct_agent", kind: .agent, owner: owner, shared: .init(mediaCount: 1)),
            isFallback: false,
            selfAccountId: "acct_me"
        )
        XCTAssertEqual(mine.statusLine(), "Your agent")
        XCTAssertEqual(mine.tiles, [.message, .settings, .more])
        XCTAssertNil(mine.shared)
        XCTAssertNil(mine.owner)
        XCTAssertFalse(mine.offersDelete)

        let system = ContactProfilePresentation(
            subject: ContactProfileSubject(accountId: "acct_support", name: "Kordi Support", kordiId: "100000001", kind: .system),
            profile: nil,
            isFallback: true
        )
        XCTAssertEqual(system.statusLine(), "Kordi")
        XCTAssertEqual(system.tiles, [.message])
        XCTAssertFalse(system.showsKordiId)
        XCTAssertFalse(system.offersDelete)
    }

    func testOfflineStatusAndEmptyShared() {
        let profile = CloudContactProfile(
            accountId: "acct_priya",
            presence: .init(status: .offline, lastSeenAt: nil),
            shared: .init()
        )
        let presentation = ContactProfilePresentation(subject: subject, profile: profile, isFallback: false)
        XCTAssertEqual(presentation.statusLine(), "last seen recently")
        XCTAssertEqual(presentation.statusTone, .muted)
        XCTAssertEqual(presentation.shared?.isEmpty, true)
    }

    func testSubjectFromContactDetectsTheSystemContact() {
        let support = CloudContact(
            accountId: "acct_x", kordiId: "100000001", displayName: "Helper", avatarUrl: nil,
            nodeId: nil, createdAt: "2026-01-01T00:00:00Z", contactKind: "system_agent"
        )
        XCTAssertEqual(ContactProfileSubject(contact: support).kind, .system)
        let person = CloudContact(accountId: "acct_y", kordiId: "123", displayName: "Yuki", avatarUrl: nil, nodeId: nil, createdAt: "")
        XCTAssertEqual(ContactProfileSubject(contact: person).kind, .person)
    }

    func testKordiIdFormatting() {
        XCTAssertEqual(ContactProfilePresentation.formattedKordiId("482731906"), "@482 731 906")
        XCTAssertEqual(ContactProfilePresentation.formattedKordiId("12"), "@12")
    }

    func testModelFallsBackWhenTheRequestFails() async {
        struct Failure: Error {}
        let model = ContactProfileModel { throw Failure() }
        XCTAssertTrue(model.isLoading)
        XCTAssertFalse(model.isFallback)
        await model.load()
        XCTAssertTrue(model.isFallback)
        XCTAssertNil(model.profile)

        let missingFlag = ContactProfileModel(loader: nil)
        XCTAssertTrue(missingFlag.isFallback)
    }

    func testModelFillsTheProfile() async throws {
        let profile = try decode(Self.personJSON)
        let model = ContactProfileModel { profile }
        await model.load()
        XCTAssertEqual(model.profile, profile)
        XCTAssertFalse(model.isFallback)
    }

    /// Renders the sheet in each state and writes PNGs for review.
    func testRendersProfileSheetStates() async throws {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let previous = scene.windows.first(where: \.isKeyWindow)
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 393, height: 1100)
        defer { window.isHidden = true; window.rootViewController = nil; previous?.makeKeyAndVisible() }
        let appModel = AppModel(previewMode: true)
        let maya = ContactProfileSubject(accountId: "acct_maya", name: "Maya Chen", kordiId: "284106395")
        let priya = ContactProfileSubject(accountId: "acct_priya", name: "Priya Shah", kordiId: "650917284")
        let agent = ContactProfileSubject(accountId: "acct_agent", name: "Nadia's agent", kordiId: "482731907", kind: .agent)
        let support = ContactProfileSubject(accountId: KordiSupportIdentity.accountId, name: KordiSupportIdentity.displayName, kind: .system)
        let states: [(String, ContactProfileSubject, CloudContactProfile?)] = [
            ("person-online", maya, ContactProfilePreviewData.profile(for: maya)),
            ("person-new", priya, ContactProfilePreviewData.profile(for: priya)),
            ("agent", agent, ContactProfilePreviewData.profile(for: agent)),
            ("system", support, ContactProfilePreviewData.profile(for: support)),
            ("fallback", maya, nil)
        ]
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("contact-profile-snapshots", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        for style in [UIUserInterfaceStyle.light, .dark] {
            window.overrideUserInterfaceStyle = style
            for (name, subject, profile) in states {
                let sheet = ContactProfileView(
                    subject: subject,
                    profileModel: ContactProfileModel(loader: nil, profile: profile, remover: profile == nil ? nil : {}),
                    onOpenConversation: { _ in }
                )
                .environmentObject(appModel)
                .environmentObject(KordiCallCoordinator())
                let host = UIHostingController(rootView: sheet)
                window.rootViewController = host
                window.makeKeyAndVisible()
                host.view.frame = window.bounds
                host.view.layoutIfNeeded()
                try await Task.sleep(for: .milliseconds(400))
                let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
                    window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
                }
                let file = directory.appendingPathComponent("\(name)-\(style == .dark ? "dark" : "light").png")
                try XCTUnwrap(image.pngData()).write(to: file)
                let attachment = XCTAttachment(image: image)
                attachment.name = file.lastPathComponent
                attachment.lifetime = .keepAlways
                add(attachment)
            }
        }
        print("Contact profile snapshots: \(directory.path)")
    }
}

private final class ContactProfileURLProtocol: URLProtocol {
    static var body = ""
    static var status = 200
    static var lastPath: String?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.lastPath = "\(request.httpMethod ?? "GET") \(request.url?.path ?? "")"
        let response = HTTPURLResponse(url: request.url!, statusCode: Self.status, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(Self.body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}
