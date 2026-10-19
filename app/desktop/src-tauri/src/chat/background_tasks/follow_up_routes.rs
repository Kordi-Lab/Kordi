//! Where a background follow-up reply is published, as the webview described
//! it when the parent request started. The webview can reload while a
//! background session runs; the route lives here, with the process that runs
//! the session, so the reloaded webview still knows the target conversation.

use std::collections::{HashMap, VecDeque};

/// Far above the number of parent requests that can still have a running
/// background session; the oldest route is dropped first.
const MAX_ROUTES: usize = 1_024;

#[derive(Default)]
pub(in crate::chat) struct FollowUpRoutes {
    order: VecDeque<String>,
    by_request_id: HashMap<String, serde_json::Value>,
}

impl FollowUpRoutes {
    pub(in crate::chat) fn remember(&mut self, request_id: &str, route: serde_json::Value) {
        let key = request_id.trim();
        if key.is_empty() || route.is_null() {
            return;
        }
        if self.by_request_id.insert(key.to_string(), route).is_none() {
            self.order.push_back(key.to_string());
        }
        while self.order.len() > MAX_ROUTES {
            if let Some(oldest) = self.order.pop_front() {
                self.by_request_id.remove(&oldest);
            }
        }
    }

    pub(in crate::chat) fn get(&self, request_id: Option<&str>) -> Option<serde_json::Value> {
        self.by_request_id.get(request_id.map(str::trim)?).cloned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_route_is_kept_per_request_and_replaced_in_place() {
        let mut routes = FollowUpRoutes::default();
        routes.remember(
            " request-1 ",
            serde_json::json!({"kind": "direct", "peerId": "a"}),
        );
        routes.remember(
            "request-1",
            serde_json::json!({"kind": "direct", "peerId": "b"}),
        );
        routes.remember("", serde_json::json!({"kind": "direct"}));
        routes.remember("request-2", serde_json::Value::Null);

        assert_eq!(
            routes.get(Some("request-1")),
            Some(serde_json::json!({"kind": "direct", "peerId": "b"}))
        );
        assert_eq!(routes.get(Some("request-2")), None);
        assert_eq!(routes.get(None), None);
        assert_eq!(routes.order.len(), 1);
    }

    #[test]
    fn the_oldest_route_is_dropped_past_the_limit() {
        let mut routes = FollowUpRoutes::default();
        for index in 0..=MAX_ROUTES {
            routes.remember(&format!("request-{index}"), serde_json::json!(index));
        }
        assert_eq!(routes.get(Some("request-0")), None);
        assert_eq!(routes.get(Some("request-1")), Some(serde_json::json!(1)));
        assert_eq!(routes.by_request_id.len(), MAX_ROUTES);
    }
}
