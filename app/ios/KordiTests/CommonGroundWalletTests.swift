import SwiftUI
import UIKit
import XCTest
@testable import Kordi

/// The wallet: creating a code for a meetup, the room's suggested card, the
/// New card availability rule and each card's design.
@MainActor
final class CommonGroundWalletTests: XCTestCase {
    private static let baseURL = URL(string: "http://127.0.0.1:17082")!

    private func freshDefaults() -> UserDefaults {
        let name = "CommonGroundWalletTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: name)!
        defaults.removePersistentDomain(forName: name)
        return defaults
    }

    private func stubbedModel(profiles: Bool, defaults: UserDefaults) -> CommonGroundModel {
        CommonGroundURLProtocol.reset()
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [CommonGroundURLProtocol.self]
        let api = CloudAPIClient(baseURL: Self.baseURL, session: URLSession(configuration: configuration))
        return CommonGroundModel(me: CommonGroundPerson(accountId: "acct_a", name: "Alex"), profilesEnabled: profiles, defaults: defaults) {
            (api, "session-value")
        }
    }

    private func body(_ recorded: CommonGroundURLProtocol.Recorded) throws -> [String: Any] {
        try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(recorded.body)) as? [String: Any])
    }

    private var profiles: [CommonGroundProfileSummary] {
        get throws { try JSONDecoder().decode(CommonGroundProfileList.self, from: Data(CommonGroundProfileTests.profilesJSON.utf8)).profiles }
    }

    // MARK: Create a code

    func testCreateCodeRequestAndResponse() async throws {
        let model = stubbedModel(profiles: true, defaults: freshDefaults())
        CommonGroundURLProtocol.stub("GET", "/v1/cloud/common-ground/profiles", [(200, CommonGroundProfileTests.profilesJSON)])
        CommonGroundURLProtocol.stub("POST", "/v1/cloud/common-ground/rooms", [(201, #"""
        {"code":"7319","name":"Agents meetup","openedByYou":true,"open":true,"members":[],"kind":"health","profileId":"cgp_h"}
        """#)])
        CommonGroundURLProtocol.stub("GET", "/v1/cloud/common-ground/rooms", [(200, #"""
        {"rooms":[{"code":"3907","name":"Lab lunch","memberCount":5},{"code":"7319","name":"Agents meetup","memberCount":1,"kind":"health","profileId":"cgp_h"}]}
        """#)])
        await model.loadProfiles()

        let room = await model.createRoom(name: "  Agents meetup ", profileId: "cgp_h")
        XCTAssertEqual(room?.code, "7319")
        XCTAssertEqual(room?.title, "Agents meetup")
        XCTAssertEqual(room?.openedByYou, true)
        XCTAssertEqual(room?.profileId, "cgp_h")

        let sent = try body(XCTUnwrap(CommonGroundURLProtocol.requests.last {
            $0.request.httpMethod == "POST" && $0.request.url?.path == "/v1/cloud/common-ground/rooms"
        }))
        XCTAssertEqual(sent["name"] as? String, "Agents meetup")
        XCTAssertEqual(sent["kind"] as? String, "health", "the kind is the chosen card's")
        XCTAssertEqual(sent["profileId"] as? String, "cgp_h")
        XCTAssertEqual(model.roomList?.first?.code, "7319", "the new room is at the top of Rooms")
        XCTAssertEqual(model.sharingLine(inRoom: "7319"), "Sharing: Health")

        CommonGroundURLProtocol.stub("POST", "/v1/cloud/common-ground/rooms", [(429, #"{"errorCode":"rate_limited","message":"x"}"#)])
        let refused = await model.createRoom(name: "Again", profileId: "cgp_w")
        XCTAssertNil(refused)
        XCTAssertEqual(model.notice, "Try again in 1 min.")
        let blank = await model.createRoom(name: "   ", profileId: "cgp_w")
        XCTAssertNil(blank, "a meetup needs a name")
    }

    func testCreateCodeBeforeProfilesSendsOnlyTheName() throws {
        let model = stubbedModel(profiles: false, defaults: freshDefaults())
        let request = model.createRoomRequest(name: " Poster session ", profileId: "cgp_w")
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(request)) as? [String: Any])
        XCTAssertEqual(json["name"] as? String, "Poster session")
        XCTAssertNil(json["kind"])
        XCTAssertNil(json["profileId"])
    }

    // MARK: Suggested card

    func testRoomSuggestsItsKindsCard() throws {
        let built = try profiles.filter(\.hasCard)
        XCTAssertEqual(CommonGroundProfileChoice.suggested(roomKind: "health", in: built), "cgp_h")
        XCTAssertNil(CommonGroundProfileChoice.suggested(roomKind: "daily", in: built), "no card of that kind")
        XCTAssertNil(CommonGroundProfileChoice.suggested(roomKind: nil, in: built), "an unknown room suggests nothing")
        XCTAssertNil(CommonGroundProfileChoice.suggested(roomKind: "custom", in: built), "only cards with a card count")

        XCTAssertEqual(CommonGroundProfileChoice.preselected(roomKind: "health", current: "cgp_w", in: built), "cgp_h")
        XCTAssertEqual(CommonGroundProfileChoice.preselected(roomKind: nil, current: "cgp_h", in: built), "cgp_h")
        XCTAssertEqual(CommonGroundProfileChoice.preselected(roomKind: "daily", current: "cgp_k", in: built), "cgp_w")
    }

    // MARK: New card

    func testNewCardAvailability() throws {
        let wallet = try profiles
        XCTAssertFalse(CommonGroundCardDesign.isAvailable(.work, in: wallet), "Work is in the wallet")
        XCTAssertFalse(CommonGroundCardDesign.isAvailable(.health, in: wallet))
        XCTAssertTrue(CommonGroundCardDesign.isAvailable(.daily, in: wallet))
        XCTAssertTrue(CommonGroundCardDesign.isAvailable(.workshop, in: wallet), "custom designs repeat")
        XCTAssertTrue(CommonGroundCardDesign.isAvailable(.research, in: wallet))
        XCTAssertTrue(CommonGroundCardDesign.isAvailable(.custom, in: wallet))
        XCTAssertEqual(CommonGroundCardDesign.firstAvailable(in: wallet), .daily)
        XCTAssertEqual(CommonGroundCardDesign.firstAvailable(in: []), .work)

        XCTAssertEqual(CommonGroundCardDesign.workshop.kind, .custom)
        XCTAssertEqual(CommonGroundCardDesign.research.kind, .custom)
        XCTAssertEqual(CommonGroundCardDesign.workshop.defaultName, "Workshop")
        XCTAssertEqual(CommonGroundCardDesign.research.defaultName, "Research group")
        XCTAssertEqual(CommonGroundCardDesign.daily.defaultName, "")
    }

    func testNewCardSendsItsDesign() async throws {
        let defaults = freshDefaults()
        let model = stubbedModel(profiles: true, defaults: defaults)
        CommonGroundURLProtocol.stub("POST", "/v1/cloud/common-ground/profiles", [(201, #"{"profileId":"cgp_m","kind":"custom","name":"MIT","position":3,"design":"workshop"}"#)])
        CommonGroundURLProtocol.stub("GET", "/v1/cloud/common-ground/card", [(200, CommonGroundTests.buildingJSON)])

        let created = await model.createCard(.workshop, name: " MIT ", focus: "")
        XCTAssertEqual(created?.profileId, "cgp_m")
        let sent = try body(XCTUnwrap(CommonGroundURLProtocol.requests.last { $0.request.httpMethod == "POST" }))
        XCTAssertEqual(sent["kind"] as? String, "custom")
        XCTAssertEqual(sent["name"] as? String, "MIT")
        XCTAssertEqual(sent["design"] as? String, "workshop")
        XCTAssertEqual(model.design(ofProfile: "cgp_m"), .workshop, "the server's design wins over the name")
        XCTAssertNil(defaults.string(forKey: CommonGroundCardDesignStore.key("cgp_m")), "nothing is kept on the device")
    }

    func testDesignFollowsServerThenKindThenName() {
        XCTAssertEqual(CommonGroundCardDesign.of(kind: "work", name: "Lab"), .work)
        XCTAssertEqual(CommonGroundCardDesign.of(kind: "health", name: "", design: nil), .health)
        XCTAssertEqual(CommonGroundCardDesign.of(kind: "daily", name: ""), .daily)
        XCTAssertEqual(CommonGroundCardDesign.of(kind: "custom", name: "KAUST", design: "research"), .research)
        XCTAssertEqual(CommonGroundCardDesign.of(kind: "custom", name: "Poster workshop", design: "custom"), .custom, "the design beats the name")
        XCTAssertEqual(CommonGroundCardDesign.of(kind: "custom", name: "Poster workshop"), .workshop)
        XCTAssertEqual(CommonGroundCardDesign.of(kind: "custom", name: "Vision research group"), .research)
        XCTAssertEqual(CommonGroundCardDesign.of(kind: "custom", name: "Board games", design: "unknown"), .custom)
    }

    // MARK: Design on the server

    func testDesignRoundTripsInProfiles() throws {
        let list = try JSONDecoder().decode(CommonGroundProfileList.self, from: Data(#"""
        {"profiles":[{"profileId":"cgp_k","kind":"custom","name":"KAUST","position":2,"design":"research"},
                     {"profileId":"cgp_w","kind":"work","name":"","position":0,"design":null}]}
        """#.utf8))
        XCTAssertEqual(list.profiles[0].design, "research")
        XCTAssertEqual(list.profiles[0].cardDesign, .research)
        XCTAssertNil(list.profiles[1].design)
        XCTAssertEqual(list.profiles[1].cardDesign, .work)

        let tag = try JSONDecoder().decode(CommonGroundProfileTag.self, from: Data(#"{"profileId":"cgp_x","kind":"custom","name":"Lab","design":"workshop"}"#.utf8))
        XCTAssertEqual(tag.design, "workshop")
        XCTAssertEqual(tag.cardDesign, .workshop, "another person's design wins over the name")
        let again = try JSONDecoder().decode(CommonGroundProfileTag.self, from: JSONEncoder().encode(tag))
        XCTAssertEqual(again, tag)
        let person = try JSONDecoder().decode(CommonGroundPerson.self, from: Data(#"""
        {"accountId":"acct_b","name":"Priya","profile":{"profileId":"cgp_p","kind":"custom","name":"Poster day","design":"research"}}
        """#.utf8))
        XCTAssertEqual(person.profile?.cardDesign, .research)

        let draft = CommonGroundNewProfile(kind: .custom, name: " KAUST ", design: .research)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(draft)) as? [String: Any])
        XCTAssertEqual(json["design"] as? String, "research")
        let edit = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(CommonGroundProfileEdit(name: "Lab"))) as? [String: Any])
        XCTAssertNil(edit["design"], "an edit without a design leaves it")
    }

    func testRenameKeepsTheCardsLook() async throws {
        let model = stubbedModel(profiles: true, defaults: freshDefaults())
        CommonGroundURLProtocol.stub("GET", "/v1/cloud/common-ground/profiles", [(200, #"""
        {"profiles":[{"profileId":"cgp_k","kind":"custom","name":"Poster workshop","position":2},
                     {"profileId":"cgp_r","kind":"custom","name":"Lab","position":3,"design":"research"}]}
        """#)])
        await model.loadProfiles()
        CommonGroundURLProtocol.stub("PUT", "/v1/cloud/common-ground/profiles/cgp_k", [(200, #"{"profileId":"cgp_k","kind":"custom","name":"KAUST","position":2,"design":"workshop"}"#)])
        CommonGroundURLProtocol.stub("PUT", "/v1/cloud/common-ground/profiles/cgp_r", [(200, #"{"profileId":"cgp_r","kind":"custom","name":"Lab","position":3,"design":"research","focus":"Vision"}"#)])

        let renamedOK = await model.updateProfile("cgp_k", name: "KAUST")
        XCTAssertTrue(renamedOK)
        let renamed = try body(XCTUnwrap(CommonGroundURLProtocol.requests.last { $0.request.url?.path.hasSuffix("cgp_k") == true }))
        XCTAssertEqual(renamed["design"] as? String, "workshop", "the guessed look is kept after the name changes")
        XCTAssertEqual(model.design(ofProfile: "cgp_k"), .workshop)

        let focusedOK = await model.updateProfile("cgp_r", focus: "Vision")
        XCTAssertTrue(focusedOK)
        let focused = try body(XCTUnwrap(CommonGroundURLProtocol.requests.last { $0.request.url?.path.hasSuffix("cgp_r") == true }))
        XCTAssertNil(focused["design"], "a stored design is left alone")
    }

    func testLocalDesignsMoveToTheServerOnce() async throws {
        let defaults = freshDefaults()
        defaults.set("research", forKey: CommonGroundCardDesignStore.key("cgp_k"))
        defaults.set("workshop", forKey: CommonGroundCardDesignStore.key("cgp_s"))
        defaults.set("custom", forKey: CommonGroundCardDesignStore.key("cgp_t"))
        let model = stubbedModel(profiles: true, defaults: defaults)
        CommonGroundURLProtocol.stub("GET", "/v1/cloud/common-ground/profiles", [(200, #"""
        {"profiles":[{"profileId":"cgp_w","kind":"work","name":"","position":0},
                     {"profileId":"cgp_k","kind":"custom","name":"KAUST","position":1,"design":null},
                     {"profileId":"cgp_s","kind":"custom","name":"Summit","position":2,"design":"custom"},
                     {"profileId":"cgp_t","kind":"custom","name":"Trail","position":3}]}
        """#)])
        CommonGroundURLProtocol.stub("PUT", "/v1/cloud/common-ground/profiles/cgp_k", [(200, #"{"profileId":"cgp_k","kind":"custom","name":"KAUST","position":1,"design":"research"}"#)])
        CommonGroundURLProtocol.stub("PUT", "/v1/cloud/common-ground/profiles/cgp_t", [(503, #"{"errorCode":"unavailable","message":"x"}"#)])

        await model.loadProfiles()
        await model.designMove?.value
        let puts = CommonGroundURLProtocol.requests.filter { $0.request.httpMethod == "PUT" }
        XCTAssertEqual(puts.map { $0.request.url?.path ?? "" }, [
            "/v1/cloud/common-ground/profiles/cgp_k", "/v1/cloud/common-ground/profiles/cgp_t",
        ], "only profiles without a server design are sent")
        XCTAssertEqual(try body(puts[0]) as NSDictionary, ["design": "research"] as NSDictionary)
        XCTAssertEqual(model.design(ofProfile: "cgp_k"), .research)
        XCTAssertNil(defaults.string(forKey: CommonGroundCardDesignStore.key("cgp_k")), "sent, then dropped")
        XCTAssertNil(defaults.string(forKey: CommonGroundCardDesignStore.key("cgp_s")), "the server's design wins")
        XCTAssertEqual(defaults.string(forKey: CommonGroundCardDesignStore.key("cgp_t")), "custom", "kept after a server error")
        XCTAssertEqual(model.design(ofProfile: "cgp_s"), .custom)

        CommonGroundURLProtocol.stub("PUT", "/v1/cloud/common-ground/profiles/cgp_t", [(200, #"{"profileId":"cgp_t","kind":"custom","name":"Trail","position":3,"design":"custom"}"#)])
        await model.loadProfiles()
        await model.designMove?.value
        XCTAssertEqual(CommonGroundURLProtocol.requests.filter { $0.request.httpMethod == "PUT" }.count, 3, "the earlier sends are not repeated")
        XCTAssertNil(defaults.string(forKey: CommonGroundCardDesignStore.key("cgp_t")))
    }

    // MARK: Icon

    func testIconRoundTripsInProfilesAndTags() throws {
        let list = try JSONDecoder().decode(CommonGroundProfileList.self, from: Data(#"""
        {"profiles":[{"profileId":"cgp_k","kind":"custom","name":"KAUST","position":2,"design":"research","icon":"flask"},
                     {"profileId":"cgp_w","kind":"work","name":"","position":0,"icon":null},
                     {"profileId":"cgp_x","kind":"work","name":"","position":1,"icon":"unknown"}]}
        """#.utf8))
        XCTAssertEqual(list.profiles[0].icon, "flask")
        XCTAssertEqual(list.profiles[0].cardIcon, .flask)
        XCTAssertNil(list.profiles[1].icon)
        XCTAssertNil(list.profiles[1].cardIcon, "null draws the design's glyph")
        XCTAssertNil(list.profiles[2].cardIcon, "an unknown icon draws the design's glyph")

        let tag = try JSONDecoder().decode(CommonGroundProfileTag.self, from: Data(#"{"profileId":"cgp_p","kind":"custom","name":"Lab","design":"workshop","icon":"rocket"}"#.utf8))
        XCTAssertEqual(tag.cardIcon, .rocket)
        XCTAssertEqual(try JSONDecoder().decode(CommonGroundProfileTag.self, from: JSONEncoder().encode(tag)), tag)
        let person = try JSONDecoder().decode(CommonGroundPerson.self, from: Data(#"""
        {"accountId":"acct_b","name":"Priya","profile":{"profileId":"cgp_p","kind":"work","name":"","design":"health","icon":"coffee"}}
        """#.utf8))
        XCTAssertEqual(person.profile?.cardIcon, .coffee)
    }

    func testIconRequestBodies() throws {
        func json<T: Encodable>(_ value: T) throws -> [String: Any] {
            try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(value)) as? [String: Any])
        }
        let draft = try json(CommonGroundNewProfile(kind: .work, design: .health, icon: .star))
        XCTAssertEqual(draft["icon"] as? String, "star")
        XCTAssertEqual(draft["design"] as? String, "health")
        XCTAssertNil(try json(CommonGroundNewProfile(kind: .work))["icon"])

        XCTAssertEqual(try json(CommonGroundProfileEdit(icon: "globe"))["icon"] as? String, "globe")
        let reset = try json(CommonGroundProfileEdit(icon: .some(nil)))
        XCTAssertTrue(reset.keys.contains("icon"), "a reset sends the key")
        XCTAssertTrue(reset["icon"] is NSNull, "a reset sends null")
        XCTAssertFalse(try json(CommonGroundProfileEdit(name: "Lab")).keys.contains("icon"), "left out keeps the icon")
    }

    func testNewCardSendsItsLook() async throws {
        let model = stubbedModel(profiles: true, defaults: freshDefaults())
        CommonGroundURLProtocol.stub("POST", "/v1/cloud/common-ground/profiles", [(201, #"{"profileId":"cgp_m","kind":"work","name":"","position":0,"design":"research","icon":"book"}"#)])
        CommonGroundURLProtocol.stub("GET", "/v1/cloud/common-ground/card", [(200, CommonGroundTests.buildingJSON)])

        await model.createCard(.work, name: "", focus: "", look: .research, icon: .book)
        let sent = try body(XCTUnwrap(CommonGroundURLProtocol.requests.last { $0.request.httpMethod == "POST" }))
        XCTAssertEqual(sent["kind"] as? String, "work", "the kind follows the card, not its background")
        XCTAssertEqual(sent["design"] as? String, "research")
        XCTAssertEqual(sent["icon"] as? String, "book")
        XCTAssertEqual(model.walletCards.first { $0.id == "cgp_m" }?.icon, .book)
    }

    func testCardLookAppliesAtOnceAndRollsBack() async throws {
        let model = stubbedModel(profiles: true, defaults: freshDefaults())
        CommonGroundURLProtocol.stub("GET", "/v1/cloud/common-ground/profiles", [(200, #"""
        {"profiles":[{"profileId":"cgp_w","kind":"work","name":"","position":0}]}
        """#)])
        await model.loadProfiles()
        let path = "/v1/cloud/common-ground/profiles/cgp_w"

        CommonGroundURLProtocol.stub("PUT", path, [(200, #"{"profileId":"cgp_w","kind":"work","name":"","position":0,"icon":"heart"}"#)])
        let pending = Task { await model.setCardLook("cgp_w", icon: .some(.heart)) }
        for _ in 0..<20 where model.profile("cgp_w")?.icon == nil { await Task.yield() }
        XCTAssertEqual(model.profile("cgp_w")?.cardIcon, .heart, "applied before the server answers")
        let iconSaved = await pending.value
        XCTAssertTrue(iconSaved)
        XCTAssertEqual(try body(XCTUnwrap(CommonGroundURLProtocol.requests.last)) as NSDictionary, ["icon": "heart"] as NSDictionary)

        CommonGroundURLProtocol.stub("PUT", path, [(500, #"{"errorCode":"internal","message":"x"}"#)])
        let refused = await model.setCardLook("cgp_w", design: .daily, icon: .some(.camera))
        XCTAssertFalse(refused)
        XCTAssertEqual(model.design(ofProfile: "cgp_w"), .work, "the old background comes back")
        XCTAssertEqual(model.profile("cgp_w")?.cardIcon, .heart, "the old icon comes back")
        XCTAssertNotNil(model.notice)

        CommonGroundURLProtocol.stub("PUT", path, [(200, #"{"profileId":"cgp_w","kind":"work","name":"","position":0,"design":"daily","icon":null}"#)])
        let resetOK = await model.setCardLook("cgp_w", design: .daily, icon: .some(nil))
        XCTAssertTrue(resetOK)
        let reset = try body(XCTUnwrap(CommonGroundURLProtocol.requests.last))
        XCTAssertEqual(reset["design"] as? String, "daily")
        XCTAssertTrue(reset["icon"] is NSNull)
        XCTAssertEqual(model.design(ofProfile: "cgp_w"), .daily)
        XCTAssertNil(model.profile("cgp_w")?.cardIcon)

        let before = CommonGroundURLProtocol.requests.count
        let unchanged = await model.setCardLook("cgp_w", design: .daily)
        XCTAssertTrue(unchanged)
        XCTAssertEqual(CommonGroundURLProtocol.requests.count, before, "the same look sends nothing")
    }

    func testIconSymbols() {
        XCTAssertEqual(CommonGroundCardIcon.allCases.map(\.rawValue), [
            "briefcase", "leaf", "sun", "flask", "book", "microscope", "graduation", "pin", "star",
            "heart", "chat", "globe", "music", "camera", "code", "calendar", "rocket", "coffee",
        ])
        XCTAssertEqual(CommonGroundCardIcon.briefcase.symbol, "briefcase.fill")
        XCTAssertEqual(CommonGroundCardIcon.sun.symbol, "sun.max.fill")
        XCTAssertEqual(CommonGroundCardIcon.graduation.symbol, "graduationcap.fill")
        XCTAssertEqual(CommonGroundCardIcon.pin.symbol, "mappin")
        XCTAssertEqual(CommonGroundCardIcon.chat.symbol, "bubble.left.fill")
        XCTAssertEqual(CommonGroundCardIcon.code.symbol, "chevron.left.forwardslash.chevron.right")
        XCTAssertEqual(CommonGroundCardIcon.coffee.symbol, "cup.and.saucer.fill")
        XCTAssertEqual(CommonGroundCardIcon.flask.symbols, ["flask.fill", "testtube.2"])
        XCTAssertEqual(CommonGroundCardIcon.microscope.symbols, ["microscope", "magnifyingglass"])
        XCTAssertEqual(CommonGroundCardIcon.rocket.symbols, ["rocket.fill", "paperplane.fill"])
        for icon in CommonGroundCardIcon.allCases {
            XCTAssertNotNil(UIImage(systemName: icon.symbol), "\(icon) draws")
        }
    }

    func testAllSixteenDesignsDecodeAndDraw() throws {
        let names = ["work", "health", "daily", "workshop", "research", "custom",
                     "ocean", "sky", "rose", "coral", "amber", "forest", "lavender", "graphite", "mint", "olive"]
        XCTAssertEqual(CommonGroundCardDesign.allCases.map(\.rawValue), names)
        XCTAssertEqual(CommonGroundCardDesign.kinds.count, 6)
        XCTAssertEqual(CommonGroundCardDesign.colours.count, 10)
        XCTAssertEqual(Set(CommonGroundCardDesign.kinds).union(CommonGroundCardDesign.colours).count, 16)
        for name in names {
            let profile = try JSONDecoder().decode(CommonGroundProfileSummary.self, from: Data(#"{"profileId":"cgp_h","kind":"health","name":"","design":"\#(name)"}"#.utf8))
            let design = profile.cardDesign
            XCTAssertEqual(design.rawValue, name, "\(name) decodes")
            if design.isColour {
                XCTAssertEqual(profile.glyphSymbol, "leaf", "\(name) keeps the kind's glyph")
                XCTAssertEqual(design.kind, .custom)
            }
            XCTAssertNotNil(UIImage(systemName: profile.glyphSymbol), "\(name) glyph draws")
            for scheme in [ColorScheme.light, .dark] {
                let card = ProfileCardView(design: design, kindDesign: profile.kindDesign, name: "Card", bottom: .topics(["Agents"]), width: 338)
                    .environment(\.colorScheme, scheme)
                let renderer = ImageRenderer(content: card)
                let image = try XCTUnwrap(renderer.uiImage, "\(name) draws in \(scheme)")
                XCTAssertEqual(image.size.width, 338, accuracy: 1)
            }
        }
        XCTAssertEqual(CommonGroundCardDesign.firstAvailable(in: []), .work, "New card opens on a kind")

        XCTAssertEqual(CommonGroundCardDesign.backgrounds.map(\.rawValue), names, "the sheet shows the kinds, then the colours")
        XCTAssertEqual(Set(CommonGroundCardDesign.backgrounds.map(\.baseHex)).count, 16, "each swatch has its own colour")
        XCTAssertEqual(CommonGroundCardDesign.work.baseHex, 0x24335f)
        XCTAssertEqual(CommonGroundCardDesign.research.baseHex, 0xc4643f)
        XCTAssertEqual(CommonGroundCardDesign.ocean.baseHex, 0x0f6e73)
    }

    // MARK: Room preview

    func testRoomPreviewDecodes() throws {
        let preview = try JSONDecoder().decode(CommonGroundRoomPreview.self, from: Data(#"{"code":"0427","name":"Agents meetup","kind":"work","memberCount":1,"member":false}"#.utf8))
        XCTAssertEqual(preview.title, "Agents meetup")
        XCTAssertEqual(preview.detail, "Work · 1 person")
        XCTAssertFalse(preview.member)
        let bare = try JSONDecoder().decode(CommonGroundRoomPreview.self, from: Data(#"{"code":"0427","name":" ","kind":null,"memberCount":6}"#.utf8))
        XCTAssertEqual(bare.title, "Room 0427")
        XCTAssertEqual(bare.detail, "6 people")
        XCTAssertNil(bare.kind)
    }

    func testRoomPreviewSuggestsACard() async throws {
        let model = stubbedModel(profiles: true, defaults: freshDefaults())
        CommonGroundURLProtocol.stub("GET", "/v1/cloud/common-ground/profiles", [(200, CommonGroundProfileTests.profilesJSON)])
        CommonGroundURLProtocol.stub("GET", "/v1/cloud/common-ground/rooms/0427/preview", [(200, #"""
        {"code":"0427","name":"Running club","kind":"health","memberCount":8,"member":false}
        """#)])
        await model.loadProfiles()
        XCTAssertEqual(model.roomTitle("0427"), "Room 0427")
        XCTAssertNil(model.suggestedKind(ofRoom: "0427"))

        let lookup = await model.previewRoom("0427")
        guard case .found(let room) = lookup else { return XCTFail("expected a room, got \(lookup)") }
        XCTAssertEqual(room.name, "Running club")
        XCTAssertEqual(model.roomTitle("0427"), "Running club")
        XCTAssertEqual(model.roomDetail("0427"), "Health · 8 people")
        let kind = model.suggestedKind(ofRoom: "0427")
        XCTAssertEqual(CommonGroundProfileChoice.suggested(roomKind: kind, in: model.shareChoices), "cgp_h")
        XCTAssertEqual(CommonGroundProfileChoice.preselected(roomKind: kind, current: "cgp_w", in: model.shareChoices), "cgp_h")
        XCTAssertEqual(CommonGroundURLProtocol.paths.filter { $0.hasSuffix("/preview") }.count, 1)
    }

    func testRoomPreviewFailures() async {
        let model = stubbedModel(profiles: true, defaults: freshDefaults())
        let path = "/v1/cloud/common-ground/rooms/9999/preview"
        CommonGroundURLProtocol.stub("GET", path, [(404, #"{"errorCode":"common_ground_room_not_found","message":"Room not found."}"#)])
        let missing = await model.previewRoom("9999")
        XCTAssertEqual(missing, .failed("Room not found."))
        XCTAssertNil(model.roomDetail("9999"))

        CommonGroundURLProtocol.stub("GET", path, [(409, #"{"errorCode":"common_ground_no_card","message":"x"}"#)])
        let noCard = await model.previewRoom("9999")
        XCTAssertEqual(noCard, .failed("Build your profile first."))

        CommonGroundURLProtocol.stub("GET", path, [(429, #"{"errorCode":"rate_limited","message":"x"}"#), (200, #"{"code":"9999","name":"Later"}"#)])
        let before = CommonGroundURLProtocol.requests.count
        let limited = await model.previewRoom("9999")
        XCTAssertEqual(limited, .failed("Try again in a minute."))
        XCTAssertEqual(CommonGroundURLProtocol.requests.count, before + 1, "never retried")

        CommonGroundURLProtocol.stub("GET", "/v1/cloud/common-ground/rooms/1111/preview", [(404, #"{"errorCode":"not_found","message":"Not found."}"#)])
        let older = await model.previewRoom("1111")
        XCTAssertEqual(older, .unavailable, "a server without the route joins as before")
    }

    func testMemberPreviewAndSuggestedCard() async throws {
        let model = stubbedModel(profiles: true, defaults: freshDefaults())
        CommonGroundURLProtocol.stub("GET", "/v1/cloud/common-ground/profiles", [(200, CommonGroundProfileTests.profilesJSON)])
        CommonGroundURLProtocol.stub("GET", "/v1/cloud/common-ground/rooms/0427/preview", [(200, #"{"code":"0427","name":"Lab","kind":"work","memberCount":3,"member":true,"profileId":"cgp_h"}"#)])
        CommonGroundURLProtocol.stub("GET", "/v1/cloud/common-ground/rooms/0533/preview", [(200, #"{"code":"0533","name":"Run","kind":"work","memberCount":2,"member":false,"suggestedProfileId":"cgp_h"}"#)])
        await model.loadProfiles()
        guard case .found(let member) = await model.previewRoom("0427") else { return XCTFail("expected a room") }
        XCTAssertTrue(member.member)
        XCTAssertEqual(model.sharingLine(inRoom: "0427"), "Sharing: Health", "a member keeps the card shared there")
        _ = await model.previewRoom("0533")
        XCTAssertEqual(model.preselectedProfile(forRoom: "0533"), "cgp_h", "the server's pick wins over the kind")
        model.roomPreviews["0533"]?.suggestedProfileId = "cgp_k"
        XCTAssertEqual(model.preselectedProfile(forRoom: "0533"), "cgp_w", "a card without topics falls back to the kind")
        XCTAssertEqual(model.joinRequest(profileId: "cgp_h").profileId, "cgp_h")
        XCTAssertEqual(model.currentProfileID, "cgp_w", "joining leaves the selected card alone")
    }

    func testStaleCodeLookupIsDropped() async throws {
        let model = stubbedModel(profiles: true, defaults: freshDefaults())
        CommonGroundURLProtocol.stub("GET", "/v1/cloud/common-ground/rooms/1111/preview", [(200, #"{"code":"1111","name":"Old"}"#)])
        CommonGroundURLProtocol.stub("GET", "/v1/cloud/common-ground/rooms/2222/preview", [(200, #"{"code":"2222","name":"New"}"#)])
        let first = Task { await model.previewRoom("1111") }
        while model.latestLookup != "1111" { await Task.yield() }
        let second = await model.previewRoom("2222")
        let stale = await first.value
        XCTAssertEqual(stale, .stale)
        XCTAssertNil(model.roomPreviews["1111"], "a stale answer is not kept")
        guard case .found(let room) = second else { return XCTFail("expected the latest room") }
        XCTAssertEqual(room.title, "New")
    }

    func testEmptyNameRestoresTheKindsName() async throws {
        let model = stubbedModel(profiles: true, defaults: freshDefaults())
        CommonGroundURLProtocol.stub("GET", "/v1/cloud/common-ground/profiles", [(200, CommonGroundProfileTests.profilesJSON)])
        CommonGroundURLProtocol.stub("PUT", "/v1/cloud/common-ground/profiles/cgp_h", [(200, #"{"profileId":"cgp_h","kind":"health","name":"","position":1}"#)])
        await model.loadProfiles()
        let restored = await model.updateProfile("cgp_h", name: "  ")
        XCTAssertTrue(restored)
        let sent = try body(XCTUnwrap(CommonGroundURLProtocol.requests.last { $0.request.httpMethod == "PUT" }))
        XCTAssertEqual(sent["name"] as? String, "", "the server restores the kind's name")
        let before = CommonGroundURLProtocol.requests.count
        let refused = await model.updateProfile("cgp_k", name: "")
        XCTAssertFalse(refused)
        XCTAssertEqual(model.nameRefusal(" ", for: "cgp_k"), "A custom card needs a name.")
        XCTAssertEqual(CommonGroundURLProtocol.requests.count, before, "a custom card is never sent without a name")
    }

    // MARK: Sync

    func testHomeReloadsCardsAtMostEvery30Seconds() async throws {
        let model = stubbedModel(profiles: true, defaults: freshDefaults())
        let path = "/v1/cloud/common-ground/profiles"
        let card = "GET /v1/cloud/common-ground/card"
        CommonGroundURLProtocol.stub("GET", path, [(200, #"{"profiles":[{"profileId":"cgp_w","kind":"work","name":"","position":0,"hasCard":true,"design":"ocean","icon":"flask"}]}"#)])
        CommonGroundURLProtocol.stub("GET", "/v1/cloud/common-ground/card", [(200, #"{"card":null,"sharing":true,"build":{"status":"idle"}}"#)])
        let start = Date()
        await model.refreshHome(now: start)
        XCTAssertEqual(model.walletCards.first?.design, .ocean)
        CommonGroundURLProtocol.stub("GET", path, [(200, #"{"profiles":[{"profileId":"cgp_w","kind":"work","name":"","position":0,"hasCard":true,"design":"research","icon":"rocket"}]}"#)])
        let cardCalls = CommonGroundURLProtocol.paths.filter { $0 == card }.count
        await model.refreshHome(now: start.addingTimeInterval(10))
        XCTAssertEqual(model.walletCards.first?.design, .ocean, "nothing reloads within 30 seconds")
        await model.refreshHome(now: start.addingTimeInterval(31))
        XCTAssertEqual(model.walletCards.first?.design, .research, "a colour changed on another device shows here")
        XCTAssertEqual(model.walletCards.first?.icon, .rocket)
        XCTAssertEqual(CommonGroundURLProtocol.paths.filter { $0 == card }.count, cardCalls + 1, "the current card reloads too")
    }
}
