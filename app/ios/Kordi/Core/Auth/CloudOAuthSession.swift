import AuthenticationServices
import Foundation
import UIKit

enum CloudOAuthSessionError: LocalizedError, Equatable {
    case cancelled
    case couldNotStart
    case invalidCallback
    case provider(String)

    var errorDescription: String? {
        switch self {
        case .cancelled:
            "Sign-in was canceled."
        case .couldNotStart:
            "Could not open the secure sign-in window. Try again."
        case .invalidCallback:
            "Kordi did not receive a valid sign-in session. Try again."
        case .provider(let message):
            message
        }
    }
}

enum CloudOAuthCallbackParser {
    static let callbackURL = URL(string: "kordi://oauth/callback")!

    static func parse(_ url: URL) throws -> CloudAuthResponse {
        guard url.scheme == callbackURL.scheme,
              url.host == callbackURL.host,
              url.path == callbackURL.path,
              let fragment = URLComponents(url: url, resolvingAgainstBaseURL: false)?.fragment else {
            throw CloudOAuthSessionError.invalidCallback
        }

        let queryURL = URL(string: "https://callback.invalid/?\(fragment)")
        let items = URLComponents(url: queryURL!, resolvingAgainstBaseURL: false)?.queryItems ?? []
        if let message = items.first(where: { $0.name == "kordi_cloud_oauth_error" })?.value?.nonEmpty {
            throw CloudOAuthSessionError.provider(message)
        }
        guard let encoded = items.first(where: { $0.name == "kordi_cloud_oauth" })?.value,
              let data = decodeBase64URL(encoded),
              let result = try? JSONDecoder().decode(CloudAuthResponse.self, from: data),
              !result.account.accountId.isEmpty,
              !result.session.token.isEmpty,
              !result.session.expiresAt.isEmpty else {
            throw CloudOAuthSessionError.invalidCallback
        }
        return result
    }

    private static func decodeBase64URL(_ value: String) -> Data? {
        var normalized = value
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        let remainder = normalized.count % 4
        if remainder != 0 {
            normalized.append(String(repeating: "=", count: 4 - remainder))
        }
        return Data(base64Encoded: normalized)
    }
}

@MainActor
final class CloudOAuthSession: NSObject, ASWebAuthenticationPresentationContextProviding {
    private let api: CloudAPIClient
    private var webSession: ASWebAuthenticationSession?

    init(api: CloudAPIClient) {
        self.api = api
    }

    func authenticate(with provider: CloudOAuthProvider) async throws -> CloudAuthResponse {
        let authenticationURL = try await api.startOAuth(
            provider: provider,
            redirectAfter: CloudOAuthCallbackParser.callbackURL
        )
        let callbackURL = try await open(authenticationURL)
        return try CloudOAuthCallbackParser.parse(callbackURL)
    }

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        for scene in scenes where scene.activationState == .foregroundActive {
            if let keyWindow = scene.windows.first(where: \.isKeyWindow) {
                return keyWindow
            }
            if let window = scene.windows.first {
                return window
            }
        }
        return scenes.first?.windows.first ?? UIWindow(frame: .zero)
    }

    private func open(_ url: URL) async throws -> URL {
        try await withCheckedThrowingContinuation { continuation in
            let completion: ASWebAuthenticationSession.CompletionHandler = { [weak self] callbackURL, error in
                Task { @MainActor in
                    self?.webSession = nil
                    if let sessionError = error as? ASWebAuthenticationSessionError,
                       sessionError.code == .canceledLogin {
                        continuation.resume(throwing: CloudOAuthSessionError.cancelled)
                    } else if let error {
                        continuation.resume(throwing: error)
                    } else if let callbackURL {
                        continuation.resume(returning: callbackURL)
                    } else {
                        continuation.resume(throwing: CloudOAuthSessionError.invalidCallback)
                    }
                }
            }

            let session: ASWebAuthenticationSession
            if #available(iOS 17.4, *) {
                session = ASWebAuthenticationSession(
                    url: url,
                    callback: .customScheme(CloudOAuthCallbackParser.callbackURL.scheme!),
                    completionHandler: completion
                )
            } else {
                session = ASWebAuthenticationSession(
                    url: url,
                    callbackURLScheme: CloudOAuthCallbackParser.callbackURL.scheme,
                    completionHandler: completion
                )
            }
            session.presentationContextProvider = self
            session.prefersEphemeralWebBrowserSession = false
            webSession = session
            guard session.start() else {
                webSession = nil
                continuation.resume(throwing: CloudOAuthSessionError.couldNotStart)
                return
            }
        }
    }
}
