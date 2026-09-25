# Handoff: fresh start (2026-09-25)

For the next agent session on AI RADIO. Read this first, then `AGENTS.md`.
It says where the product stands, how the owner wants the work done, what is
open, and what bit us. It holds no secrets: keys, frequencies and host
details live outside this public repository (see the end).

## 1. Where things stand

| | |
| --- | --- |
| **Production** | <https://airadio.akbrd.com> runs commit `20bcaef`, radio **1.5.0**, deployed 2026-09-25 with the owner's approval. `/health` reports the SHA. |
| **Staging** | `airadio-staging` on workers.dev follows `main` automatically (tests run first; prose-only changes skip the deploy). |
| **`main`** | Only documentation has changed since production. `npm run check` passes 225 of 225 on Node 22 (CI) and 24. |
| **Milestones** | MS-1 done (see `docs/ai-radio-MS-1-report.md`). MS-2 is in progress: live delivery and authority (below). |

What 1.5.0 added on top of the MS-1 station:
- **Live delivery over WebSocket with Durable Object Hibernation**
  (`docs/design/ws-hibernation.md`):
  - receivers keep a socket per channel, and the station pushes a frame per
    message;
  - the socket only rings: the receiver reads through the usual REST path;
  - a quiet channel costs no requests;
  - it falls back to polling, with a safety poll every 5 minutes.
- The **phone app** listens on a socket opened with a one-time **ticket**:
  10 s, one use, and only its SHA-256 is stored.
- A **callsign's mailbox** rings over a socket too. Its frames carry only
  the seq, because calls can hold keys.
- **Permission requests** (`docs/design/authority.md`, "sitter" convention):
  - an agent asks with `radio.mjs request` in the `request/v1` shape;
  - the operator's app shows a card, and one tap sends a signed `grant/v1`;
  - `radio.mjs granted <f> <id> [--use]` exits 0 only for a current grant
    signed with the pinned operator key, and spends counted grants in a
    local ledger.
- Agents see messages up to 16 KB whole; before, anything past 4,000
  characters was cut silently. The radio hides held keys by value, so a
  SHA-256 is readable on the air.
- Worker entry is `worker/entry.mjs`, so `npm run worker:dev` works on
  wrangler 4.138. CI is read-only and pinned to `ubuntu-24.04`.

## 2. Who is on the air

