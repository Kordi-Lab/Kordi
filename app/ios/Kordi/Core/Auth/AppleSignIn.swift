import AuthenticationServices
import CryptoKit
import Foundation
import SwiftUI
import UIKit

/// The nonce that binds Apple's identity token to this sign-in: the request
/// carries its SHA-256 and the server receives the raw value.
enum AppleSignInNonce {
    private static let alphabet = Array("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_")

    static func make(length: Int = 32) -> String {
        var bytes = [UInt8](repeating: 0, count: length)
        if SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) != errSecSuccess {
            var generator = SystemRandomNumberGenerator()
            bytes = bytes.map { _ in UInt8.random(in: .min ... .max, using: &generator) }
        }
        // 256 is a multiple of the 64-character alphabet, so there is no bias.
        return String(bytes.map { alphabet[Int($0) % alphabet.count] })
    }

    static func sha256Hex(_ value: String) -> String {
        SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined()
    }
}

enum AppleSignInError: LocalizedError, Equatable {
    case cancelled
    case busy
    case invalidCredential

    var errorDescription: String? {
        switch self {
        case .cancelled: "Sign-in was canceled."
        case .busy: "Sign-in is already in progress."
        case .invalidCredential: "Apple did not return a valid sign-in. Try again."
        }
    }

    /// Cancelling the Apple sheet is not an error worth showing.
    static func isCancellation(_ error: Error) -> Bool {
        if let error = error as? AppleSignInError { return error == .cancelled }
        if let error = error as? ASAuthorizationError { return error.code == .canceled }
        return false
    }
}

/// Runs the native Sign in with Apple sheet and returns Apple's credential.
@MainActor
final class AppleSignInController: NSObject, ASAuthorizationControllerDelegate,
    ASAuthorizationControllerPresentationContextProviding {
    private var continuation: CheckedContinuation<AppleSignInCredential, Error>?
    private var controller: ASAuthorizationController?

    func signIn(hashedNonce: String) async throws -> AppleSignInCredential {
        guard continuation == nil else { throw AppleSignInError.busy }
        let request = ASAuthorizationAppleIDProvider().createRequest()
        request.requestedScopes = [.fullName, .email]
        request.nonce = hashedNonce
        let controller = ASAuthorizationController(authorizationRequests: [request])
        controller.delegate = self
        controller.presentationContextProvider = self
        self.controller = controller
        return try await withCheckedThrowingContinuation { continuation in
            self.continuation = continuation
            controller.performRequests()
        }
    }

    func authorizationController(
        controller: ASAuthorizationController,
        didCompleteWithAuthorization authorization: ASAuthorization
    ) {
        guard let apple = authorization.credential as? ASAuthorizationAppleIDCredential,
              let tokenData = apple.identityToken,
              let token = String(data: tokenData, encoding: .utf8),
              let codeData = apple.authorizationCode,
              let code = String(data: codeData, encoding: .utf8) else {
            finish(.failure(AppleSignInError.invalidCredential))
            return
        }
        finish(.success(AppleSignInCredential(
            identityToken: token,
            authorizationCode: code,
            givenName: apple.fullName?.givenName,
            familyName: apple.fullName?.familyName,
            email: apple.email
        )))
    }

    func authorizationController(controller: ASAuthorizationController, didCompleteWithError error: Error) {
        finish(.failure(AppleSignInError.isCancellation(error) ? AppleSignInError.cancelled : error))
    }

    func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        for scene in scenes where scene.activationState == .foregroundActive {
            if let window = scene.windows.first(where: \.isKeyWindow) ?? scene.windows.first {
                return window
            }
        }
        return scenes.first?.windows.first ?? UIWindow(frame: .zero)
    }

    private func finish(_ result: Result<AppleSignInCredential, Error>) {
        controller = nil
        let continuation = continuation
        self.continuation = nil
        continuation?.resume(with: result)
    }
}

/// Apple's own Sign in with Apple button, with the corner radius of the
/// buttons beside it.
struct AppleSignInButton: UIViewRepresentable {
    let style: ASAuthorizationAppleIDButton.Style
    var cornerRadius: CGFloat = 26
    let action: () -> Void

    func makeUIView(context: Context) -> ASAuthorizationAppleIDButton {
        let button = ASAuthorizationAppleIDButton(authorizationButtonType: .signIn, authorizationButtonStyle: style)
        button.cornerRadius = cornerRadius
        button.addTarget(context.coordinator, action: #selector(Coordinator.tapped), for: .touchUpInside)
        return button
    }

    func updateUIView(_ button: ASAuthorizationAppleIDButton, context: Context) {
        context.coordinator.action = action
        button.cornerRadius = cornerRadius
        button.isEnabled = context.environment.isEnabled
    }

    func makeCoordinator() -> Coordinator { Coordinator(action: action) }

    final class Coordinator: NSObject {
        var action: () -> Void

        init(action: @escaping () -> Void) {
            self.action = action
        }

        @objc func tapped() { action() }
    }
}

/// Kordi's public legal pages.
enum KordiLegalLinks {
    static let terms = URL(string: "https://kordi.ai/terms")!
    static let privacy = URL(string: "https://kordi.ai/privacy")!

    /// "By continuing you agree to the Terms and Privacy Policy." with both links.
    static var agreement: AttributedString {
        var line = AttributedString("By continuing you agree to the ")
        line.append(link("Terms", terms))
        line.append(AttributedString(" and "))
        line.append(link("Privacy Policy", privacy))
        line.append(AttributedString("."))
        return line
    }

    private static func link(_ title: String, _ url: URL) -> AttributedString {
        var text = AttributedString(title)
        text.link = url
        text.underlineStyle = .single
        return text
    }
}
