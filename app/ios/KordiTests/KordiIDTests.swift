import XCTest
@testable import Kordi

final class KordiIDTests: XCTestCase {
    func testNumberFormats() {
        XCTAssertEqual(KordiID.normalize("@482731906"), "482731906")
        XCTAssertEqual(KordiID.normalize("482 731 906"), "482731906")
        XCTAssertEqual(KordiID.normalize("482-731-906"), "482731906")
        XCTAssertNil(KordiID.normalize("48273190"))
        XCTAssertNil(KordiID.normalize("082731906"))
        XCTAssertNil(KordiID.normalize("123456789012"))
    }

    func testHandles() {
        XCTAssertEqual(KordiID.normalize("@shuyhere"), "shuyhere")
        XCTAssertEqual(KordiID.normalize(" ShuYhere "), "ShuYhere")
        XCTAssertNil(KordiID.normalize("shu_yhere"))
        XCTAssertNil(KordiID.normalize("ab"))
        XCTAssertNil(KordiID.normalize("a b"))
        XCTAssertNil(KordiID.normalize(String(repeating: "a", count: 31)))
        XCTAssertNil(KordiID.normalize("@"))
        XCTAssertNil(KordiID.normalize(nil))
    }
}
