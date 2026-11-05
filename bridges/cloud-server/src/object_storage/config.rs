//! Object storage settings and server wiring.
//!
//! | Variable | Meaning |
//! | --- | --- |
//! | `KORDI_OBJECT_STORAGE_BACKEND` | `s3` (default) or `gcs` |
//! | `KORDI_OBJECT_STORAGE_ATTACHMENTS_BUCKET` | Attachment bucket. Required for `gcs`; overrides `S3_BUCKET` for `s3`. |
//! | `KORDI_OBJECT_STORAGE_RELEASES_BUCKET` | Desktop release bucket. Enables releases for `gcs`; overrides `KORDI_RELEASE_S3_BUCKET` for `s3` (default `kordi-releases`). |
//! | `KORDI_OBJECT_STORAGE_GCS_ENDPOINT` | JSON API origin, default `https://storage.googleapis.com` |
//! | `KORDI_OBJECT_STORAGE_GCS_TOKEN_URL` | Token endpoint, default the instance metadata server |

use std::sync::Arc;

use url::Url;

use super::gcs::DEFAULT_GCS_ENDPOINT;
use super::gcs_token::{GcsTokenSource, DEFAULT_GCS_TOKEN_URL};
use super::{gcs_bucket, ObjectStore};
use crate::attachments::S3Config;
use crate::server::ServerState;
use crate::updates::store::{
    GcsReleaseStore, MinioReleaseStore, ReleaseCatalogStore, ReleaseStoreConfig,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ObjectStorageBackend {
    S3,
    Gcs,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ObjectStorageSettings {
    pub backend: ObjectStorageBackend,
    pub attachments_bucket: Option<String>,
    pub releases_bucket: Option<String>,
    pub gcs_endpoint: Url,
    pub gcs_token_url: Url,
}

/// Accepts names valid for both S3 and GCS buckets: 3 to 63 lowercase
/// letters, digits, dots, dashes, or underscores, starting and ending with a
/// letter or digit.
pub fn valid_bucket_name(name: &str) -> bool {
    let bytes = name.as_bytes();
    (3..=63).contains(&bytes.len())
        && bytes.iter().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'.' | b'-' | b'_')
        })
        && bytes[0].is_ascii_alphanumeric()
        && bytes[bytes.len() - 1].is_ascii_alphanumeric()
}

fn non_empty_env(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

impl ObjectStorageSettings {
    pub fn from_env() -> Result<Self, &'static str> {
        Self::from_lookup(non_empty_env)
    }

    pub fn from_lookup(lookup: impl Fn(&str) -> Option<String>) -> Result<Self, &'static str> {
        let backend = match lookup("KORDI_OBJECT_STORAGE_BACKEND").as_deref() {
            None | Some("s3") => ObjectStorageBackend::S3,
            Some("gcs") => ObjectStorageBackend::Gcs,
            Some(_) => return Err("KORDI_OBJECT_STORAGE_BACKEND must be s3 or gcs"),
        };
        let bucket = |name: &str| -> Result<Option<String>, &'static str> {
            match lookup(name) {
                Some(value) if !valid_bucket_name(&value) => {
                    Err("Object storage bucket names must be valid bucket names")
                }
                value => Ok(value),
            }
        };
        let url = |name: &str, default: &str| -> Result<Url, &'static str> {
            let value = lookup(name).unwrap_or_else(|| default.to_string());
            let parsed = Url::parse(&value).map_err(|_| "Object storage URL is invalid")?;
            if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
                return Err("Object storage URL is invalid");
            }
            Ok(parsed)
        };
        let settings = Self {
            backend,
            attachments_bucket: bucket("KORDI_OBJECT_STORAGE_ATTACHMENTS_BUCKET")?,
            releases_bucket: bucket("KORDI_OBJECT_STORAGE_RELEASES_BUCKET")?,
            gcs_endpoint: url("KORDI_OBJECT_STORAGE_GCS_ENDPOINT", DEFAULT_GCS_ENDPOINT)?,
            gcs_token_url: url("KORDI_OBJECT_STORAGE_GCS_TOKEN_URL", DEFAULT_GCS_TOKEN_URL)?,
        };
        if backend == ObjectStorageBackend::Gcs && settings.attachments_bucket.is_none() {
            return Err("KORDI_OBJECT_STORAGE_ATTACHMENTS_BUCKET is required for the gcs backend");
        }
        Ok(settings)
    }
}

struct Stores {
    attachments: Option<ObjectStore>,
    releases: Option<ReleaseCatalogStore>,
}

