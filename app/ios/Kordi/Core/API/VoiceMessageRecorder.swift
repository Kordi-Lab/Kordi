import AVFoundation
import Foundation
import Observation
import Speech

@MainActor
@Observable
final class VoiceMessageRecorder: NSObject, AVAudioRecorderDelegate {
    enum Phase: Equatable {
        case idle
        case recording
        case paused
        case review
        case failed
    }

    enum TranscriptionPhase: Equatable {
        case idle
        case transcribing
        case ready
        case failed
    }

    static let minimumDurationMs = 1_000
    static let maximumDurationMs = 60_000

    private(set) var phase = Phase.idle
    private(set) var transcriptionPhase = TranscriptionPhase.idle
    private(set) var isLocked = false
    private(set) var shouldAutoSend = false
    private(set) var durationMs = 0
    private(set) var waveformSamples: [Double] = []
    private(set) var transcript = ""
    private(set) var pendingMessage: PendingVoiceMessage?
    private(set) var reviewURL: URL?
    private(set) var trimStartMs = 0
    private(set) var trimEndMs = 0
    private(set) var errorMessage: String?

    private let speechTranscriber: ((URL) async throws -> String)?

    init(speechTranscriber: ((URL) async throws -> String)? = nil) {
        self.speechTranscriber = speechTranscriber
        super.init()
    }

    private var recorder: AVAudioRecorder?
    private var meterTimer: Timer?
    private var recordingURL: URL?
    private var preparedURL: URL?
    private var rawSamples: [Double] = []
    private var recognitionOperation: VoiceSpeechOperation?
    private var preparationTask: Task<PendingVoiceMessage?, Never>?
    private var transcriptionTask: Task<Void, Never>?
    private var generation = 0
    private var transcriptionAttempts = 0
    private var transcriptionLanguage: String?
    private var sourceVersion = UUID().uuidString.lowercased()
    private var preparedTrimStartMs = 0
    private var preparedTrimEndMs = 0

    var canRetryTranscription: Bool {
        transcriptionPhase == .failed && (transcriptionAttempts < VoiceTranscription.maximumAttempts
            || preparedTrimStartMs != trimStartMs || preparedTrimEndMs != trimEndMs)
    }

    var isVisible: Bool {
        phase == .recording || phase == .paused || (phase == .review && !shouldAutoSend) || phase == .failed
    }

