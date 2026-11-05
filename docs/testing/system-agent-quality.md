# System agent quality test

Compare models before changing the System agent's provider. The test replays a fixed set of synthetic group conversations and Grounding card builds through the real System agent path, scores what the model did, and compares a baseline run with candidate runs.

It calls a real model, so it is opt-in and never part of default CI. A scripted stub model keeps the harness itself tested in CI.

## What is real

Each System agent fixture is written into a disposable PostgreSQL database, created for that run, through the server's own stores. Then, for every pass:

1. The server's sweep decides whether the conversation needs a model call (including its free plan-word check) and builds the run input.
2. The runner's System agent loop (the `omp` or `rust` engine) calls the configured model with the production prompt and the `plan_card` tool.
3. Every `plan_card` call goes to the server's runner handler, which applies the same validation as production.
4. The server completes the run: it posts the reply, refreshes cards, and records reminders.

Grounding fixtures use the server's redaction, card-build instructions and reply parsing, and the runner's Common ground completion on the same service credential. They need no database.

All people, messages and evidence are synthetic (`example.test` identities).

## Fixtures

Fixtures live in `bridges/system-agent-eval/fixtures`. List them with:

```bash
cargo run -p kordi-system-agent-eval -- list
```

They cover a vote that is then decided, a deal confirmed across two passes, a reschedule, a cancellation, a decline that must not cancel, the 24-hour and 2-hour reminders, an @mention question, conversations where the System agent must stay silent, a conversation that tempts it to repeat itself, a timezone case, a plan with no time yet, and two Grounding card builds.

Each pass states its expected outcome: whether the System agent replies or stays silent, which `plan_card` actions are allowed and required, and the expected card (state, time, place, who is going). Dates are templates resolved at replay time, for example `{{d+3:long}}` or `{{now+20h}}`; see `src/fixture.rs`.

## Run a comparison

1. Point the harness at a PostgreSQL server on this machine whose role may create databases. The database in the URL is used only to connect for administration and is never written to: every run creates its own `kordi_eval_<pid>_<time>_<random>` database on that server, applies the migrations there, replays into it, and drops it when the run ends, also after an error, a panic, or Ctrl-C (`DROP DATABASE ... WITH (FORCE)` on PostgreSQL 13 and later). The harness refuses any server that is not a Unix socket, `localhost`, or a loopback address, judged from the parsed connection settings (URL host, `host`/`hostaddr` parameters, `PGHOST`). A loopback port can be a tunnel to a shared server, so never point it at a shared development tunnel even though nothing outside the run's own database is touched.

   ```bash
   export KORDI_SYSTEM_AGENT_EVAL_DATABASE_URL=postgresql://postgres@127.0.0.1:5432/postgres
   ```

2. Configure the baseline provider with the same environment variables a deployment uses, then run:

   ```bash
   cargo run --release -p kordi-system-agent-eval -- run --label baseline
   ```

3. Change the provider settings to the candidate and run again with another label:

   ```bash
   cargo run --release -p kordi-system-agent-eval -- run --label candidate
   ```

4. Compare. Reports are written to `target/system-agent-eval/<label>.json` unless `--out` is given.

   ```bash
   cargo run --release -p kordi-system-agent-eval -- compare target/system-agent-eval/baseline.json target/system-agent-eval/candidate.json --markdown comparison.md --json comparison.json
   ```

Use `--only <id>,<id>` to replay a subset. Model output varies between runs, so run each configuration more than once before deciding. `compare` warns, on stderr and at the top of the comparison, when a candidate ran a different set of fixtures than the baseline, and lists the added and removed fixture ids; totals are then not comparable.

## Settings

Everything comes from environment variables; nothing is read from files and no key belongs in the repository.

