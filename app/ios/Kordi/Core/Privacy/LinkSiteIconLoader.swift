import Foundation
import UIKit

/// Loads `https://<host>/favicon.ico` for inline links through a dedicated
/// session: no cookies, no credentials, no disk cache, a per-request redirect
/// guard, and a small body limit. Results live in memory only, so nothing
/// about visited hosts is written to disk.
@MainActor
enum LinkSiteIconLoader {
    nonisolated static let maximumBytes = 256 * 1_024
    nonisolated static let maximumPixelSize: CGFloat = 42
    nonisolated static let failureTTL: TimeInterval = 10 * 60
    nonisolated static let maximumEntries = 512

    private enum Entry {
        case icon(UIImage)
        case failed(until: Date)
    }

    private static var entries: [String: Entry] = [:]
    private static var inFlight: [String: Task<UIImage?, Never>] = [:]

    nonisolated private static let session = URLSession(configuration: makeSessionConfiguration())

    nonisolated static func makeSessionConfiguration() -> URLSessionConfiguration {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil
        configuration.httpCookieAcceptPolicy = .never
        configuration.httpShouldSetCookies = false
        configuration.urlCredentialStorage = nil
        configuration.urlCache = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.timeoutIntervalForRequest = 10
        configuration.timeoutIntervalForResource = 15
        return configuration
    }

    nonisolated static func iconURL(forHost host: String) -> URL? {
        let normalized = host.lowercased()
        guard let url = URL(string: "https://\(normalized)/favicon.ico"),
              url.host?.lowercased() == normalized,
              LinkPreviewPolicy.isPreviewableURL(url) else { return nil }
        return url
    }

    static func icon(forHost host: String, now: Date = Date()) async -> UIImage? {
        guard let url = iconURL(forHost: host) else { return nil }
        let key = url.absoluteString
        switch entries[key] {
        case let .icon(image):
            return image
        case let .failed(until) where until > now:
            return nil
        default:
            break
        }
        if let task = inFlight[key] { return await task.value }

        let task = Task { await fetchIcon(url, session: session) }
        inFlight[key] = task
        let image = await task.value
        inFlight[key] = nil
        if entries.count >= maximumEntries { entries.removeAll() }
        entries[key] = image.map(Entry.icon) ?? .failed(until: now.addingTimeInterval(failureTTL))
        return image
    }

    /// Runs off the main actor: the body is read byte by byte up to the limit.
    nonisolated static func fetchIcon(_ url: URL, session: URLSession) async -> UIImage? {
        guard LinkPreviewPolicy.isPreviewableURL(url) else { return nil }
        var request = URLRequest(url: url)
        request.httpShouldHandleCookies = false
        request.setValue("image/*", forHTTPHeaderField: "Accept")
        let redirectGuard = SiteIconRedirectGuard()
        guard let (bytes, response) = try? await session.bytes(for: request, delegate: redirectGuard) else {
            return nil
        }
        // A refused redirect ends with the 3xx response itself.
        guard let http = response as? HTTPURLResponse,
              (200..<300).contains(http.statusCode),
              http.expectedContentLength <= Int64(maximumBytes) else {
            bytes.task.cancel()
            return nil
        }
        var data = Data()
        do {
            for try await byte in bytes {
                data.append(byte)
                if data.count > maximumBytes {
                    bytes.task.cancel()
                    return nil
                }
            }
        } catch {
            return nil
        }
        guard !data.isEmpty else { return nil }
        return AttachmentImageDecoder.downsampledImage(data: data, maximumPixelSize: maximumPixelSize)
    }
}

/// Follows at most three redirects, and only to URLs that pass
/// `LinkPreviewPolicy.isPreviewableURL`. One instance guards one request.
final class SiteIconRedirectGuard: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    static let maximumRedirects = 3

    private let lock = NSLock()
    private var hops = 0

    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping (URLRequest?) -> Void
    ) {
        let hop = lock.withLock {
            hops += 1
            return hops
        }
        let allowed = hop <= Self.maximumRedirects && LinkPreviewPolicy.isPreviewableURL(request.url)
        completionHandler(allowed ? request : nil)
    }
}
