//! Per-email login lockout: per-client failure limits, the email-wide
//! ceiling, and familiar clients. See the module documentation of
//! [`super`] for the algorithm and key layout.

use super::*;

/// Counter scopes for one login email: the email from a single client
/// address, and the email across all clients.
struct EmailLockoutKeys {
    client: String,
    global: String,
}

impl EmailLockoutKeys {
    fn new(email: &str, client: Option<IpAddr>) -> Self {
        let client = rate_limit_client_key(client);
        Self {
            client: format!("client:{client}:{email}"),
            global: format!("all:{email}"),
        }
    }
}

impl CloudRateLimiter {
    /// Read whether `email` is currently locked for `client`, either by that
    /// client's own failures or, unless the client is familiar, by the
    /// email-wide ceiling. Does not record an attempt — call
    /// `record_email_failure` after an actual failure.
    pub async fn check_email_lockout(
        &self,
        email: &str,
        client: Option<IpAddr>,
    ) -> RateLimitDecision {
        let keys = EmailLockoutKeys::new(email, client);
        match &self.backend {
            Backend::Memory(store) => self.check_email_lockout_memory(store, &keys),
            Backend::Redis(store) => self.check_email_lockout_redis(store, &keys).await,
        }
    }

    /// Record a failed login. Once the failures for this email from `client`
    /// reach `per_email_failure_limit`, that client is locked out of the email
    /// for `per_email_lockout`; once failures from all clients reach
    /// `per_email_global_failure_limit`, every client that is not familiar is.
    pub async fn record_email_failure(&self, email: &str, client: Option<IpAddr>) {
        let keys = EmailLockoutKeys::new(email, client);
        match &self.backend {
            Backend::Memory(store) => self.record_email_failure_memory(store, &keys),
            Backend::Redis(store) => self.record_email_failure_redis(store, &keys).await,
        }
    }

    /// Record a successful sign-in or signup: clear this client's failure
    /// history and remember it as familiar for `email`.
    pub async fn record_login_success(&self, email: &str, client: Option<IpAddr>) {
        let keys = EmailLockoutKeys::new(email, client);
        match &self.backend {
            Backend::Memory(store) => self.record_login_success_memory(store, &keys),
            Backend::Redis(store) => self.record_login_success_redis(store, &keys).await,
        }
    }

    // ---- Memory backend ----

    fn check_email_lockout_memory(
        &self,
        store: &MemoryStore,
        keys: &EmailLockoutKeys,
    ) -> RateLimitDecision {
        let now = Instant::now();
        let locked_for = |key: &str| {
            let buckets = store.per_email.lock().expect("rate limiter poisoned");
            buckets
                .get(key)?
                .locked_until
                .filter(|until| now < *until)
                .map(|until| until.duration_since(now))
        };
        if let Some(retry_after) = locked_for(&keys.client) {
            return RateLimitDecision::Limited { retry_after };
        }
        let Some(retry_after) = locked_for(&keys.global) else {
            return RateLimitDecision::Allowed;
        };
        let mut familiar = store
            .familiar_clients
            .lock()
            .expect("rate limiter poisoned");
        match familiar.get(&keys.client) {
            Some(until) if now < *until => RateLimitDecision::Allowed,
            Some(_) => {
                familiar.remove(&keys.client);
                RateLimitDecision::Limited { retry_after }
            }
            None => RateLimitDecision::Limited { retry_after },
        }
    }

    fn record_email_failure_memory(&self, store: &MemoryStore, keys: &EmailLockoutKeys) {
        let mut buckets = store.per_email.lock().expect("rate limiter poisoned");
        let now = Instant::now();
        for (key, limit) in [
            (&keys.client, self.config.per_email_failure_limit),
            (&keys.global, self.config.per_email_global_failure_limit),
        ] {
            let entry = buckets
                .entry(key.clone())
                .or_insert_with(|| EmailFailureWindow {
                    attempts: 0,
                    locked_until: None,
                    first_attempt_at: now,
                });
            if let Some(until) = entry.locked_until {
                if now >= until {
                    entry.attempts = 0;
                    entry.locked_until = None;
                    entry.first_attempt_at = now;
                }
            }
            if now.duration_since(entry.first_attempt_at) > self.config.per_email_lockout {
                entry.attempts = 0;
                entry.first_attempt_at = now;
            }
            entry.attempts += 1;
            if entry.attempts >= limit {
                entry.locked_until = Some(now + self.config.per_email_lockout);
            }
        }
    }

