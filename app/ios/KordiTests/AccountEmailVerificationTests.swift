import XCTest
@testable import Kordi

final class AccountEmailVerificationModelTests: XCTestCase {
    private func accountJSON(verifiedField: String) -> Data {
        Data(#"{"accountId":"acct_1","kordiId":"482731906","displayName":"Maya","primaryEmail":"maya@example.com",\#(verifiedField)"avatarUrl":null,"avatar":{"entityType":"human","entityId":"acct_1","source":"generated","style":"lorelei","seed":"acct_1","rendererVersion":"dicebear-rust-10.6.0-styles-10.5.0","uploadedAsset":null,"version":1,"updatedAt":"2026-08-19T00:00:00Z"},"nodeId":null,"passwordSet":true}"#.utf8)
    }

    func testAccountDecodesVerifiedPrimaryEmail() throws {
        let account = try JSONDecoder().decode(CloudAccount.self, from: accountJSON(verifiedField: #""primaryEmailVerified":true,"#))
        XCTAssertEqual(account.primaryEmailVerified, true)
    }

    func testAccountDecodesUnverifiedPrimaryEmail() throws {
        let account = try JSONDecoder().decode(CloudAccount.self, from: accountJSON(verifiedField: #""primaryEmailVerified":false,"#))
        XCTAssertEqual(account.primaryEmailVerified, false)
    }

    func testAccountFromOlderServerLeavesVerificationUnknown() throws {
        let account = try JSONDecoder().decode(CloudAccount.self, from: accountJSON(verifiedField: ""))
        XCTAssertNil(account.primaryEmailVerified)
        XCTAssertEqual(account.primaryEmail, "maya@example.com")
    }

    func testCodeRequestEncodesAnEmptyObject() throws {
        let body = try JSONEncoder().encode(CloudAccountEmailCodeRequest())
        XCTAssertEqual(String(decoding: body, as: UTF8.self), "{}")
    }

    func testVerificationRequestUsesServerFieldNames() throws {
        let body = try JSONEncoder().encode(CloudAccountEmailVerificationRequest(
            verificationId: "challenge_1",
            verificationCode: "123456"
        ))
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: String])
        XCTAssertEqual(object, ["verificationId": "challenge_1", "verificationCode": "123456"])
    }

    func testCodeChallengeDecodesServerResponse() throws {
        let challenge = try JSONDecoder().decode(
            CloudSignupCodeChallenge.self,
            from: Data(#"{"verificationId":"challenge_1","expiresAt":"2026-10-05T10:10:00Z","retryAfterSeconds":60}"#.utf8)
        )
        XCTAssertEqual(challenge.verificationId, "challenge_1")
        XCTAssertEqual(challenge.expiresAt, "2026-10-05T10:10:00Z")
        XCTAssertEqual(challenge.retryAfterSeconds, 60)
    }
}

final class AccountEmailVerificationClientTests: XCTestCase {
    private func client() -> CloudAPIClient {
        AccountEmailURLProtocol.reset()
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [AccountEmailURLProtocol.self]
        return CloudAPIClient(
            baseURL: URL(string: "http://127.0.0.1:17081")!,
            session: URLSession(configuration: configuration)
        )
    }

    func testRequestAndVerifyUseSessionAuthenticatedRoutes() async throws {
        let client = client()

        let challenge = try await client.requestAccountEmailCode(token: "session_secret")
        try await client.verifyAccountEmail(
            token: "session_secret",
            verificationId: challenge.verificationId,
            verificationCode: "123456"
        )

        let requests = AccountEmailURLProtocol.recorded()
        XCTAssertEqual(requests.map(\.path), [
            "/v1/cloud/auth/email/verification/code",
            "/v1/cloud/auth/email/verification"
        ])
        XCTAssertEqual(requests.map(\.method), ["POST", "POST"])
        XCTAssertEqual(requests.map(\.authorization), ["Bearer session_secret", "Bearer session_secret"])
        XCTAssertEqual(String(decoding: requests[0].body, as: UTF8.self), "{}")
        let verifyBody = try XCTUnwrap(JSONSerialization.jsonObject(with: requests[1].body) as? [String: String])
        XCTAssertEqual(verifyBody, ["verificationId": "account_challenge", "verificationCode": "123456"])
    }

    func testRejectedCodeSurfacesTheServerErrorCode() async throws {
        let client = client()
        AccountEmailURLProtocol.rejectVerification = true

        do {
            try await client.verifyAccountEmail(
                token: "session_secret",
                verificationId: "account_challenge",
                verificationCode: "000000"
            )
            XCTFail("Expected the rejected code to throw.")
        } catch let error as CloudAPIError {
            XCTAssertEqual(error.code, "invalid_verification_code")
            XCTAssertEqual(error.statusCode, 400)
        }
    }
}

@MainActor
final class AccountEmailVerificationAppModelTests: XCTestCase {
    func testPreviewAccountIsVerifiedUnlessAPreviewOptsOut() {
        XCTAssertEqual(PreviewData.make(arguments: []).account.primaryEmailVerified, true)
        XCTAssertEqual(
            PreviewData.make(arguments: ["--preview-email-unverified"]).account.primaryEmailVerified,
            false
        )
        XCTAssertEqual(
            PreviewData.make(arguments: ["--preview-email-verification"]).account.primaryEmailVerified,
            false
        )
    }

    func testPreviewVerificationRejectsInvalidCodesAndKeepsTheAccountVerified() async throws {
        let model = AppModel(previewMode: true, previewLaunchFlow: false)

        let requested = await model.requestAccountEmailCode()
        let challenge = try XCTUnwrap(requested)
        XCTAssertEqual(challenge.retryAfterSeconds, 60)

        let incomplete = await model.verifyAccountEmail(verificationId: challenge.verificationId, verificationCode: "12a4")
        XCTAssertFalse(incomplete)
        XCTAssertEqual(model.errorMessage, "Enter the 6-digit code from your email.")

        let rejected = await model.verifyAccountEmail(verificationId: challenge.verificationId, verificationCode: "000000")
        XCTAssertFalse(rejected)
        XCTAssertEqual(model.errorMessage, "The email code is invalid or expired. Request a new code and try again.")

        let verified = await model.verifyAccountEmail(verificationId: challenge.verificationId, verificationCode: "123456")
        XCTAssertTrue(verified)
        XCTAssertNil(model.errorMessage)
        XCTAssertEqual(model.account?.primaryEmailVerified, true)
    }
}

private struct RecordedAccountEmailRequest {
    let path: String
    let method: String
    let authorization: String?
    let body: Data
}

private final class AccountEmailURLProtocol: URLProtocol {
    private static let lock = NSLock()
    nonisolated(unsafe) private static var requests: [RecordedAccountEmailRequest] = []
    nonisolated(unsafe) static var rejectVerification = false

    static func reset() {
        lock.withLock {
            requests = []
            rejectVerification = false
        }
    }

    static func recorded() -> [RecordedAccountEmailRequest] {
        lock.withLock { requests }
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let path = request.url?.path ?? ""
        let recorded = RecordedAccountEmailRequest(
            path: path,
            method: request.httpMethod ?? "",
            authorization: request.value(forHTTPHeaderField: "Authorization"),
            body: Self.body(of: request)
        )
        let reject = Self.lock.withLock {
            Self.requests.append(recorded)
            return Self.rejectVerification
        }
        let status: Int
        let payload: Data
        switch path {
        case "/v1/cloud/auth/email/verification/code":
            status = 200
            payload = Data(#"{"verificationId":"account_challenge","expiresAt":"2099-01-01T00:00:00Z","retryAfterSeconds":60}"#.utf8)
        case "/v1/cloud/auth/email/verification" where reject:
            status = 400
            payload = Data(#"{"errorCode":"invalid_verification_code","message":"The email code is invalid or expired. Request a new code and try again."}"#.utf8)
        case "/v1/cloud/auth/email/verification":
            status = 204
            payload = Data()
        default:
            status = 404
            payload = Data(#"{"errorCode":"not_found","message":"Not found."}"#.utf8)
        }
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: status,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: payload)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}

    private static func body(of request: URLRequest) -> Data {
        if let body = request.httpBody { return body }
        guard let stream = request.httpBodyStream else { return Data() }
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 1024)
        while stream.hasBytesAvailable {
            let count = stream.read(&buffer, maxLength: buffer.count)
            guard count > 0 else { break }
            data.append(buffer, count: count)
        }
        return data
    }
}
