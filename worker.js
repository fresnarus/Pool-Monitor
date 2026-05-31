// Cloudflare Worker: poll occupancy API + weather, append a row to data/occupancy.csv on GitHub.
// Configured via a cron trigger (every 10 min during opening hours) and a GITHUB_PAT secret.
// Also responds to plain HTTP GETs (useful for manual testing).

const OWNER = "fresnarus";
const REPO = "Pool-Monitor";
const BRANCH = "claude/relaxed-planck-BgLPg";
const CSV_PATH = "data/occupancy.csv";

const POOL_API = "https://wssc.cyc.org.tw/api";
const WEATHER_API = "https://api.open-meteo.com/v1/forecast" +
  "?latitude=24.987&longitude=121.553" +
  "&current=temperature_2m,precipitation,weather_code" +
  "&timezone=Asia%2FTaipei";

const HEADER = "timestamp_utc,timestamp_local,ice_current,ice_capacity," +
  "swim_current,swim_capacity,gym_current,gym_capacity," +
  "temperature_c,precipitation_mm,weather_code,api_status,weather_status";

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(pollAndAppend(env).then(msg => console.log(msg)));
  },
  async fetch(request, env, ctx) {
    const msg = await pollAndAppend(env);
    return new Response(msg + "\n", { headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }
};

async function pollAndAppend(env) {
  if (!env.GITHUB_PAT) return "ERROR: GITHUB_PAT secret is not set";

  const now = new Date();
  const taipeiMs = now.getTime() + 8 * 3600 * 1000;
  const tpe = new Date(taipeiMs);
  const tpeHour = tpe.getUTCHours();
  if (tpeHour < 6 || tpeHour >= 22) {
    return `closed (Taipei ${pad2(tpeHour)}:${pad2(tpe.getUTCMinutes())}); skipping`;
  }

  // --- fetch pool API ---
  let facilities = null;
  let api_status = "ok";
  try {
    const r = await fetch(POOL_API, {
      method: "POST",
      headers: {
        "User-Agent": "Mozilla/5.0 (occupancy-worker)",
        "Accept": "application/json, */*",
        "Accept-Language": "zh-TW,zh;q=0.9,en;q=0.8",
        "Referer": "https://wssc.cyc.org.tw/",
      },
    });
    if (!r.ok) api_status = `http_${r.status}`;
    else facilities = await r.json();
  } catch (e) {
    api_status = "fetch_failed";
  }

  // --- fetch weather ---
  let weather = null;
  let weather_status = "ok";
  try {
    const r = await fetch(WEATHER_API, { headers: { "User-Agent": "occupancy-worker" } });
    if (!r.ok) weather_status = `http_${r.status}`;
    else weather = (await r.json()).current;
  } catch (e) {
    weather_status = "fetch_failed";
  }

  // --- parse pool values ---
  const take = (k) => {
    if (!facilities || !Array.isArray(facilities[k]) || facilities[k].length < 2) return ["", ""];
    let [cur, cap] = facilities[k];
    if (typeof cur === "string" && cur.includes("找不到資源")) return ["", ""];
    if (cur == null || cap == null) return ["", ""];
    return [String(cur), String(cap)];
  };
  const [ice_cur, ice_cap]  = take("ice");
  const [swim_cur, swim_cap] = take("swim");
  const [gym_cur, gym_cap]  = take("gym");
  if (api_status === "ok" && !ice_cur && !swim_cur && !gym_cur) api_status = "no_data";

  // --- timestamps ---
  const ts_utc = now.toISOString().replace(/\.\d+Z$/, "Z");
  const ts_local =
    `${tpe.getUTCFullYear()}-${pad2(tpe.getUTCMonth()+1)}-${pad2(tpe.getUTCDate())} ` +
    `${pad2(tpe.getUTCHours())}:${pad2(tpe.getUTCMinutes())}:${pad2(tpe.getUTCSeconds())}`;

  // --- assemble CSV row ---
  const row = [
    ts_utc, ts_local,
    ice_cur, ice_cap, swim_cur, swim_cap, gym_cur, gym_cap,
    weather?.temperature_2m ?? "",
    weather?.precipitation ?? "",
    weather?.weather_code ?? "",
    api_status, weather_status,
  ].map(csvEscape).join(",");

  // --- append to GitHub CSV with sha-conflict retry ---
  const ghHeaders = {
    "Authorization": `Bearer ${env.GITHUB_PAT}`,
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "occupancy-worker",
  };

  let lastErr = "";
  for (let attempt = 0; attempt < 4; attempt++) {
    let content = HEADER + "\n", sha = null;
    const getResp = await fetch(
      `https://api.github.com/repos/${OWNER}/${REPO}/contents/${CSV_PATH}?ref=${BRANCH}`,
      { headers: ghHeaders }
    );
    if (getResp.status === 200) {
      const data = await getResp.json();
      sha = data.sha;
      content = atob(data.content.replace(/\s/g, ""));
      content = new TextDecoder().decode(Uint8Array.from(content, c => c.charCodeAt(0)));
      if (!content.endsWith("\n")) content += "\n";
    } else if (getResp.status !== 404) {
      lastErr = `GET ${getResp.status}: ${await getResp.text()}`;
      break;
    }

    const newContent = content + row + "\n";
    const putBody = {
      message: `data: sample ${ts_utc}`,
      content: b64encode(newContent),
      branch: BRANCH,
    };
    if (sha) putBody.sha = sha;

    const putResp = await fetch(
      `https://api.github.com/repos/${OWNER}/${REPO}/contents/${CSV_PATH}`,
      {
        method: "PUT",
        headers: { ...ghHeaders, "Content-Type": "application/json" },
        body: JSON.stringify(putBody),
      }
    );
    if (putResp.ok) {
      return `OK  ${ts_local}  ice=${ice_cur || "-"}/${ice_cap || "-"}  ` +
             `temp=${weather?.temperature_2m ?? "-"}C  api=${api_status} weather=${weather_status}`;
    }
    if (putResp.status === 409 || putResp.status === 422) {
      lastErr = `PUT ${putResp.status}, retrying`;
      await sleep(500 * (attempt + 1));
      continue;
    }
    lastErr = `PUT ${putResp.status}: ${await putResp.text()}`;
    break;
  }
  return `ERROR appending row: ${lastErr}  (would have written: ${row})`;
}

function pad2(n) { return String(n).padStart(2, "0"); }
function csvEscape(v) {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function b64encode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
