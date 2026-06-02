# Notes for future Claude Code sessions on this repo

## User preferences (apply in every response)

- **URLs must always be on their own line, never embedded in a sentence.** The user copy-pastes URLs frequently and embedding them in prose with markdown formatting makes them hard to select. Render every URL as a bare hyperlink on its own line.
- The user is a research mathematician, not a programmer. Keep explanations short. Avoid jargon unless explaining a specific concept. Default to "just do it" over "let me explain the options."
- Minimize manual steps the user has to take in third-party UIs (GitHub, Cloudflare). When something must be done by hand, give numbered, screenshot-friendly steps. If something can be done by pushing a commit instead, do that.

## Project quick reference

- **Repo**: `fresnarus/Pool-Monitor`, development branch `claude/relaxed-planck-BgLPg` (also the default and Pages-serving branch).
- **Dashboard URL**:

  https://fresnarus.github.io/Pool-Monitor/

- **Cloudflare Worker URL** (manual test endpoint):

  https://pool-monitor.fresnarus2-cloudflare.workers.dev/

- **Data flow**: Cloudflare Worker (`worker.js`, configured by `wrangler.toml`) polls the pool API + Open-Meteo every 10 min during opening hours (06:00–22:00 Asia/Taipei). It commits one row per sample to `data/occupancy.csv` via GitHub Contents API, using a fine-grained PAT stored as the Cloudflare secret `GITHUB_PAT`.
- **Cloudflare Workers Builds** auto-deploys the worker on every push to this repo. Editing `worker.js` or `wrangler.toml` and pushing is sufficient — no manual paste into Cloudflare needed.
- The `.github/workflows/poll.yml` GHA workflow is kept only as a manual fallback (`workflow_dispatch`); its schedule was removed after diagnostics showed GitHub's US runners cannot reach the pool API (the site geo-filters).
- The pool API is at `https://wssc.cyc.org.tw/api`, POST, returns `{"gym":[n,cap], "swim":[n,cap], "ice":[n,cap]}`. Key `ice` is the Jingmei pool. Empty slots return the string `"找不到資源"`.
- This repo is intentionally public but unindexed (`robots.txt`, `<meta name="robots" content="noindex">`). Do not add the pool's name, the operator's name, or the words 景美 / 文山 / Jingmei / Wenshan to any commit message, code identifier, README, or page text. CSV column names use the API's neutral keys (`ice_`, `swim_`, `gym_`).
