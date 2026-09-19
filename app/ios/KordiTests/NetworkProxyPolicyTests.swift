import Foundation
import Testing
@testable import Kordi

struct NetworkProxyPolicyTests {
    @Test func loopbackOriginsConnectDirectly() {
        #expect(NetworkProxyPolicy.isLoopback(URL(string: "http://127.0.0.1:17081")!))
        #expect(NetworkProxyPolicy.isLoopback(URL(string: "http://localhost:8080")!))
        #expect(NetworkProxyPolicy.isLoopback(URL(string: "http://[::1]:8080")!))
        #expect(!NetworkProxyPolicy.isLoopback(URL(string: "https://kordi.ai")!))
        #expect(!NetworkProxyPolicy.isLoopback(URL(string: "https://127.0.0.1.example.com")!))
    }

    @Test func proxyStatesDistinguishAutomaticAndManualConfiguration() {
        #expect(NetworkProxyPolicy.state(systemProxySettings: [:]) == .direct)
        #expect(NetworkProxyPolicy.state(systemProxySettings: ["HTTPEnable": 1]) == .manualProxy)
        #expect(NetworkProxyPolicy.state(systemProxySettings: ["HTTPSEnable": true]) == .manualProxy)
        #expect(NetworkProxyPolicy.state(systemProxySettings: ["SOCKSEnable": NSNumber(value: 1)]) == .manualProxy)
        #expect(NetworkProxyPolicy.state(systemProxySettings: ["ProxyAutoConfigEnable": 1]) == .automaticProxy)
        #expect(NetworkProxyPolicy.state(systemProxySettings: ["ProxyAutoDiscoveryEnable": 1]) == .automaticProxy)
        #expect(
            NetworkProxyPolicy.state(systemProxySettings: ["ProxyAutoConfigEnable": 0, "HTTPEnable": 1]) == .manualProxy
        )
    }

    @Test func onlyPreConnectionFailuresRetryDirectly() {
        #expect(NetworkProxyPolicy.isDirectRetryEligible(URLError(.cannotFindHost)))
        #expect(NetworkProxyPolicy.isDirectRetryEligible(URLError(.dnsLookupFailed)))
        #expect(NetworkProxyPolicy.isDirectRetryEligible(URLError(.cannotConnectToHost)))
        #expect(NetworkProxyPolicy.isDirectRetryEligible(URLError(.notConnectedToInternet)))
        #expect(!NetworkProxyPolicy.isDirectRetryEligible(URLError(.timedOut)))
        #expect(!NetworkProxyPolicy.isDirectRetryEligible(URLError(.networkConnectionLost)))
        #expect(!NetworkProxyPolicy.isDirectRetryEligible(URLError(.cancelled)))
        #expect(
            !NetworkProxyPolicy.isDirectRetryEligible(
                CloudAPIError(code: "network_error", message: "Synthetic", statusCode: 0)
            )
        )
    }

    @Test func proxyFailuresExplainTheProxySetting() {
        let automatic = NetworkProxyPolicy.failureMessage(for: .automaticProxy, fallback: "fallback")
        #expect(automatic.contains("automatic proxy"))
        #expect(automatic.contains("Wi-Fi"))
        let manual = NetworkProxyPolicy.failureMessage(for: .manualProxy, fallback: "fallback")
        #expect(manual.contains("proxy server"))
        #expect(NetworkProxyPolicy.failureMessage(for: .direct, fallback: "fallback") == "fallback")
    }
}

private final class ProxyFallbackURLProtocol: URLProtocol {
    private static let lock = NSLock()
    private static var attemptsStorage: [Bool] = []
    private static var failureStorage: URLError.Code = .cannotFindHost
    private static var failDirectStorage = false

    static func reset(failure: URLError.Code, failDirect: Bool = false) {
        lock.lock()
        attemptsStorage = []
        failureStorage = failure
        failDirectStorage = failDirect
        lock.unlock()
    }

