# Local agent execution

Owner requests use YOLO by default. Model hosting and tool execution are separate: a remote model can call tools on the owner's Mac. Explicit tool allowlists and safety-mode settings remain effective. A shared request from another participant retains the restricted shared policy.

## Workspace references

An owner message with one unambiguous directory reference, such as `@~/sample-project` or `@"~/My Project"`, selects that directory for local execution. The selection is stored in the local runtime session and survives resume. Multiple different directory references do not silently select one. File references retain their existing attachment behavior.

Relative tool paths resolve against the selected directory. File tools and shell workdirs share home-directory expansion. The shell also accepts `workdir` for a single command without changing subsequent commands. Safety-mode workdirs cannot expand beyond the configured workspace.

The runtime supplies the model with the execution location, selected working directory, home directory, effective permission policy, history capability, and applicable workspace instructions on every turn. This context is built after request authority is established. Shared participants cannot select, probe, or receive the owner's saved execution workspace.

## Applications

On macOS, `local_app` provides discovery and JavaScript for Automation (JXA) for running applications. `action=list` returns application names and bundle IDs. `action=script` requires a discovered bundle ID and a JXA function body; `app` refers to that running application. Scripts return JSON-serializable results.

This adapter works with existing application sessions, including scripting interfaces exposed by Safari and Chrome. It is not a browser DOM automation engine or a complete screenshot-driven computer-use system. `browser_fetch` still uses a fresh headless browser profile and does not inherit a user's logged-in tabs.

Application automation is available only under owner YOLO authority. Kordi does not add a confirmation dialog for these owner requests. macOS Automation and Accessibility permissions still apply and failures are reported as operating-system errors. Calls have a bounded timeout and captured output; cancellation terminates the automation process.

## Models and verification

Local providers such as Ollama and LM Studio receive the same default tool catalog as remote providers. Users can explicitly disable tools or restrict the catalog. A model must support tool calling to perform actions.

An action request should end with a verified result or a concrete blocker. Available chat-history tools should be consulted before asking an owner to repeat retrievable context. Tool results include the actual execution outcome; shell results also identify the working directory used for that command.

Regression coverage includes home and relative path resolution, directory selection and resume, shared-request isolation, safety-mode boundaries, shell execution in the selected directory without an approval callback, application input validation, bounded app output, and preservation of file references during mention handling.

For an opt-in smoke test on a Mac with Finder running, start the deterministic model fixture on a free loopback port:

```sh
python3 scripts/local-agent-model-fixture.py --port 18863
```

In another terminal, run the native runtime test:

```sh
KORDI_LOCAL_TOOLS_TEST_MODEL_URL=http://127.0.0.1:18863/v1 \
  cargo test -p kordi-cli --lib --no-default-features --features desktop-runtime \
  native_owner_local_tools_round_trip -- --ignored --test-threads=1
```

The test creates disposable storage and files, then verifies real `read`, `bash`, and `local_app` results through the model/tool loop. It needs no provider credential and sends no data to a model service. It validates harness wiring rather than model judgment or the desktop UI. Stop the fixture server after testing.
