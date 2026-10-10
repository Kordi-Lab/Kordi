use super::{ToolRegistry, ToolSelection, build_tool_defs, build_tool_metadata};

impl ToolRegistry {
    /// Mac-local connector tools exist only for an owner-local run whose host
    /// supplied a runtime, and only for the sources that runtime has on. Called
    /// before every turn so settings toggles apply immediately.
    /// The CLI binary has no desktop runtime, so it never calls this.
    #[allow(dead_code)]
    pub(crate) fn sync_mac_local_tools(
        &mut self,
        runtime: Option<&kordi_tools::mac_local::MacLocalRuntime>,
        selection: &ToolSelection,
    ) {
        let is_mac_local =
            |name: &str| kordi_tools::mac_local::MAC_LOCAL_TOOL_NAMES.contains(&name);
        self.active_tools.retain(|tool| !is_mac_local(tool.name()));
        for tool in kordi_tools::mac_local::mac_local_tools(runtime) {
            let selected = match selection {
                ToolSelection::All => true,
                ToolSelection::AllExcept(excluded) => {
                    !excluded.iter().any(|name| name == tool.name())
                }
                ToolSelection::None => false,
                ToolSelection::Only(names) => names.iter().any(|name| name == tool.name()),
            };
            if selected {
                self.active_tools.push(tool);
            }
        }
        self.tool_defs = build_tool_defs(&self.active_tools);
        self.metadata_by_name = build_tool_metadata(&self.active_tools);
        #[cfg(test)]
        {
            self.active_names = self
                .active_tools
                .iter()
                .map(|tool| tool.name().to_string())
                .collect();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn mac_local_runtime(
        notification_center_enabled: bool,
    ) -> kordi_tools::mac_local::MacLocalRuntime {
        fn reader<R: Send + 'static>() -> kordi_tools::mac_local::MacLocalFn<R> {
            std::sync::Arc::new(|_| Box::pin(async { Ok(json!({})) }))
        }
        kordi_tools::mac_local::MacLocalRuntime {
            read_events: reader(),
            read_reminders: reader(),
            search_contacts: reader(),
            recent_notifications: reader(),
            calendar_enabled: true,
            contacts_enabled: true,
            notification_center_enabled,
        }
    }

    #[test]
    fn mac_local_tools_follow_the_turn_runtime() {
        use kordi_tools::mac_local::MAC_LOCAL_TOOL_NAMES;
        let mut registry = ToolRegistry::from_builtin_and_extensions(vec![], ToolSelection::All);
        let has = |registry: &ToolRegistry, name: &str| {
            registry.active_names().iter().any(|active| active == name)
                && registry
                    .tool_defs()
                    .iter()
                    .any(|def| def["function"]["name"] == name)
        };
        for name in MAC_LOCAL_TOOL_NAMES {
            assert!(!has(&registry, name), "{name} is not a default builtin");
        }

        registry.sync_mac_local_tools(None, &ToolSelection::All);
        for name in MAC_LOCAL_TOOL_NAMES {
            assert!(!has(&registry, name), "{name} without a runtime");
        }

        let runtime = mac_local_runtime(false);
        registry.sync_mac_local_tools(Some(&runtime), &ToolSelection::All);
        for name in &MAC_LOCAL_TOOL_NAMES[..3] {
            assert!(has(&registry, name), "{name} with a runtime");
        }
        assert!(!has(&registry, MAC_LOCAL_TOOL_NAMES[3]));
        assert!(has(&registry, "read"));

        let runtime = mac_local_runtime(true);
        registry.sync_mac_local_tools(Some(&runtime), &ToolSelection::All);
        for name in MAC_LOCAL_TOOL_NAMES {
            assert!(has(&registry, name), "{name} with Notification Center on");
        }
        let count = registry.len();
        registry.sync_mac_local_tools(Some(&runtime), &ToolSelection::All);
        assert_eq!(
            registry.len(),
            count,
            "syncing twice must not duplicate tools"
        );

        registry.sync_mac_local_tools(None, &ToolSelection::All);
        for name in MAC_LOCAL_TOOL_NAMES {
            assert!(!has(&registry, name), "{name} after the runtime is removed");
        }

        registry.sync_mac_local_tools(Some(&runtime), &ToolSelection::None);
        assert!(!has(&registry, MAC_LOCAL_TOOL_NAMES[0]));
    }
}
