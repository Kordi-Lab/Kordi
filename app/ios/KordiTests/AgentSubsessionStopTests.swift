import Foundation
import Testing
@testable import Kordi

@MainActor
struct AgentSubsessionStopTests {
    @Test func onlyTheOwnerCanStopRunningTasks() {
        var task = AgentSubsessionStopPreview.snapshot(accountId: "owner")
        #expect(task.canStop(accountId: "owner"))
        #expect(!task.canStop(accountId: "peer"))
        #expect(!task.canStop(accountId: nil))
        for status in ["stopped", "done", "failed"] {
            task.status = status
            #expect(!task.canStop(accountId: "owner"))
        }
    }

    @Test func previewStopsOnceAndUpdatesBothSurfaces() async throws {
        let model = AppModel(previewMode: true, previewLaunchFlow: false)
        let task = AgentSubsessionStopPreview.snapshot(accountId: try #require(model.account?.accountId))
        model.installSubsessionStopPreview(task)
        async let first: Void = model.stopAgentSubsession(task)
        async let second: Void = model.stopAgentSubsession(task)
        _ = try await (first, second)
        #expect(model.subsessions[task.sessionId]?.state == .stopped)
        #expect(model.subsessions[task.sessionId]?.version == 2)
        #expect(model.stoppingSubsessionIDs.isEmpty)
        #expect(try await model.agentSubsession(id: task.sessionId).state == .stopped)
    }

    @Test func anotherOwnersTaskCannotBeStopped() async {
        let model = AppModel(previewMode: true, previewLaunchFlow: false)
        let task = AgentSubsessionStopPreview.snapshot(accountId: "another-owner")
        do { try await model.stopAgentSubsession(task); Issue.record("Non-owner Stop must fail") }
        catch { #expect(model.stoppingSubsessionIDs.isEmpty) }
    }

    @Test func stopUsesTheSharedTaskEndpoint() async throws {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StopSubsessionProtocol.self]
        let session = URLSession(configuration: config)
        defer { session.invalidateAndCancel() }
        let api = CloudAPIClient(session: session)
        let result = try await api.stopAgentSubsession(token: "synthetic", id: "preview-background-stop", expectedStartedAtMs: 1000)
        #expect(result.state == .stopped)
    }

    @Test func failuresDoNotClaimTheTaskStopped() {
        let text = AgentSubsessionStopButton.failureMessage(URLError(.notConnectedToInternet))
        #expect(text.contains("may still be running"))
        let conflict = CloudAPIError(code: "subsession_execution_changed", message: "Changed", statusCode: 409)
        #expect(AgentSubsessionStopButton.failureMessage(conflict).contains("Refresh"))
    }
}

private final class StopSubsessionProtocol: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        #expect(request.httpMethod == "POST")
        #expect(request.url?.path == "/v1/cloud/agent-subsessions/preview-background-stop/stop")
        #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer synthetic")
        let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil,
            headerFields: ["Content-Type": "application/json"])!
        var snapshot = AgentSubsessionStopPreview.snapshot(accountId: "owner")
        snapshot.status = "stopped"
        let data = try! JSONEncoder().encode(snapshot)
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
