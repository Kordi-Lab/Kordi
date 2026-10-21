import XCTest
@testable import Kordi

/// Photos, Files and Links of the contact profile, collected from the chat.
@MainActor
final class ContactProfileSharedItemsTests: XCTestCase {
    private var calendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        return calendar
    }

    private let locale = Locale(identifier: "en_US")

    private func date(_ year: Int, _ month: Int, _ day: Int) -> Date {
        calendar.date(from: DateComponents(year: year, month: month, day: day, hour: 12))!
    }

    private func message(
        _ id: String,
        at createdAt: Date,
        text: String = "",
        attachments: [ChatAttachment] = [],
        messageKind: String? = nil,
        author: MessageAuthor = .person,
        deliveryState: MessageDeliveryState = .delivered
    ) -> ChatMessage {
        ChatMessage(
            id: id, conversationId: "person:acct_nadia", author: author, authorName: "Nadia",
            text: text, createdAt: createdAt, deliveryState: deliveryState, errorMessage: nil,
            requestMessageId: nil, attachments: attachments, messageKind: messageKind
        )
    }

    private func attachment(
        _ id: String,
        name: String,
        kind: ChatAttachmentKind,
        mime: String?,
        subtype: ChatAttachmentSubtype? = nil
    ) -> ChatAttachment {
        ChatAttachment(attachmentId: id, name: name, kind: kind, subtype: subtype, mimeType: mime, sizeBytes: 1_200, previewURL: nil)
    }

    func testPhotosAndFilesSplitWithVideosCountedAsPhotos() {
        let messages = [
            message("m1", at: date(2026, 10, 2), attachments: [
                attachment("img", name: "a.png", kind: .image, mime: "image/png"),
                attachment("pdf", name: "Grant.pdf", kind: .file, mime: "application/pdf"),
            ]),
            message("m2", at: date(2026, 10, 9), attachments: [
                attachment("vid", name: "clip.mp4", kind: .file, mime: "video/mp4"),
                attachment("md", name: "notes.md", kind: .file, mime: "text/markdown"),
            ]),
            message("m3", at: date(2026, 10, 10), attachments: [
                attachment("pending:upload", name: "b.png", kind: .image, mime: "image/png"),
                attachment("sticker", name: "s.webp", kind: .image, mime: "image/webp", subtype: .sticker),
            ]),
        ]
        let items = ContactProfileSharedItems(messages: messages)

        XCTAssertEqual(items.photos.map(\.attachment.id), ["vid", "img"], "newest first, video in Photos")
        XCTAssertEqual(items.photos.map(\.isVideo), [true, false])
        XCTAssertEqual(items.files.map(\.attachment.id), ["md", "pdf"])
        XCTAssertEqual(items.counts, .init(photos: 2, files: 2, links: 0))
    }

    func testSystemNoticesAndFailedLocalSendsAreSkipped() {
        let messages = [
            message("notice", at: date(2026, 10, 1), text: "https://example.com", messageKind: "session_pin_activity"),
            message("failed", at: date(2026, 10, 2), text: "https://failed.example.com",
                    attachments: [attachment("f", name: "a.png", kind: .image, mime: "image/png")],
                    author: .me, deliveryState: .failed),
        ]
        XCTAssertEqual(ContactProfileSharedItems(messages: messages).counts, .init())
    }

    func testLinksAreDistinctHttpURLsWithMarkdownTitles() {
        let messages = [
            message("m1", at: date(2026, 10, 1), text: "Old copy https://ARXIV.org/abs/1/ and mailto:a@b.com"),
            message("m2", at: date(2026, 10, 5), text: "Read [Transfer survey](https://arxiv.org/abs/1) and www.github.com/kordi"),
            message("m3", at: date(2026, 10, 6), text: "ftp://files.example.com plus http://example.org/page twice http://example.org/page"),
        ]
        let items = ContactProfileSharedItems(messages: messages)

        XCTAssertEqual(items.links.map(\.domain), ["example.org", "arxiv.org", "github.com"])
        XCTAssertEqual(items.links[1].title, "Transfer survey")
        XCTAssertEqual(items.links[1].messageId, "m2", "the newest mention wins")
        XCTAssertNil(items.links[0].title)
        XCTAssertEqual(items.links[0].displayURL, "example.org/page")
        XCTAssertEqual(items.count(.links), 3)
    }

    func testMonthGroupingAddsTheYearOutsideTheCurrentYear() {
        let now = date(2026, 10, 21)
        let messages = [
            message("a", at: date(2026, 10, 18), text: "https://a.example.com"),
            message("b", at: date(2026, 10, 3), text: "https://b.example.com"),
            message("c", at: date(2026, 9, 22), text: "https://c.example.com"),
            message("d", at: date(2025, 10, 9), text: "https://d.example.com"),
        ]
        let links = ContactProfileSharedItems(messages: messages).links
        let sections = ContactProfileMonthGrouping.sections(links, date: \.date, now: now, calendar: calendar, locale: locale)

        XCTAssertEqual(sections.map(\.title), ["October", "September", "October 2025"])
        XCTAssertEqual(sections.map { $0.items.map(\.domain) }, [["a.example.com", "b.example.com"], ["c.example.com"], ["d.example.com"]])
        XCTAssertEqual(sections.flatMap(\.items).count, links.count)
        XCTAssertEqual(ContactProfileMonthGrouping.dayLabel(date(2026, 10, 14), calendar: calendar, locale: Locale(identifier: "en_GB")), "14 Oct")
    }

    func testRowCountsEqualPageLengthsOnceTheChatIsLoaded() {
        let items = ContactProfileSharedItems(messages: [
            message("m1", at: date(2026, 10, 1), text: "https://a.example.com", attachments: [
                attachment("img", name: "a.png", kind: .image, mime: "image/png"),
                attachment("doc", name: "a.pdf", kind: .file, mime: "application/pdf"),
            ]),
        ])
        let profile = CloudContactProfile(
            accountId: "acct_nadia",
            shared: .init(mediaCount: 24, linkCount: 9, documentCount: 3, groups: [])
        )
        let subject = ContactProfileSubject(accountId: "acct_nadia", name: "Nadia")
        var presentation = ContactProfilePresentation(subject: subject, profile: profile, isFallback: false)

        // Before the history is loaded the server counts stand in.
        XCTAssertEqual(presentation.sharedCount(.photos), 24)
        XCTAssertEqual(presentation.sharedCount(.files), 3)
        XCTAssertEqual(presentation.sharedCount(.links), 9)

        presentation.localShared = items.counts
        for row in [ContactProfileSharedRow.photos, .files, .links] {
            XCTAssertEqual(presentation.sharedCount(row), row.page.map(items.count), "\(row)")
            XCTAssertEqual(presentation.sharedCount(row), 1)
        }

        // Local zeros win over server counts and mute the rows.
        presentation.localShared = .init()
        XCTAssertFalse(presentation.isSharedRowEnabled(.photos))
        XCTAssertTrue(presentation.showsNothingShared)
    }
}
