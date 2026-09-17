import Foundation
import Testing
@testable import Kordi

@MainActor
struct VoiceTranscriptionTests {
    func voice(_ status: VoiceTranscription.Status, text: String = "", version: String = "audio-v1") -> VoiceMessage {
        VoiceMessage(mediaId: "audio-v1", mimeType: "audio/mp4", durationMs: 2000,
            waveformSamples: [0.2], transcript: text,
            transcription: VoiceTranscription(status: status, sourceVersion: version, engine: "apple-speech-v1", attempts: 1))
    }

    @Test func statusesAndVersionsCannotMasqueradeAsSpeech() {
        for status in [VoiceTranscription.Status.pending, .failed, .unavailable] {
            #expect(voice(status, text: "not speech").spokenText.isEmpty)
        }
        #expect(voice(.ready, text: "old speech", version: "audio-v0").spokenText.isEmpty)
        #expect(voice(.ready, text: "Transcription unavailable.").spokenText.isEmpty)
        #expect(voice(.ready, text: "Meet at noon.").spokenText == "Meet at noon.")
    }

    @Test func failedRetryKeepsAudioIdentityAndSuccessfulRetryIsReused() async {
        var calls = 0
        let recorder = VoiceMessageRecorder(speechTranscriber: { _ in
            calls += 1
            return "Meet at noon."
        })
        let original = voice(.failed)
        let url = URL(fileURLWithPath: "/synthetic/audio.m4a")
        let ready = await recorder.transcribeExisting(original, url: url)
        #expect(ready.mediaId == original.mediaId)
        #expect(ready.transcription?.sourceVersion == original.mediaId)
        #expect(ready.transcription?.attempts == 2)
        #expect(ready.spokenText == "Meet at noon.")
        let reused = await recorder.transcribeExisting(ready, url: url)
        #expect(reused == ready)
        #expect(calls == 1)
    }

    @Test func silentPermissionDeniedAndRetryLimitStayExplicit() async {
        struct PermissionDenied: Error {}
        for transcribe in [ { (_: URL) async throws -> String in " " },
                            { (_: URL) async throws -> String in throw PermissionDenied() } ] {
            let recorder = VoiceMessageRecorder(speechTranscriber: transcribe)
            let result = await recorder.transcribeExisting(voice(.failed), url: URL(fileURLWithPath: "/synthetic/audio.m4a"))
            #expect(result.transcript.isEmpty)
            #expect(result.transcription?.status == .failed)
            #expect(result.transcription?.attempts == 2)
        }
    }

    @Test func exhaustedRetriesDoNotStartRecognition() async {
        var exhausted = voice(.failed)
        exhausted.transcription = VoiceTranscription(status: .failed, sourceVersion: exhausted.mediaId,
            engine: "apple-speech-v1", attempts: 3)
        var calls = 0
        let recorder = VoiceMessageRecorder(speechTranscriber: { _ in calls += 1; return "Hello" })
        let result = await recorder.transcribeExisting(exhausted, url: URL(fileURLWithPath: "/synthetic/audio.m4a"))
        #expect(result == exhausted)
        #expect(calls == 0)
    }

    @Test func metadataSurvivesWireAndCacheRoundTrip() throws {
        let original = voice(.ready, text: "Meet at noon.")
        let content = CloudChatContent(body: original.transcript, attachments: [], voiceMessage: original)
        let decoded = try JSONDecoder().decode(CloudChatContent.self, from: JSONEncoder().encode(content))
        #expect(decoded.voiceMessage == original)
    }

    @Test func sendingPreparesAudioWithoutTranscribing() async throws {
        var calls = 0
        let recorder = VoiceMessageRecorder(speechTranscriber: { _ in
            calls += 1
            return "Must not run."
        })
        let url = try recordingFixture()
        defer { recorder.cancel() }
        recorder.prepareRecording(at: url, durationMs: 2_000, waveformSamples: [0.2], autoSend: true)
        #expect(!recorder.isVisible)

        let pending = try #require(await recorder.prepareForSend())
        try await Task.sleep(for: .milliseconds(200))
        #expect(calls == 0)
        #expect(!pending.attachment.data.isEmpty)
        #expect(pending.transcript.isEmpty)
        #expect(pending.transcription?.status == .pending)
        #expect(pending.transcription?.attempts == 0)
        #expect(recorder.transcriptionPhase == .idle)

        // The uploaded copy binds its transcription to the uploaded media id.
        let uploaded = pending.voiceMessage(mediaId: "att_uploaded")
        #expect(uploaded.transcription?.sourceVersion == "att_uploaded")
        #expect(uploaded.isAwaitingFirstTranscription)
    }

