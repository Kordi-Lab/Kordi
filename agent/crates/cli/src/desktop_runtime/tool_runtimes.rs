use super::DesktopRuntimeSession;

impl DesktopRuntimeSession {
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
}
