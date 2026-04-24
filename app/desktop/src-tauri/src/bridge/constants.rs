pub(super) const API_STYLE_REGISTRY: &str = "registry";
pub(super) const API_STYLE_SERVE: &str = "serve";
pub(super) const BRIDGE_SERVE_SUBCOMMAND: &str = "serve";

pub(super) const DESKTOP_BRIDGE_RUNTIME: &str = "kordi-desktop";
pub(super) const DEFAULT_BRIDGE_RUNTIME: &str = "bridge-node";

pub(super) const BRIDGE_MESSAGE_TYPE_ASK: &str = "ask";
pub(super) const BRIDGE_MESSAGE_TYPE_RAW: &str = "raw";
pub(super) const BRIDGE_MESSAGE_TYPE_RESPONSE: &str = "response";
pub(super) const BRIDGE_MESSAGE_TYPE_DELIVERY_EVENT: &str = "delivery_event";
pub(super) const BRIDGE_MESSAGE_TYPE_TYPING: &str = "typing";
pub(super) const BRIDGE_MESSAGE_TYPE_HEARTBEAT: &str = "heartbeat";

pub(super) const BRIDGE_DELIVERY_STATE_SENT: &str = "sent";
pub(super) const BRIDGE_DELIVERY_STATE_RESPONDED: &str = "responded";
pub(super) const BRIDGE_DELIVERY_STATE_DELIVERED: &str = "delivered";
pub(super) const BRIDGE_DELIVERY_STATE_READ: &str = "read";

pub(super) const BRIDGE_HOST_ID_PREFIX: &str = "bridge_";
pub(super) const BRIDGE_NODE_ID_PREFIX: &str = "kd_";
pub(super) const BRIDGE_HUMAN_ID_PREFIX: &str = "kh_";
pub(super) const BRIDGE_AGENT_ID_PREFIX: &str = "ka_";
pub(super) const BRIDGE_MESSAGE_ID_PREFIX: &str = "bridge_msg_";
pub(super) const BRIDGE_REQUEST_ID_PREFIX: &str = "bridge_req_";
pub(super) const BRIDGE_CONVERSATION_ID_PREFIX: &str = "bridge:";

pub(super) const KORDE_DIR_NAME: &str = ".korde";
pub(super) const DESKTOP_BRIDGE_CONFIG_FILE_NAME: &str = "desktop-bridges.json";
pub(super) const DESKTOP_BRIDGE_CONVERSATIONS_FILE_NAME: &str = "desktop-bridge-conversations.json";
pub(super) const DESKTOP_BRIDGE_SECRETS_FILE_NAME: &str = "desktop-bridge-secrets.json";
pub(super) const LEGACY_BRIDGE_CONFIG_FILE_NAME: &str = "config.json";
pub(super) const DESKTOP_BRIDGE_IDENTITY_FILE_NAME: &str = "desktop-bridge-identity.json";
pub(super) const DESKTOP_BRIDGE_AGENT_IDENTITIES_DIR_NAME: &str = "desktop-bridge-identities";
pub(super) const HOSTED_BRIDGE_DIR_NAME: &str = "hosted-bridge";

pub(super) const DESKTOP_BRIDGE_CONFIG_FALLBACK_PATH: &str = "~/.korde/desktop-bridges.json";
pub(super) const LEGACY_BRIDGE_CONFIG_FALLBACK_PATH: &str = "~/.korde/config.json";
pub(super) const DESKTOP_BRIDGE_CONVERSATIONS_FALLBACK_PATH: &str =
    "~/.korde/desktop-bridge-conversations.json";

pub(super) const DEFAULT_DISPLAY_NAME: &str = "Kordi";
pub(super) const DEFAULT_OWNER_NAME: &str = "Kordi User";
pub(super) const DEFAULT_ENDPOINT: &str = "http://127.0.0.1:39221/kordi-desktop";
pub(super) const DEFAULT_LOCAL_SERVER_HOST: &str = "http://127.0.0.1";
pub(super) const DEFAULT_LOCAL_SERVER_PORT: u16 = 17080;
pub(super) const LOCAL_SERVER_STARTUP_WAIT_MS: u64 = 900;
pub(super) const PEER_TYPING_WINDOW_MS: i64 = 6_000;

pub(super) const BRIDGE_KEYCHAIN_SERVICE_NAME: &str = "app.kordi.desktop.bridge";
pub(super) const BRIDGE_KEYCHAIN_HOST_ACCOUNT_PREFIX: &str = "host:";
pub(super) const BRIDGE_KEYCHAIN_AGENT_ACCOUNT_PREFIX: &str = "agent:";
