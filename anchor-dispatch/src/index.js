// Cloudflare Worker: precise daily trigger for the GLM/MiniMax anchor workflow.
//
// Why: GitHub Actions `schedule` is best-effort and can lag hours at the top
// of the hour (observed 3.5-6.7h daily). A workflow_dispatch fired by this
// Worker starts within seconds, and the workflow's own wait-until-anchor step
// holds until the exact anchor instant before making the anchor call.
//
// Two anchor slots per day (both are Beijing-time "reset points"):
//   slot a -> UTC 22:00 = Beijing 06:00  (window A opens, resets 11:00)
//   slot b -> UTC 03:10 = Beijing 11:10  (window B opens, resets 16:10)
// The Worker fires 30 min before each slot and passes `slot` as an input, so
// the workflow knows which anchor it is serving without guessing from the
// clock. The slot id is part of the cache-marker key, so a late trigger for
// slot a can never be mistaken for slot b.
//
// One-time setup:
//   1. Create a fine-grained PAT (github.com/settings/personal-access-tokens/new)
//      scoped to this repo only, permission "Actions: Read and write".
//   2. npx wrangler login
//   3. npx wrangler secret put GH_PAT
//   4. npx wrangler deploy
// Test without waiting for cron: npx wrangler dev --test-scheduled

const API = "https://api.github.com";
const REPO = "flycun/code-plan-reset";
const WORKFLOW_ID = "glm-anchor.yml";
const REF = "main";

// Anchor slot -> UTC hour of that slot. The Worker cron fires 30 min before,
// so the current UTC hour identifies the slot unambiguously:
//   21:xx -> slot a (anchors at 22:00 UTC)
//   02:xx -> slot b (anchors at 03:10 UTC)
function slotForHour(utcHour) {
  if (utcHour === 22 || utcHour === 21) return "a";
  if (utcHour === 3 || utcHour === 2) return "b";
  // Fallback: pick the slot whose anchor instant is still ahead of us.
  const now = new Date();
  const minutesOfDay = now.getUTCHours() * 60 + now.getUTCMinutes();
  const anchorA = 22 * 60; // 22:00 UTC
  const anchorB = 3 * 60 + 10; // 03:10 UTC
  let aheadB = (anchorB - minutesOfDay + 1440) % 1440;
  let aheadA = (anchorA - minutesOfDay + 1440) % 1440;
  return aheadA <= aheadB ? "a" : "b";
}

export default {
  async scheduled(event, env, ctx) {
    const slot = slotForHour(new Date().getUTCHours());
    ctx.waitUntil(dispatchWithRetry(env.GH_PAT, slot));
  },
};

async function dispatchWithRetry(token, slot, attempts = 3) {
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
            inputs: { slot },
          }),
        }
      );
      // GitHub returns 204 No Content on success.
      if (res.status === 204) {
        console.log(
          `dispatch OK slot=${slot} (attempt ${i}) at ${new Date().toISOString()}`
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
