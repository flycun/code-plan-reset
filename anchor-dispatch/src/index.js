// Cloudflare Worker: precise daily trigger for the GLM/MiniMax anchor workflow.
//
// Why: GitHub Actions `schedule` is best-effort and can lag hours at the top
// of the hour (observed 3.5-6.7h daily). A workflow_dispatch fired by this
// Worker starts within seconds, and the workflow's own wait-until-anchor step
// holds until UTC 22:00 (Beijing 06:00) sharp before making the anchor call.
//
// Cron (UTC) 21:30 daily = Beijing 05:30, 30 min before the 22:00 anchor.
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

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(dispatchWithRetry(env.GH_PAT));
  },
};

async function dispatchWithRetry(token, attempts = 3) {
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
          body: JSON.stringify({ ref: REF }),
        }
      );
      // GitHub returns 204 No Content on success.
      if (res.status === 204) {
        console.log(`dispatch OK (attempt ${i}) at ${new Date().toISOString()}`);
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