    static var attempts: [Bool] {
        lock.lock()
        defer { lock.unlock() }
        return attemptsStorage
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let isDirect = request.value(forHTTPHeaderField: "X-Test-Direct") == "1"
        Self.lock.lock()
        Self.attemptsStorage.append(isDirect)
        let failure = Self.failureStorage
        let failDirect = Self.failDirectStorage
        Self.lock.unlock()
        guard isDirect, !failDirect else {
            client?.urlProtocol(self, didFailWithError: URLError(failure))
            return
        }
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: 200,
            httpVersion: nil,
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(#"{"events":[],"nextBefore":null}"#.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

@Suite(.serialized, .timeLimit(.minutes(1)))
struct CloudTransportProxyFallbackTests {
    private func makeSessions(failure: URLError.Code, failDirect: Bool = false) -> (URLSession, URLSession) {
        ProxyFallbackURLProtocol.reset(failure: failure, failDirect: failDirect)
        let primaryConfiguration = URLSessionConfiguration.ephemeral
        primaryConfiguration.protocolClasses = [ProxyFallbackURLProtocol.self]
        primaryConfiguration.httpAdditionalHeaders = ["X-Test-Direct": "0"]
        let directConfiguration = URLSessionConfiguration.ephemeral
        directConfiguration.protocolClasses = [ProxyFallbackURLProtocol.self]
        directConfiguration.httpAdditionalHeaders = ["X-Test-Direct": "1"]
        return (
            URLSession(configuration: primaryConfiguration),
            URLSession(configuration: directConfiguration)
        )
    }

    private func makeClient(
        sessions: (URLSession, URLSession),
        proxyState: NetworkProxyPolicy.SystemState = .automaticProxy
    ) -> CloudAPIClient {
        CloudAPIClient(
            baseURL: URL(string: "https://kordi.test")!,
            session: sessions.0,
            directSession: sessions.1,
            proxyStateProvider: { proxyState }
        )
    }

    private func pinHistory(_ api: CloudAPIClient) async throws -> [CloudPinHistoryEvent] {
        try await api.sessionPinHistory(token: "synthetic", sessionId: "chat")
    }

    @Test func preConnectionProxyFailureRetriesDirectlyAndSucceeds() async throws {
        let sessions = makeSessions(failure: .cannotFindHost)
        defer {
            sessions.0.invalidateAndCancel()
            sessions.1.invalidateAndCancel()
        }
        let history = try await pinHistory(makeClient(sessions: sessions))
        #expect(history.isEmpty)
        #expect(ProxyFallbackURLProtocol.attempts == [false, true])
    }

    @Test func ambiguousFailuresDoNotRetryAndExplainTheProxy() async throws {
        let sessions = makeSessions(failure: .timedOut)
        defer {
            sessions.0.invalidateAndCancel()
            sessions.1.invalidateAndCancel()
        }
        do {
            _ = try await pinHistory(makeClient(sessions: sessions))
            Issue.record("A timed-out request must fail")
        } catch let error as CloudAPIError {
            #expect(error.code == "proxy_unreachable")
            #expect(error.message.contains("automatic proxy"))
        }
        #expect(ProxyFallbackURLProtocol.attempts == [false])
    }

    @Test func unreachableProxyAfterDirectRetryReportsTheProxySetting() async throws {
        let sessions = makeSessions(failure: .cannotFindHost, failDirect: true)
        defer {
            sessions.0.invalidateAndCancel()
            sessions.1.invalidateAndCancel()
        }
        do {
            _ = try await pinHistory(makeClient(sessions: sessions))
            Issue.record("An unreachable host must fail")
        } catch let error as CloudAPIError {
            #expect(error.code == "proxy_unreachable")
            #expect(error.message.contains("automatic proxy"))
        }
        #expect(ProxyFallbackURLProtocol.attempts == [false, true])
    }

    @Test func directFailuresKeepTheGenericNetworkMessage() async throws {
        let sessions = makeSessions(failure: .cannotFindHost, failDirect: true)
        defer {
            sessions.0.invalidateAndCancel()
            sessions.1.invalidateAndCancel()
        }
        do {
            _ = try await pinHistory(makeClient(sessions: sessions, proxyState: .direct))
            Issue.record("An unreachable host must fail")
        } catch let error as CloudAPIError {
            #expect(error.code == "network_error")
            #expect(error.message == "Could not load pin history.")
        }
        #expect(ProxyFallbackURLProtocol.attempts == [false, true])
    }
}

@Suite(.serialized, .timeLimit(.minutes(1)))
struct LoopbackTransportProxyTests {
    @Test func loopbackOriginsStartOnTheDirectSession() async throws {
        ProxyFallbackURLProtocol.reset(failure: .cannotFindHost)
        let primaryConfiguration = URLSessionConfiguration.ephemeral
        primaryConfiguration.protocolClasses = [ProxyFallbackURLProtocol.self]
        primaryConfiguration.httpAdditionalHeaders = ["X-Test-Direct": "0"]
        let directConfiguration = URLSessionConfiguration.ephemeral
        directConfiguration.protocolClasses = [ProxyFallbackURLProtocol.self]
        directConfiguration.httpAdditionalHeaders = ["X-Test-Direct": "1"]
        let primary = URLSession(configuration: primaryConfiguration)
        let direct = URLSession(configuration: directConfiguration)
        defer {
            primary.invalidateAndCancel()
            direct.invalidateAndCancel()
        }
        let api = CloudAPIClient(
            baseURL: URL(string: "https://127.0.0.1:17081")!,
            session: primary,
            directSession: direct,
            proxyStateProvider: { .automaticProxy }
        )
        let history = try await api.sessionPinHistory(token: "synthetic", sessionId: "chat")
        #expect(history.isEmpty)
        #expect(ProxyFallbackURLProtocol.attempts == [true])
    }
}
