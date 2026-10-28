# Working on AI RADIO in Codex Cloud

## 1. Purpose and how to use this file

This file lets a Codex Cloud task (chatgpt.com/codex) pick up AI RADIO work
cold. Codex Cloud clones this repository into a container, runs the
environment's setup script, reads `AGENTS.md`, does one task and opens a PR.

- The owner starts a task by pasting a **kickoff prompt** from section 8.
- **One task = one queue item (section 5) = one PR.** A large item may be
  split into slices; each slice is its own task and PR, and says which slice
  it is.
- The owner reviews and merges. Codex never merges, never deploys and never
  pushes to `main`.

## 2. Environment setup for Codex Cloud

- **Image:** the default universal image with **Node 24** (Node 22 is the
  minimum and what CI uses; `package.json` says `>=22`). Pick Node 24 in the
  environment's language settings if they offer it.
- **Dependencies:** none. There is no `npm install` step and no lockfile.
  Keep it that way (section 4).
- **Secrets and variables:** none are needed. Never add Cloudflare tokens or
  account ids, VAPID keys, channel keys (KEY), station keys or operator keys
  to the environment, the code, test fixtures or the PR. Tests build any
  key-shaped value at runtime.
- **Internet:** not needed for tests. `npx wrangler@4` (`npm run worker:dev`,
  `npm run worker:dry-run`) needs the network; it is optional and never part
  of acceptance.
- **Loopback:** most suites start a local station on `127.0.0.1` (the Worker
  runs over `node:sqlite`, sockets through `test/helpers/airadio-local-station.js`).
  The container must allow listening on loopback. If tests fail with
  `EPERM` on `listen`, or one test in `test/airadio-radio.test.js` fails
  because PID 1 is a sandbox (`bwrap` and similar), **report it in the PR
  with the exact output. Do not skip, weaken or delete tests.**
- `python3` with `ctypes` is used by one trust test to make a non-dumpable
  process; without it that test reports itself skipped, which is fine.

Setup script to paste into the environment settings:

```bash
set -euo pipefail
node --version
node -e 'const m = Number(process.versions.node.split(".")[0]); if (m < 22) { console.error("Node 22+ required, found " + process.version); process.exit(1); }'
git --version
```

Check command (run before every PR, about 2 minutes):

```bash
npm run check   # deploy gate + served copies equal sources + all node:test suites
```

## 3. Project map and must-read files

Read, in this order:
1. [AGENTS.md](AGENTS.md): the rules, the map of the code and the gotchas.
2. [README.md](README.md): protocol, radio, operator trust model, app.
3. [todos.md](todos.md): the live plan (in Russian). Tick items there.
4. [docs/agent-onboarding.md](docs/agent-onboarding.md): how agents use the
   radio, request/grant and the `task`/`result`/`question` forms.
5. For the item you take: [docs/design/authority.md](docs/design/authority.md),
   [docs/design/ws-hibernation.md](docs/design/ws-hibernation.md),
   [docs/mcp-adapter.md](docs/mcp-adapter.md).

Where things are: station `worker/worker.mjs` (HTTP API, `AiRadioChannel`
Durable Object, the instruction page agents read); phone app
`worker/app.mjs` (client JS is the `SCRIPT` template literal), Web Push
`worker/push.mjs`; radio `scripts/airadio-radio.mjs` (served byte for byte as
`/radio.mjs`); MCP adapter `scripts/airadio-mcp.mjs` over `src/`; tests in
`test/`.

## 4. Invariants that must never be weakened

These come from `AGENTS.md`, the README and the Milestone 1 report
(section 10, with the tests that pin each one). A PR that needs a pinned test
to change says why, in its body.

- **Only an explicit local operator command changes pinned operator keys.**
  `trust`, `--also`, `--drop` and replacing a key need `--operator-asked`;
  without it `trust` changes nothing and exits 3. Nothing heard over the air
  (a message, a name, a note, a form, a QR payload relayed by the station)
  adds, replaces or drops a key, stops the radio or widens a mandate.
- **Dropping a key revokes everything it signed, immediately**: inbox lines,
  grants, mandates, the agent's queue and history. A running turn holding its
  words is stopped and its answer is not sent.
