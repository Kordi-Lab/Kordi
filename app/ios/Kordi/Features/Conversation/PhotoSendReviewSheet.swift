import ImageIO
import SwiftUI
import UIKit

enum PhotoSendGrouping: Equatable {
    case combined
    case separate
}

struct PhotoSelectionReview: Identifiable {
    let id = UUID()
    let attachments: [PendingAttachment]
}

enum OutgoingAttachmentGroupingPlan {
    static func batches(
        for attachments: [PendingAttachment],
        photoGrouping: PhotoSendGrouping
    ) -> [[PendingAttachment]] {
        let images = attachments.filter { $0.kind == .image }
        guard photoGrouping == .separate, images.count > 1 else {
            return attachments.isEmpty ? [] : [attachments]
        }

        var batches = images.map { [$0] }
        let otherAttachments = attachments.filter { $0.kind != .image }
        if !otherAttachments.isEmpty {
            batches[0].append(contentsOf: otherAttachments)
        }
        return batches
    }
}

struct PhotoSendReviewSheet: View {
    @Environment(\.dismiss) private var dismiss

    let review: PhotoSelectionReview
    let allowsSeparateMessages: Bool
    let onSend: (PhotoSendGrouping) async -> Void

    @State private var grouping: PhotoSendGrouping = .combined
    @State private var isSending = false

    private let columns = [
        GridItem(.flexible(), spacing: 2),
        GridItem(.flexible(), spacing: 2),
        GridItem(.flexible(), spacing: 2),
    ]

    var body: some View {
        NavigationStack {
            ScrollView {
                LazyVGrid(columns: columns, spacing: 2) {
                    ForEach(review.attachments) { attachment in
                        PhotoSelectionThumbnail(attachment: attachment)
                    }
                }
                .padding(.horizontal, 2)
                .padding(.top, 8)

                if allowsSeparateMessages {
                    groupingControl
                        .padding(.horizontal, 16)
                        .padding(.vertical, 18)
                }
            }
            .background(Color(uiColor: .systemGroupedBackground))
            .navigationTitle("Selected Photos")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Cancel", action: dismiss.callAsFunction)
                        .disabled(isSending)
                }
            }
            .safeAreaInset(edge: .bottom, spacing: 0) {
                sendBar
            }
        }
        .interactiveDismissDisabled(isSending)
    }

    private var groupingControl: some View {
        Button {
            grouping = grouping == .combined ? .separate : .combined
        } label: {
            HStack(spacing: 12) {
                Image(systemName: grouping == .combined ? "checkmark.circle.fill" : "circle")
                    .font(.title3)
                    .foregroundStyle(grouping == .combined ? KordiTheme.signalBlue : .secondary)

                VStack(alignment: .leading, spacing: 3) {
                    Text("Send as one grouped message")
                        .font(.body.weight(.semibold))
                        .foregroundStyle(.primary)
                    Text(grouping == .combined
                         ? "The photos appear as one expandable stack."
                         : "Each photo appears as its own message.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.leading)
                }

                Spacer(minLength: 0)
            }
            .frame(maxWidth: .infinity, minHeight: 52, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Send as one grouped message")
        .accessibilityValue(grouping == .combined ? "On" : "Off")
        .accessibilityHint("Double tap to change how the selected photos appear in the conversation")
        .accessibilityAddTraits(grouping == .combined ? .isSelected : [])
    }

    private var sendBar: some View {
        HStack {
            Text("\(review.attachments.count) selected")
                .font(.subheadline)
                .foregroundStyle(.secondary)

            Spacer(minLength: 12)

            Button(action: send) {
                HStack(spacing: 8) {
                    if isSending {
                        ProgressView()
                            .tint(.white)
                            .controlSize(.small)
                    }
                    Text("Send \(review.attachments.count)")
                        .font(.body.weight(.semibold))
                }
                .frame(minWidth: 92, minHeight: 44)
            }
            .buttonStyle(.borderedProminent)
            .disabled(isSending)
            .accessibilityLabel(isSending
                                ? "Sending selected photos"
                                : "Send \(review.attachments.count) selected photos")
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .background(.bar)
    }

    private func send() {
        guard !isSending else { return }
        isSending = true
        Task {
            await onSend(grouping)
            dismiss()
        }
    }
}

private struct PhotoSelectionThumbnail: View {
    let attachment: PendingAttachment

    @State private var image: UIImage?

    var body: some View {
        ZStack {
            Color(uiColor: .secondarySystemGroupedBackground)

            if let image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
                    .transition(.opacity)
            } else {
                ProgressView()
            }
        }
        .aspectRatio(1, contentMode: .fit)
        .clipped()
        .task(id: attachment.id) {
            image = await Task.detached(priority: .userInitiated) {
                AttachmentImageDecoder.downsampledImage(
                    data: attachment.data,
                    maximumPixelSize: 720
                )
            }.value
        }
        .accessibilityLabel(attachment.name)
    }
}
