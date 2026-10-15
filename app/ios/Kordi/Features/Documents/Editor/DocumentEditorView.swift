import SwiftUI

/// Who may edit a document's content on iPhone: members and the owner of a
/// Markdown document the server lets them edit.
enum DocumentEditing {
    static func isAvailable(for document: DocumentResponse) -> Bool {
        document.viewer != .public && document.viewerCan.edit == true && document.format == .markdown
    }
}

/// Edits a shared document with the Mac's editor, live with everyone else in
/// it. Done saves what is pending and leaves the room.
struct DocumentEditorView: View {
    @StateObject private var session: DocumentEditorSession
    @Environment(\.dismiss) private var dismiss
    @State private var isClosing = false
    @State private var showsLink = false
    @State private var linkDraft = ""

    init(session: @autoclosure @escaping () -> DocumentEditorSession) {
        _session = StateObject(wrappedValue: session())
    }

    var body: some View {
        NavigationStack {
            ZStack {
                DocumentEditorWebView(session: session)
                    .opacity(session.isLoaded ? 1 : 0)
                if let error = session.loadError {
                    ContentUnavailableView(error, systemImage: "doc.text")
                } else if !session.isLoaded {
                    ProgressView()
                }
            }
            .safeAreaInset(edge: .bottom, spacing: 0) {
                if session.isLoaded && session.loadError == nil {
                    VStack(spacing: 6) {
                        if let notice = session.notice {
                            Text(notice)
                                .font(.footnote.weight(.medium))
                                .padding(.horizontal, 12)
                                .padding(.vertical, 6)
                                .background(.regularMaterial, in: Capsule())
                                .transition(.opacity)
                        }
                        DocumentEditorToolbar(session: session, onLink: beginLink)
                    }
                }
            }
            .background(Color(uiColor: .systemBackground))
            .navigationTitle(session.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    if isClosing {
                        ProgressView()
                    } else {
                        Button("Done", action: close)
                            .fontWeight(.semibold)
                    }
                }
                ToolbarItem(placement: .topBarLeading) {
                    if !session.peers.isEmpty {
                        DocumentEditorPresence(peers: session.peers)
                    }
                }
            }
            .alert("Link", isPresented: $showsLink) {
                TextField("https://", text: $linkDraft)
                    .keyboardType(.URL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                Button("Cancel", role: .cancel) {}
                Button("Add") { session.command("link", value: linkDraft) }
                    .disabled(linkDraft.trimmingCharacters(in: .whitespaces).isEmpty)
            }
        }
        .interactiveDismissDisabled()
        .task(id: session.notice) {
            guard session.notice != nil else { return }
            try? await Task.sleep(for: .seconds(3))
            withAnimation { session.notice = nil }
        }
    }

    /// An active link is removed; otherwise asks for the address.
    private func beginLink() {
        if session.toolbar.link {
            session.command("link", value: "")
            return
        }
        linkDraft = ""
        showsLink = true
    }

    private func close() {
        isClosing = true
        Task {
            await session.close()
            dismiss()
        }
    }
}
