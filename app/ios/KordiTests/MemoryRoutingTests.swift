import XCTest
@testable import Kordi

/// Memory categories and profile routing (#1977): chips, the new fields,
/// the move request, the card page's memories and its "new memories" line.
final class MemoryRoutingTests: XCTestCase {
    private static let legacyJSON = #"""
    {"memoryId": "m1", "scope": "global", "scopeId": "account", "scopeLabel": null, "source": "manual",
     "text": "Answer briefly.", "createdAt": "2026-10-20T09:00:00Z", "updatedAt": "2026-10-20T09:00:00Z"}
    """#

    private static let routedJSON = #"""
    {"memoryId": "m2", "scope": "conversation", "scopeId": "c1", "scopeLabel": "Planning", "source": "user_correction",
     "text": "Runs on Tuesday mornings.", "createdAt": "2026-10-20T09:00:00Z", "updatedAt": "2026-10-21T09:00:00Z",
     "category": "health_context", "declarationType": "model-inferred", "confidence": "high",
     "profileId": "prof_health", "profileKind": "health"}
    """#

    func testCategoryLabelsMatchTheMac() {
        let expected = [
            "work_context": "Work", "education_learner_profile": "Learning", "health_context": "Health",
            "coordination_context": "Schedule", "location_context": "Location", "purchase_history_preferences": "Shopping",
            "general_preferences": "Preference", "goals_and_constraints": "Goal", "values_and_ethics": "Values",
            "hcp-custom:task_lessons": "Task note",
        ]
        for (category, label) in expected {
            XCTAssertEqual(MemoryPresentation.categoryLabel(for: category), label, category)
        }
        XCTAssertEqual(MemoryPresentation.categoryLabels.count, 10)
        XCTAssertNil(MemoryPresentation.categoryLabel(for: nil))
        XCTAssertNil(MemoryPresentation.categoryLabel(for: "hcp-custom:unknown"))
    }

    func testMemoryDecodesWithAndWithoutRoutingFields() throws {
        let legacy = try JSONDecoder().decode(CloudMemory.self, from: Data(Self.legacyJSON.utf8))
        XCTAssertNil(legacy.category)
        XCTAssertNil(legacy.declarationType)
        XCTAssertNil(legacy.confidence)
        XCTAssertNil(legacy.profileId)
        XCTAssertNil(legacy.profileKind)

        let routed = try JSONDecoder().decode(CloudMemory.self, from: Data(Self.routedJSON.utf8))
        XCTAssertEqual(routed.category, "health_context")
        XCTAssertEqual(routed.declarationType, "model-inferred")
        XCTAssertEqual(routed.confidence, "high")
        XCTAssertEqual(routed.profileId, "prof_health")
        XCTAssertEqual(routed.profileKind, "health")
        XCTAssertEqual(routed.source, .userCorrection)
    }

    private func encoded(_ request: CloudMemoryUpdateRequest) throws -> [String: Any] {
        let data = try JSONEncoder().encode(request)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    func testUpdateRequestSendsAnExplicitNullProfileOnlyWhenCleared() throws {
        let text = try encoded(CloudMemoryUpdateRequest(text: "Short replies."))
        XCTAssertEqual(text["text"] as? String, "Short replies.")
        XCTAssertFalse(text.keys.contains("profileId"))
        XCTAssertFalse(text.keys.contains("category"))

        let moved = try encoded(CloudMemoryUpdateRequest(profile: .move("prof_work")))
        XCTAssertEqual(moved["profileId"] as? String, "prof_work")
        XCTAssertFalse(moved.keys.contains("text"))

        let cleared = try encoded(CloudMemoryUpdateRequest(profile: .clear))
        XCTAssertTrue(cleared.keys.contains("profileId"))
        XCTAssertTrue(cleared["profileId"] is NSNull)
        XCTAssertEqual(cleared.count, 1)

        let recategorized = try encoded(CloudMemoryUpdateRequest(category: "work_context"))
        XCTAssertEqual(recategorized["category"] as? String, "work_context")
    }

    func testProfileMemoriesDecodeEveryProfileFlag() throws {
        let routed = Self.routedJSON.trimmingCharacters(in: .whitespacesAndNewlines).dropLast()
        let json = #"{"memories": ["# + routed + #", "everyProfile": true}, "# + Self.legacyJSON + "]}"
        let list = try JSONDecoder().decode(CloudProfileMemoryList.self, from: Data(json.utf8))
        XCTAssertEqual(list.memories.map(\.id), ["m2", "m1"])
        XCTAssertTrue(list.memories[0].everyProfile)
        XCTAssertEqual(list.memories[0].memory.category, "health_context")
        XCTAssertFalse(list.memories[1].everyProfile)
    }

    func testOwnerViewDecodesMemoriesSinceBuild() throws {
        let view = try JSONDecoder().decode(CommonGroundOwnerView.self, from: Data(CommonGroundTests.ownerJSON.utf8))
        XCTAssertNil(view.memoriesSinceBuild)
        let json = #"{"card": null, "sharing": true, "build": {"status": "idle", "errorCode": null}, "memoriesSinceBuild": 3}"#
        XCTAssertEqual(try JSONDecoder().decode(CommonGroundOwnerView.self, from: Data(json.utf8)).memoriesSinceBuild, 3)
    }

    func testMemoriesSinceBuildCaption() {
        XCTAssertNil(MemoryPresentation.memoriesSinceBuildCaption(nil))
        XCTAssertNil(MemoryPresentation.memoriesSinceBuildCaption(0))
        XCTAssertEqual(MemoryPresentation.memoriesSinceBuildCaption(1), "1 new memory since this card was built")
        XCTAssertEqual(MemoryPresentation.memoriesSinceBuildCaption(4), "4 new memories since this card was built")
    }

    func testProfileRoutingNeedsMemoryVersionTwo() {
        XCTAssertFalse(MemoryPresentation.hasProfileRouting(nil))
        XCTAssertFalse(MemoryPresentation.hasProfileRouting(CloudAuthCapabilities(memoryVersion: 1)))
        XCTAssertTrue(MemoryPresentation.hasProfileRouting(CloudAuthCapabilities(memoryVersion: 2)))
    }

    @MainActor
    func testCardPageListsMemoriesOnlyWithRouting() throws {
        let me = CommonGroundPerson(accountId: "acct_a", name: "Alex", avatarUrl: nil)
        let context: CommonGroundModel.Context = { throw CancellationError() }
        XCTAssertFalse(CommonGroundModel(me: me, profilesEnabled: true, context: context).showsProfileMemories)
        XCTAssertFalse(CommonGroundModel(me: me, memoriesEnabled: true, context: context).showsProfileMemories)
        let model = CommonGroundModel(me: me, profilesEnabled: true, memoriesEnabled: true, context: context)
        XCTAssertTrue(model.showsProfileMemories)
        model.profiles = [
            CommonGroundProfileSummary(profileId: "prof_work", kind: "work", name: ""),
            CommonGroundProfileSummary(profileId: "prof_health", kind: "health", name: "", position: 1),
        ]
        model.currentProfileID = "prof_work"
        let memory = try JSONDecoder().decode(CloudMemory.self, from: Data(Self.routedJSON.utf8))
        XCTAssertEqual(model.moveTargets(for: CloudProfileMemory(memory: memory)).map(\.profileId), ["prof_health"])
        XCTAssertEqual(model.moveTargets(for: CloudProfileMemory(memory: memory, everyProfile: true)).map(\.profileId), ["prof_work", "prof_health"])
    }
}