| Variable | Purpose |
|---|---|
| `KORDI_SYSTEM_AGENT_PROVIDER` | `openai`, `openai-compatible`, or `vertex-ai` |
| `KORDI_SYSTEM_AGENT_OPENAI_API_KEY`, `KORDI_SYSTEM_AGENT_OPENAI_BASE_URL`, `KORDI_SYSTEM_AGENT_OPENAI_MODEL` | OpenAI and OpenAI-compatible providers |
| `KORDI_SYSTEM_AGENT_VERTEX_MODEL`, `KORDI_SERVICE_VERTEX_PROJECT`, `KORDI_SERVICE_VERTEX_LOCATION` | Vertex AI, with workload identity in `GOOGLE_APPLICATION_CREDENTIALS` |
| `KORDI_SYSTEM_AGENT_PERSONA` | The deployment's persona text; without it, debug builds use the development persona |
| `KORDI_CLOUD_AGENT_ENGINE` | `omp` (the runner's default; needs an absolute `KORDI_OMP_WORKER_ENTRY` pointing to the packaged `kordi-omp` worker, see [OMP runtime](../development/omp-runtime.md)) or `rust` |
| `KORDI_SYSTEM_AGENT_EVAL_DATABASE_URL` | The disposable database |
| `KORDI_SYSTEM_AGENT_EVAL_INPUT_USD_PER_MTOK`, `KORDI_SYSTEM_AGENT_EVAL_OUTPUT_USD_PER_MTOK` | Optional prices for the cost estimate |

The provider fallback (`KORDI_SYSTEM_AGENT_FALLBACK_*`) must be unset, so each run measures one model.

### OpenAI-compatible gateways

Any endpoint that serves OpenAI chat completions over HTTPS works, for example OpenRouter:

```bash
export KORDI_SYSTEM_AGENT_PROVIDER=openai-compatible
export KORDI_SYSTEM_AGENT_OPENAI_BASE_URL=https://openrouter.ai/api/v1
export KORDI_SYSTEM_AGENT_OPENAI_MODEL=anthropic/claude-sonnet-4.5
export KORDI_SYSTEM_AGENT_OPENAI_API_KEY=...   # from your shell or secret store, never a file in the repository
```

The base URL must be `https`, and the runner refuses local or private-network endpoints. Reports name the provider as `openai` with the gateway's host. The System agent route strips a leading `openai/` from the model ID, as it does in production, so a gateway model such as `openai/gpt-5.1` is requested as `gpt-5.1`; models under other vendor prefixes are sent unchanged.

## Metrics

| Metric | Meaning |
|---|---|
| Plan card correctness | The card ends in the expected state, time, place and attendance, and required actions succeeded |
| Silence when no hook applies | No message where none is expected |
| Replies when one is due | A message where one is expected, mentioning what it must |
| Valid tool calls | Every `plan_card` call is allowed for that pass and accepted by the server |
| No repeated messages | No message repeats an earlier System agent message |
| Grounding cards | The reply parses into a card with enough cited topics, the expected topics, and none of the excluded ones |
| Runs completed | The run finished without a provider error or timeout |
| Passes the sweep skipped correctly | Passes with no model call; the same for every provider |

Each report also records latency per run (p50, p95, max), tokens per run as the provider reports them, and an estimated cost when prices are set. When some runs made model calls without reporting token counts, the cost covers only the runs that did and is marked partial (`costPartial` in JSON, `≥ $X (partial: n of m runs reported usage)` in text). Provider error text in reports is cut to 300 characters, and anything that looks like a credential (bearer tokens, `sk-` keys, Google keys and access tokens, JWTs, `key=` query parameters, long hex or base64 strings) is replaced with `[redacted]`. The comparison lists every check that passed in the baseline and failed in a candidate, and the reverse.

## In CI

`pnpm check:server` runs the unit tests and the Grounding fixtures with the stub model. `pnpm check:migrations` replays every System agent fixture with the stub model on its PostgreSQL database and checks that the scoring catches a misbehaving model.

To run the stub suite locally, including the database tests (each creates and drops its own database on the server):

```bash
cargo run -p kordi-system-agent-eval -- run --stub --label stub
KORDI_SYSTEM_AGENT_EVAL_DATABASE_URL=postgresql://postgres@127.0.0.1:5432/postgres \
  cargo test -p kordi-system-agent-eval -- --include-ignored --test-threads=1
```

## Add a fixture

Add a JSON file under `fixtures/system-agent` or `fixtures/grounding`. Every pass needs a `stub` script with the replies a good model would give, so the stub suite proves the expectations are reachable through the real server. History messages must be more than 30 minutes old and turn messages 1 to 29 minutes old, so the timeline stays history, then the seeded card, then the turn.
