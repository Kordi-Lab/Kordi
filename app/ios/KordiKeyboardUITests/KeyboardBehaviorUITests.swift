import UIKit
import XCTest

final class KeyboardBehaviorUITests: XCTestCase {
    @MainActor
    func testWallpaperAndInteractiveKeyboardDismissalInTheActualApp() throws {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["--preview-data", "-kordi.chatTheme.v1", "sand"]
        app.launch()
        let chat = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Maya Chen")).firstMatch
        XCTAssertTrue(chat.waitForExistence(timeout: 15))
        chat.tap()
        let editor = app.textViews["Message Maya Chen"]
        XCTAssertTrue(editor.waitForExistence(timeout: 10))
        editor.tap()
        let keyboard = app.keyboards.firstMatch
        XCTAssertTrue(keyboard.waitForExistence(timeout: 10))
        let introduction = keyboard.buttons["Continue"]
        if introduction.waitForExistence(timeout: 2) { introduction.tap() }
        let screenshot = XCUIScreen.main.screenshot()
        let attachment = XCTAttachment(screenshot: screenshot)
        attachment.name = "Actual keyboard over the chat wallpaper"
        attachment.lifetime = .keepAlways
        add(attachment)

        func pixel(_ point: CGPoint) throws -> [UInt8] {
            let image = screenshot.image
            let cgImage = try XCTUnwrap(image.cgImage)
            let scale = CGFloat(cgImage.width) / image.size.width
            let crop = try XCTUnwrap(cgImage.cropping(to: CGRect(
                x: point.x * scale, y: point.y * scale, width: 1, height: 1
            )))
            var bytes = [UInt8](repeating: 0, count: 4)
            let context = try XCTUnwrap(CGContext(data: &bytes, width: 1, height: 1,
                bitsPerComponent: 8, bytesPerRow: 4, space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
            context.draw(crop, in: CGRect(x: 0, y: 0, width: 1, height: 1))
            return bytes
        }
        // Accessibility's keyboard frame excludes the prediction bar. The
        // composer ends nine points above the actual input surface.
        let inputSurfaceTop = editor.frame.maxY + 9
        let chatBackground = try pixel(CGPoint(x: 3, y: inputSurfaceTop - 5))
        XCTAssertLessThan(chatBackground[2], 245, "The fixture must use the sand wallpaper")
        for point in [CGPoint(x: 3, y: inputSurfaceTop + 3),
                      CGPoint(x: 3, y: app.frame.maxY - 5)] {
            let outsideCorner = try pixel(point)
            for channel in 0..<3 {
                XCTAssertEqual(Double(outsideCorner[channel]), Double(chatBackground[channel]), accuracy: 10,
                    "The keyboard's rounded corners must expose wallpaper, not a white backing")
            }
        }

        func point(_ x: CGFloat, _ y: CGFloat) -> XCUICoordinate {
            app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: x, dy: y))
        }
        let centerX = app.frame.minX + 25
        let start = point(centerX, editor.frame.minY - 35)
        // Scrolling history upward must not dismiss the keyboard immediately.
        start.press(forDuration: 0.05, thenDragTo: point(centerX, editor.frame.minY - 135))
        XCTAssertTrue(keyboard.exists)
        let immediateDismissal = expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: keyboard)
        immediateDismissal.isInverted = true
        wait(for: [immediateDismissal], timeout: 0.6)
        // Pulling the keyboard fully down dismisses it, and focus can be restored.
        point(centerX, editor.frame.minY - 25).press(forDuration: 0.05,
            thenDragTo: point(centerX, app.frame.maxY - 10),
            withVelocity: .slow, thenHoldForDuration: 0.3)
        let dismissed = expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: keyboard)
        wait(for: [dismissed], timeout: 5)
        editor.tap()
        XCTAssertTrue(keyboard.waitForExistence(timeout: 5))
    }
}
