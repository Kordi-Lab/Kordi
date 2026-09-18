import XCTest
@testable import Kordi

final class VoiceMessageTests: XCTestCase {
    func testGroupEnvelopeDoesNotRepeatVoiceAudioAsAFileAttachment() throws {
        let audio = CloudMessageAttachment(attachmentId: "voice-audio", name: "Voice message.m4a",
            kind: "file", mimeType: "audio/mp4", sizeBytes: 1024, downloadUrl: nil, previewUrl: nil)
        let document = CloudMessageAttachment(attachmentId: "notes", name: "Notes.pdf",
            kind: "file", mimeType: "application/pdf", sizeBytes: 512, downloadUrl: nil, previewUrl: nil)
        let voice = VoiceMessage(mediaId: audio.attachmentId, mimeType: "audio/mp4", durationMs: 2000,
            waveformSamples: [0.2], transcript: "")
        let payload = CloudGroupMessagePayload(id: "voice-message", senderAccountId: "sender", text: "",
            createdAtMs: 1, senderKind: "human", senderDisplayName: "Sender", deliveryState: "complete",
            replyToMessageId: nil, requestId: nil, attachments: [audio, document],
            messageKind: "voice", voiceMessage: voice)
        let decoded = try JSONDecoder().decode(CloudGroupMessagePayload.self, from: JSONEncoder().encode(payload))
        XCTAssertEqual(decoded.attachments?.map(\.attachmentId), [document.attachmentId])
        XCTAssertEqual(decoded.voiceMessage?.mediaId, audio.attachmentId)
    }

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
    func testHoldToTalkIntentFollowsFingerPositionAroundTheArc() {
        let size = CGSize(width: 400, height: 1_000)
        func intent(_ x: CGFloat, _ y: CGFloat, from previous: VoiceRecordingGestureIntent) -> VoiceRecordingGestureIntent {
            VoiceHoldToTalkTargetLayout.intent(for: CGPoint(x: x, y: y), in: size, previous: previous)
        }

        // The arc top is at 830 and the center line at x = 200.
        XCTAssertEqual(intent(100, 900, from: .hold), .hold)
        XCTAssertEqual(intent(100, 600, from: .hold), .cancel)
        XCTAssertEqual(intent(300, 600, from: .hold), .convertToText)
        XCTAssertEqual(intent(200, 600, from: .hold), .convertToText)
        XCTAssertEqual(intent(199, 600, from: .hold), .cancel)
    }

    @MainActor
    func testHoldToTalkIntentUsesHysteresisAtTheArcEdge() {
        let size = CGSize(width: 400, height: 1_000)
        func intent(_ x: CGFloat, _ y: CGFloat, from previous: VoiceRecordingGestureIntent) -> VoiceRecordingGestureIntent {
            VoiceHoldToTalkTargetLayout.intent(for: CGPoint(x: x, y: y), in: size, previous: previous)
        }

        // Leaving the send zone requires moving 12 pt above the arc top.
        XCTAssertEqual(intent(100, 829, from: .hold), .hold)
        XCTAssertEqual(intent(100, 818, from: .hold), .hold)
        XCTAssertEqual(intent(100, 817.9, from: .hold), .cancel)
        XCTAssertEqual(intent(300, 817.9, from: .hold), .convertToText)

        // Returning to the send zone requires moving 12 pt below the arc top.
        XCTAssertEqual(intent(100, 831, from: .cancel), .cancel)
        XCTAssertEqual(intent(100, 842, from: .cancel), .cancel)
        XCTAssertEqual(intent(100, 842.1, from: .cancel), .hold)
        XCTAssertEqual(intent(300, 842, from: .convertToText), .convertToText)
        XCTAssertEqual(intent(300, 842.1, from: .convertToText), .hold)
    }

    @MainActor
    func testHoldToTalkIntentUsesHysteresisAtTheCenterLine() {
        let size = CGSize(width: 400, height: 1_000)
        func intent(_ x: CGFloat, _ y: CGFloat, from previous: VoiceRecordingGestureIntent) -> VoiceRecordingGestureIntent {
            VoiceHoldToTalkTargetLayout.intent(for: CGPoint(x: x, y: y), in: size, previous: previous)
        }

        XCTAssertEqual(intent(205, 600, from: .cancel), .cancel)
        XCTAssertEqual(intent(210, 600, from: .cancel), .cancel)
        XCTAssertEqual(intent(210.1, 600, from: .cancel), .convertToText)
        XCTAssertEqual(intent(195, 600, from: .convertToText), .convertToText)
        XCTAssertEqual(intent(190, 600, from: .convertToText), .convertToText)
        XCTAssertEqual(intent(189.9, 600, from: .convertToText), .cancel)
    }

