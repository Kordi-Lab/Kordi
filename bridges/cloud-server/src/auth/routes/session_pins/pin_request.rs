//! Applies one pin request to a scope's ordered pin list. The last entry is
//! the latest pin, which is also the single pin older clients display.

pub(super) const MAX_SCOPE_PINS: usize = 5;

/// Returns the next pin list and the message the request acted on.
///
/// Current clients name an `action`. Clients released before pin stacks send
/// only `messageId`: a value pins that message, and no value unpins the one
/// pin they display. Either way only that message changes.
pub(super) fn apply_pin_request(
    previous: &[String],
    action: Option<&str>,
    message_id: Option<&str>,
) -> (Vec<String>, Option<String>) {
    let mut next = previous.to_vec();
    let target = match (action, message_id) {
        (Some("unpin"), Some(id)) => {
            next.retain(|pinned| pinned != id);
            Some(id.to_string())
        }
        (Some(_), Some(id)) => {
            if !next.iter().any(|pinned| pinned == id) {
                next.push(id.to_string());
            }
            Some(id.to_string())
        }
        // An older client expects the message it pinned to be the one it shows.
        // It used to replace the pin, so a full scope drops its oldest pin
        // instead of refusing.
        (None, Some(id)) => {
            next.retain(|pinned| pinned != id);
            next.push(id.to_string());
            if next.len() > MAX_SCOPE_PINS {
                next.remove(0);
            }
            Some(id.to_string())
        }
        (None, None) => next.pop(),
        (Some(_), None) => None,
    };
    (next, target)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ids(values: &[&str]) -> Vec<String> {
        values.iter().map(ToString::to_string).collect()
    }

    #[test]
    fn current_clients_add_and_remove_one_message() {
        let pins = ids(&["one", "two"]);
        assert_eq!(
            apply_pin_request(&pins, Some("pin"), Some("three")),
            (ids(&["one", "two", "three"]), Some("three".to_string()))
        );
        assert_eq!(
            apply_pin_request(&pins, Some("pin"), Some("one")),
            (ids(&["one", "two"]), Some("one".to_string()))
        );
        assert_eq!(
            apply_pin_request(&pins, Some("unpin"), Some("one")),
            (ids(&["two"]), Some("one".to_string()))
        );
        assert_eq!(
            apply_pin_request(&pins, Some("unpin"), Some("missing")),
            (ids(&["one", "two"]), Some("missing".to_string()))
        );
    }

    #[test]
    fn older_client_pin_keeps_the_other_pins() {
        let pins = ids(&["one", "two"]);
        assert_eq!(
            apply_pin_request(&pins, None, Some("legacy")),
            (ids(&["one", "two", "legacy"]), Some("legacy".to_string()))
        );
        assert_eq!(
            apply_pin_request(&[], None, Some("legacy")),
            (ids(&["legacy"]), Some("legacy".to_string()))
        );
    }

    #[test]
    fn older_client_pin_of_a_pinned_message_makes_it_the_displayed_pin() {
        let pins = ids(&["one", "two", "three"]);
        assert_eq!(
            apply_pin_request(&pins, None, Some("one")),
            (ids(&["two", "three", "one"]), Some("one".to_string()))
        );
        assert_eq!(
            apply_pin_request(&pins, None, Some("three")),
            (pins.clone(), Some("three".to_string()))
        );
    }

    #[test]
    fn older_client_pin_on_a_full_scope_drops_the_oldest_pin() {
        let pins = ids(&["one", "two", "three", "four", "five"]);
        assert_eq!(
            apply_pin_request(&pins, None, Some("legacy")),
            (
                ids(&["two", "three", "four", "five", "legacy"]),
                Some("legacy".to_string())
            )
        );
    }

    #[test]
    fn older_client_unpin_removes_only_the_displayed_pin() {
        let pins = ids(&["one", "two", "three"]);
        assert_eq!(
            apply_pin_request(&pins, None, None),
            (ids(&["one", "two"]), Some("three".to_string()))
        );
        assert_eq!(apply_pin_request(&[], None, None), (Vec::new(), None));
    }
}
