import UIKit
import XCTest
@testable import Kordi

final class AvatarIdentityTests: XCTestCase {
    func testKordiSupportUsesTheOfficialSupportIdentityFallback() {
        XCTAssertTrue(KordiSupportIdentity.matches(name: "Kordi Support", seed: nil))
        XCTAssertTrue(KordiSupportIdentity.matches(name: nil, seed: "acct_kordi_support"))
        XCTAssertTrue(KordiSupportIdentity.matches(name: nil, seed: "cloud_agent_kordi_support"))
        XCTAssertFalse(KordiSupportIdentity.matches(name: "Zimu", seed: "acct_zimu"))
    }

    func testAcceptsRealCloudImageSourcesWithoutConvertingThemToInitials() async throws {
        let remote = "https://lh3.googleusercontent.com/a/example=s96-c"
        XCTAssertEqual(AvatarImageLoader.normalizedSource(remote), remote)

        let png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
        XCTAssertEqual(AvatarImageLoader.normalizedSource(png), png)
        XCTAssertNotNil(try XCTUnwrap(AvatarImageLoader.dataFromImageURL(png)))
        let loadedImage = await AvatarImageLoader.image(from: png)
        XCTAssertNotNil(loadedImage)

        XCTAssertNil(AvatarImageLoader.normalizedSource("kordi-pixel-avatar://legacy-seed"))
        XCTAssertNil(AvatarImageLoader.normalizedSource("file:///private/avatar.png"))
    }

    func testAgentIdenticonMatchesTheMacDesktopGenerator() {
        let parts = AgentIdenticonGenerator.parts(seed: "cloud_agent_research")

        XCTAssertEqual(parts.paletteIndex, 0)
        XCTAssertEqual(parts.cells.count, 15)
        XCTAssertEqual(parts.cells[0].x, 0)
        XCTAssertEqual(parts.cells[0].y, 0)
        XCTAssertFalse(parts.cells[0].accent)
        XCTAssertEqual(parts.cells[0].opacity, 0.88462171, accuracy: 0.00000001)
        XCTAssertEqual(parts.cells[1].x, 4)
        XCTAssertEqual(parts.cells.last?.x, 2)
        XCTAssertEqual(parts.cells.last?.y, 4)
        XCTAssertEqual(parts.cells.last?.opacity ?? 0, 0.93623877, accuracy: 0.00000001)
    }

    func testDirectConversationKeepsTheExactProfileImageSource() {
        let avatar = "https://lh3.googleusercontent.com/a/example=s96-c"
        let account = CloudAccount(
            accountId: "acct_me",
            kordiId: "123456789",
            displayName: "Me",
            primaryEmail: "me@example.com",
            avatarUrl: nil,
            nodeId: nil,
            passwordSet: true
        )
        let contact = CloudContact(
            accountId: "acct_peer",
            kordiId: "987654321",
            displayName: "Peer",
            avatarUrl: avatar,
            nodeId: nil,
            createdAt: "2026-08-08T00:00:00Z"
        )

        let catalog = CloudConversationCatalog.build(
            account: account,
            contacts: [contact],
            ownedAgents: [],
            sharedAgents: [],
            messagesByPeer: [:]
        )

        XCTAssertEqual(catalog.first { $0.kind == .person }?.avatarSource, avatar)
    }
}
