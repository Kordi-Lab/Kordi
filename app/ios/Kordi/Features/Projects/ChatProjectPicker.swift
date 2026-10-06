import SwiftUI

struct ChatProjectPicker: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    let conversation: ConversationSummary?
    @State private var search = ""
    @State private var importDevice: ChatProjectDevice?
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            List {
                if let conversation, let device = model.projectDevices.first(where: { $0.projects.contains { $0.sessions.contains(conversation.sessionId) } }) {
                    Section {
                        PickerRow(title: "No project", systemImage: "folder.badge.minus", showsDivider: false) {
                            assign(nil, device: device)
                        }
                    }
                    .listSectionSeparator(.hidden)
                }
                ForEach(model.projectDevices) { device in
                    Section {
                        ForEach(device.projects.filter { conversation != nil && (search.isEmpty || $0.name.localizedCaseInsensitiveContains(search)) }) { project in
                            PickerRow(
                                title: project.name,
                                systemImage: "folder",
                                isSelected: conversation.map { project.sessions.contains($0.sessionId) } ?? false
                            ) { assign(project, device: device) }
                            .disabled(!device.online)
                        }
                        PickerRow(title: "New project", systemImage: "plus", showsDivider: false) { importDevice = device }
                            .disabled(!device.online)
                    } header: {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(device.online ? device.name : "\(device.name) · Offline")
                                .font(.footnote.weight(.semibold))
                                .foregroundStyle(.primary)
                            if !device.online {
                                Text("Open Kordi on this Mac to use its projects.")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                        .textCase(nil)
                        .listRowInsets(EdgeInsets(top: 12, leading: 20, bottom: 4, trailing: 20))
                    }
                    .listSectionSeparator(.hidden)
                }
                if model.projectDevices.isEmpty {
                    ContentUnavailableView("Connect your Mac", systemImage: "laptopcomputer", description: Text("Open Kordi on your Mac and sign in to the same account. Projects and GitHub imports will appear here."))
                        .listRowBackground(Color.clear)
                        .listRowSeparator(.hidden)
                }
                if busy {
                    ProgressView("Updating on your Mac…")
                        .listRowSeparator(.hidden)
                }
                if let error = error ?? model.projectError {
                    Text(error).font(.caption).foregroundStyle(KordiTheme.destructiveText)
                        .listRowSeparator(.hidden)
                        .listRowInsets(EdgeInsets(top: 8, leading: 20, bottom: 8, trailing: 20))
                }
            }
            .listStyle(.plain)
            .listSectionSpacing(8)
            .scrollContentBackground(.hidden)
            .background(Color(uiColor: .systemBackground))
            .environment(\.defaultMinListRowHeight, 44)
            .searchable(text: $search, placement: .navigationBarDrawer(displayMode: .automatic), prompt: "Search projects")
            .navigationTitle(conversation == nil ? "New project" : "Choose project")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close", systemImage: "xmark") { dismiss() }
                        .labelStyle(.iconOnly)
                        .tint(.primary)
                        .disabled(busy)
                }
            }
            .disabled(busy)
            .refreshable { await model.refreshProjects() }
            .task { await model.refreshProjects() }
            .sheet(item: $importDevice) { device in
                ChatProjectImportSheet(device: device) { project in
                    if conversation != nil { assign(project, device: device) }
                }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .presentationCornerRadius(24)
        .interactiveDismissDisabled(busy)
    }

    private func assign(_ project: ChatProject?, device: ChatProjectDevice) {
        guard let conversation else { return }
        busy = true
        error = nil
        Task {
            do {
                try await model.assignProject(project, device: device, conversation: conversation)
                dismiss()
            } catch { self.error = error.localizedDescription }
            busy = false
        }
    }
}

/// Compact picker row with a custom inset divider in place of the native separator.
private struct PickerRow: View {
    let title: String
    let systemImage: String
    var isSelected = false
    var showsDivider = true
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 12) {
                Image(systemName: systemImage)
                    .font(.body)
                    .foregroundStyle(.secondary)
                    .frame(width: 22)
                Text(title)
                    .font(.subheadline)
                    .foregroundStyle(.primary)
                Spacer(minLength: 8)
                if isSelected {
                    Image(systemName: "checkmark").foregroundStyle(KordiTheme.signalBlue)
                }
            }
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .overlay(alignment: .bottom) {
            if showsDivider { Divider().padding(.leading, 34) }
        }
        .listRowInsets(EdgeInsets(top: 0, leading: 20, bottom: 0, trailing: 20))
        .listRowSeparator(.hidden)
    }
}
