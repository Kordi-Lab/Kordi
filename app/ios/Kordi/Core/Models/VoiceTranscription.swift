import Foundation
import Observation

struct VoiceTranscription: Codable, Hashable, Sendable {
    enum Status: String, Codable, Sendable { case pending, ready, failed, unavailable }
    static let maximumAttempts = 3
    let status: Status
    let sourceVersion: String
    let engine: String
    var language: String? = nil
    let attempts: Int

    func bound(to source: String) -> Self {
        Self(status: status, sourceVersion: source, engine: engine, language: language, attempts: attempts)
    }
}

extension VoiceMessage {
    var spokenText: String {
        let text = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
        if let transcription,
           transcription.status != .ready || transcription.sourceVersion != mediaId { return "" }
        return text == "Transcription unavailable." ? "" : text
    }

    /// The same audio under another media id, for example after a pending upload finishes.
    func rebound(to mediaId: String) -> VoiceMessage {
        VoiceMessage(
            mediaId: mediaId,
            mimeType: mimeType,
            durationMs: durationMs,
            waveformSamples: waveformSamples,
            transcript: transcript,
            transcription: transcription?.bound(to: mediaId)
        )
    }

    /// A newly sent voice message: no transcript yet and no recognition attempts.
    var isAwaitingFirstTranscription: Bool {
        spokenText.isEmpty && transcription?.status == .pending && (transcription?.attempts ?? 0) == 0
    }
}

/// What a voice bubble shows for its transcript. Transcription only runs on request.
enum VoiceTranscriptState: Equatable {
    case ready(String)
    /// Nobody has transcribed this recording on this device yet. Tapping transcribes it.
    case notTranscribed
    case transcribing
    case failed(canRetry: Bool)

    var canStartTranscription: Bool {
        switch self {
        case .notTranscribed: true
        case .failed(let canRetry): canRetry
        case .ready, .transcribing: false
        }
    }

    /// The model-visible text an agent receives when the transcript is not available.
    static let agentFailureText =
        "[Voice message: transcription failed. No spoken content or audio was provided to the agent.]"

    /// Senders share attempts with the server copy. Recipients cannot update the server,
    /// so only their local attempts on this device count toward the limit.
    static func resolve(
        voice: VoiceMessage,
        localResult: VoiceMessage?,
        isRunning: Bool,
        lastAttemptFailed: Bool,
        isSender: Bool
    ) -> VoiceTranscriptState {
        if let text = voice.spokenText.nonEmpty { return .ready(text) }
        if let text = localResult?.spokenText.nonEmpty { return .ready(text) }
        if isRunning { return .transcribing }
        let localAttempts = localResult?.transcription?.attempts ?? 0
        let attempts = isSender
            ? max(voice.transcription?.attempts ?? 0, localAttempts)
            : localAttempts
        let canRetry = attempts < VoiceTranscription.maximumAttempts
        let senderAttemptFailed = isSender
            && (voice.transcription?.attempts ?? 0) > 0
            && voice.transcription?.status != .pending
        if lastAttemptFailed || localResult != nil || senderAttemptFailed {
            return .failed(canRetry: canRetry)
        }
        return canRetry ? .notTranscribed : .failed(canRetry: false)
    }
}

/// Background transcription jobs keyed by media id. Jobs live outside views so
/// scrolling and cell reuse keep their progress, and one recording never runs twice.
@MainActor
@Observable
final class VoiceTranscriptionJobs {
    private(set) var runningKeys: Set<String> = []
    private(set) var failedKeys: Set<String> = []
    private(set) var localResults: [String: VoiceMessage] = [:]
    @ObservationIgnored private var tasks: [String: Task<VoiceMessage?, Never>] = [:]
    @ObservationIgnored private var aliases: [String: String] = [:]
    @ObservationIgnored private var recipientSavedAt: [String: Date] = [:]
    @ObservationIgnored private var accountId: String?
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private let cache: VoiceTranscriptLocalCache?

    init(cache: VoiceTranscriptLocalCache? = nil) {
        self.cache = cache
    }

    func activate(accountId: String?) {
        guard accountId != self.accountId else { return }
        generation += 1
        tasks.values.forEach { $0.cancel() }
        tasks = [:]
        aliases = [:]
        runningKeys = []
        failedKeys = []
        self.accountId = accountId
        let entries = accountId.flatMap { cache?.load(accountId: $0) } ?? []
        localResults = Dictionary(entries.map { ($0.voice.mediaId, $0.voice) }, uniquingKeysWith: { first, _ in first })
        recipientSavedAt = Dictionary(entries.map { ($0.voice.mediaId, $0.savedAt) }, uniquingKeysWith: { first, _ in first })
    }

    func state(for voice: VoiceMessage, isSender: Bool) -> VoiceTranscriptState {
        let key = resolvedKey(voice.mediaId)
        return .resolve(
            voice: voice,
            localResult: localResults[key],
            isRunning: runningKeys.contains(key),
            lastAttemptFailed: failedKeys.contains(key),
            isSender: isSender
        )
    }

    func task(for mediaId: String) -> Task<VoiceMessage?, Never>? {
        tasks[resolvedKey(mediaId)]
    }

    func localResult(for mediaId: String) -> VoiceMessage? {
        let key = resolvedKey(mediaId)
        return localResults[key].map { $0.mediaId == key ? $0 : $0.rebound(to: key) }
    }