fn build_stores(settings: &ObjectStorageSettings) -> Result<Stores, &'static str> {
    match settings.backend {
        ObjectStorageBackend::S3 => Ok(Stores {
            attachments: S3Config::from_env().map(ObjectStore::s3),
            releases: ReleaseStoreConfig::from_env()
                .and_then(|config| MinioReleaseStore::new(config).ok())
                .map(|backend| ReleaseCatalogStore::new(Arc::new(backend))),
        }),
        ObjectStorageBackend::Gcs => {
            let unavailable = |_| "Google Cloud Storage client could not be created";
            let tokens =
                Arc::new(GcsTokenSource::new(settings.gcs_token_url.clone()).map_err(unavailable)?);
            let attachments = match settings.attachments_bucket.as_deref() {
                Some(name) => Some(ObjectStore::gcs(
                    gcs_bucket(&settings.gcs_endpoint, name, &tokens).map_err(unavailable)?,
                )),
                None => None,
            };
            let releases = match settings.releases_bucket.as_deref() {
                Some(name) => Some(ReleaseCatalogStore::new(Arc::new(GcsReleaseStore::new(
                    gcs_bucket(&settings.gcs_endpoint, name, &tokens).map_err(unavailable)?,
                )))),
                None => None,
            };
            Ok(Stores {
                attachments,
                releases,
            })
        }
    }
}

/// The attachment store for command-line tools such as the avatar backfill.
pub fn attachment_store_from_env() -> Result<Option<ObjectStore>, &'static str> {
    Ok(build_stores(&ObjectStorageSettings::from_env()?)?.attachments)
}

/// Attaches the configured attachment and release stores to `state`.
pub fn configure_object_storage(mut state: ServerState) -> Result<ServerState, &'static str> {
    let settings = ObjectStorageSettings::from_env()?;
    let stores = build_stores(&settings)?;
    match stores.attachments {
        Some(store) => {
            println!(
                "Kordi cloud server attachment store backend={} bucket={}",
                store.backend_name(),
                store.bucket()
            );
            state = state.with_object_store(store);
        }
        None => println!(
            "Kordi cloud server starting without object storage (attachments disabled; see the object storage settings)"
        ),
    }
    match stores.releases {
        Some(store) => {
            println!("Kordi cloud server release store configured");
            state = state.with_release_store(store);
        }
        None => println!("Kordi cloud server starting without desktop release storage"),
    }
    Ok(state)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn settings(values: &[(&str, &str)]) -> Result<ObjectStorageSettings, &'static str> {
        let map: HashMap<String, String> = values
            .iter()
            .map(|(key, value)| (key.to_string(), value.to_string()))
            .collect();
        ObjectStorageSettings::from_lookup(|name| map.get(name).cloned())
    }

    #[test]
    fn s3_stays_the_default_backend() {
        let parsed = settings(&[]).unwrap();
        assert_eq!(parsed.backend, ObjectStorageBackend::S3);
        assert_eq!(
            parsed.gcs_endpoint.as_str(),
            "https://storage.googleapis.com/"
        );
        assert!(parsed
            .gcs_token_url
            .as_str()
            .starts_with("http://metadata.google.internal/"));
    }

    #[test]
    fn gcs_requires_a_valid_attachment_bucket() {
        assert!(settings(&[("KORDI_OBJECT_STORAGE_BACKEND", "gcs")]).is_err());
        assert!(settings(&[("KORDI_OBJECT_STORAGE_BACKEND", "minio")]).is_err());
        assert!(settings(&[
            ("KORDI_OBJECT_STORAGE_BACKEND", "gcs"),
            ("KORDI_OBJECT_STORAGE_ATTACHMENTS_BUCKET", "Bad/Name"),
        ])
        .is_err());
        let parsed = settings(&[
            ("KORDI_OBJECT_STORAGE_BACKEND", "gcs"),
            (
                "KORDI_OBJECT_STORAGE_ATTACHMENTS_BUCKET",
                "example-attachments",
            ),
            ("KORDI_OBJECT_STORAGE_RELEASES_BUCKET", "example-releases"),
            (
                "KORDI_OBJECT_STORAGE_GCS_TOKEN_URL",
                "http://127.0.0.1:9/token",
            ),
        ])
        .unwrap();
        assert_eq!(parsed.backend, ObjectStorageBackend::Gcs);
        assert_eq!(parsed.releases_bucket.as_deref(), Some("example-releases"));
        assert_eq!(parsed.gcs_token_url.as_str(), "http://127.0.0.1:9/token");
    }

    #[test]
    fn bucket_names_follow_the_shared_rules() {
        assert!(valid_bucket_name("kordi-releases"));
        assert!(valid_bucket_name("a.b_c-1"));
        assert!(!valid_bucket_name("ab"));
        assert!(!valid_bucket_name("-leading"));
        assert!(!valid_bucket_name("Upper"));
        assert!(!valid_bucket_name(&"a".repeat(64)));
    }
}
