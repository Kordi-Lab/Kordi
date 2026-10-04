//! Keep a signed-in Mac available to host its Cloud agent while it is idle.
//! This activity does not prevent normal display or system sleep.

#[cfg(target_os = "macos")]
mod macos {
    use objc2_foundation::{NSActivityOptions, NSProcessInfo, NSString};
    use std::sync::{mpsc, Mutex, OnceLock};

    enum Command {
        Start,
        Stop,
        Exit,
    }

    static WORKER: OnceLock<Mutex<Option<mpsc::Sender<Command>>>> = OnceLock::new();

    fn worker() -> &'static Mutex<Option<mpsc::Sender<Command>>> {
        WORKER.get_or_init(|| Mutex::new(None))
    }

    fn run(receiver: mpsc::Receiver<Command>) {
        let process = NSProcessInfo::processInfo();
        let mut activity = None;
        while let Ok(command) = receiver.recv() {
            match command {
                Command::Start if activity.is_none() => {
                    activity = Some(process.beginActivityWithOptions_reason(
                        NSActivityOptions::UserInitiatedAllowingIdleSystemSleep,
                        &NSString::from_str("Hosting the signed-in Kordi Cloud desktop agent"),
                    ));
                }
                Command::Stop | Command::Exit => {
                    if let Some(token) = activity.take() {
                        // `token` is retained from this process's beginActivity call above.
                        unsafe { process.endActivity(&token) };
                    }
                    if matches!(command, Command::Exit) {
                        break;
                    }
                }
                Command::Start => {}
            }
        }
        if let Some(token) = activity.take() {
            // Also release the activity if all senders disappear unexpectedly.
            unsafe { process.endActivity(&token) };
        }
    }

    pub fn start() -> Result<(), String> {
        let mut sender = worker()
            .lock()
            .map_err(|_| "Cloud host activity lock poisoned".to_string())?;
        if sender.is_none() {
            let (tx, rx) = mpsc::channel();
            std::thread::Builder::new()
                .name("kordi-cloud-host-activity".into())
                .spawn(move || run(rx))
                .map_err(|err| format!("Unable to start Cloud host activity thread: {err}"))?;
            *sender = Some(tx);
        }
        sender
            .as_ref()
            .expect("sender initialized")
            .send(Command::Start)
            .map_err(|_| "Cloud host activity thread stopped".to_string())
    }

    pub fn stop() {
        if let Some(sender) = worker()
            .lock()
            .ok()
            .and_then(|guard| guard.as_ref().cloned())
        {
            let _ = sender.send(Command::Stop);
        }
    }

    pub fn exit() {
        if let Ok(mut sender) = worker().lock() {
            if let Some(sender) = sender.take() {
                let _ = sender.send(Command::Exit);
            }
        }
    }
}

#[cfg(target_os = "macos")]
pub use macos::{exit, start, stop};

#[cfg(not(target_os = "macos"))]
pub fn start() -> Result<(), String> {
    Ok(())
}

#[cfg(not(target_os = "macos"))]
pub fn stop() {}

#[cfg(not(target_os = "macos"))]
pub fn exit() {}
