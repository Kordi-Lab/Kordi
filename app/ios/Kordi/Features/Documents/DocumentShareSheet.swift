import SwiftUI
import UIKit

/// Share for a document, in the flat Settings-sheet style. The owner gets
/// the link switch; everyone gets the send and save rows that apply.
struct DocumentShareSheet: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @ObservedObject var reader: DocumentReaderModel
    let request: DocumentReaderRequest

    @State private var confirmsLinkOff = false
    @State private var forwardRequest: MessageForwardRequest?
    @State private var shareItem: SharedFileItem?
    @State private var isPreparingFile = false
    @State private var copied = false

    private var document: DocumentResponse? { reader.document }
    private var agentName: String { document?.agent?.displayName ?? "the agent" }
    private var canSendInKordi: Bool { request.message != nil && request.conversation != nil }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    if document?.viewerCan.share == true {
                        linkSection
                        SettingsDivider()
                    }
                    sendSection
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 20)
                .padding(.top, 8)
                .padding(.bottom, 24)
            }
            .background(Color(uiColor: .systemBackground))
            .navigationTitle("Share")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .alert("Turn off the link?", isPresented: $confirmsLinkOff) {
            Button("Turn off", role: .destructive) { reader.setLinkOn(false) }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("People in the session keep access.")
        }
        .sheet(item: $forwardRequest) { request in
            ForwardMessageSheet(request: request) { _ in forwardRequest = nil }
        }
        .sheet(item: $shareItem) { item in
            ActivityShareSheet(items: [item.url])
        }
    }

    @ViewBuilder
    private var linkSection: some View {
        SettingsSectionTitle("Link")
        Toggle(isOn: Binding(
            get: { reader.isLinkOn },
            set: { on in
                if on { reader.setLinkOn(true) } else { confirmsLinkOff = true }
            }
        )) {
            CompactSettingsLabel(title: "Anyone with the link", systemImage: "link")
        }
        .frame(minHeight: 48)
        .disabled(reader.isUpdatingShare)
        .accessibilityIdentifier("document-link-toggle")

        if reader.isLinkOn, let share = document?.share {
            HStack(spacing: 12) {
                Text(share.shareUrl.replacingOccurrences(of: "https://", with: ""))
                    .font(.footnote.monospaced())
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .textSelection(.enabled)
                Spacer(minLength: 8)
                Button(copied ? "Copied" : "Copy") {
                    UIPasteboard.general.string = share.shareUrl
                    copied = true
                }
                .font(.subheadline.weight(.semibold))
            }
            .frame(minHeight: 44)

            Toggle(isOn: Binding(
                get: { share.readersCanAskAgent },
                set: { reader.setReadersCanAskAgent($0) }
            )) {
                CompactSettingsLabel(title: "Readers can ask \(agentName)", systemImage: "sparkles")
            }
            .frame(minHeight: 48)
            .disabled(reader.isUpdatingShare)
        }
    }

    @ViewBuilder
    private var sendSection: some View {
        SettingsSectionTitle("Send")
        if canSendInKordi, let message = request.message, let conversation = request.conversation {
            row(title: "Send in Kordi", systemImage: "paperplane") {
                forwardRequest = MessageForwardRequest(sourceConversation: conversation, messages: [message])
            }
        }
        if let url = reader.shareURL {
            ShareLink(item: url, subject: Text(document?.title ?? request.title)) {
                rowLabel(title: "Share link", systemImage: "square.and.arrow.up")
            }
            .buttonStyle(.plain)
        }
        if let attachment = request.attachment {
            row(title: "Save file", systemImage: "arrow.down.circle", isLoading: isPreparingFile) {
                guard !isPreparingFile else { return }
                isPreparingFile = true
                Task {
                    defer { isPreparingFile = false }
                    if let url = await model.prepareAttachmentForSharing(attachment) {
                        shareItem = SharedFileItem(url: url)
                    }
                }
            }
        }
    }

    private func row(title: String, systemImage: String, isLoading: Bool = false, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            rowLabel(title: title, systemImage: systemImage, isLoading: isLoading)
        }
        .buttonStyle(.plain)
    }

    private func rowLabel(title: String, systemImage: String, isLoading: Bool = false) -> some View {
        HStack(spacing: 10) {
            CompactSettingsLabel(title: title, systemImage: systemImage)
            Spacer(minLength: 0)
            if isLoading { ProgressView() } else { SettingsChevron() }
        }
        .frame(minHeight: 48)
        .contentShape(Rectangle())
    }
}
