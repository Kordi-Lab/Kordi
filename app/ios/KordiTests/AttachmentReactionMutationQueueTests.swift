import XCTest
@testable import Kordi

@MainActor
private final class ReactionTransportHarness {
    typealias Queue = AttachmentReactionMutationQueue
    let queue = Queue()
    let scope = Queue.Scope(accountID: "synthetic-account", sessionToken: "synthetic-session",
                            conversationID: "synthetic-chat", messageID: "synthetic-message")
    var server: [Queue.Target: Bool] = [:]
    var displayed: [Queue.Target: Bool] = [:]
    var requests: [(Queue.Target, Bool)] = []
    var failures = 0
    var continuation: CheckedContinuation<Void, Error>?

    func toggle(_ target: Queue.Target) async -> Bool {
        await queue.toggle(in: scope, target: target, current: displayed[target] ?? false) { [self] active in
            requests.append((target, active))
            try await withCheckedThrowingContinuation { continuation = $0 }
            server[target] = active
            // A full canonical response contains none of the later local choices.
            displayed = server
        } reconcile: { [self] choices in
            displayed.merge(choices) { _, pending in pending }
        } onFailure: { [self] _ in failures += 1 }
    }

    func complete(success: Bool) {
        let pending = continuation
        continuation = nil
        if success { pending?.resume() }
        else { pending?.resume(throwing: URLError(.notConnectedToInternet)) }
    }
}

@MainActor
final class AttachmentReactionMutationQueueTests: XCTestCase {
    typealias Target = AttachmentReactionMutationQueue.Target
    private let firstPhoto = Target(attachmentID: "photo-one", reaction: "smile")
    private let secondPhoto = Target(attachmentID: "photo-two", reaction: "smile")

    private func waitUntil(_ predicate: () -> Bool) async throws {
        for _ in 0..<1000 {
            if predicate() { return }
            await Task.yield()
        }
        XCTFail("The test executor did not schedule the controlled request")
        throw URLError(.timedOut)
    }

    func testRapidAddAndRemoveKeepsLatestChoiceWhileSendingInOrder() async throws {
        let h = ReactionTransportHarness()
        let add = Task { await h.toggle(firstPhoto) }
        try await waitUntil { h.requests.count == 1 }
        let remove = Task { await h.toggle(firstPhoto) }
        try await waitUntil { h.displayed[firstPhoto] == false }
        XCTAssertEqual(h.requests.count, 1, "The remove must wait for the add response")
        h.complete(success: true)
        try await waitUntil { h.requests.count == 2 }
        XCTAssertEqual(h.requests.map(\.1), [true, false])
        XCTAssertEqual(h.displayed[firstPhoto], false, "The old add response must not flash the reaction back")
        XCTAssertEqual(h.queue.pendingValues(in: h.scope)[firstPhoto], false,
                       "History and sync projections must retain the pending remove")
        h.complete(success: true)
        let results = await (add.value, remove.value)
        XCTAssertTrue(results.0 && results.1)
        XCTAssertEqual(h.server[firstPhoto], false)
        XCTAssertEqual(h.displayed[firstPhoto], false)
        XCTAssertTrue(h.queue.pendingValues(in: h.scope).isEmpty)
    }

    func testFailedSupersededAddDoesNotRollbackRemoveOrShowAnObsoleteError() async throws {
        let h = ReactionTransportHarness()
        let add = Task { await h.toggle(firstPhoto) }
        try await waitUntil { h.requests.count == 1 }
        let remove = Task { await h.toggle(firstPhoto) }
        try await waitUntil { h.displayed[firstPhoto] == false }
        h.complete(success: false)
        try await waitUntil { h.requests.count == 2 }
        XCTAssertEqual(h.displayed[firstPhoto], false)
        XCTAssertEqual(h.failures, 0)
        h.complete(success: false)
        let results = await (add.value, remove.value)
        XCTAssertFalse(results.0 || results.1)
        XCTAssertEqual(h.displayed[firstPhoto], false, "Rollback must use the confirmed baseline, not the failed optimistic add")
        XCTAssertEqual(h.failures, 1)
    }

    func testFailedLatestRemoveRestoresSuccessfullyConfirmedAdd() async throws {
        let h = ReactionTransportHarness()
        let add = Task { await h.toggle(firstPhoto) }
        try await waitUntil { h.requests.count == 1 }
        let remove = Task { await h.toggle(firstPhoto) }
        try await waitUntil { h.displayed[firstPhoto] == false }
        h.complete(success: true)
        try await waitUntil { h.requests.count == 2 }
        h.complete(success: false)
        _ = await (add.value, remove.value)
        XCTAssertEqual(h.displayed[firstPhoto], true)
        XCTAssertEqual(h.failures, 1)
    }

    func testWholeMessageResponsesPreservePendingChoiceOnAnotherPhoto() async throws {
        let h = ReactionTransportHarness()
        let first = Task { await h.toggle(firstPhoto) }
        try await waitUntil { h.requests.count == 1 }
        let second = Task { await h.toggle(secondPhoto) }
        try await waitUntil { h.displayed[secondPhoto] == true }
        XCTAssertEqual(h.requests.count, 1, "All attachment writes to one message share an ordering")
        h.complete(success: true)
        try await waitUntil { h.requests.count == 2 }
        XCTAssertEqual(h.displayed[firstPhoto], true)
        XCTAssertEqual(h.displayed[secondPhoto], true)
        h.complete(success: true)
        _ = await (first.value, second.value)
        XCTAssertEqual(h.displayed, h.server)
    }

    func testPendingStateCannotCrossAnAuthenticatedSessionBoundary() async throws {
        let h = ReactionTransportHarness()
        let operation = Task { await h.toggle(firstPhoto) }
        try await waitUntil { h.requests.count == 1 }
        let replacement = AttachmentReactionMutationQueue.Scope(accountID: h.scope.accountID,
            sessionToken: "replacement-session", conversationID: h.scope.conversationID, messageID: h.scope.messageID)
        XCTAssertTrue(h.queue.pendingValues(in: replacement).isEmpty)
        h.complete(success: true)
        _ = await operation.value
    }
}
