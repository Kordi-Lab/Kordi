//! Device proofs are refused unless they are signed with the session device's
//! registered key, over a live challenge, for this server, device, run, and
//! claim.

use super::*;

#[tokio::test]
async fn device_proofs_from_other_keys_runs_or_times_are_refused() {
    let Some((pool, router, mac)) = setup().await else {
        return;
    };
    let owner = mac.account.account_id.clone();
    let (run, claim) = claimed_run(&router, &pool, &mac.account).await;
    let (other_run, other_claim) = claimed_run(&router, &pool, &mac.account).await;
    // A second Mac of the same account registers its own key.
    let second_key = random_device_key();
    let second =
        sign_in_with_device_key(&router, "/v1/cloud/auth/login", &mac.email, &second_key).await;
    assert_eq!(second.account_id, owner);
    let second_device = device_id_for_key(&pool, &second, &second_key).await;
    assert_ne!(second_device, mac.device_id);

    let refused = |label: &'static str| {
        move |(status, body): (StatusCode, Value)| {
            assert_eq!(status, StatusCode::FORBIDDEN, "{label}");
            assert_eq!(body["errorCode"], "device_proof_invalid", "{label}");
        }
    };
    let issued = nonce(&router, &mac.account, &run, claim).await;
    refused("an unregistered key")(
        provider_auth(
            &router,
            &mac.account,
            &run,
            claim,
            Some(proof(
                &random_device_key(),
                &owner,
                &mac.device_id,
                &run,
                claim,
                &issued,
            )),
        )
        .await,
    );
    let issued = nonce(&router, &mac.account, &run, claim).await;
    refused("another registered device's key")(
        provider_auth(
            &router,
            &mac.account,
            &run,
            claim,
            Some(proof(
                &second_key,
                &owner,
                &mac.device_id,
                &run,
                claim,
                &issued,
            )),
        )
        .await,
    );
    let issued = nonce(&router, &mac.account, &run, claim).await;
    refused("a challenge issued for another run")(
        provider_auth(
            &router,
            &mac.account,
            &other_run,
            other_claim,
            Some(proof(
                &mac.key,
                &owner,
                &mac.device_id,
                &other_run,
                other_claim,
                &issued,
            )),
        )
        .await,
    );
    refused("a signature over another run")(
        provider_auth(
            &router,
            &mac.account,
            &run,
            claim,
            Some(proof(
                &mac.key,
                &owner,
                &mac.device_id,
                &other_run,
                claim,
                &issued,
            )),
        )
        .await,
    );
    // The signed text names the server and device it is for.
    let other_server = "https://other.example";
    for (label, audience, signed_audience, device) in [
        (
            "a signature for another server",
            other_server,
            other_server,
            mac.device_id.as_str(),
        ),
        (
            "an audience the signature does not name",
            AUDIENCE,
            other_server,
            mac.device_id.as_str(),
        ),
        (
            "a signature for another device",
            AUDIENCE,
            AUDIENCE,
            second_device.as_str(),
        ),
    ] {
        let issued = nonce(&router, &mac.account, &run, claim).await;
        let text = message(signed_audience, &owner, device, &run, claim, &issued);
        refused(label)(
            provider_auth(
                &router,
                &mac.account,
                &run,
                claim,
                Some(signed(&mac.key, audience, &text, &issued)),
            )
            .await,
        );
    }
    let issued = nonce(&router, &mac.account, &run, claim).await;
    sqlx_core::query::query("UPDATE cloud_device_proof_challenges SET expires_at=now()-interval '1 second' WHERE nonce=$1")
        .bind(&issued).execute(&pool).await.unwrap();
    refused("an expired challenge")(
        provider_auth(
            &router,
            &mac.account,
            &run,
            claim,
            Some(proof(
                &mac.key,
                &owner,
                &mac.device_id,
                &run,
                claim,
                &issued,
            )),
        )
        .await,
    );
    refused("a signature without a challenge")(
        provider_auth(
            &router,
            &mac.account,
            &run,
            claim,
            Some(proof(
                &mac.key,
                &owner,
                &mac.device_id,
                &run,
                claim,
                "unissued-nonce",
            )),
        )
        .await,
    );
    let replaced = nonce(&router, &mac.account, &run, claim).await;
    let current = nonce(&router, &mac.account, &run, claim).await;
    refused("a replaced challenge")(
        provider_auth(
            &router,
            &mac.account,
            &run,
            claim,
            Some(proof(
                &mac.key,
                &owner,
                &mac.device_id,
                &run,
                claim,
                &replaced,
            )),
        )
        .await,
    );
    // The second Mac's session cannot use the first Mac's challenge or lease.
    let (status, _) = provider_auth(
        &router,
        &second,
        &run,
        claim,
        Some(proof(
            &second_key,
            &owner,
            &second_device,
            &run,
            claim,
            &current,
        )),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    let (status, body) = provider_auth(
        &router,
        &mac.account,
        &run,
        claim,
        Some(proof(
            &mac.key,
            &owner,
            &mac.device_id,
            &run,
            claim,
            &current,
        )),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
}
