use super::*;

#[derive(Debug, Serialize)]
pub struct DeviceSyncStatusResponse {
    #[serde(rename = "protocolVersion")]
    pub protocol_version: i32,
    #[serde(rename = "lastAppliedSequence")]
    pub last_applied_sequence: i64,
    #[serde(rename = "lastSuccessfulCatchUpAt")]
    pub last_successful_catch_up_at: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct DeviceAuthorizationResponse {
    #[serde(rename = "deviceId")]
    pub device_id: String,
    #[serde(rename = "displayName")]
    pub display_name: Option<String>,
    pub platform: Option<String>,
    #[serde(rename = "osVersion")]
    pub os_version: Option<String>,
    #[serde(rename = "appVersion")]
    pub app_version: Option<String>,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    #[serde(rename = "lastActiveAt")]
    pub last_active_at: String,
    #[serde(rename = "authorizationState")]
    pub authorization_state: String,
    #[serde(rename = "currentDevice")]
    pub current_device: bool,
    #[serde(rename = "sessionExpiresAt")]
    pub session_expires_at: Option<String>,
    #[serde(rename = "approximateLocation")]
    pub approximate_location: Option<String>,
    #[serde(rename = "syncStatus")]
    pub sync_status: DeviceSyncStatusResponse,
}

#[derive(Debug, Serialize)]
pub struct DeviceListResponse {
    pub devices: Vec<DeviceAuthorizationResponse>,
}

#[derive(Debug, Deserialize)]
pub struct DeviceOperationRequest {
    #[serde(rename = "clientOperationId")]
    pub client_operation_id: uuid::Uuid,
}

#[derive(Debug, Deserialize)]
pub struct RenameDeviceRequest {
    #[serde(rename = "clientOperationId")]
    pub client_operation_id: uuid::Uuid,
    #[serde(rename = "displayName")]
    pub display_name: String,
}

pub use crate::auth::devices::DeviceMetadataUpdateRequest;

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct DeviceMutationResponse {
    #[serde(rename = "affectedDeviceIds")]
    pub affected_device_ids: Vec<String>,
}
