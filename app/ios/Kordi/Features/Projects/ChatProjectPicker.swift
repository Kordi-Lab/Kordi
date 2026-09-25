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
                    Button("No project") { assign(nil, device: device) }
                        .foregroundStyle(.primary)
                }
                ForEach(model.projectDevices) { device in
                    Section {
                        ForEach(device.projects.filter { search.isEmpty || $0.name.localizedCaseInsensitiveContains(search) }) { project in
                            Button { assign(project, device: device) } label: {
                                HStack(spacing: 10) {
                                    Image(systemName: "folder").foregroundStyle(.secondary)
                                    Text(project.name).foregroundStyle(.primary)
                                    Spacer()
                                    if let conversation, project.sessions.contains(conversation.sessionId) {
                                        Image(systemName: "checkmark").foregroundStyle(.secondary)
                                    }
                                }
                                .font(.subheadline)
                                .frame(minHeight: 32)
                            }
                            .disabled(!device.online)
                        }
                        Button { importDevice = device } label: {
                            Label("New project", systemImage: "plus").foregroundStyle(.primary)
                        }
                        .disabled(!device.online)
                    } header: {
                        Text(device.online ? device.name : "\(device.name) · Offline")
                    } footer: {
                        if !device.online { Text("Open Kordi on this Mac to use its projects.") }
                    }
                }
                if model.projectDevices.isEmpty {
                    ContentUnavailableView("Connect your Mac", systemImage: "laptopcomputer", description: Text("Open Kordi on your Mac and sign in to the same account. Projects and GitHub imports will appear here."))
                        .listRowBackground(Color.clear)
                }
                if busy { ProgressView("Updating on your Mac…") }
                if let error = error ?? model.projectError {
                    Text(error).font(.footnote).foregroundStyle(KordiTheme.destructiveText)
                }
            }
            .listStyle(.insetGrouped)
            .searchable(text: $search, prompt: "Search projects")
            .navigationTitle("Choose project")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() }.disabled(busy) } }
            .disabled(busy)
            .refreshable { await model.refreshProjects() }
            .task { await model.refreshProjects() }
            .sheet(item: $importDevice) { device in
                ChatProjectImportSheet(device: device) { project in
                    if conversation != nil { assign(project, device: device) }
                }
            }
        }
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

struct ChatProjectComposerControl: View {
    @EnvironmentObject private var model: AppModel
    let conversation: ConversationSummary
    @State private var presented = false

    var body: some View {
        if model.canChooseProject(conversation) {
            Button { presented = true } label: {
                Label(model.project(for: conversation.sessionId)?.name ?? "Choose project", systemImage: "folder")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .padding(.horizontal, 10)
                    .frame(minHeight: 44)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(conversation.agentActivity == .replying)
            .accessibilityHint("Choose the workspace on your Mac for this session")
            .sheet(isPresented: $presented) { ChatProjectPicker(conversation: conversation) }
        }
    }
}
