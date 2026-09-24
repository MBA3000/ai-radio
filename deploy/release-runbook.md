# Airadio release and rollback

A local test, dry run, workflow dispatch, and successful production read-back
are separate evidence stages; passing one does not establish the next.

The source of the deployment sequence is
[the deploy workflow](../.github/workflows/deploy.yml).
Its production choice also attaches `airadio.akbrd.com` when the zone exists;
the owner must have authority for that existing domain operation. Credentials
(`CLOUDFLARE_GLOBAL_API_TOKEN`, `CLOUDFLARE_EMAIL`) live only in this
repository's Actions secrets. Do not export or rotate them here.
Execute from a clean isolated checkout of the exact reviewed release commit.

## 1. Freeze the candidate and perform local checks

Set `RELEASE_SHA` to the reviewed full Git SHA and `RELEASE_REF` to the pushed
branch containing exactly that SHA. Set `RELEASE_DIR`
to a new evidence directory outside the checkout. Keep these variables in the
same shell for subsequent blocks. The workflow selects `wrangler@4` and records
its own version.

```bash
set -euo pipefail
: "${RELEASE_SHA:?Set the reviewed full SHA}"
: "${RELEASE_REF:?Set the pushed release branch}"
: "${RELEASE_DIR:?Set a new external evidence directory}"
test "$(git rev-parse HEAD)" = "$RELEASE_SHA"
test -z "$(git status --porcelain)"
test "$(git ls-remote origin "refs/heads/$RELEASE_REF" | cut -f1)" = "$RELEASE_SHA"
mkdir -p "$RELEASE_DIR"
npm run check
npm run airadio:probe -- --local-selftest
npx wrangler@4 --version
npx wrangler@4 deploy --config worker/wrangler.toml --env staging --var GIT_SHA:"$RELEASE_SHA" --dry-run --outdir "$RELEASE_DIR/staging-bundle"
npx wrangler@4 deploy --config worker/wrangler.toml --var GIT_SHA:"$RELEASE_SHA" --dry-run --outdir "$RELEASE_DIR/production-bundle"
```

There are no npm dependencies to install, and `npm run check` already runs the
deploy gate. The deploy commands above compile locally. `airadio:gate` is a
static limiter gate, not a network probe. `airadio:probe` has a local
self-test and an explicit preview canary; it has no `--dry-run` flag. Workflow
dispatch, rollback and HTTP read-back have no dry-run mode. A failed command
stops this runbook.

## 2. Deploy staging through the workflow

The workflow performs the deployment, reads `/health` back against its
`GITHUB_SHA`, and then runs a disposable preview-channel canary. Capture the
new run ID from `gh run list`; require its `headSha` to match before waiting.
The list may initially be empty while GitHub registers the dispatch: rerun
the list command, never substitute a prior run.

```bash
set -euo pipefail
test "$(git ls-remote origin "refs/heads/$RELEASE_REF" | cut -f1)" = "$RELEASE_SHA"
RELEASE_STARTED=$(date -u +%Y-%m-%dT%H:%M:%SZ)
gh workflow run deploy.yml --repo MBA3000/ai-radio --ref "$RELEASE_REF" -f environment=staging
gh run list --repo MBA3000/ai-radio --workflow deploy.yml --commit "$RELEASE_SHA" --event workflow_dispatch --created ">=$RELEASE_STARTED" --json databaseId,headSha,status,url
: "${STAGING_RUN_ID:?Set the new staging databaseId from the preceding output}"
test "$(gh run view "$STAGING_RUN_ID" --repo MBA3000/ai-radio --json headSha --jq .headSha)" = "$RELEASE_SHA"
gh run watch "$STAGING_RUN_ID" --repo MBA3000/ai-radio --exit-status
gh run view "$STAGING_RUN_ID" --repo MBA3000/ai-radio --log > "$RELEASE_DIR/staging-workflow.log"
```

Set `AIRADIO_PREVIEW_BASE` to the exact `airadio-staging.<subdomain>.workers.dev`
origin reported by that run. This repeats its build stamp and canary gates:

```bash
set -euo pipefail
: "${AIRADIO_PREVIEW_BASE:?Set the deployed staging origin from the workflow}"
curl --fail --silent --show-error --max-time 30 "$AIRADIO_PREVIEW_BASE/health" > "$RELEASE_DIR/staging-health.json"
jq -e --arg sha "$RELEASE_SHA" '.ok == true and .service == "airadio" and .sha == $sha' "$RELEASE_DIR/staging-health.json"
npm run airadio:probe -- --canary --preview-url "$AIRADIO_PREVIEW_BASE" --channel-only
```