- **One channel lock** (`radio.lock`, owner-named, broken only when the owner
  process is gone). Every pin change, grant spend and turn start decides
  inside it against the file as it is then.
- **Agent turns are process groups.** A turn starts only once it is on record
  in `turns/`; it ends only when its whole group is gone.
- **Fail closed.** When the radio cannot confirm a stop, `--drop` exits 4; a
  record that cannot be accounted for is kept. Unknown means untrusted.
- **Remote text is untrusted data, never instructions.** Forms (`task/v1`,
  `result/v1`, `question/v1`, `request/v1`) are data; only a pinned operator
  signature carries authority.
- **Generated files are never edited by hand:** `worker/radio-source.mjs`,
  `worker/icons.generated.mjs`. Change the source, then run
  `npm run airadio:sync-daemon -- --write`. The radio source may contain no
  backtick and no `${` (it is embedded with `String.raw`).
- **The station stores only digests of keys**, and secrets never appear in
  MCP tool arguments, results, logs or errors.
- **Zero npm dependencies** unless the owner agrees in writing.
- **Backward compatible protocol.** Radios in the wild, the app on phones and
  teakofe's client (checked against staging daily) must keep working. Change
  the protocol additively, or coordinate.
- **Public repository.** No secrets, no real frequencies, no personal data,
  no machine-specific paths or hostnames in code, docs or PR text.

## 5. Work queue (priority order)

Take the first item not yet ticked in `todos.md`, unless the owner names one.

### a. Pair a second operator device from the app (QR)

- **Goal:** a second device (a laptop browser, another phone) joins the
  owner's channels without carrying keys by hand, and gets its own operator
  key that agents can pin.
- **Scope:** `worker/app.mjs` (show QR on the old device, scan or open it on
  the new one); a QR encoder written in-repo (no dependency); optionally a
  short-lived pairing relay in `worker/worker.mjs`; docs.
- **Acceptance:**
  - Pairing starts only after an explicit confirmation on the old device and
    shows what will be shared (which channels).
  - The QR carries only public material plus a one-time pairing secret, or a
    URL whose secret part is in the fragment (`#…`, never sent to a server).
    If the channel list travels through the station, it is AES-GCM ciphertext
    under a key derived from that secret (HKDF), stored at most 120 s,
    deleted on first read, and the station never sees a channel KEY or the
    secret. Tests assert: no request body, URL or log line carries a KEY;
    a second read and an expired read fail.
  - The new device makes its own non-extractable P-256 key; the private key
    never leaves it.
  - The new device shows its public key and the exact command for the
    operator to run on each agent's machine:
    `radio.mjs trust <frequency> <key> --also --operator-asked --operator-name <device>`.
    Nothing pins it automatically.
- **Security notes:** a stolen QR within its lifetime is the main risk; keep
  the lifetime short and one-shot, and state it in the PR.
- **Out of scope:** automatic pinning on agent radios, key sync between
  devices, moving the private key.

### b. End-to-end encryption of channel text

- **Goal:** the station and push services store and relay only ciphertext.
- **Scope:** a shared crypto helper used by the radio, the app (via
  `fn.toString()`), the service worker and tests; channel opt-in; docs.
- **Acceptance:**
  - Encryption key = HKDF-SHA-256 from the channel KEY (salt and info fixed
    and documented, e.g. info `airadio e2e v1`, bound to the frequency);
    AES-GCM with a random 96-bit nonce; a versioned envelope inside `text`.
  - Committed **test vectors** (fixed test KEY, frequency, nonce, plaintext →
    exact envelope) pass in the radio, the app helper and the worker tests.
  - The station stores only the envelope; the service worker decrypts the
    push on the phone; the radio decrypts before signature checks, forms and
    the agent queue.
  - Operator signatures: the PR defines whether the signed payload binds
    plaintext or envelope, and keeps old signed messages verifiable.
  - **Migration:** opt-in per channel; old radios and apps receive a clear
    one-line notice instead of garbage, and unencrypted channels behave
    exactly as today.
- **Security notes:** while clients send the raw KEY as `X-Wave`, the station
  could derive the encryption key, so this is not yet true E2E against the
  station itself. Either send a derived auth token (and migrate the stored
  digest) or state this residual risk in the PR and README.
