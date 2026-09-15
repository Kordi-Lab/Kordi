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

    @Test func releaseHandsOffAudioBeforeRecognitionCompletesAndReusesItsTask() async throws {
        let (speech, completion) = AsyncStream<String>.makeStream()
        var calls = 0
        let recorder = VoiceMessageRecorder(speechTranscriber: { _ in
            calls += 1
            for await text in speech { return text }
            throw CancellationError()
        })
        let url = try recordingFixture()
        defer { recorder.cancel(); completion.finish() }
        recorder.prepareRecording(at: url, durationMs: 2_000, waveformSamples: [0.2], autoSend: true)
        #expect(!recorder.isVisible)

        // Release the gate after a deadline so a regression reports a failure instead of hanging.
        var exceededDeadline = false
        let deadline = Task {
            try await Task.sleep(for: .seconds(2))
            exceededDeadline = true
            completion.yield("Deadline fallback")
        }
        defer { deadline.cancel() }
        let pending = try #require(await recorder.prepareForSend())
        #expect(!exceededDeadline)
        #expect(pending.transcription?.status == .pending)
        #expect(pending.transcript.isEmpty)
        #expect(FileManager.default.fileExists(atPath: url.path))

        let outgoing = Task { await recorder.finishTranscriptionForSend(pending) }
        let nextRecorder = VoiceMessageRecorder()
        nextRecorder.cancel()
        completion.yield("Meet at noon.")
        let resolved = try #require(await outgoing.value)
        #expect(resolved.attachment == pending.attachment)
        #expect(resolved.transcript == "Meet at noon.")
        #expect(resolved.transcription?.status == .ready)
        #expect(resolved.transcription?.attempts == 1)
        #expect(calls == 1)
        #expect(!FileManager.default.fileExists(atPath: url.path))
        #expect(recorder.phase == .idle)
        #expect(nextRecorder.phase == .idle)
    }

    @Test func transcriptionFailureStillHandsOffTheOriginalAudio() async throws {
        struct RecognitionFailed: Error {}
        let recorder = VoiceMessageRecorder(speechTranscriber: { _ in throw RecognitionFailed() })
        defer { recorder.cancel() }
        recorder.prepareRecording(at: try recordingFixture(), durationMs: 2_000,
            waveformSamples: [0.2], autoSend: true)
        let pending = try #require(await recorder.prepareForSend())
        let resolved = try #require(await recorder.finishTranscriptionForSend(pending))
        #expect(resolved.attachment == pending.attachment)
        #expect(!resolved.attachment.data.isEmpty)
        #expect(resolved.transcript.isEmpty)
        #expect(resolved.transcription?.status == .failed)
        #expect(resolved.transcription?.attempts == 1)
    }

    @Test func convertToTextStillWaitsForTheTranscript() async throws {
        let recorder = VoiceMessageRecorder(speechTranscriber: { _ in "Converted words." })
        defer { recorder.cancel() }
        recorder.prepareRecording(at: try recordingFixture(), durationMs: 2_000,
            waveformSamples: [0.2], autoSend: false)
        #expect(recorder.isVisible)
        #expect(await recorder.prepareTranscript() == "Converted words.")
    }

    @Test func cancelledRecordingCannotResurrectAPendingSend() async throws {
        let (speech, completion) = AsyncStream<String>.makeStream()
        let recorder = VoiceMessageRecorder(speechTranscriber: { _ in
            for await text in speech { return text }
            throw CancellationError()
        })
        defer { recorder.cancel(); completion.finish() }
        recorder.prepareRecording(at: try recordingFixture(), durationMs: 2_000,
            waveformSamples: [0.2], autoSend: true)
        let pending = try #require(await recorder.prepareForSend())
        recorder.cancel()
        completion.yield("Late words.")
        #expect(await recorder.finishTranscriptionForSend(pending) == nil)
        #expect(recorder.pendingMessage == nil)
        #expect(recorder.phase == .idle)
    }

    private func recordingFixture() throws -> URL {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("voice-handoff-test-\(UUID().uuidString).m4a")
        try Data([1, 2, 3, 4]).write(to: url)
        return url
    }
}
