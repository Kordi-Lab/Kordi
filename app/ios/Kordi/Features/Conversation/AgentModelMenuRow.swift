import SwiftUI

/// One labeled menu of the agent model sheet, shown as a popover list.
struct AgentModelMenuRow: View {
    let title: String
    let options: [String]
    @Binding var selection: String
    var isEnabled = true
    var optionLabel: (String) -> String = { $0 }
    @State private var isOptionsPresented = false

    private var selectedLabel: String {
        optionLabel(selection.nonEmpty ?? options.first ?? "")
    }

    var body: some View {
        HStack(spacing: 12) {
            Text(title)
                .lineLimit(1)
                .layoutPriority(1)

            Button {
                isOptionsPresented = true
            } label: {
                HStack(spacing: 5) {
                    Text(selectedLabel)
                        .lineLimit(1)
                        .truncationMode(.tail)
                        .foregroundStyle(.primary)

                    if isEnabled && !options.isEmpty {
                        Image(systemName: "chevron.up.chevron.down")
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(KordiTheme.signalBlue)
                            .accessibilityHidden(true)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .trailing)
                .contentShape(Rectangle())
            }
            .frame(maxWidth: .infinity, alignment: .trailing)
            .buttonStyle(.plain)
            .disabled(!isEnabled)
            .accessibilityLabel(title)
            .accessibilityValue(selectedLabel)
            .popover(
                isPresented: $isOptionsPresented,
                attachmentAnchor: .rect(.bounds),
                arrowEdge: .bottom
            ) {
                ScrollView {
                    LazyVStack(spacing: 2) {
                        ForEach(options, id: \.self) { option in
                            let isSelected = selection == option
                            Button {
                                selection = option
                                isOptionsPresented = false
                            } label: {
                                Text(optionLabel(option))
                                    .font(.body.weight(isSelected ? .semibold : .regular))
                                    .foregroundStyle(isSelected ? KordiTheme.signalBlue : .primary)
                                    .lineLimit(1)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .padding(.horizontal, 12)
                                    .frame(minHeight: 44)
                                    .background(
                                        isSelected
                                            ? KordiTheme.signalBlue.opacity(0.12)
                                            : Color.clear,
                                        in: RoundedRectangle(cornerRadius: 10, style: .continuous)
                                    )
                                    .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .accessibilityValue(isSelected ? "Selected" : "Not selected")
                            .accessibilityAddTraits(isSelected ? .isSelected : [])
                        }
                    }
                    .padding(8)
                }
                .frame(width: 290)
                .frame(height: min(CGFloat(options.count) * 46 + 16, 360))
                .presentationCompactAdaptation(.popover)
            }
        }
        .frame(minHeight: 44)
    }
}