    @discardableResult
    func start(locked: Bool = true) async -> Bool {
        guard phase == .idle || phase == .failed else { return false }
        cancel(removeFile: true)
        transcriptionAttempts = 0
        sourceVersion = UUID().uuidString.lowercased()
        let startGeneration = generation
        do {
            guard await AVAudioApplication.requestRecordPermission() else {
                throw VoiceMessageError.microphonePermission
            }
            guard startGeneration == generation else { return false }
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(
                .playAndRecord,
                mode: .spokenAudio,
                options: [.defaultToSpeaker, .allowBluetoothHFP]
            )
            try session.setActive(true, options: .notifyOthersOnDeactivation)
            let url = FileManager.default.temporaryDirectory
                .appendingPathComponent("kordi-voice-\(UUID().uuidString.lowercased()).m4a")
            let recorder = try AVAudioRecorder(
                url: url,
                settings: [
                    AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
                    AVSampleRateKey: 44_100,
                    AVNumberOfChannelsKey: 1,
                    AVEncoderBitRateKey: 64_000,
                    AVEncoderAudioQualityKey: AVAudioQuality.high.rawValue,
                ]
            )
            recorder.delegate = self
            recorder.isMeteringEnabled = true
            guard recorder.record(forDuration: TimeInterval(Self.maximumDurationMs) / 1_000) else {
                throw VoiceMessageError.recordingFailed
            }
            self.recorder = recorder
            recordingURL = url
            rawSamples = []
            waveformSamples = []
            durationMs = 0
            transcript = ""
            pendingMessage = nil
            reviewURL = nil
            errorMessage = nil
            isLocked = locked
            shouldAutoSend = false
            transcriptionPhase = .idle
            phase = .recording
            meterTimer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in
                Task { @MainActor [weak self] in self?.sampleMeter() }
            }
            return true
        } catch {
            fail(error, preserveReview: false)
            return false
        }
    }

    func pause() {
        guard phase == .recording, let recorder else { return }
        recorder.pause()
        phase = .paused
        durationMs = min(Self.maximumDurationMs, Int(recorder.currentTime * 1_000))
    }

    func resume() {
        guard phase == .paused, let recorder else { return }
        guard recorder.record() else {
            fail(VoiceMessageError.recordingFailed, preserveReview: false)
            return
        }
        isLocked = true
        phase = .recording
    }

    @discardableResult
    func stop(autoSend: Bool = false) -> Bool {
        guard [.recording, .paused].contains(phase),
              let recorder,
              let url = recordingURL else { return false }
        durationMs = min(Self.maximumDurationMs, max(1, Int(recorder.currentTime * 1_000)))
        recorder.stop()
        meterTimer?.invalidate()
        meterTimer = nil
        self.recorder = nil
        guard Self.isDurationSendable(durationMs) else {
            cancel()
            return false
        }
        prepareRecording(at: url, durationMs: durationMs,
            waveformSamples: Self.downsample(rawSamples), autoSend: autoSend)
        return true
    }

    func prepareRecording(at url: URL, durationMs: Int, waveformSamples: [Double], autoSend: Bool) {
        recordingURL = url
        self.durationMs = durationMs
        self.waveformSamples = waveformSamples
        shouldAutoSend = autoSend
        trimStartMs = 0
        trimEndMs = durationMs
        reviewURL = url
        phase = .review
        beginPreparation(url: url, startMs: 0, endMs: durationMs)
    }

    func restoreReview() {
        shouldAutoSend = false
    }

    func setTrim(startMs: Int, endMs: Int) {
        guard transcriptionPhase != .transcribing else { return }
        let start = max(0, min(durationMs - 250, startMs))
        let end = max(start + 250, min(durationMs, endMs))
        trimStartMs = start
        trimEndMs = end
    }

    func retryTranscription() {
        guard phase == .review, canRetryTranscription, let recordingURL else { return }
        beginPreparation(url: recordingURL, startMs: trimStartMs, endMs: trimEndMs)
    }

    func prepareForSend() async -> PendingVoiceMessage? {
        guard phase == .review, let recordingURL else { return nil }
        let needsNewRange = preparedTrimStartMs != trimStartMs || preparedTrimEndMs != trimEndMs
        if needsNewRange {
            beginPreparation(url: recordingURL, startMs: trimStartMs, endMs: trimEndMs)
        }
        let preparationGeneration = generation
        if let preparationTask { _ = await preparationTask.value }
        guard preparationGeneration == generation else { return nil }
        return pendingMessage
    }

    // The outgoing message owns this recorder after the composer receives a new one.
    // Reuse the recognition already in flight and keep its audio alive until it finishes.
    func finishTranscriptionForSend(_ pending: PendingVoiceMessage) async -> PendingVoiceMessage? {
        let sendGeneration = generation
        await transcriptionTask?.value
        guard generation == sendGeneration,
              pendingMessage?.attachment.id == pending.attachment.id else { return nil }
        let resolved = pendingMessage
        cancel()
        return resolved
    }

    func prepareTranscript() async -> String? {
        guard await prepareForSend() != nil else { return nil }
        await transcriptionTask?.value
        return transcript.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty
    }

    func transcribeExisting(_ voice: VoiceMessage, url: URL) async -> VoiceMessage {
        guard voice.spokenText.isEmpty else { return voice }
        let attempts = (voice.transcription?.attempts ?? 0) + 1
        guard attempts <= VoiceTranscription.maximumAttempts else { return voice }
        do {
            let text = try await transcribe(url: url)
            return VoiceMessage(mediaId: voice.mediaId, mimeType: voice.mimeType,
                durationMs: voice.durationMs, waveformSamples: voice.waveformSamples, transcript: text,
                transcription: VoiceTranscription(status: .ready, sourceVersion: voice.mediaId,
                    engine: "apple-speech-v1", language: transcriptionLanguage, attempts: attempts))
        } catch {
            return VoiceMessage(mediaId: voice.mediaId, mimeType: voice.mimeType,
                durationMs: voice.durationMs, waveformSamples: voice.waveformSamples, transcript: "",
                transcription: VoiceTranscription(status: Self.failureStatus(error), sourceVersion: voice.mediaId,
                    engine: "apple-speech-v1", attempts: attempts))
        }
    }

    func cancel() {
        cancel(removeFile: true)
        phase = .idle
        transcriptionPhase = .idle
        isLocked = false
        shouldAutoSend = false
        durationMs = 0
        waveformSamples = []
        transcript = ""
        transcriptionAttempts = 0
        sourceVersion = UUID().uuidString.lowercased()
        pendingMessage = nil
        reviewURL = nil
        trimStartMs = 0
        trimEndMs = 0
        errorMessage = nil
    }

    private func cancel(removeFile: Bool) {
        generation += 1
        recorder?.stop()
        recorder = nil
        recognitionOperation?.cancel()
        recognitionOperation = nil
        preparationTask?.cancel()
        preparationTask = nil
        transcriptionTask?.cancel()
        transcriptionTask = nil
        meterTimer?.invalidate()
        meterTimer = nil
        if removeFile {
            if let recordingURL { try? FileManager.default.removeItem(at: recordingURL) }
            if let preparedURL, preparedURL != recordingURL {
                try? FileManager.default.removeItem(at: preparedURL)
            }
        }
        recordingURL = nil
        preparedURL = nil
        rawSamples = []
    }

    private func sampleMeter() {
        guard let recorder, phase == .recording else { return }
        recorder.updateMeters()
        let normalized = max(
            0.08,
            min(1, (Double(recorder.averagePower(forChannel: 0)) + 55) / 55)
        )
        rawSamples.append(normalized)
        waveformSamples = Self.downsample(Array(rawSamples.suffix(48)), count: 48)
        durationMs = min(Self.maximumDurationMs, Int(recorder.currentTime * 1_000))
        if durationMs >= Self.maximumDurationMs { stop() }
    }

    @discardableResult
    private func beginPreparation(url: URL, startMs: Int, endMs: Int) -> Task<PendingVoiceMessage?, Never> {
        preparationTask?.cancel()
        recognitionOperation?.cancel()
        transcriptionTask?.cancel()
        generation += 1
        let preparationGeneration = generation
        let sameRange = preparedTrimStartMs == startMs && preparedTrimEndMs == endMs
        let previous = sameRange ? pendingMessage : nil
        preparedTrimStartMs = startMs
        preparedTrimEndMs = endMs
        if !sameRange {
            transcriptionAttempts = 0
            sourceVersion = UUID().uuidString.lowercased()
        }
        transcriptionAttempts += 1
        let attempts = transcriptionAttempts
        let version = sourceVersion
        transcriptionPhase = .transcribing
        errorMessage = nil
        pendingMessage = nil
        let originalDurationMs = durationMs
        let originalWaveform = waveformSamples
        let task = Task { [weak self] () -> PendingVoiceMessage? in
            guard let self else { return nil }
            do {
                let trimmed = startMs > 50 || endMs < originalDurationMs - 50
                let outputURL = trimmed
                    ? try await exportTrimmedAudio(url: url, startMs: startMs, endMs: endMs)
                    : url
                try Task.checkCancellation()
                let data = try Data(contentsOf: outputURL, options: [.mappedIfSafe])
                let preparedDurationMs = endMs - startMs
                let preparedWaveform = trimmed
                    ? Self.trimmedWaveform(
                        originalWaveform,
                        durationMs: originalDurationMs,
                        startMs: startMs,
                        endMs: endMs
                    )
                    : originalWaveform
                let pending = PendingVoiceMessage(
                    attachment: previous?.attachment ?? PendingAttachment(
                        id: UUID().uuidString.lowercased(),
                        name: "Voice message.m4a",
                        kind: .file,
                        mimeType: "audio/mp4",
                        data: data,
                        previewURL: nil
                    ),
                    durationMs: preparedDurationMs,
                    waveformSamples: preparedWaveform,
                    transcript: "",
                    transcription: VoiceTranscription(status: .pending, sourceVersion: version,
                        engine: "apple-speech-v1", attempts: attempts)
                )
                guard preparationGeneration == generation else { return nil }
                preparedURL = outputURL
                preparedTrimStartMs = startMs
                preparedTrimEndMs = endMs
                pendingMessage = pending
                transcriptionTask = Task { [weak self] in
                    guard let self else { return }
                    do {
                        let text = try await transcribe(url: outputURL)
                        try Task.checkCancellation()
                        guard preparationGeneration == generation else { return }
                        transcript = text
                        pendingMessage = PendingVoiceMessage(
                            attachment: pending.attachment,
                            durationMs: pending.durationMs,
                            waveformSamples: pending.waveformSamples,
                            transcript: text,
                            transcription: VoiceTranscription(status: .ready, sourceVersion: version,
                                engine: "apple-speech-v1", language: transcriptionLanguage, attempts: attempts)
                        )
                        transcriptionPhase = .ready
                    } catch is CancellationError {
                        return
                    } catch {
                        guard preparationGeneration == generation else { return }
                        transcript = ""
                        pendingMessage = PendingVoiceMessage(attachment: pending.attachment,
                            durationMs: pending.durationMs, waveformSamples: pending.waveformSamples,
                            transcript: "", transcription: VoiceTranscription(status: Self.failureStatus(error),
                                sourceVersion: version, engine: "apple-speech-v1", attempts: attempts))
                        transcriptionPhase = .failed
                        errorMessage = (error as? LocalizedError)?.errorDescription
                            ?? "Unable to transcribe this recording. Retry or record another message."
                    }
                }
                return pending
            } catch is CancellationError {
                return nil
            } catch {
                guard preparationGeneration == generation else { return nil }
                fail(error, preserveReview: true)
                return nil
            }
        }
        preparationTask = task
        return task
    }

    private func exportTrimmedAudio(url: URL, startMs: Int, endMs: Int) async throws -> URL {
        let asset = AVURLAsset(url: url)
        guard let session = AVAssetExportSession(
            asset: asset,
            presetName: AVAssetExportPresetAppleM4A
        ) else {
            throw VoiceMessageError.trimmingFailed
        }
        session.timeRange = CMTimeRange(
            start: CMTime(seconds: Double(startMs) / 1_000, preferredTimescale: 600),
            duration: CMTime(seconds: Double(endMs - startMs) / 1_000, preferredTimescale: 600)
        )
        let output = FileManager.default.temporaryDirectory
            .appendingPathComponent("kordi-voice-trim-\(UUID().uuidString.lowercased()).m4a")
        try await session.export(to: output, as: .m4a)
        return output
    }

    private func transcribe(url: URL) async throws -> String {
        if let speechTranscriber {
            let text = try await speechTranscriber(url).trimmingCharacters(in: .whitespacesAndNewlines)
            guard !text.isEmpty else { throw VoiceMessageError.noSpeech }
            guard text.count <= 20_000 else { throw VoiceMessageError.transcriptTooLong }
            return text
        }
        guard await speechAuthorization() == .authorized else {
            throw VoiceMessageError.speechPermission
        }
        var lastError: Error = VoiceMessageError.onDeviceUnavailable
        for identifier in Self.transcriptionLocaleIdentifiers(
            preferred: Locale.current.identifier
        ) {
            guard let recognizer = SFSpeechRecognizer(
                locale: Locale(identifier: identifier)
            ),
            recognizer.isAvailable else {
                continue
            }
            do {
                try Task.checkCancellation()
                let text = try await transcribe(url: url, recognizer: recognizer)
                try Task.checkCancellation()
                guard text.count <= 20_000 else { throw VoiceMessageError.transcriptTooLong }
                transcriptionLanguage = identifier
                return text
            } catch is CancellationError {
                throw CancellationError()
            } catch {
                lastError = error
            }
        }
        throw lastError
    }

    private func transcribe(
        url: URL,
        recognizer: SFSpeechRecognizer
    ) async throws -> String {
        let request = SFSpeechURLRecognitionRequest(url: url)
        request.shouldReportPartialResults = false
        request.requiresOnDeviceRecognition = recognizer.supportsOnDeviceRecognition
        let operation = VoiceSpeechOperation()
        recognitionOperation = operation
        defer {
            if recognitionOperation === operation { recognitionOperation = nil }
        }
        return try await operation.run(recognizer: recognizer, request: request)
    }

    private static func failureStatus(_ error: Error) -> VoiceTranscription.Status {
        switch error as? VoiceMessageError {
        case .speechPermission, .onDeviceUnavailable: .unavailable
        default: .failed
        }
    }

    private func fail(_ error: Error, preserveReview: Bool) {
        recorder?.stop()
        recorder = nil
        meterTimer?.invalidate()
        meterTimer = nil
        if preserveReview {
            shouldAutoSend = false
            phase = .review
            transcriptionPhase = .failed
        } else {
            phase = .failed
        }
        errorMessage = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
    }

    private func speechAuthorization() async -> SFSpeechRecognizerAuthorizationStatus {
        let current = SFSpeechRecognizer.authorizationStatus()
        if current != .notDetermined { return current }
        return await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { continuation.resume(returning: $0) }
        }
    }

    static func downsample(_ samples: [Double], count: Int = 48) -> [Double] {
        guard !samples.isEmpty else { return Array(repeating: 0.08, count: count) }
        let outputCount = min(count, samples.count)
        return (0..<outputCount).map { index in
            let start = (index * samples.count) / outputCount
            let end = max(start + 1, ((index + 1) * samples.count) / outputCount)
            return max(0.08, samples[start..<min(end, samples.count)].max() ?? 0.08)
        }
    }

    static func isDurationSendable(_ durationMs: Int) -> Bool {
        durationMs >= minimumDurationMs
    }

    static func transcriptionLocaleIdentifiers(preferred: String) -> [String] {
        var locales: [String] = []
        for identifier in [preferred, "zh-CN", "zh-TW", "zh-HK", "en-US"]
        where !identifier.isEmpty && !locales.contains(identifier) {
            locales.append(identifier)
        }
        return locales
    }

    static func trimmedWaveform(
        _ samples: [Double],
        durationMs: Int,
        startMs: Int,
        endMs: Int
    ) -> [Double] {
        guard !samples.isEmpty, durationMs > 0 else { return downsample([]) }
        let start = Int((Double(max(0, startMs)) / Double(durationMs)) * Double(samples.count))
        let end = max(
            start + 1,
            Int(ceil((Double(min(durationMs, endMs)) / Double(durationMs)) * Double(samples.count)))
        )
        return downsample(Array(samples[start..<min(end, samples.count)]))
    }
}

private enum VoiceMessageError: LocalizedError {
    case microphonePermission
    case speechPermission
    case onDeviceUnavailable
    case recordingFailed
    case trimmingFailed
    case noSpeech
    case transcriptTooLong

    var errorDescription: String? {
        switch self {
        case .microphonePermission:
            "Allow Kordi to use the microphone in Settings and try again."
        case .speechPermission:
            "Allow Kordi to use Speech Recognition in Settings and try again."
        case .onDeviceUnavailable:
            "Speech Recognition is unavailable for this language right now."
        case .recordingFailed:
            "Kordi could not start the voice recording."
        case .trimmingFailed:
            "Kordi could not trim this voice message."
        case .transcriptTooLong:
            "The transcript exceeds the message limit. Trim the recording and retry."
        case .noSpeech:
            "No recognizable speech was found. Try again or record another message."
        }
    }
}
