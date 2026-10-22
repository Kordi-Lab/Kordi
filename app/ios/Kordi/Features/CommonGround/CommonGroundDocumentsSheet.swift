import SwiftUI

/// Picks up to eight of the account's own documents for a card.
struct CommonGroundDocumentsSheet: View {
    @Environment(\.dismiss) private var dismiss
    /// Nil while loading.
    let documents: [CommonGroundDocument]?
    let failed: Bool
    @Binding var selection: [String]

    private var full: Bool { selection.count >= CommonGroundSourcePicks.maxDocuments }

    var body: some View {
        NavigationStack {
            content
                .navigationTitle("Documents")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Done") { dismiss() }
                    }
                }
        }
    }

    @ViewBuilder private var content: some View {
        if let documents, !documents.isEmpty {
            List(documents) { document in
                row(document)
            }
        } else {
            Group {
                if documents == nil && !failed {
                    ProgressView()
                } else {
                    Text(failed ? "Could not load documents" : "No documents you own yet")
                        .foregroundStyle(.secondary)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Color(uiColor: .systemGroupedBackground))
        }
    }

    private func row(_ document: CommonGroundDocument) -> some View {
        let chosen = selection.contains(document.attachmentId)
        return Button {
            if chosen {
                selection.removeAll { $0 == document.attachmentId }
            } else if !full {
                selection.append(document.attachmentId)
            }
        } label: {
            HStack(spacing: 12) {
                Image(systemName: chosen ? "checkmark.circle.fill" : "circle")
                    .font(.title3)
                    .foregroundStyle(chosen ? Color.accentColor : Color(uiColor: .tertiaryLabel))
                VStack(alignment: .leading, spacing: 2) {
                    Text(document.displayTitle)
                        .foregroundStyle(.primary)
                        .lineLimit(1)
                    if let date = document.shortDate() {
                        Text(date).font(.footnote).foregroundStyle(.secondary)
                    }
                }
                Spacer(minLength: 0)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!chosen && full)
        .accessibilityAddTraits(chosen ? .isSelected : [])
    }
}
