use std::time::Duration;

use livekit_api::access_token::{AccessToken, AccessTokenError, VideoGrants};
use url::Url;

const JOIN_TOKEN_TTL: Duration = Duration::from_secs(5 * 60);

#[derive(Clone)]
pub struct CallMediaConfig {
    client_url: String,
    api_key: String,
    api_secret: String,
}

#[derive(Debug, thiserror::Error)]
pub enum CallMediaConfigError {
    #[error("KORDI_LIVEKIT_URL, KORDI_LIVEKIT_API_KEY, and KORDI_LIVEKIT_API_SECRET must be configured together")]
    Incomplete,
    #[error("KORDI_LIVEKIT_URL must use wss, or ws on loopback for isolated development")]
    UnsafeUrl,
    #[error("could not create a short-lived media token")]
    Token(#[from] AccessTokenError),
}

impl CallMediaConfig {
    pub fn from_env() -> Result<Option<Self>, CallMediaConfigError> {
        let url = non_empty_env("KORDI_LIVEKIT_URL");
        let api_key = non_empty_env("KORDI_LIVEKIT_API_KEY");
        let api_secret = non_empty_env("KORDI_LIVEKIT_API_SECRET");
        match (url, api_key, api_secret) {
            (None, None, None) => Ok(None),
            (Some(client_url), Some(api_key), Some(api_secret)) => {
                let parsed =
                    Url::parse(&client_url).map_err(|_| CallMediaConfigError::UnsafeUrl)?;
                let secure = parsed.scheme() == "wss";
                let loopback = parsed.scheme() == "ws"
                    && parsed.host_str().is_some_and(|host| {
                        host == "localhost"
                            || host
                                .parse::<std::net::IpAddr>()
                                .is_ok_and(|ip| ip.is_loopback())
                    });
                if !secure && !loopback {
                    return Err(CallMediaConfigError::UnsafeUrl);
                }
                Ok(Some(Self {
                    client_url,
                    api_key,
                    api_secret,
                }))
            }
            _ => Err(CallMediaConfigError::Incomplete),
        }
    }

    pub fn client_url(&self) -> &str {
        &self.client_url
    }

    pub fn join_token(
        &self,
        room_name: &str,
        account_id: &str,
        display_name: &str,
        allows_video: bool,
    ) -> Result<String, CallMediaConfigError> {
        let mut allowed_sources = vec!["microphone".to_string()];
        if allows_video {
            allowed_sources.push("camera".to_string());
        }
        Ok(AccessToken::with_api_key(&self.api_key, &self.api_secret)
            .with_ttl(JOIN_TOKEN_TTL)
            .with_identity(account_id)
            .with_name(display_name)
            .with_grants(VideoGrants {
                room_join: true,
                room: room_name.to_string(),
                can_publish: true,
                can_subscribe: true,
                can_publish_data: false,
                can_publish_sources: allowed_sources,
                ..Default::default()
            })
            .to_jwt()?)
    }
}

fn non_empty_env(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

#[cfg(test)]
mod tests {
    use super::CallMediaConfig;

    #[test]
    fn join_token_uses_short_lived_room_grants() {
        let config = CallMediaConfig {
            client_url: "ws://127.0.0.1:7880".to_string(),
            api_key: "development-key".to_string(),
            api_secret: "development-secret-long-enough".to_string(),
        };
        let token = config
            .join_token("kordi-call-test", "acct_test", "Test User", false)
            .unwrap();
        let claims = livekit_api::access_token::Claims::from_unverified(&token).unwrap();
        assert_eq!(claims.sub, "acct_test");
        assert_eq!(claims.name, "Test User");
        assert_eq!(claims.video.room, "kordi-call-test");
        assert_eq!(claims.video.can_publish_sources, vec!["microphone"]);
        assert!(claims.video.room_join);
        assert!(!claims.video.can_publish_data);
        assert!(claims.exp.saturating_sub(claims.nbf) <= 5 * 60);
    }
}
