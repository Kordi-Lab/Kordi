use super::*;

impl FlySandboxBackend {
    pub(super) fn machine_config(&self, volume: &str) -> Value {
        json!({"image":self.config.image,"env":{},"services":[],
            "init":{"exec":["/bin/sh","-c",INIT]},
            "guest":{"cpu_kind":"shared","cpus":1,"memory_mb":512},
            "restart":{"policy":"no"},"auto_destroy":false,
            "metadata":{"kordi_workspace":self.key,"kordi_executor":"fly-v1"},
            "mounts":[{"volume":volume,"path":"/workspace"}]})
    }
    pub(super) async fn ensure(&self) -> Result<Lease, SandboxClientError> {
        if let Some(lease) = self.lease.lock().await.as_ref() {
            return Ok(lease.clone());
        }
        // This validation deployment has exactly one runner process. Serializing
        // provisioning also makes its workspace count an admission limit.
        let _provision = PROVISION.get_or_init(|| Mutex::new(())).lock().await;
        let name = format!("ks-{}", &self.key[..40]);
        let machines = self.api.call(Method::GET, "/machines", None, None).await?;
        let matching: Vec<_> = rows(&machines)?
            .iter()
            .filter(|m| m["name"] == name)
            .collect();
        if matching.len() > 1 {
            return Err(error(
                "Duplicate Fly workspace machines; operator reconciliation required",
            ));
        }
        let machine = if let Some(machine) = matching.first() {
            (*machine).clone()
        } else {
            let volumes = self.api.call(Method::GET, "/volumes", None, None).await?;
            let volume_name = format!("ks_{}", &self.key[..24]);
            let matches: Vec<_> = rows(&volumes)?
                .iter()
                .filter(|v| v["name"] == volume_name)
                .collect();
            if matches.len() > 1 {
                return Err(error(
                    "Duplicate Fly workspace volumes; preserve and reconcile them",
                ));
            }
            if rows(&machines)?
                .iter()
                .filter(|m| m["config"]["metadata"]["kordi_executor"] == "fly-v1")
                .count()
                >= self.config.max_workspaces
            {
                return Err(error(
                    "Fly workspace limit reached; increase capacity explicitly",
                ));
            }
            let volume = if let Some(volume) = matches.first() {
                (*volume).clone()
            } else {
                if rows(&volumes)?.len() >= self.config.max_workspaces {
                    return Err(error("Fly volume limit reached"));
                }
                self.api.call(Method::POST,"/volumes",Some(json!({"name":volume_name,"region":self.config.region,
                    "size_gb":1,"encrypted":true,"snapshot_retention":1,"auto_backup_enabled":true})),None).await?
            };
            if volume["region"] != self.config.region
                || volume["encrypted"] != true
                || !volume["attached_machine_id"].is_null()
            {
                return Err(error("Fly volume is not available for this workspace"));
            }
            self.api
                .call(
                    Method::POST,
                    "/machines",
                    Some(json!({"name":name,"region":self.config.region,
                "skip_launch":true,"config":self.machine_config(&field(&volume,"id")?)})),
                    None,
                )
                .await?
        };
        self.validate_machine(&machine)?;
        let volume_id = field(&machine["config"]["mounts"][0], "volume")?;
        if !volume_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_')
        {
            return Err(error("Invalid Fly volume id"));
        }
        let volume = self
            .api
            .call(Method::GET, &format!("/volumes/{volume_id}"), None, None)
            .await?;
        if volume["name"] != format!("ks_{}", &self.key[..24])
            || volume["region"] != self.config.region
            || volume["encrypted"] != true
        {
            return Err(error("Fly volume does not belong to this workspace"));
        }
        let id = field(&machine, "id")?;
        if !id.bytes().all(|b| b.is_ascii_alphanumeric()) {
            return Err(error("Invalid Fly machine id"));
        }
        // Fly Exec rejects calls while the execution VM itself is leased,
        // even when a lease nonce is supplied. Hold a stopped coordinator VM's
        // lease instead. All provisioners must use this protocol and one app.
        let lock_name = format!("kl-{}", &self.key[..40]);
        let locks: Vec<_> = rows(&machines)?
            .iter()
            .filter(|m| m["name"] == lock_name)
            .collect();
        if locks.len() > 1 {
            return Err(error("Duplicate Fly workspace coordinators"));
        }
        let lock = if let Some(lock) = locks.first() {
            (*lock).clone()
        } else {
            let mut config = self.machine_config("");
            config["mounts"] = json!([]);
            config["metadata"]["kordi_executor"] = json!("fly-lock-v1");
            config["guest"]["memory_mb"] = json!(256);
            self.api
                .call(
                    Method::POST,
                    "/machines",
                    Some(json!({"name":lock_name,
                "region":self.config.region,"skip_launch":true,"config":config})),
                    None,
                )
                .await?
        };
        if lock["config"]["metadata"]["kordi_workspace"] != self.key
            || lock["config"]["metadata"]["kordi_executor"] != "fly-lock-v1"
            || !matches!(lock["state"].as_str(), Some("stopped" | "created"))
        {
            return Err(error("Invalid Fly workspace coordinator"));
        }
        let lock_id = field(&lock, "id")?;
        drop(_provision);
        let mut claimed = None;
        // A crashed runner stops renewing its short coordinator lease. Wait
        // for that lease to expire instead of failing a recovered server run.
        for attempt in 0..36 {
            let result = self
                .api
                .call(
                    Method::POST,
                    &format!("/machines/{lock_id}/lease"),
                    Some(json!({"ttl":60,"description":"Kordi isolated workspace execution"})),
                    None,
                )
                .await;
            match result {
                Ok(value) => {
                    claimed = Some(value);
                    break;
                }
                Err(err) if attempt < 35 && err.to_string().contains("HTTP 409 for lease") => {
                    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                }
                Err(err) => return Err(err),
            }
        }
        let claimed = claimed.ok_or_else(|| error("Fly workspace remains busy"))?;
        let lease = Lease {
            id,
            lock_id,
            nonce: field(&claimed["data"], "nonce")?,
        };
        *self.lease.lock().await = Some(lease.clone());
        // An expired prior lease may leave a bounded command running. Stop it
        // before taking over the workspace; never reuse the previous process.
        if machine["state"] != "stopped" && machine["state"] != "created" {
            stop(&self.api, &lease).await?;
        }
        // Fly's stopped state can precede the host releasing the VM. Retry
        // only a refused start, never a create or an ambiguous execution.
        for attempt in 0..15 {
            let started = self
                .api
                .call(
                    Method::POST,
                    &format!("/machines/{}/start", lease.id),
                    Some(json!({})),
                    None,
                )
                .await;
            match started {
                Ok(_) => break,
                Err(err) if attempt < 14 && err.to_string().contains("HTTP 412 for start") => {
                    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                }
                Err(err) => return Err(err),
            }
        }
        self.api
            .call(
                Method::GET,
                &format!("/machines/{}/wait?state=started&timeout=30", lease.id),
                None,
                None,
            )
            .await?;
        Ok(lease)
    }
    pub(super) fn validate_machine(&self, machine: &Value) -> Result<(), SandboxClientError> {
        let c = &machine["config"];
        if machine["region"] != self.config.region
            || c["metadata"]["kordi_workspace"] != self.key
            || c["metadata"]["kordi_executor"] != "fly-v1"
            || c["image"] != self.config.image
            || c["init"]["exec"] != json!(["/bin/sh", "-c", INIT])
            || c["mounts"].as_array().map(Vec::len) != Some(1)
            || c["mounts"][0]["path"] != "/workspace"
            || c["services"].as_array().is_some_and(|v| !v.is_empty())
            || c["env"].as_object().is_some_and(|v| !v.is_empty())
        {
            return Err(error(
                "Fly workspace machine does not match the approved isolation configuration",
            ));
        }
        Ok(())
    }
}
