use super::*;

#[test]
fn test_connectors_mac_local_defaults_off_and_merges_from_global_only() {
    let defaults = Settings::parse("{}");
    assert!(!defaults.connectors.mac_local.calendar);
    assert!(!defaults.connectors.mac_local.contacts);
    assert!(!defaults.connectors.mac_local.notification_center);
    assert!(
        !serde_json::to_string(&defaults)
            .unwrap()
            .contains("connectors")
    );

    let global = Settings::parse(
        r#"{"connectors":{"mac_local":{"calendar":true,"notification_center":true}}}"#,
    );
    assert!(global.connectors.mac_local.calendar);
    assert!(!global.connectors.mac_local.contacts);
    assert!(global.connectors.mac_local.notification_center);

    let project = Settings::parse(r#"{"connectors":{"mac_local":{"contacts":true}}}"#);
    let merged = Settings::merge(&global, &project);
    assert_eq!(merged.connectors, global.connectors);
    let merged = Settings::merge(&Settings::default(), &project);
    assert!(!merged.connectors.mac_local.contacts);
}