| Agent | Runs where | Radio | How it hears |
| --- | --- | --- | --- |
| **Claude** (you, Claude Code) | owner's main WSL distro | 1.5.0, own systemd user unit | Monitor tool on `radio.mjs inbox --follow` |
| **Solnze** (Hermes, owner's first agent) | owner's main WSL distro | 1.5.0 | her own 30 s local inbox pre-check |
| **Gemini** (Antigravity `agy`) | isolated agents distro, user `gemini` | 1.5.0, own unit | `radio.mjs agent … --run agy`, chat-only |
| **Roger** (Hermes, cloned from Solnze on 2026-09-25) | isolated agents distro, user `hermes` | not on AI RADIO yet | his own Telegram bot through the host `hermes-gateway` |

Claude has a star of channels: one to Solnze, one to Gemini.
**Communications with agents are on hold** at the owner's word (2026-09-25).
Don't message Solnze or Gemini until the owner resumes it.

## 3. How the owner wants the work done

- **Act as CTO.** Do routine git/gh work end to end:
  - branch;
  - PR;
  - green CI;
  - squash merge;
  - sync;
  - clean up worktrees.

  Don't hand the owner commands you can run, and don't make them a proxy.
  Communicate in Russian with about 15% English terms.
- **Production deploys need the owner's explicit "yes".** After one, check:
  - `/health` shows the SHA;
  - `radio.mjs` is byte-equal (`cmp`);
  - `/app` answers 200;
  - a socket smoke test passes.
- **The repository is public.** Scan every diff for tokens, keys and real
  frequencies before pushing, and never print a key.
- **The sitter role.** Claude triages agents' permission requests for
  ai-radio engineering and forwards to the owner only what needs his
  decision, with a recommendation. Claude holds no authority of its own:
  grants come from the owner's direct word or signed message. Never
  delegated:
  - `secret.*`;
  - `money.*`;
  - `irreversible.*`;
  - `authority.*`.

  Owner-only by default: `deploy.production` and security-critical
  self-updates.
- **Solnze's files are read-only for you.** Ask her, or the owner, and never
  relay "the owner allowed X" as authority.

## 4. What is open, in rough priority

1. **Authority, slice 2.** Grants signed by a sitter's key and delegated by
   the owner (`docs/design/authority.md`, section 12):
   - the sitter is a policy signer under its own Unix user, never an LLM
     holding a key;
   - delegations last 48 h (7 days at most), and actions are typed schemas;
   - each agent opts in, with a policy the owner signs.

   Isolation now exists for Gemini and Roger, but not for Solnze.
2. **Handle a socket frame directly**, without the REST read. This saves one
   read per message.
3. **Structured messages** `task`, `result` and `question`, following
   `request/v1`.
4. **Put Roger on AI RADIO**, if the owner wants it: his own radio home, his
   own channel, `agent --run hermes --profile roger` or a pre-check like
   Solnze's.
5. **Logins for Codex, Claude Code and opencode** in the agents distro. The
   tools are installed in `/usr/local/bin`; there is no browser, so use a
   device code or a key.
6. **Staging on our own domain** (Solnze's scanner flags `*.workers.dev`).
7. Later (see `todos.md`):
   - end-to-end channel encryption;
   - agent keypairs for callsigns;
   - a remote MCP at `/mcp`;
   - attachments (R2);
   - a second operator device.

Dated chores:
- **2026-09-28:** remove the old copies of Gemini's radio from the owner's
  distro.
- **Monday 2026-09-28:** the owner rotates Roger's bot token again (it
  passed through chat). Then restart `hermes-gateway` and check the old
  token answers 401.

## 5. Gotchas that cost time

- **Radio source.** `scripts/airadio-radio.mjs` is embedded as `String.raw`,
  so it may contain no backtick and no `${`, not even in comments. After a
  change run `npm run airadio:sync-daemon -- --write`, then check with
  `` grep -c '`\|\${' ``.
- **App script.** The app's client JS is a template literal in
  `worker/app.mjs`: double the backslashes. Browser helpers are exported
  functions inserted with `fn.toString()`, so tests run the same code.
- **Node 22 in CI.** Its WebSocket reports a refused handshake with `error`
  alone, never `close`. Handle both, and run the suite on Node 22 before
  pushing socket code.
- **Local station.** `test/helpers/airadio-local-station.js` is a minimal
  RFC 6455 server standing in for the Hibernation API. It offers
  `station.reads(id)`, `sockets(id)`, `restart(id)` (like a deploy),
  `hibernate(id)` and `alarm(id)`.
- **workerd close timing.** A socket closed from inside another request
  reaches the client after about 10 s. Wait that long in smoke tests.
- **Browser E2E.** Use `playwright-core` with a cached headless Chromium;
  Claude's memory has the recipe.
- **WSL and binfmt.** `binfmt_misc` is shared by all WSL2 distros.
  `systemd-binfmt` in a distro with interop off wipes the owner's
  `WSLInterop`, and Claude cannot repair that from inside. Keep the
  agents-distro unit masked. A root guard timer in the owner's distro puts
  it back within 5 s. Verify with `head -1 /proc/sys/fs/binfmt_misc/WSLInterop`.
- **Scripts into another distro.** Pass them through stdin:
  `wsl.exe -d <distro> -u root -- bash -s < script`. `bash -c "…"` loses
  `$vars`.
- **Killing processes.** `pgrep -f`/`pkill -f` with a pattern that appears
  in your own command line kills your own shell. Match PIDs another way.
- **Installers.** An installer can wait forever on a hidden `sudo` prompt.
  Pre-install packages as root, and put a failing `sudo` stub first on
  `PATH`.

## 6. Where the rest lives

- **In this repository:**
  - `AGENTS.md` for the rules and the map;
  - `todos.md` for the live plan;
  - `docs/agent-onboarding.md`, the field guide, with a case study and the
    WSL isolation recipe;
  - `docs/design/*.md`;
  - `deploy/release-runbook.md`.
- **Outside it (private, on the owner's machine):**
  - the owner's secrets keeper folder: an inventory of every credential, a
    journal, the Cloudflare vault with the Global Key used only through
    `cf-token`, and runbooks, including agent isolation;
  - Claude's auto-memory for this project, which names that folder and
    records the channels, the agents' setups and the traps above.

  Start a session by reading memory, then `todos.md`.
