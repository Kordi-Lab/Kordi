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
}