    /// Starts transcription unless a job is already running or the transcript is ready.
    /// Returns the running job, or nil when there is nothing to do.
    @discardableResult
    func transcribe(
        _ voice: VoiceMessage,
        isSender: Bool,
        prepareAudio: @escaping @MainActor (VoiceMessage) async -> URL?,
        recognize: @escaping @MainActor (VoiceMessage, URL) async -> VoiceMessage,
        persist: (@MainActor (VoiceMessage) async -> Bool)?
    ) -> Task<VoiceMessage?, Never>? {
        let key = resolvedKey(voice.mediaId)
        if let task = tasks[key] { return task }
        guard state(for: voice, isSender: isSender).canStartTranscription else { return nil }
        let base = attemptBase(for: voice, isSender: isSender, localResult: localResults[key])
        let generation = generation
        runningKeys.insert(key)
        failedKeys.remove(key)
        let task = Task { @MainActor [weak self] () -> VoiceMessage? in
            guard let url = await prepareAudio(voice) else {
                self?.finish(key: key, result: nil, isSender: isSender, generation: generation)
                return nil
            }
            let result = await recognize(base, url)
            guard let self, self.generation == generation else { return nil }
            self.finish(key: key, result: result, isSender: isSender, generation: generation)
            if isSender, let persist { _ = await persist(result) }
            return result
        }
        tasks[key] = task
        return task
    }

    /// Moves a job and its result from a pending upload id to the uploaded media id.
    func rekey(from pendingKey: String, to newKey: String) {
        // A retried send uploads again, so follow any earlier move first.
        let oldKey = resolvedKey(pendingKey)
        guard oldKey != newKey else { return }
        aliases[pendingKey] = newKey
        aliases[oldKey] = newKey
        aliases[newKey] = nil
        if let task = tasks.removeValue(forKey: oldKey) { tasks[newKey] = task }
        if runningKeys.remove(oldKey) != nil { runningKeys.insert(newKey) }
        if failedKeys.remove(oldKey) != nil { failedKeys.insert(newKey) }
        if let result = localResults.removeValue(forKey: oldKey) {
            localResults[newKey] = result.rebound(to: newKey)
        }
    }

    private func resolvedKey(_ key: String) -> String {
        var key = key
        var visited = Set<String>()
        while let next = aliases[key], visited.insert(key).inserted { key = next }
        return key
    }

    private func attemptBase(for voice: VoiceMessage, isSender: Bool, localResult: VoiceMessage?) -> VoiceMessage {
        let localAttempts = localResult?.transcription?.attempts ?? 0
        let attempts = isSender
            ? max(voice.transcription?.attempts ?? 0, localAttempts)
            : localAttempts
        return VoiceMessage(
            mediaId: voice.mediaId,
            mimeType: voice.mimeType,
            durationMs: voice.durationMs,
            waveformSamples: voice.waveformSamples,
            transcript: "",
            transcription: VoiceTranscription(
                status: .failed,
                sourceVersion: voice.mediaId,
                engine: "apple-speech-v1",
                attempts: attempts
            )
        )
    }

    private func finish(key originalKey: String, result: VoiceMessage?, isSender: Bool, generation: Int) {
        guard generation == self.generation else { return }
        let key = resolvedKey(originalKey)
        tasks[key] = nil
        runningKeys.remove(key)
        guard let result else {
            failedKeys.insert(key)
            return
        }
        let stored = result.mediaId == key ? result : result.rebound(to: key)
        localResults[key] = stored
        if stored.spokenText.isEmpty { failedKeys.insert(key) } else { failedKeys.remove(key) }
        guard !isSender, let accountId, let cache else { return }
        recipientSavedAt[key] = Date()
        let entries = recipientSavedAt.compactMap { mediaId, savedAt in
            localResults[mediaId].map { VoiceTranscriptLocalCache.Entry(voice: $0, savedAt: savedAt) }
        }
        cache.save(entries, accountId: accountId)
    }
}

/// Transcripts a recipient made on this device. The server only accepts transcripts
/// from the sender, so these stay local.
struct VoiceTranscriptLocalCache: Sendable {
    struct Entry: Codable, Sendable {
        let voice: VoiceMessage
        let savedAt: Date
    }

    static let maximumEntries = 300
    let directory: URL

    static func standard() -> VoiceTranscriptLocalCache? {
        guard let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first else {
            return nil
        }
        return VoiceTranscriptLocalCache(directory: caches.appendingPathComponent("KordiVoiceTranscripts", isDirectory: true))
    }

    func load(accountId: String) -> [Entry] {
        guard let data = try? Data(contentsOf: fileURL(accountId: accountId)) else { return [] }
        return (try? JSONDecoder().decode([Entry].self, from: data)) ?? []
    }

    func save(_ entries: [Entry], accountId: String) {
        let kept = Array(entries.sorted { $0.savedAt > $1.savedAt }.prefix(Self.maximumEntries))
        let url = fileURL(accountId: accountId)
        let directory = directory
        Task.detached(priority: .utility) {
            guard let data = try? JSONEncoder().encode(kept) else { return }
            try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            try? data.write(to: url, options: [.atomic])
        }
    }

    private func fileURL(accountId: String) -> URL {
        let name = accountId.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? "account"
        return directory.appendingPathComponent("\(name).json")
    }
}
