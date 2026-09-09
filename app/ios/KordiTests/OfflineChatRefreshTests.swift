import XCTest
import Foundation
@testable import Kordi

final class OfflineChatRefreshTests: XCTestCase {
    @MainActor
    func testPullToRefreshKeepsOfflineConversationsAndDoesNotContactCloud() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [RejectPreviewNetwork.self]
        let session = URLSession(configuration: configuration)
        defer { session.invalidateAndCancel() }
        let api = CloudAPIClient(baseURL: URL(string: "http://127.0.0.1:17081")!, session: session)
        let model = AppModel(api: api, previewMode: true, previewLaunchFlow: false)
        let conversations = model.conversations.map(\.id)
        await model.refreshWorkspace()
        XCTAssertEqual(model.conversations.map(\.id), conversations)
        XCTAssertEqual(model.cloudConnectionState, .connected)
        XCTAssertEqual(model.messageSyncState, .upToDate)
        XCTAssertNil(model.errorMessage)
    }
}

private final class RejectPreviewNetwork: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        XCTFail("Offline chat refresh must not issue an HTTP request")
        client?.urlProtocol(self, didFailWithError: URLError(.notConnectedToInternet))
    }
    override func stopLoading() {}
}
