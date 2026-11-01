use crate::{db, identity};

pub(super) fn open_local_db_or_exit() -> rusqlite::Connection {
    let conn = db::open_db().unwrap_or_else(|err| {
        eprintln!("Failed to open local database: {}", err);
        std::process::exit(1);
    });
    db::init_db(&conn).unwrap_or_else(|err| {
        eprintln!("Failed to initialize local database: {}", err);
        std::process::exit(1);
    });
    conn
}

pub(super) fn load_identity_or_exit() -> (ed25519_dalek::SigningKey, ed25519_dalek::VerifyingKey) {
    identity::load_or_create_keypair().unwrap_or_else(|err| {
        eprintln!("Failed to load identity: {}", err);
        std::process::exit(1);
    })
}

pub(super) fn build_runtime_or_exit() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .unwrap_or_else(|err| {
            eprintln!("Failed to build tokio runtime: {}", err);
            std::process::exit(1);
        })
}