    @Test func sendPathDoesNotWaitForTranscriptionBeforeUpload() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        let model = try String(contentsOf: root.appendingPathComponent("Kordi/App/AppModel.swift"), encoding: .utf8)
        let conversation = try String(
            contentsOf: root.appendingPathComponent("Kordi/Features/Conversation/ConversationView.swift"),
            encoding: .utf8
        )
        let send = try #require(model.range(of: "    func send(\n"))
        let upload = try #require(model.range(of: "let uploadedAttachments = try await attachmentUpload", range: send.upperBound..<model.endIndex))
        let beforeUpload = model[send.lowerBound..<upload.lowerBound]
        #expect(!model.contains("resolvedVoiceMessage"))
        #expect(!beforeUpload.contains(".transcript.trimmingCharacters"))
        #expect(!beforeUpload.contains("await agentVoiceTranscription"))
        #expect(beforeUpload.contains("startVoiceTranscription(optimisticVoice, isSender: true, persist: nil)"))
        #expect(!conversation.contains("finishTranscriptionForSend"))
    }

    @Test func convertToTextStillWaitsForTheTranscript() async throws {
        let recorder = VoiceMessageRecorder(speechTranscriber: { _ in "Converted words." })
        defer { recorder.cancel() }
        recorder.prepareRecording(at: try recordingFixture(), durationMs: 2_000,
            waveformSamples: [0.2], autoSend: false)
        #expect(recorder.isVisible)
        #expect(await recorder.prepareTranscript() == "Converted words.")
        #expect(recorder.pendingMessage?.transcription?.status == .ready)
        #expect(recorder.pendingMessage?.transcription?.attempts == 1)
    }

    @Test func cancelledConversionReturnsNoTranscript() async throws {
        let (speech, completion) = AsyncStream<String>.makeStream()
        let recorder = VoiceMessageRecorder(speechTranscriber: { _ in
            for await text in speech { return text }
            throw CancellationError()
        })
        defer { recorder.cancel(); completion.finish() }
        recorder.prepareRecording(at: try recordingFixture(), durationMs: 2_000,
            waveformSamples: [0.2], autoSend: false)
        let conversion = Task { await recorder.prepareTranscript() }
        try await Task.sleep(for: .milliseconds(100))
        recorder.cancel()
        completion.yield("Late words.")
        #expect(await conversion.value == nil)
        #expect(recorder.pendingMessage == nil)
        #expect(recorder.phase == .idle)
    }

    @Test func untranscribedMessagesOfferTranscribeInsteadOfPending() {
        var pending = voice(.pending)
        pending.transcription = VoiceTranscription(status: .pending, sourceVersion: "audio-v1",
            engine: "apple-speech-v1", attempts: 0)
        for isSender in [true, false] {
            #expect(VoiceTranscriptState.resolve(voice: pending, localResult: nil, isRunning: false,
                lastAttemptFailed: false, isSender: isSender) == .notTranscribed)
            #expect(VoiceTranscriptState.resolve(voice: pending, localResult: nil, isRunning: true,
                lastAttemptFailed: false, isSender: isSender) == .transcribing)
        }
        let legacy = VoiceMessage(mediaId: "audio-v1", mimeType: "audio/mp4", durationMs: 2000,
            waveformSamples: [0.2], transcript: "")
        #expect(VoiceTranscriptState.resolve(voice: legacy, localResult: nil, isRunning: false,
            lastAttemptFailed: false, isSender: false) == .notTranscribed)
        #expect(VoiceTranscriptState.resolve(voice: voice(.ready, text: "Meet at noon."), localResult: nil,
            isRunning: false, lastAttemptFailed: false, isSender: false) == .ready("Meet at noon."))

        var exhausted = voice(.failed)
        exhausted.transcription = VoiceTranscription(status: .failed, sourceVersion: "audio-v1",
            engine: "apple-speech-v1", attempts: 3)
        #expect(VoiceTranscriptState.resolve(voice: exhausted, localResult: nil, isRunning: false,
            lastAttemptFailed: false, isSender: true) == .failed(canRetry: false))
        // A recipient's attempts are local; the sender's failures do not block them.
        #expect(VoiceTranscriptState.resolve(voice: exhausted, localResult: nil, isRunning: false,
            lastAttemptFailed: false, isSender: false) == .notTranscribed)
        #expect(VoiceTranscriptState.resolve(voice: voice(.failed), localResult: nil, isRunning: false,
            lastAttemptFailed: false, isSender: true) == .failed(canRetry: true))
    }

    @Test func senderPersistsTranscriptAndRecipientKeepsItOnDevice() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("voice-transcripts-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let cache = VoiceTranscriptLocalCache(directory: directory)
        let jobs = VoiceTranscriptionJobs(cache: cache)
        jobs.activate(accountId: "acct_me")
        let recognizer = VoiceMessageRecorder(speechTranscriber: { _ in "Meet at noon." })
        var persisted: [VoiceMessage] = []
        func pending(_ mediaId: String) -> VoiceMessage {
            VoiceMessage(mediaId: mediaId, mimeType: "audio/mp4", durationMs: 2000, waveformSamples: [0.2],
                transcript: "", transcription: VoiceTranscription(status: .pending, sourceVersion: mediaId,
                    engine: "apple-speech-v1", attempts: 0))
        }
        func start(_ voice: VoiceMessage, isSender: Bool) -> Task<VoiceMessage?, Never>? {
            jobs.transcribe(voice, isSender: isSender,
                prepareAudio: { _ in URL(fileURLWithPath: "/synthetic/audio.m4a") },
                recognize: { voice, url in await recognizer.transcribeExisting(voice, url: url) },
                persist: { result in persisted.append(result); return true })
        }

        let sent = pending("att_sent")
        let senderResult = try #require(await start(sent, isSender: true)?.value)
        #expect(senderResult.spokenText == "Meet at noon.")
        #expect(senderResult.transcription?.attempts == 1)
        #expect(persisted.map(\.mediaId) == ["att_sent"])
        #expect(jobs.state(for: sent, isSender: true) == .ready("Meet at noon."))

        let received = pending("att_received")
        _ = await start(received, isSender: false)?.value
        #expect(persisted.count == 1)
        #expect(jobs.state(for: received, isSender: false) == .ready("Meet at noon."))

        var saved: [VoiceTranscriptLocalCache.Entry] = []
        for _ in 0..<40 where saved.isEmpty {
            saved = cache.load(accountId: "acct_me")
            if saved.isEmpty { try await Task.sleep(for: .milliseconds(50)) }
        }
        #expect(saved.map(\.voice.mediaId) == ["att_received"])
        let reopened = VoiceTranscriptionJobs(cache: cache)
        reopened.activate(accountId: "acct_me")
        #expect(reopened.state(for: received, isSender: false) == .ready("Meet at noon."))
    }

    @Test func localCacheKeepsTheNewestSnapshotWhenSavesOverlap() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("voice-transcripts-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let cache = VoiceTranscriptLocalCache(directory: directory)
        func entry(_ index: Int) -> VoiceTranscriptLocalCache.Entry {
            let mediaId = "att_\(index)"
            return VoiceTranscriptLocalCache.Entry(
                voice: VoiceMessage(mediaId: mediaId, mimeType: "audio/mp4", durationMs: 2000, waveformSamples: [0.2],
                    transcript: "Line \(index)", transcription: VoiceTranscription(status: .ready, sourceVersion: mediaId,
                        engine: "apple-speech-v1", attempts: 1)),
                savedAt: Date(timeIntervalSince1970: Double(index))
            )
        }
        for count in 1...40 {
            cache.save((0..<count).map(entry), accountId: "acct_me")
        }
        cache.waitForPendingWrites()
        #expect(cache.load(accountId: "acct_me").count == 40)
    }

    @Test func repeatedRequestsShareOneJobAndFollowTheUpload() async throws {
        let (speech, completion) = AsyncStream<String>.makeStream()
        var calls = 0
        let recognizer = VoiceMessageRecorder(speechTranscriber: { _ in
            calls += 1
            for await text in speech { return text }
            throw CancellationError()
        })
        defer { completion.finish() }
        let jobs = VoiceTranscriptionJobs()
        jobs.activate(accountId: "acct_me")
        let voice = VoiceMessage(mediaId: "pending:draft", mimeType: "audio/mp4", durationMs: 2000,
            waveformSamples: [0.2], transcript: "", transcription: VoiceTranscription(status: .pending,
                sourceVersion: "pending:draft", engine: "apple-speech-v1", attempts: 0))
        func start() -> Task<VoiceMessage?, Never>? {
            jobs.transcribe(voice, isSender: true,
                prepareAudio: { _ in URL(fileURLWithPath: "/synthetic/audio.m4a") },
                recognize: { voice, url in await recognizer.transcribeExisting(voice, url: url) },
                persist: nil)
        }
        let first = try #require(start())
        let second = try #require(start())
        #expect(jobs.state(for: voice, isSender: true) == .transcribing)

        let uploaded = voice.rebound(to: "att_uploaded")
        jobs.rekey(from: "pending:draft", to: "att_uploaded")
        #expect(jobs.task(for: "att_uploaded") != nil)
        #expect(jobs.state(for: uploaded, isSender: true) == .transcribing)

        try await Task.sleep(for: .milliseconds(50))
        completion.yield("Meet at noon.")
        _ = await first.value
        _ = await second.value
        #expect(calls == 1)
        #expect(jobs.localResult(for: "att_uploaded")?.spokenText == "Meet at noon.")
        #expect(jobs.state(for: uploaded, isSender: true) == .ready("Meet at noon."))
    }

    @Test func transcriptUpdateKeepsAnOutgoingVoiceMessageDelivered() {
        let updated = CloudMessageDTO(messageId: "voice-message", clientMessageId: "client-voice",
            fromAccountId: "acct_me", toAccountId: "acct_peer", body: "Meet at noon.",
            createdAt: "2026-01-01T00:00:00Z", editedAt: "2026-01-01T00:00:05Z",
            deliveredAt: nil, readAt: nil, direction: "outgoing", sessionId: "session",
            messageKind: "voice", voiceMessage: voice(.ready, text: "Meet at noon."), version: 2)
        #expect(CloudMessageStateProjector.deliveryState(for: updated, ownAccountId: "acct_me") == .delivered)
    }

    private func recordingFixture() throws -> URL {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("voice-handoff-test-\(UUID().uuidString).m4a")
        try Data([1, 2, 3, 4]).write(to: url)
        return url
    }
}