    fn record_login_success_memory(&self, store: &MemoryStore, keys: &EmailLockoutKeys) {
        store
            .per_email
            .lock()
            .expect("rate limiter poisoned")
            .remove(&keys.client);
        let now = Instant::now();
        let mut familiar = store
            .familiar_clients
            .lock()
            .expect("rate limiter poisoned");
        if familiar.len() >= MEMORY_FAMILIAR_CLIENT_PRUNE_THRESHOLD {
            familiar.retain(|_, until| now < *until);
        }
        familiar.insert(keys.client.clone(), now + FAMILIAR_CLIENT_TTL);
    }

    // ---- Redis backend ----
    //
    // Connection failures fall open (Allowed), like the per-IP limit.

    async fn check_email_lockout_redis(
        &self,
        store: &RedisStore,
        keys: &EmailLockoutKeys,
    ) -> RateLimitDecision {
        let mut conn = store.conn.clone();
        let mut locked_for = [None, None];
        for (slot, scope) in locked_for.iter_mut().zip([&keys.client, &keys.global]) {
            let lock_key = format!("{}:email:{scope}:lock", store.key_prefix);
            let pttl_ms: i64 = match conn.pttl(&lock_key).await {
                Ok(value) => value,
                Err(err) => {
                    eprintln!("[rate_limit] redis PTTL {lock_key}: {err}");
                    return RateLimitDecision::Allowed;
                }
            };
            if pttl_ms > 0 {
                *slot = Some(Duration::from_millis(pttl_ms as u64));
            }
        }
        if let [Some(retry_after), _] = locked_for {
            return RateLimitDecision::Limited { retry_after };
        }
        let [None, Some(retry_after)] = locked_for else {
            return RateLimitDecision::Allowed;
        };
        let known_key = format!("{}:email:{}:known", store.key_prefix, keys.client);
        match conn.exists::<_, bool>(&known_key).await {
            Ok(true) => RateLimitDecision::Allowed,
            Ok(false) => RateLimitDecision::Limited { retry_after },
            Err(err) => {
                eprintln!("[rate_limit] redis EXISTS {known_key}: {err}");
                RateLimitDecision::Allowed
            }
        }
    }

    async fn record_email_failure_redis(&self, store: &RedisStore, keys: &EmailLockoutKeys) {
        let mut conn = store.conn.clone();
        let lockout_secs = self.config.per_email_lockout.as_secs().max(1) as i64;
        for (scope, limit) in [
            (&keys.client, self.config.per_email_failure_limit),
            (&keys.global, self.config.per_email_global_failure_limit),
        ] {
            let fail_key = format!("{}:email:{scope}:fail", store.key_prefix);
            let lock_key = format!("{}:email:{scope}:lock", store.key_prefix);
            let count: i64 = match conn.incr(&fail_key, 1).await {
                Ok(value) => value,
                Err(err) => {
                    eprintln!("[rate_limit] redis INCR {fail_key}: {err}");
                    return;
                }
            };
            if count == 1 {
                if let Err(err) = conn.expire::<_, ()>(&fail_key, lockout_secs).await {
                    eprintln!("[rate_limit] redis EXPIRE {fail_key}: {err}");
                }
            }
            if count >= limit as i64 {
                if let Err(err) = conn
                    .set_ex::<_, _, ()>(&lock_key, "1", lockout_secs as u64)
                    .await
                {
                    eprintln!("[rate_limit] redis SETEX {lock_key}: {err}");
                }
            }
        }
    }

    async fn record_login_success_redis(&self, store: &RedisStore, keys: &EmailLockoutKeys) {
        let mut conn = store.conn.clone();
        let fail_key = format!("{}:email:{}:fail", store.key_prefix, keys.client);
        let lock_key = format!("{}:email:{}:lock", store.key_prefix, keys.client);
        if let Err(err) = conn.del::<_, ()>(&[fail_key, lock_key]).await {
            eprintln!("[rate_limit] redis DEL email keys: {err}");
        }
        let known_key = format!("{}:email:{}:known", store.key_prefix, keys.client);
        if let Err(err) = conn
            .set_ex::<_, _, ()>(&known_key, "1", FAMILIAR_CLIENT_TTL.as_secs())
            .await
        {
            eprintln!("[rate_limit] redis SETEX {known_key}: {err}");
        }
    }
}
