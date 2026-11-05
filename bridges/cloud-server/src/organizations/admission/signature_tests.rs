use base64::Engine;
use ed25519_dalek::{Signer, SigningKey};

use super::*;

fn key_pair() -> (SigningKey, String) {
    let signing = SigningKey::generate(&mut rand::rngs::OsRng);
    let public =
        base64::engine::general_purpose::STANDARD.encode(signing.verifying_key().to_bytes());
    (signing, public)
}

fn sign(key: &SigningKey, bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(key.sign(bytes).to_bytes())
}

struct TempFile(std::path::PathBuf);

impl TempFile {
    fn new(bytes: &[u8]) -> Self {
        let path = std::env::temp_dir().join(format!(
            "kordi-organizations-{}.json",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::write(&path, bytes).unwrap();
        Self(path)
    }

    fn path(&self) -> &str {
        self.0.to_str().unwrap()
    }

    fn write_signature(&self, text: &str) {
        std::fs::write(signature_path(self.path()), text).unwrap();
    }
}

impl Drop for TempFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
        let _ = std::fs::remove_file(signature_path(self.path()));
    }
}

#[test]
fn no_key_reads_the_file_as_before() {
    let file = TempFile::new(b"{\"version\":1}");
    assert_eq!(read_file(file.path(), None).unwrap(), "{\"version\":1}");
    assert_eq!(parse_signing_key(None).unwrap(), None);
    assert_eq!(parse_signing_key(Some("  ")).unwrap(), None);
}

#[test]
fn a_correctly_signed_file_is_read() {
    let (signing, public) = key_pair();
    let key = parse_signing_key(Some(&public)).unwrap().unwrap();
    let body = b"{\"version\":1,\"organizations\":[]}";
    let file = TempFile::new(body);
    file.write_signature(&format!("{}\n", sign(&signing, body)));
    assert!(read_file(file.path(), Some(&key)).is_ok());
}

#[test]
fn an_unsigned_file_is_refused_when_a_key_is_set() {
    let (_, public) = key_pair();
    let key = parse_signing_key(Some(&public)).unwrap().unwrap();
    let file = TempFile::new(b"{}");
    let error = read_file(file.path(), Some(&key)).unwrap_err();
    assert!(error.contains("not signed"), "{error}");
}

#[test]
fn a_changed_or_foreign_signature_is_refused() {
    let (signing, public) = key_pair();
    let key = parse_signing_key(Some(&public)).unwrap().unwrap();
    let file = TempFile::new(b"{\"widened\":true}");
    // Signed a different body.
    file.write_signature(&sign(&signing, b"{\"widened\":false}"));
    assert!(read_file(file.path(), Some(&key)).is_err());
    // Signed by another key.
    let (other, _) = key_pair();
    file.write_signature(&sign(&other, b"{\"widened\":true}"));
    assert!(read_file(file.path(), Some(&key)).is_err());
    // Not a signature at all.
    file.write_signature("not base64!");
    assert!(read_file(file.path(), Some(&key)).is_err());
}

#[test]
fn an_invalid_key_is_an_error_not_a_disabled_check() {
    assert!(parse_signing_key(Some("not base64!")).is_err());
    let short = base64::engine::general_purpose::STANDARD.encode([7u8; 16]);
    assert!(parse_signing_key(Some(&short)).is_err());
}
