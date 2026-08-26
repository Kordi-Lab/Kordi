import XCTest
@testable import Kordi

final class VoiceMessageTests: XCTestCase {
    @MainActor
    func testWaveformDownsamplingKeepsRealPeaks() {
        XCTAssertEqual(
            VoiceMessageRecorder.downsample([0.1, 0.2, 0.8, 1.0], count: 2),
            [0.2, 1.0]
        )
        XCTAssertEqual(
            VoiceMessageRecorder.trimmedWaveform(
                [0.1, 0.2, 0.8, 1.0],
                durationMs: 4_000,
                startMs: 1_000,
                endMs: 3_000
            ),
            [0.2, 0.8]
        )
    }

    @MainActor
    func testShortVoiceMessagesUseACompactBubbleWidth() {
        XCTAssertLessThan(
            VoiceMessageBubbleContent.compactWidth(durationMs: 1_000),
            VoiceMessageBubbleContent.compactWidth(durationMs: 60_000)
        )
        XCTAssertLessThanOrEqual(
            VoiceMessageBubbleContent.compactWidth(durationMs: 60_000),
            260
        )
    }

    @MainActor
    func testVoiceMessagesShorterThanOneSecondAreRejected() {
        XCTAssertFalse(VoiceMessageRecorder.isDurationSendable(999))
        XCTAssertTrue(VoiceMessageRecorder.isDurationSendable(1_000))
    }

    @MainActor
    func testHoldToTalkGestureRequiresDistanceInsideSideSectors() {
        XCTAssertEqual(VoiceHoldToTalkTargetLayout.intent(for: CGSize(width: -72, height: -60)), .cancel)
        XCTAssertEqual(VoiceHoldToTalkTargetLayout.intent(for: CGSize(width: 72, height: -60)), .convertToText)
        XCTAssertEqual(VoiceHoldToTalkTargetLayout.intent(for: CGSize(width: -60, height: -40)), .hold)
        XCTAssertEqual(VoiceHoldToTalkTargetLayout.intent(for: CGSize(width: 0, height: -100)), .hold)
        XCTAssertEqual(VoiceHoldToTalkTargetLayout.intent(for: CGSize(width: 100, height: 0)), .hold)
        XCTAssertEqual(VoiceHoldToTalkTargetLayout.intent(for: CGSize(width: -100, height: -28)), .hold)
        XCTAssertEqual(VoiceHoldToTalkTargetLayout.intent(for: CGSize(width: 100, height: -28)), .hold)
    }

    @MainActor
    func testNativeTranscriptionFallsBackToChineseLocales() {
        XCTAssertEqual(
            VoiceMessageRecorder.transcriptionLocaleIdentifiers(preferred: "en-US"),
            ["en-US", "zh-CN", "zh-TW", "zh-HK"]
        )
    }

    func testVoiceContentUsesTypedBlockWithoutLegacyAttachmentMetadata() throws {
        let voice = VoiceMessage(
            mediaId: "att_voice",
            mimeType: "audio/mp4",
            durationMs: 12_000,
            waveformSamples: [0.1, 0.5, 1.0],
            transcript: "Meet me after lunch."
        )
        let attachment = CloudMessageAttachment(
            attachmentId: "att_voice",
            name: "Voice message.m4a",
            kind: "file",
            mimeType: "audio/mp4",
            sizeBytes: 1_024,
            downloadUrl: nil,
            previewUrl: nil
        )
        let content = CloudChatContent(
            body: voice.transcript,
            attachments: [attachment],
            voiceMessage: voice
        )
        let decoded = try JSONDecoder().decode(
            CloudChatContent.self,
            from: JSONEncoder().encode(content)
        )

        XCTAssertTrue(decoded.legacyAttachments.isEmpty)
        XCTAssertEqual(decoded.body, voice.transcript)
        XCTAssertEqual(decoded.voiceMessage, voice)
    }

    func testVoiceMessageRoundTripsInCachedChatMessage() throws {
        let voice = VoiceMessage(
            mediaId: "att_voice",
            mimeType: "audio/mp4",
            durationMs: 4_000,
            waveformSamples: [0.2, 0.7],
            transcript: "Hello from Kordi."
        )
        let message = ChatMessage(
            id: "voice-message",
            conversationId: "conversation",
            author: .me,
            authorName: "You",
            text: voice.transcript,
            createdAt: Date(timeIntervalSince1970: 1),
            deliveryState: .delivered,
            errorMessage: nil,
            requestMessageId: nil,
            messageKind: "voice",
            voiceMessage: voice
        )
        let decoded = try JSONDecoder().decode(
            ChatMessage.self,
            from: JSONEncoder().encode(message)
        )

        XCTAssertEqual(decoded.messageKind, "voice")
        XCTAssertEqual(decoded.voiceMessage, voice)
    }
}