    @MainActor
    func testHoldToTalkLayoutPlacesTargetsAboveTheArc() {
        let layout = VoiceHoldToTalkTargetLayout(size: CGSize(width: 400, height: 1_000))

        XCTAssertEqual(layout.arcTop, 830, accuracy: 0.001)
        XCTAssertEqual(layout.midX, 200, accuracy: 0.001)
        XCTAssertEqual(layout.bubbleCenter.x, 200, accuracy: 0.001)
        XCTAssertEqual(layout.bubbleCenter.y, 430, accuracy: 0.001)
        XCTAssertEqual(layout.cancelTargetCenter.x, 100, accuracy: 0.001)
        XCTAssertEqual(layout.cancelTargetCenter.y, 730, accuracy: 0.001)
        XCTAssertEqual(layout.convertTargetCenter.x, 300, accuracy: 0.001)
        XCTAssertEqual(layout.convertTargetCenter.y, 730, accuracy: 0.001)

        // Every point of each drawn target resolves to that target.
        let radius = VoiceHoldToTalkTargetLayout.targetDiameter / 2
        let cancelBottom = CGPoint(x: layout.cancelTargetCenter.x, y: layout.cancelTargetCenter.y + radius)
        let convertBottom = CGPoint(x: layout.convertTargetCenter.x, y: layout.convertTargetCenter.y + radius)
        XCTAssertLessThan(cancelBottom.y, layout.arcTop - VoiceHoldToTalkTargetLayout.verticalHysteresis)
        XCTAssertEqual(layout.intent(for: cancelBottom, previous: .hold), .cancel)
        XCTAssertEqual(layout.intent(for: convertBottom, previous: .hold), .convertToText)
        XCTAssertLessThan(
            layout.cancelTargetCenter.x + radius,
            layout.midX - VoiceHoldToTalkTargetLayout.horizontalHysteresis
        )
        XCTAssertGreaterThan(
            layout.convertTargetCenter.x - radius,
            layout.midX + VoiceHoldToTalkTargetLayout.horizontalHysteresis
        )
    }

    @MainActor
    func testHoldToTalkTimerCountsDownDuringTheLastTenSeconds() {
        XCTAssertEqual(VoiceHoldToTalkOverlay.timerText(durationMs: 0), "0:00")
        XCTAssertEqual(VoiceHoldToTalkOverlay.timerText(durationMs: 4_000), "0:04")
        XCTAssertEqual(VoiceHoldToTalkOverlay.timerText(durationMs: 4_900), "0:04")
        XCTAssertEqual(VoiceHoldToTalkOverlay.timerText(durationMs: 49_999), "0:49")
        XCTAssertEqual(VoiceHoldToTalkOverlay.timerText(durationMs: 50_000), "10s left")
        XCTAssertEqual(VoiceHoldToTalkOverlay.timerText(durationMs: 55_400), "5s left")
        XCTAssertEqual(VoiceHoldToTalkOverlay.timerText(durationMs: 59_000), "1s left")
        XCTAssertEqual(VoiceHoldToTalkOverlay.timerText(durationMs: 60_000), "1s left")
    }

    @MainActor
    func testHoldToTalkBubbleGrowsWithRecordingLength() {
        XCTAssertEqual(VoiceHoldToTalkOverlay.bubbleWidth(durationMs: 0), 150)
        XCTAssertEqual(VoiceHoldToTalkOverlay.bubbleWidth(durationMs: 4_500), 190)
        XCTAssertEqual(VoiceHoldToTalkOverlay.bubbleWidth(durationMs: 60_000), 250)
    }

    @MainActor
    func testHoldToTalkLevelBarsUseRecentSamples() {
        let empty = VoiceHoldToTalkOverlay.levelBarHeights([])
        XCTAssertEqual(empty.count, 16)
        XCTAssertTrue(empty.allSatisfy { $0 == VoiceHoldToTalkOverlay.minimumBarHeight })

        let samples = Array(repeating: 0.08, count: 20) + [1.0]
        let heights = VoiceHoldToTalkOverlay.levelBarHeights(samples)
        XCTAssertEqual(heights.count, 16)
        XCTAssertEqual(heights[15], VoiceHoldToTalkOverlay.maximumBarHeight, accuracy: 0.001)
        XCTAssertEqual(heights[0], VoiceHoldToTalkOverlay.minimumBarHeight, accuracy: 0.001)
    }

    @MainActor
    func testHoldToTalkStatusMatchesIntent() {
        XCTAssertEqual(VoiceHoldToTalkOverlay.statusText(stage: .recording, intent: .hold).title, "Release to send")
        XCTAssertEqual(VoiceHoldToTalkOverlay.statusText(stage: .recording, intent: .cancel).title, "Release to cancel")
        XCTAssertEqual(
            VoiceHoldToTalkOverlay.statusText(stage: .recording, intent: .convertToText).title,
            "Release to convert to text"
        )
        XCTAssertEqual(VoiceHoldToTalkOverlay.statusText(stage: .tooShort, intent: .hold).subtitle, "Hold for at least 1 second")
    }

    @MainActor
    func testHoldToTalkPresentationShowsTooShortThenDismisses() async throws {
        let presentation = VoiceHoldToTalkPresentation()
        presentation.present()
        presentation.intent = .cancel
        XCTAssertEqual(presentation.stage, .recording)

        presentation.showTooShort()
        XCTAssertEqual(presentation.stage, .tooShort)
        XCTAssertEqual(presentation.intent, .hold)

        try await Task.sleep(for: .milliseconds(1_300))
        XCTAssertNil(presentation.stage)
        XCTAssertFalse(presentation.isOverlayMounted)

        presentation.showTooShort()
        presentation.present()
        try await Task.sleep(for: .milliseconds(1_300))
        XCTAssertEqual(presentation.stage, .recording)
        XCTAssertTrue(presentation.isOverlayMounted)
    }

    @MainActor
    func testHoldToTalkActivationDelayKeepsFeedbackResponsive() {
        XCTAssertLessThanOrEqual(VoiceRecordingGestureCapture.activationDelay, 0.2)
        XCTAssertGreaterThan(VoiceRecordingGestureCapture.activationDelay, 0)
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