The canary creates its own channel and leaves it to normal expiry. It never
touches an operator's mailbox, invitation state, station keys, or someone else's
channel. Its CLI refuses production origins; preserve that refusal.

Until the teakofe repository retires its `deploy-airadio.yml`, a push there
that touches `airadio/**` redeploys an older copy to staging. The `/health`
SHA check above is what tells the two apart: rerun it right before relying on
staging.

## 3. Capture rollback evidence, then deploy production

Before production, the owner uses an already authenticated operator context
to capture `npx wrangler@4 deployments list --config worker/wrangler.toml` and
`npx wrangler@4 versions list --config worker/wrangler.toml` in the release evidence.
Record the current production version ID, current `/health`, its SHA (which
may be null for an older unstamped build), and the chosen compatible rollback
version. These are observed values, not values the executor can invent.

After the staging gates and the owner's production decision:

```bash
set -euo pipefail
: "${ROLLBACK_VERSION:?Record the previous compatible production version ID}"
test "$(git ls-remote origin "refs/heads/$RELEASE_REF" | cut -f1)" = "$RELEASE_SHA"
RELEASE_STARTED=$(date -u +%Y-%m-%dT%H:%M:%SZ)
gh workflow run deploy.yml --repo MBA3000/ai-radio --ref "$RELEASE_REF" -f environment=production
gh run list --repo MBA3000/ai-radio --workflow deploy.yml --commit "$RELEASE_SHA" --event workflow_dispatch --created ">=$RELEASE_STARTED" --json databaseId,headSha,status,url
: "${PRODUCTION_RUN_ID:?Set the new production databaseId from the preceding output}"
test "$(gh run view "$PRODUCTION_RUN_ID" --repo MBA3000/ai-radio --json headSha --jq .headSha)" = "$RELEASE_SHA"
gh run watch "$PRODUCTION_RUN_ID" --repo MBA3000/ai-radio --exit-status
gh run view "$PRODUCTION_RUN_ID" --repo MBA3000/ai-radio --log > "$RELEASE_DIR/production-workflow.log"
curl --fail --silent --show-error --max-time 30 https://airadio.akbrd.com/health > "$RELEASE_DIR/production-health.json"
jq -e --arg sha "$RELEASE_SHA" '.ok == true and .service == "airadio" and .sha == $sha' "$RELEASE_DIR/production-health.json"
curl --fail --silent --show-error --max-time 30 https://airadio.akbrd.com/llms.txt > "$RELEASE_DIR/production-instructions.txt"
curl --fail --silent --show-error --max-time 30 https://airadio.akbrd.com/radio.mjs | cmp - scripts/airadio-radio.mjs
test "$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 30 https://airadio.akbrd.com/app)" = 200
```

Agents download `/radio.mjs` and run it, so it must be byte-for-byte the
release's `scripts/airadio-radio.mjs`. Review the served instructions against
`INSTRUCTIONS` in `worker/worker.mjs`, including the 200-row receive cap and
the status-code list. The successful workflow
and matching health SHA bind the deployed bundle; downloading the
page alone does not establish that binding. Preserve the exact workflow URL,
SHA, timestamps and downloaded files. Station-key rotation and invitation
retention acceptance remain separate decisions.

## 4. Roll back if the production gates fail

In the owner's authenticated operator context, stop release progression and
use the previously captured version. This changes live code and therefore
needs the owner's release/rollback authority.

```bash
set -euo pipefail
: "${ROLLBACK_VERSION:?Use the recorded compatible version ID}"
npx wrangler@4 rollback "$ROLLBACK_VERSION" --config worker/wrangler.toml --message "release rollback after failed gate"
curl --fail --silent --show-error --max-time 30 https://airadio.akbrd.com/health > "$RELEASE_DIR/rollback-health.json"
jq -e '.ok == true and .service == "airadio"' "$RELEASE_DIR/rollback-health.json"
```

Compare the returned SHA with the captured previous health response. If the
previous build had no SHA, retain that limitation instead of claiming exact
SHA verification. Rollback does not restore Durable Object data. A migration
or resource change can make a version incompatible; do not delete data or
rewrite migrations to force a rollback. See the current
[Wrangler command reference](https://developers.cloudflare.com/workers/wrangler/commands/workers/)
and [Cloudflare rollback constraints](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/).
