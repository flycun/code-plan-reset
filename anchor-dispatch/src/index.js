// Cloudflare Worker: precise daily trigger for the GLM/MiniMax anchor workflow.
//
// Why: GitHub Actions `schedule` is best-effort and can lag hours (observed
// 4-8h daily in Nov 2026), so it was removed as a trigger. This Worker fires
// a workflow_dispatch within seconds of the schedule, and the workflow's own
// wait-until-anchor step holds until the exact anchor instant.
//
// Two providers, two anchor slots each, staggered by 30 min so their 5h
// windows never expire at the same time (and so MiniMax covers GLM's
// 14:00-18:00 peak-hour window, where GLM costs 2x credits):
//
//   provider  slot  cron (UTC)   anchor (UTC)  anchor (Beijing)  window
//   glm       a     30 21 * * *  22:00         06:00             06:00-11:00
//   minimax   a     00 22 * * *  22:30         06:30             06:30-11:30
//   glm       b     40 02 * * *  03:10         11:10             11:10-16:10
//   minimax   b     10 03 * * *  03:40         11:40             11:40-16:40
//
// The cron fires 30 min before each anchor. The provider and slot are passed
// as workflow_dispatch inputs, so the workflow never has to guess which
// anchor it is serving. The slot is part of the cache-marker key, so a late
// trigger for one slot can never be mistaken for another.
//
// One-time setup:
//   1. Create a fine-grained PAT (github.com/settings/personal-access-tokens/new)
//      scoped to this repo only, permission "Actions: Read and write".
//      Set a long expiry (90 days+) - an expired PAT silently breaks the anchor.
//   2. npx wrangler login
//   3. npx wrangler secret put GH_PAT
//   4. npx wrangler deploy
// Test without waiting for cron: npx wrangler dev --test-scheduled

const API = "https://api.github.com";
const REPO = "flycun/code-plan-reset";
const WORKFLOW_ID = "glm-anchor.yml";
const REF = "main";

// UTC hour of each cron trigger -> which provider/slot it serves.
// The cron always fires 30 min before its anchor instant, so the hour is
// enough to identify the target unambiguously.
const TRIGGER_MAP = {
  21: { provider: "glm", slot: "a" }, // 21:30 UTC -> glm slot a (anchor 22:00)
  22: { provider: "minimax", slot: "a" }, // 22:00 UTC -> minimax slot a (anchor 22:30)
  2: { provider: "glm", slot: "b" }, // 02:40 UTC -> glm slot b (anchor 03:10)
  3: { provider: "minimax", slot: "b" }, // 03:10 UTC -> minimax slot b (anchor 03:40)
};

function targetFor(utcHour) {
  if (TRIGGER_MAP[utcHour]) return TRIGGER_MAP[utcHour];
  // Fallback: pick the anchor instant closest ahead of now.
  const now = new Date();
  const minutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  const anchors = [
    { at: 22 * 60, provider: "glm", slot: "a" },
    { at: 22 * 60 + 30, provider: "minimax", slot: "a" },
    { at: 3 * 60 + 10, provider: "glm", slot: "b" },
    { at: 3 * 60 + 40, provider: "minimax", slot: "b" },
  ];
  let best = null;
  let bestDist = Infinity;
  for (const a of anchors) {
    const dist = (a.at - minutes + 1440) % 1440;
    if (dist < bestDist) {
      bestDist = dist;
      best = a;
    }
  }
  return { provider: best.provider, slot: best.slot };
}

export default {
  async scheduled(event, env, ctx) {
    const { provider, slot } = targetFor(new Date().getUTCHours());
    ctx.waitUntil(dispatchWithRetry(env.GH_PAT, provider, slot));
  },
};

async function dispatchWithRetry(token, provider, slot, attempts = 3) {
  let lastError;
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetch(
        `${API}/repos/${REPO}/actions/workflows/${WORKFLOW_ID}/dispatches`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "anchor-dispatch-worker",
          },
          body: JSON.stringify({
            ref: REF,
            inputs: { provider, slot },
          }),
        }
      );
      // GitHub returns 204 No Content on success.
      if (res.status === 204) {
        console.log(
          `dispatch OK provider=${provider} slot=${slot} (attempt ${i}) at ${new Date().toISOString()}`
        );
        return;
      }
      throw new Error(`GitHub API ${res.status}: ${await res.text()}`);
    } catch (e) {
      lastError = e;
      console.error(`attempt ${i}/${attempts} failed: ${e.message}`);
      if (i < attempts) await new Promise((r) => setTimeout(r, 10_000 * i));
    }
  }
  throw lastError;
}
