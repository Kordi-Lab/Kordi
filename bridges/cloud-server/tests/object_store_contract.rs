//! Live object-store contract for attachments. Ignored by default because it
//! needs a running S3-compatible server, such as the development stack's
//! MinIO:
//!
//! ```text
//! S3_ENDPOINT=http://127.0.0.1:19000 S3_BUCKET=kordi-attachments \
//! S3_ACCESS_KEY=... S3_SECRET_KEY=... \
//! cargo test -p kordi-cloud-server --test object_store_contract -- --ignored
//! ```
//!
//! Every request is signed with the server's own presign helpers and sent the
//! way the attachment routes send it: single PUT, HEAD, GET, multipart create,
//! part upload, complete, and abort. Objects are written under
//! `object-store-contract/` and deleted afterwards.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use kordi_cloud_server::attachments::{
    presign_abort_multipart_url, presign_complete_multipart, presign_create_multipart_url,
    presign_download_url, presign_head_url, presign_upload_part_url, presign_upload_url, S3Config,
    MULTIPART_CHUNK_SIZE, PRESIGNED_URL_TTL,
};
use reqwest::{header, Client, StatusCode};
use rusty_s3::actions::{CreateMultipartUpload, DeleteObject, S3Action};
use rusty_s3::{Bucket, Credentials, UrlStyle};

fn payload(len: usize, seed: u8) -> Vec<u8> {
    (0..len)
        .map(|index| (index as u8).wrapping_mul(31).wrapping_add(seed))
        .collect()
}

async fn download(http: &Client, cfg: &S3Config, key: &str) -> Vec<u8> {
    let response = http
        .get(presign_download_url(cfg, key).unwrap())
        .send()
        .await
        .unwrap();
    assert!(
        response.status().is_success(),
        "presigned GET: {}",
        response.status()
    );
    response.bytes().await.unwrap().to_vec()
}

async fn create_multipart(http: &Client, cfg: &S3Config, key: &str) -> String {
    let response = http
        .post(presign_create_multipart_url(cfg, key).unwrap())
        .send()
        .await
        .unwrap();
    assert!(
        response.status().is_success(),
        "create multipart: {}",
        response.status()
    );
    let body = response.bytes().await.unwrap();
    CreateMultipartUpload::parse_response(&body)
        .unwrap()
        .upload_id()
        .to_string()
}

async fn delete(http: &Client, cfg: &S3Config, key: &str) {
    let bucket = Bucket::new(
        cfg.endpoint.clone(),
        UrlStyle::Path,
        cfg.bucket.clone(),
        cfg.region.clone(),
    )
    .unwrap();
    let credentials = Credentials::new(cfg.access_key.clone(), cfg.secret_key.clone());
    let url = DeleteObject::new(&bucket, Some(&credentials), key).sign(PRESIGNED_URL_TTL);
    let response = http.delete(url).send().await.unwrap();
    assert!(
        response.status().is_success(),
        "cleanup DELETE: {}",
        response.status()
    );
}

#[tokio::test]
#[ignore = "needs a live S3-compatible endpoint; see the module documentation"]
async fn attachment_presigned_requests_work_against_the_object_store() {
    let cfg =
        S3Config::from_env().expect("set S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY, and S3_SECRET_KEY");
    let http = Client::builder()
        .timeout(Duration::from_secs(120))
        .build()
        .unwrap();
    let run = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let single_key = format!("object-store-contract/{run}/single");
    let multipart_key = format!("object-store-contract/{run}/multipart");
    let aborted_key = format!("object-store-contract/{run}/aborted");

    // Single presigned PUT, then HEAD and GET.
    let single = payload(64 * 1024, 7);
    let response = http
        .put(presign_upload_url(&cfg, &single_key).unwrap())
        .body(single.clone())
        .send()
        .await
        .unwrap();
    assert!(
        response.status().is_success(),
        "presigned PUT: {}",
        response.status()
    );
    let head = http
        .head(presign_head_url(&cfg, &single_key).unwrap())
        .send()
        .await
        .unwrap();
    assert!(
        head.status().is_success(),
        "presigned HEAD: {}",
        head.status()
    );
    assert_eq!(
        head.headers()[header::CONTENT_LENGTH].to_str().unwrap(),
        single.len().to_string()
    );
    assert_eq!(download(&http, &cfg, &single_key).await, single);

    // Multipart upload in the server's chunk size, with a short final part.
    let upload_id = create_multipart(&http, &cfg, &multipart_key).await;
    let parts = [payload(MULTIPART_CHUNK_SIZE, 1), payload(4096, 2)];
    let mut etags = Vec::new();
    for (index, part) in parts.iter().enumerate() {
        let part_number = u16::try_from(index + 1).unwrap();
        let url = presign_upload_part_url(&cfg, &multipart_key, part_number, &upload_id).unwrap();
        let response = http.put(url).body(part.clone()).send().await.unwrap();
        assert!(
            response.status().is_success(),
            "upload part {part_number}: {}",
            response.status()
        );
        let etag = response.headers()[header::ETAG].to_str().unwrap().trim();
        assert!(!etag.is_empty(), "part {part_number} has no ETag");
        etags.push(etag.to_string());
    }
    let (url, body) = presign_complete_multipart(&cfg, &multipart_key, &upload_id, &etags).unwrap();
    let response = http
        .post(url)
        .header(header::CONTENT_TYPE, "application/xml")
        .body(body)
        .send()
        .await
        .unwrap();
    let status = response.status();
    let text = response.text().await.unwrap();
    // S3 can report a failed completion inside a 200 response.
    assert!(
        status.is_success() && !text.contains("<Error>"),
        "complete multipart: {status} {text}"
    );
    assert_eq!(download(&http, &cfg, &multipart_key).await, parts.concat());

    // An aborted upload leaves no object behind.
    let upload_id = create_multipart(&http, &cfg, &aborted_key).await;
    let response = http
        .delete(presign_abort_multipart_url(&cfg, &aborted_key, &upload_id).unwrap())
        .send()
        .await
        .unwrap();
    assert!(
        response.status().is_success(),
        "abort multipart: {}",
        response.status()
    );
    let head = http
        .head(presign_head_url(&cfg, &aborted_key).unwrap())
        .send()
        .await
        .unwrap();
    assert_eq!(head.status(), StatusCode::NOT_FOUND);

    // The bucket stays private: an unsigned read is refused.
    let unsigned = cfg
        .endpoint
        .join(&format!("{}/{single_key}", cfg.bucket))
        .unwrap();
    let response = http.get(unsigned).send().await.unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);

    delete(&http, &cfg, &single_key).await;
    delete(&http, &cfg, &multipart_key).await;
}
