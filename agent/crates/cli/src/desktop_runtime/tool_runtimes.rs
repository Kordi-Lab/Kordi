//! Setters that attach tool runtimes (reach out, scheduled tasks, session
//! observation, Mac-local tools, and the account memory remote) to a desktop
//! session.

use super::DesktopRuntimeSession;

impl DesktopRuntimeSession {
    pub fn set_reach_out_runtime(&mut self, runtime: Option<kordi_tools::ReachOutRuntime>) {
        self.setup.tool_ctx.reach_out = runtime;
    }

    pub fn set_scheduled_tasks_cloud_runtime(&mut self, api_base: String, token: String) {
        self.set_scheduled_tasks_cloud_runtime_for_session(
            api_base,
            token,
            self.setup.session_id.clone(),
        );
    }

    pub fn set_scheduled_tasks_cloud_runtime_for_session(
        &mut self,
        api_base: String,
        token: String,
        session_id: String,
    ) {
        self.setup.tool_ctx.schedule_task = Some(
            crate::scheduled_tasks_runtime::build_scheduled_tasks_runtime_for_session(
                api_base, token, session_id,
            ),
        );
    }

    pub fn set_session_observation_runtime(
        &mut self,
        runtime: Option<kordi_tools::SessionObservationRuntime>,
    ) {
        self.setup.tool_ctx.session_observation = runtime;
    }

    /// Set per turn by the desktop host; `None` removes the Mac-local tools.
    pub fn set_mac_local_runtime(
        &mut self,
        runtime: Option<kordi_tools::mac_local::MacLocalRuntime>,
    ) {
        self.setup.tool_ctx.mac_local = runtime;
    }

    /// Set the account memory remote used by the `reflection` tool. `None`
    /// keeps memories on this Mac and marks them for a later upload.
    pub fn set_memory_remote(
        &mut self,
        remote: Option<std::sync::Arc<dyn crate::memory_remote::MemoryRemote>>,
    ) {
        match self.setup.memory_remote.write() {
            Ok(mut slot) => *slot = remote,
            Err(poisoned) => *poisoned.into_inner() = remote,
        }
    }
}