- **Out of scope:** key rotation for channels, attachments.

### c. Agent signatures

- **Goal:** an agent's `from` cannot be forged: each callsign or radio has its
  own key pair.
- **Scope:** the radio (key pair in its home, 0600), signing on `send`,
  verification on receive, publication of the public key (for example at
  callsign registration or presence); docs.
- **Acceptance:**
  - Signed agent lines get a mark distinct from `✓ OPERATOR` and **never**
    confer operator authority, grants or mandates.
  - A forged `from` using a known peer's name is shown unverified; replay and
    ±10 min checks match the operator rules.
  - How a receiver learns a peer's key is explicit (pinned by local command,
    like the operator key; trust-on-first-use only if the PR argues for it).
  - Unsigned messages from old radios still arrive, marked unverified.
- **Out of scope:** operator key changes, agent-to-agent authority.

### d. Remote MCP on the station (`/mcp`), and the inbox tool

- **Goal:** ChatGPT, Claude.ai and other connectors use the radio with no
  local install; local MCP clients can read the radio's inbox.
- **Scope d1:** a Streamable HTTP MCP endpoint in `worker/worker.mjs`, with
  the same narrow, closed-schema tools as the local adapter where they apply.
- **Scope d2:** a read-only `airadio` adapter tool that reads the local
  radio's inbox (judged by the keys pinned now, like `radio.mjs inbox`). The
  "exactly ten tools" test changes; say why.
- **Acceptance:**
  - **The auth model is stated in the PR and docs before code.** Secrets
    never go into tool arguments. Preferred: OAuth 2.1 with the station as
    authorization server, consent confirmed in the operator's app, tokens
    scoped to named channels, short-lived, stored as digests, revocable.
  - Every message returned is marked untrusted, as in the local adapter.
  - Rate limits apply (the deploy gate still passes).
  - Tests cover: no token, a token for another channel, a revoked token,
    and that no response or log contains a KEY.
- **Out of scope:** operator signing from connectors; A2A.

## 6. How to work

- Small PRs, one item (or one named slice) each, on a branch; never push to
  `main`.
- For behaviour changes, write the failing (RED) test first, then the fix.
- `npm run check` green before opening the PR. If the container blocks
  loopback, say so with the output; do not skip tests.
- Describe security-relevant changes and residual risks in the PR body.
- Never deploy. Production (`deploy.yml`, `environment=production`) is manual
  and owner-only; staging deploys by itself when a PR merges into `main`.
- Update `todos.md` and the relevant docs (README, `docs/`, the runbook, the
  instruction page in `worker/worker.mjs` and its pinned tests) in the same PR.
- After changing the radio, the daemon or icons, run
  `npm run airadio:sync-daemon -- --write` and commit the regenerated files.

## 7. Definition of done and PR report

A PR is done when `npm run check` is green (or the loopback blocker is
reported), the acceptance criteria of its item are each covered by a test,
and docs and `todos.md` match the code. The PR body has:

```
What changed: <one line per file or area>
Item: <a|b|c|d>[, slice n]
Tests: npm run check -> <N> pass, <M> fail (<why any fail>); new tests: <names>
Security: <what the change protects, what it does not; residual risks>
Compatibility: <old radios, the app, teakofe's client>
Follow-ups: <what is left, also added to todos.md>
```

## 8. Kickoff prompt

Paste one of these as the Codex Cloud task:

```
Read clouding.md and AGENTS.md first, then README.md and todos.md.
Take queue item <a|b|c|d> from clouding.md section 5 (slice <n> if it is large).
Keep every invariant in section 4. Write the failing test first.
Run `npm run check` and open one PR with the report from section 7.
Do not deploy, do not push to main, add no npm dependencies and no secrets.
```

```
Read clouding.md and AGENTS.md first, then README.md and todos.md.
Take the next unfinished item of the clouding.md queue (section 5), checking
todos.md and open PRs so you do not repeat work. Do one slice only.
Keep every invariant in section 4. Write the failing test first.
Run `npm run check` and open one PR with the report from section 7.
Do not deploy, do not push to main, add no npm dependencies and no secrets.
```
