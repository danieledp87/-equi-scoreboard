const API_BASE = `${location.origin}/api`; // same-origin proxy (avoids CORS)
// const DIRECT_API = "https://api.equiresults.com/v1";

// If you deploy without the ./assets/flags folder, keep this ON.
// On Render abbiamo le SVG in assets/flags, quindi usiamo i file reali.
const USE_EMBEDDED_FLAGS = false;


const EQUI_SAMPLE = {
  competitionId: 14277,
  classId: 322284,
  classesUrl: `${API_BASE}/competitions/14277/classes.json`,
  resultsUrl: `${API_BASE}/classes/322284/results.json`,
  startingUrl: `${API_BASE}/classes/322284/startinglist.json`,
};

const state = {
  competitionId: "14277",
  arenaName: "GIULIO CESARE",
  arenas: [],
  mode: "api",      // demo | api | sample
  layout: "live",    // live | final
  page: 0,
  // paging is computed dynamically from available space
  pageCount: 1,
  pageSwitchAt: 0,
  pageKey: "",
  firstPageMs: 20000,
  nextPagesMs: 10000,
  refreshMs: 2000,
  lastSnapshot: new Map(), // head_number -> time
  lastAnimKey: "",
  // ETA tracking
  finishStartTime: null,       // timestamp when first result of the class is seen
  finishSamples: new Map(),    // legacy placeholder (not used)
  finishArrivals: [],          // timestamps when new results arrive (Date.now)
  finishAvgInterval: null,     // average milliseconds between arrivals
  finishClassId: null,
  finishSeenIds: new Set(),    // ids of results already counted
  renderedIds: new Set(),
};

const $ = (id) => document.getElementById(id);

function setStatus(msg){
  const el = $("setupStatus");
  if(el) el.textContent = msg || "";
}

function nowClock(){
  return new Date().toLocaleTimeString("it-IT",{hour12:false});
}
function pad2(x){ return String(x).padStart(2,"0"); }

function fmtRider(r){
  if(!r) return "—";
  const s = (r.surname || "").toUpperCase();
  const n = (r.name || "");
  return (s && n) ? `${s} ${n}` : (s || n || "—");
}
function safeStr(x){ return (x===null || x===undefined) ? "" : String(x); }
function safeNum(x){
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}
function fmtTime(val){
  const n = safeNum(val);
  if(n === null) return "";
  return `${n.toFixed(2)} s`;
}

function isPointsClass(meta, standings){
  const n = (meta?.class_name || "").toLowerCase();
  const timeCat = n.includes("tempo") || n.includes("time") || n.includes("clock");
  if(!timeCat) return false;
  if(n.includes("accumulator") || n.includes("punti") || n.includes("points") || n.includes("a punti")) return true;

  // euristica: se punti variano e non ci sono faults, allora è a punti
  let ptsNonZero = 0, faultsPresent = 0;
  for(const r of (standings||[])){
    const p = safeStr(r.points).trim();
    if(p && p !== "0" && p !== "0.0") ptsNonZero++;
    const f = safeStr(r.faults).trim();
    if(f) faultsPresent++;
  }
  if(ptsNonZero > 0 && faultsPresent === 0) return true;
  return false;
}

// Available flag files (lowercase, without extension) taken from assets/flags
const FLAG_CODES = [
  "afg","aho","alb","alg","and","ang","ant","arg","arm","aru","asa","aus","aut","aze","bah","ban","bar","bdi","bel","ben","ber","bhu","bih","biz","blr","bol","bot","bra","brn","bru","bul","bur","caf","cam","can","cay","cgo","cha","chi","chn","civ","cmr","cod","cok","col","com","cpv","crc","cro","cub","cyp","cze","dan","den","dji","dma","dom","ecu","egy","eri","esa","esp","est","eth","fij","fin","fra","fsm","gab","gam","gbr","gbs","geo","geq","ger","gha","gre","grn","gua","gui","gum","guy","hai","hkg","hon","hun","ina","ind","ira","ire","iri","irl","irq","isl","isr","isv","ita","ivb","jam","jor","jpn","kaz","ken","kgz","kir","kor","kos","ksa","kuw","lao","lat","lba","lbn","lbr","lca","les","lib","lie","ltu","lux","mac","macau","mad","mar","mas","maw","mda","mdv","mex","mgl","mhl","mkd","mli","mlt","mne","mon","moz","mri","mtn","mya","nam","nca","ned","nep","ngr","nig","nor","nru","nzl","oma","pak","pan","par","per","phi","phy","ple","plw","png","pol","por","prk","pur","qat","rou","rsa","rsm","rus","rwa","sam","sen","sey","sgp","sin","skn","sle","slo","smr","sol","som","spa","srb","sri","stp","sud","sui","sur","svk","swe","swz","syr","taiwan","tan","tga","tha","tjk","tkm","tls","tog","tpe","tri","tto","tun","tur","tuv","twn","uae","uga","ukr","uru","usa","uzb","van","ven","vie","vin","yem","zam","zim"
];
const ISO3_TO_FILE = FLAG_CODES.reduce((m,c)=>{ m[c.toUpperCase()] = c; return m; }, {});
const FLAG_SET = new Set(FLAG_CODES);
// Common aliases (IOC/ISO variants)
const FLAG_ALIASES = {
  UK:"gbr", ENG:"gbr", SCO:"gbr", WAL:"gbr",
  GRE:"gre", GRC:"grc",
  GER:"ger", DEU:"ger",
  NED:"ned", NLD:"ned",
  SUI:"sui", CHE:"sui",
  DEN:"den", DNK:"den",
  NOR:"nor", SWE:"swe",
  POR:"por", PRT:"por",
  KOR:"kor", PRK:"prk",
  UAE:"uae", KSA:"ksa", QAT:"qat",
  HKG:"hkg", MAC:"mac", TPE:"tpe",
  RSA:"rsa", ZAF:"rsa",
};
const ISO2_TO_ISO3 = { GR:"GRE", EL:"GRE", UK:"GBR", GB:"GBR" };
const COUNTRY_NAME_TO_CODE = {
  GREECE:"GRE", GRECIA:"GRE", HELLAS:"GRE",
  ITALY:"ITA", ITALIA:"ITA",
  FRANCE:"FRA", FRANCIA:"FRA",
  GERMANY:"GER", DEUTSCHLAND:"GER",
  SPAIN:"ESP", ESPANA:"ESP", ESPAÑA:"ESP",
  PORTUGAL:"POR", PORTUGAL:"POR"
};

function trimmedMean(values){
  const arr = values.filter(Number.isFinite);
  if(arr.length === 0) return null;
  if(arr.length <= 4) return arr.reduce((a,b)=>a+b,0) / arr.length;
  const sorted = arr.slice().sort((a,b)=>a-b);
  const cut = Math.floor(sorted.length * 0.2); // drop 20% low/high
  const trimmed = sorted.slice(cut, sorted.length - cut);
  if(trimmed.length === 0) return sorted.reduce((a,b)=>a+b,0) / sorted.length;
  return trimmed.reduce((a,b)=>a+b,0) / trimmed.length;
}

function isOutOfCompetition(r){
  const posLabel = safeStr(r.ranking_position_explained || r.ranking_position || "").toUpperCase();
  return posLabel.includes("F.C");
}

function isInvalidRank(r){
  const posLabel = safeStr(r.ranking_position_explained || r.ranking_position || "").toUpperCase();
  return posLabel.includes("ELIM") || posLabel.includes("RIT") || posLabel.includes("N.P");
}

function rankingValue(r){
  const v = Number(r.ranking_position);
  return Number.isFinite(v) ? v : 9999;
}

function flagDataUri(label){
  const txt = safeStr(label).trim().toUpperCase().slice(0,3) || "—";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="80" height="56" viewBox="0 0 80 56">
    <defs>
      <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="rgba(0,190,255,.55)"/>
        <stop offset="1" stop-color="rgba(255,255,255,.10)"/>
      </linearGradient>
    </defs>
    <rect x="1" y="1" width="78" height="54" rx="6" fill="url(#g)" stroke="rgba(255,255,255,.35)" />
    <text x="40" y="35" text-anchor="middle" font-family="system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif"
          font-size="18" font-weight="800" fill="rgba(0,0,0,.55)">${txt}</text>
  </svg>`;
  return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
}

function flagSrc(iso3){
  const raw = safeStr(iso3).trim();
  if(!raw) return null;
  let key = raw.toUpperCase();
  if(key.length > 3 && COUNTRY_NAME_TO_CODE[key]) key = COUNTRY_NAME_TO_CODE[key];
  if(key.length === 2 && ISO2_TO_ISO3[key]) key = ISO2_TO_ISO3[key];

  if(USE_EMBEDDED_FLAGS){
    // Show a clean badge with the country code (prevents broken images when assets/flags is missing).
    return flagDataUri(key);
  }

  const file = FLAG_ALIASES[key]
    || ISO3_TO_FILE[key]
    || (FLAG_SET.has(key.toLowerCase()) ? key.toLowerCase() : key.toLowerCase());
  return file ? `./assets/flags/${file}.svg` : null;
}


async function fetchJson(url){
  const res = await fetch(url, { cache: "no-store" });
  if(!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

function uniq(arr){
  return Array.from(new Set(arr));
}

async function loadArenasForCompetition(competitionId){
  const classes = await fetchJson(`${API_BASE}/competitions/${encodeURIComponent(competitionId)}/classes.json`);
  const list = Array.isArray(classes) ? classes : (classes.classes || []);
  const names = uniq(list.map(c => (c.arena_name||"").trim()).filter(Boolean));
  // mark arenas that currently have a LIVE class
  const liveByArena = new Map();
  for(const c of list){
    const a = (c.arena_name||"").trim();
    if(!a) continue;
    const isLive = (c.is_live === true && c.is_finished === false);
    if(isLive) liveByArena.set(a, (liveByArena.get(a)||0)+1);
  }
  names.sort((a,b)=>a.localeCompare(b));
  return { names, liveByArena, classes: list };
}

function populateArenaSelect(names, liveByArena){
  const sel = $("arenaSelect");
  if(!sel) return;
  sel.innerHTML = "";
  if(!names.length){
    const opt = document.createElement("option");
    opt.value = ""; opt.textContent = "(nessuna arena trovata)";
    sel.appendChild(opt);
    return;
  }
  for(const n of names){
    const opt = document.createElement("option");
    opt.value = n;
    const liveN = liveByArena.get(n) || 0;
    opt.textContent = liveN ? `${n} (LIVE)` : n;
    sel.appendChild(opt);
  }
}

async function loadDemo(){
  const [classes, results, starting] = await Promise.all([
    fetchJson("./data/demo_classes.json"),
    fetchJson("./data/demo_results.json"),
    fetchJson("./data/demo_startinglist.json"),
  ]);
  return { classes, results, starting };
}

async function loadSampleOnline(){
  const [classes, results, starting] = await Promise.all([
    fetchJson(EQUI_SAMPLE.classesUrl),
    fetchJson(EQUI_SAMPLE.resultsUrl),
    fetchJson(EQUI_SAMPLE.startingUrl),
  ]);
  return { classes, results, starting };
}

function uniqueArenasFromClasses(classes){
  const map = new Map();
  for(const c of (classes||[])){
    const name = (c.arena_name || "").trim();
    if(!name) continue;
    const cur = map.get(name) || { name, liveCount:0, classes:0, updated:0 };
    cur.classes += 1;
    if(c.is_live === true && c.is_finished === false) cur.liveCount += 1;
    cur.updated = Math.max(cur.updated, Number(c.updated||0));
    map.set(name, cur);
  }
  return Array.from(map.values()).sort((a,b)=>{
    // live arenas first, then most recently updated
    if(b.liveCount !== a.liveCount) return b.liveCount - a.liveCount;
    return b.updated - a.updated;
  });
}

async function loadArenasForCompetition(competitionId){
  const classes = await fetchJson(`${API_BASE}/competitions/${encodeURIComponent(competitionId)}/classes.json`);
  const arenas = uniqueArenasFromClasses(classes);
  state.arenas = arenas;
  return arenas;
}

function renderArenaSelect(arenas){
  const sel = $("arenaSelect");
  if(!sel) return;
  sel.innerHTML = "";
  if(!arenas || arenas.length===0){
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "(nessuna arena trovata)";
    sel.appendChild(opt);
    return;
  }
  for(const a of arenas){
    const opt = document.createElement("option");
    opt.value = a.name;
    opt.textContent = a.liveCount>0 ? `${a.name} (LIVE)` : a.name;
    sel.appendChild(opt);
  }
  // keep current selection if possible
  const wanted = (state.arenaName||"").trim();
  if(wanted && arenas.some(a=>a.name===wanted)) sel.value = wanted;
  else sel.value = arenas[0].name;
  // sync manual field
  const inp = $("arenaName");
  if(inp) inp.value = sel.value;
  state.arenaName = sel.value;
}


function pickClassForArena(classes, arenaName){
  const arena = classes.filter(c => c.is_visible && c.arena_name === arenaName);

  const live = arena
    .filter(c => c.is_live === true && c.is_finished === false)
    .sort((a,b)=>Number(b.updated||0)-Number(a.updated||0));

  if(live.length) return { mode:"live", classMeta: live[0] };

  const official = arena
    .filter(c => c.has_official_results_list === true && c.is_finished === true)
    .sort((a,b)=>Number(b.updated||0)-Number(a.updated||0));

  if(official.length) return { mode:"official", classMeta: official[0] };

  arena.sort((a,b)=>Number(b.updated||0)-Number(a.updated||0));
  return { mode:"official", classMeta: arena[0] || null };
}

function setBadge(mode){
  const b = $("modeBadge");
  const t = $("modeBadgeText");
  if(mode==="live"){
    b.className = "badge live";
    if(t) t.textContent = "LIVE";
  }else{
    b.className = "badge official";
    if(t) t.textContent = "OFFICIAL RANKING";
  }
}

function renderHeader(meta, mode){
  const no = meta?.fise_class_id || meta?.id || "--";
  $("classNo").textContent = pad2(no).slice(-2);
  $("className").textContent = meta?.class_name || "—";
  $("subtitle").textContent = meta?.arena_name ? `Arena: ${meta.arena_name}` : "—";
  setBadge(mode);
}

function snapshotTimes(results){
  state.lastSnapshot.clear();
  for(const r of results){
    state.lastSnapshot.set(r.head_number, safeStr(r.time).trim());
  }
}
function rowKey(r){
  return r?.id ?? `${r?.head_number||""}-${r?.updated||""}-${r?.time||""}`;
}
function computeLastByDelta(results){
  for(const r of results){
    const hn = r.head_number;
    const prev = state.lastSnapshot.get(hn) || "";
    const cur = safeStr(r.time).trim();
    if(!prev && cur) return r;
  }
  return null;
}
function computeLastFallback(results){
  return results.slice().sort((a,b)=>Number(b.updated||0)-Number(a.updated||0))[0] || null;
}
function computeNext(starting, results){
  const finished = new Set(results.filter(r => safeStr(r.time).trim() !== "").map(r => r.head_number));
  return starting
    .slice()
    .sort((a,b)=>Number(a.entry_order||0)-Number(b.entry_order||0))
    .find(e => !finished.has(e.head_number) && e.not_in_competition === false) || null;
}

// ---- Finish ETA helpers ----
function detectStartTime(pick){
  if(state.finishStartTime) return;
  if(pick?.mode === "live"){
    state.finishStartTime = Date.now();
  }
}

function collectDurations(standings){
  // legacy: keep points-based durations if needed elsewhere
  for(const r of (standings||[])){
    const rid = r.id || `${r.head_number||""}-${r.updated||""}`;
    if(state.finishSamples.has(rid)) continue;
    const t = safeNum(r.time);
    if(t && t > 0 && t < 600){
      state.finishSamples.set(rid, t);
    }
  }
  if(state.finishSamples.size > 30){
    const excess = state.finishSamples.size - 30;
    const keys = Array.from(state.finishSamples.keys());
    for(let i=0;i<excess;i++) state.finishSamples.delete(keys[i]);
  }
  const vals = Array.from(state.finishSamples.values());
  if(vals.length >= 3){
    const sum = vals.reduce((a,b)=>a+b,0);
    state.finishAvg = sum / vals.length;
  }
}

function trackArrivals(results){
  let newArrivals = 0;
  let lastTs = state.finishArrivals[state.finishArrivals.length-1] || 0;

  for(const r of results){
    const rid = r.id || `${r.head_number||""}-${r.updated||""}`;
    if(state.finishSeenIds.has(rid)) continue;
    state.finishSeenIds.add(rid);

    // prefer server timestamp if present, fallback to now
    const upd = Number(r.updated);
    const now = Date.now();
    let ts = Number.isFinite(upd) && upd > 0 ? upd * 1000 : now;
    // sanitize: if server ts is far in the past/future, clamp to now
    const skew = ts - now;
    const maxSkew = 5 * 60 * 1000; // 5 minutes
    if(skew < -maxSkew || skew > maxSkew) ts = now;
    if(ts <= lastTs) ts = lastTs + 1; // ensure monotonic increasing
    state.finishArrivals.push(ts);
    lastTs = ts;
    newArrivals++;
    if(!state.finishStartTime) state.finishStartTime = ts;
  }

  // keep last 120 arrivals to avoid unbounded growth
  if(state.finishArrivals.length > 120){
    state.finishArrivals = state.finishArrivals.slice(-120);
  }

  if(state.finishArrivals.length >= 2){
    const arr = state.finishArrivals;
    const intervals = [];
    for(let i=1;i<arr.length;i++){
      intervals.push(arr[i]-arr[i-1]);
    }
    const lastN = intervals.slice(-40); // smoother average
    const avgMs = trimmedMean(lastN);
    state.finishAvgInterval = avgMs;
  }

  return newArrivals > 0;
}

function computeFinishEta(totalDone, totalAll){
  if(!totalAll) return null;
  const remaining = Math.max(0, totalAll - totalDone);
  if(remaining === 0) return "FINISH";
  // semplice stima: 2 minuti per binomio mancante
  const avgMsPerHorse = 2 * 60 * 1000;
  const finishMs = Date.now() + remaining * avgMsPerHorse;
  const dt = new Date(finishMs);
  const hh = String(dt.getHours()).padStart(2,"0");
  const mm = String(dt.getMinutes()).padStart(2,"0");
  return `${hh}:${mm}`;
}

function buildRow(r, highlight=false){
  const row = document.createElement("div");
  row.className = "row" + (highlight ? " last" : "");

  const pos = document.createElement("div");
  pos.className = "pos";
  const posLabel = safeStr(r.ranking_position_explained || r.ranking_position || "—").trim();
  const upperPos = posLabel.toUpperCase();
  const isFC = upperPos.includes("F.C");
  const isElim = upperPos.includes("ELIM");
  const isRit = upperPos.includes("RIT");
  const isNP = upperPos.includes("N.P");
  if(isElim || isRit || isNP){
    pos.textContent = "";
  }else{
    pos.textContent = posLabel || "—";
  }

  const flag = document.createElement("div");
  flag.className = "flag";
  const nat = r.rider?.nationality || r.rider?.country_code || r.nationality || r.country_code;
  const src = flagSrc(nat);
  if(src){
    const img = document.createElement("img");
    img.src = src;
    img.alt = r.rider?.nationality || "";
    flag.appendChild(img);
  }

  const name = document.createElement("div");
  name.className = "name";
  name.innerHTML = `
    <div class="riderLine">${fmtRider(r.rider)} <span class="small">(${r.head_number||"—"})</span></div>
    <div class="horseLine">${safeStr(r.horse?.full_name || "—")}</div>
  `;

  const score = document.createElement("div");
  score.className = "score";
  const penalties = safeStr(r.faults).trim();
  const points = safeStr(r.points).trim();
  const isPts = isPointsClass(state._currentClassMeta, state._currentStandings);

  if(isFC){
    score.innerHTML = `<div></div><div class="small"></div>`;
  }else if(isElim || isRit || isNP){
    const tag = isElim ? "Elim." : isRit ? "Rit." : "N.P.";
    score.innerHTML = `<div>${tag}</div><div class="small"></div>`;
  }else{
    const main = isPts ? (points ? `${points} pts` : "—") : (penalties || "—");
    const sub  = isPts ? (penalties ? penalties : "") : (penalties ? "penalties" : "");
    score.innerHTML = `<div>${main}</div><div class="small">${sub}</div>`;
  }

  const time = document.createElement("div");
  time.className = "time";
  const timeStr = fmtTime(r.time);
  time.textContent = (isFC || isElim || isRit || isNP) ? "" : (timeStr || "—");

  row.append(pos, flag, name, score, time);
  return row;
}

function dummyRow(){
  return {
    ranking_position: 1,
    head_number: 1,
    rider: { surname: "SURNAME", name: "Name", nationality: "ITA" },
    horse: { full_name: "Horse Name" },
    points: "65",
    time: "45.46",
    faults: "0/0",
  };
}

function measureRowHeight(containerEl, sample){
  const probe = buildRow(sample || dummyRow(), false);
  probe.style.visibility = "hidden";
  containerEl.appendChild(probe);
  const h = probe.getBoundingClientRect().height || 0;
  probe.remove();
  return h || 64;
}

function rowsThatFit(containerId, sample){
  const el = $(containerId);
  if(!el) return 10;
  const rect = el.getBoundingClientRect();
  if(rect.height < 80) return 10;
  const rh = measureRowHeight(el, sample);
  // try to pack one more row if there's meaningful leftover space
  const usable = rect.height - 6; // smaller margin to reclaim room
  let fit = Math.floor(usable / rh);
  const leftover = usable - fit * rh;
  if(leftover > rh * 0.35) fit += 1; // allow an extra row if >35% space remains
  return Math.max(1, fit);
}

function resetPaging(pageCount, key){
  state.page = 0;
  state.pageCount = Math.max(1, pageCount || 1);
  state.pageKey = key || "";
  state.pageSwitchAt = Date.now() + state.firstPageMs;
}

function setStats(totalDone, totalAll, standings){
  const totalEl = $("statTotal");
  totalEl.textContent = totalAll ? `${totalDone}/${totalAll}` : `${totalDone}/—`;
  // time to beat = tempo del leader (rank 1) che non sia F.C.
  const leader = (standings||[])
    .filter(r => !isOutOfCompetition(r) && !isInvalidRank(r) && Number.isFinite(safeNum(r.time)) && safeNum(r.time) > 0 && safeNum(r.time) < 1000)
    .sort((a,b)=> rankingValue(a) - rankingValue(b))[0];
  const best = leader ? safeNum(leader.time) : null;
  $("statAllowed").textContent = best ? `${best.toFixed(2)} s` : "—";
  const etaEl = $("statEta");
  if(etaEl && !etaEl.classList.contains("etaPending")){
    etaEl.textContent = etaEl.textContent || "—";
  }

  const pct = (totalAll && totalAll>0) ? Math.max(0, Math.min(100, (totalDone/totalAll)*100)) : 0;
  const box = totalEl?.parentElement; // statMini
  if(box){
    box.style.setProperty("--p", `${pct}%`);
  }
}

function advancePageIfDue(pageCount, key){
  const now = Date.now();
  const pc = Math.max(1, pageCount || 1);
  const k = key || "";

  if(state.pageKey !== k || state.pageCount !== pc || !state.pageSwitchAt){
    resetPaging(pc, k);
    return;
  }

  if(pc <= 1){
    state.page = 0;
    state.pageSwitchAt = now + state.firstPageMs;
    return;
  }

  if(now >= state.pageSwitchAt){
    state.page = (state.page + 1) % pc;
    state.pageSwitchAt = now + (state.page === 0 ? state.firstPageMs : state.nextPagesMs);
  }
}

function renderLive(standings, last, next, totalDone, totalAll, isLive, pageKey){
  $("layoutLive").style.display = "";
  $("layoutFinal").style.display = "none";

  trackArrivals(standings);

  const rows = $("rowsLive");
  rows.innerHTML = "";

  const sorted = standings.slice().sort((a,b)=>Number(a.ranking_position||9999)-Number(b.ranking_position||9999));
  // mobile: mostra solo i primi 10, scrollabili, senza paging
  const isMobile = window.innerWidth <= 768;
  let pageItems;
  if(isMobile){
    pageItems = sorted.slice(0, 10);
    state.page = 0;
  }else{
    const fit = rowsThatFit("rowsLive", sorted[0] || dummyRow());
    const pageCount = Math.max(1, Math.ceil(sorted.length / fit));
    advancePageIfDue(pageCount, pageKey);
    state.page = state.page % pageCount;
    const start = state.page * fit;
    pageItems = sorted.slice(start, start + fit);
  }

  const animKey = `${pageKey}|${state.page}`;
  const shouldAnimate = state.lastAnimKey !== animKey;

  const prevSet = state.renderedIds || new Set();
  const newSet = new Set();

  pageItems.forEach((r,i) => {
    const key = rowKey(r);
    newSet.add(key);
    const el = buildRow(r, isLive && last && r.id === last.id);
    const fresh = !prevSet.has(key);
    if(shouldAnimate || fresh){
      el.classList.add("rowSlideIn");
      el.style.opacity = "0";
      el.style.animationDelay = `${i*0.12}s`;
    }
    rows.appendChild(el);
  });
  state.renderedIds = newSet;
  state.lastAnimKey = animKey;

  if(isLive && last){
    $("lastRank").textContent = `Rank ${last.ranking_position_explained || last.ranking_position || "—"}`;
    $("lastRider").textContent = fmtRider(last.rider);
    $("lastBib").textContent = last.head_number ? `(${last.head_number})` : "";
    const lf = $("lastFlag");
    const lNat = last.rider?.nationality || last.rider?.country_code || last.nationality || last.country_code;
    const lsrc = flagSrc(lNat);
    if(lf){ if(lsrc){ lf.src = lsrc; lf.style.display = ""; } else { lf.removeAttribute("src"); lf.style.display = "none"; } }
    $("lastHorse").textContent = last.horse?.full_name || "—";
    const isPts = isPointsClass(state._currentClassMeta, state._currentStandings);
    const posLabel = safeStr(last.ranking_position_explained || last.ranking_position || "");
    const upperPos = posLabel.toUpperCase();
    const isFC = upperPos.includes("F.C");
    const isElim = upperPos.includes("ELIM");
    const isRit = upperPos.includes("RIT");
    const isNP = upperPos.includes("N.P");
    if(isFC){
      $("lastScore").textContent = "";
      $("lastTime").textContent = "";
    }else if(isElim || isRit || isNP){
      const tag = isElim ? "Elim." : isRit ? "Rit." : "N.P.";
      $("lastScore").textContent = tag;
      $("lastTime").textContent = "";
    }else{
      $("lastScore").textContent = isPts
        ? (safeStr(last.points).trim() ? `${safeStr(last.points).trim()} pts` : "—")
        : (safeStr(last.faults).trim() ? safeStr(last.faults).trim() : "—");
      const tstr = fmtTime(last.time);
      $("lastTime").textContent = tstr || "—";
    }
  }else{
    $("lastRank").textContent = "—";
    $("lastRider").textContent = "—";
    $("lastBib").textContent = "";
    const lf = $("lastFlag"); if(lf){ lf.removeAttribute("src"); lf.style.display="none"; }
    $("lastHorse").textContent = "—";
    $("lastScore").textContent = "—";
    $("lastTime").textContent = "—";
  }

  if(isLive && next){
    $("nextOrder").textContent = `#${next.entry_order}`;
    $("nextRider").textContent = fmtRider(next.rider);
    $("nextBib").textContent = next.head_number ? `(${next.head_number})` : "";
    const nf = $("nextFlag");
    const nNat = next.rider?.nationality || next.rider?.country_code || next.nationality || next.country_code;
    const nsrc = flagSrc(nNat);
    if(nf){ if(nsrc){ nf.src = nsrc; nf.style.display = ""; } else { nf.removeAttribute("src"); nf.style.display = "none"; } }
    $("nextHorse").textContent = next.horse?.full_name || "—";
  }else{
    $("nextOrder").textContent = "—";
    $("nextRider").textContent = "—";
    $("nextBib").textContent = "";
    const nf = $("nextFlag"); if(nf){ nf.removeAttribute("src"); nf.style.display="none"; }
    $("nextHorse").textContent = "—";
  }

  setStats(totalDone, totalAll, standings);
}

function renderFinal(standings, totalDone, totalAll, pageKey){
  $("layoutLive").style.display = "none";
  $("layoutFinal").style.display = "";

  const sorted = standings.slice().sort((a,b)=>Number(a.ranking_position||9999)-Number(b.ranking_position||9999));
  const perCol = rowsThatFit("rowsFinalLeft", sorted[0] || dummyRow());
  const perPage = perCol * 2;
  const pageCount = Math.max(1, Math.ceil(sorted.length / perPage));
  advancePageIfDue(pageCount, pageKey);
  state.page = state.page % pageCount;

  const start = state.page * perPage;
  const items = sorted.slice(start, start + perPage);

  const left = items.slice(0, perCol);
  const right = items.slice(perCol, perPage);
  const animKey = `${pageKey}|${state.page}`;
  const shouldAnimate = state.lastAnimKey !== animKey;

  $("rowsFinalLeft").innerHTML = "";
  $("rowsFinalRight").innerHTML = "";

  const prevSet = state.renderedIds || new Set();
  const newSet = new Set();

  left.forEach((r,i) => {
    const key = rowKey(r);
    newSet.add(key);
    const el = buildRow(r, false);
    const fresh = !prevSet.has(key);
    if(shouldAnimate || fresh){
      el.classList.add("rowSlideIn");
      el.style.animationDelay = `${i*0.10}s`;
    }
    $("rowsFinalLeft").appendChild(el);
  });
  right.forEach((r,i) => {
    const key = rowKey(r);
    newSet.add(key);
    const el = buildRow(r, false);
    const fresh = !prevSet.has(key);
    if(shouldAnimate || fresh){
      el.classList.add("rowSlideIn");
      el.style.opacity = "0";
      el.style.animationDelay = `${i*0.12}s`;
    }
    $("rowsFinalRight").appendChild(el);
  });

  state.lastAnimKey = animKey;
  state.renderedIds = newSet;

  setStats(totalDone, totalAll, standings);
}

async function tick(){
  $("clock").textContent = nowClock();

  
  let classes, resultsJson, startJson;

  if(state.mode === "demo"){
    const demo = await loadDemo();
    classes = demo.classes;
    resultsJson = demo.results;
    startJson = demo.starting;
  }else if(state.mode === "sample"){
    const sample = await loadSampleOnline();
    classes = sample.classes;
    resultsJson = sample.results;
    startJson = sample.starting;
  }else{
    classes = await fetchJson(`${API_BASE}/competitions/${encodeURIComponent(state.competitionId)}/classes.json`);
  }


let pick;
if(state.mode === "sample"){
  const classMeta = (classes || []).find(c => Number(c.id) === Number(EQUI_SAMPLE.classId)) || null;
  const mode = (classMeta && classMeta.is_finished === false) ? "live" : "official";
  pick = { mode, classMeta };
}else{
  pick = pickClassForArena(classes, state.arenaName);
}

  if(!pick.classMeta) return;

  // Paging resets automatically whenever this key changes
  const currentClassId = pick.classMeta?.id || pick.classMeta?.fise_class_id || "--";
  const pageKey = `${state.mode}|${state.layout}|${currentClassId}|${pick.mode}`;

  renderHeader(pick.classMeta, pick.mode);

  if(state.mode === "api"){
    const classId = pick.classMeta.id;
    [resultsJson, startJson] = await Promise.all([
      fetchJson(`${API_BASE}/classes/${classId}/results.json`),
      fetchJson(`${API_BASE}/classes/${classId}/startinglist.json`)
    ]);
  }

  const standings = (resultsJson.results || []);
  // reset ETA tracking if class changed
  const currentClassId2 = pick.classMeta?.id || pick.classMeta?.fise_class_id || "--";
  if(state.finishClassId !== currentClassId2){
    state.finishClassId = currentClassId2;
    state.finishStartTime = null;
    state.finishSamples = new Map();
    state.finishArrivals = [];
    state.finishAvgInterval = null;
    state.finishSeenIds = new Set();
    state.finishAvg = null;
    state.renderedIds = new Set();
  }

  state._currentClassMeta = pick.classMeta;
  state._currentStandings = standings;
  const starting = (startJson.starting_lists || []);
  const totalAll = startJson.starting_list_count || pick.classMeta.starting_list_count || starting.length || null;
  const totalDone = standings.filter(r => safeStr(r.time).trim() !== "").length;

  let last = computeLastByDelta(standings);
  if(!last) last = computeLastFallback(standings);

  const isLive = (pick.mode === "live");
  const next = isLive ? computeNext(starting, standings) : null;
  detectStartTime(pick);
  collectDurations(standings);
  trackArrivals(standings);

  // auto-switch layout: go to FINAL when class completed/official, back to LIVE when a live class is active
  const layoutSel = $("layoutSelect");
  if(isLive){
    if(state.layout !== "live"){
      state.layout = "live";
      if(layoutSel) layoutSel.value = "live";
      resetPaging(1, ""); // reset paging when returning to live
    }
  }else{
    const finished = totalAll && totalDone >= totalAll;
    if(state.layout !== "final" && finished){
      state.layout = "final";
      if(layoutSel) layoutSel.value = "final";
      resetPaging(1, ""); // reset paging when entering final
    }
  }

  // stats under NEXT only in LIVE view
  const rs = document.getElementById("rightStats");
  if(rs){ rs.style.display = (isLive && state.layout==="live") ? "grid" : "none"; }

  const eta = computeFinishEta(totalDone, totalAll);
  const etaEl = $("statEta");
  if(eta && etaEl){
    etaEl.textContent = eta;
    etaEl.classList.remove("etaPending");
  }else if(etaEl){
    etaEl.textContent = "...";
    etaEl.classList.add("etaPending");
  }

  if(state.layout === "live"){
    renderLive(standings, last, next, totalDone, totalAll, isLive, pageKey);
  }else{
    renderFinal(standings, totalDone, totalAll, pageKey);
  }

  snapshotTimes(standings);
}

function fillSetup(){
  $("competitionId").value = state.competitionId;
  const arenaInp = $("arenaName");
  if(arenaInp) arenaInp.value = state.arenaName;
  // render arena select if we already have arenas in memory
  renderArenaSelect(state.arenas);
  $("modeSelect").value = state.mode;
  $("layoutSelect").value = state.layout;
}
function applySetup(){
  state.competitionId = $("competitionId").value.trim();
  const sel = $("arenaSelect");
  const manual = $("arenaName");
  state.arenaName = (sel && sel.value) ? sel.value.trim() : (manual ? manual.value.trim() : "");
  if(manual) manual.value = state.arenaName;
  state.mode = $("modeSelect").value;
  state.layout = $("layoutSelect").value;
  state.page = 0;
}

document.addEventListener("DOMContentLoaded", async () => {
// helpers to show/hide setup with body class (keeps it on top)
function showSetup(){
  const setup = $("setup");
  if(setup){
    setup.classList.remove("hidden");
    setup.style.display = "flex";
    setup.style.opacity = "1";
    setup.style.pointerEvents = "auto";
    document.body.classList.add("setup-open");
  }
}
function hideSetup(){
  const setup = $("setup");
  if(setup){
    setup.classList.add("hidden");
    setup.style.opacity = "0";
    setup.style.pointerEvents = "none";
    // hide after fade-out
    setTimeout(()=>{ if(setup.classList.contains("hidden")) setup.style.display = "none"; }, 200);
    document.body.classList.remove("setup-open");
  }
}

// make sure the setup overlay is visible on first load (in case a cached display:none sticks around)
showSetup();
  fillSetup();
  setStatus("");
  $("clock").textContent = nowClock();
  setInterval(()=> $("clock").textContent = nowClock(), 1000);

  // Arena: manual sync
  const sel = $("arenaSelect");
  if(sel){
    sel.addEventListener("change", () => {
      const v = sel.value;
      const inp = $("arenaName");
      if(inp) inp.value = v;
      state.arenaName = v;
    });
  }

  // Load arenas for a competition ID
  const loadBtn = $("loadArenasBtn");
  if(loadBtn){
    loadBtn.addEventListener("click", async () => {
      const comp = $("competitionId").value.trim();
      if(!comp) return;
      try{
        setStatus("Carico arene…");
        const arenas = await loadArenasForCompetition(comp);
        renderArenaSelect(arenas);
        setStatus(arenas.length ? `Arene: ${arenas.map(a=>a.name).join(" | ")}` : "Nessuna arena trovata");
      }catch(e){
        console.error(e);
        setStatus(`Errore carico arene: ${e.message}`);
      }
    });
  }

  const previewBtn = $("previewBtn");
  if(previewBtn){
    previewBtn.addEventListener("click", async () => {
      applySetup();
      if(state.mode === "api" && (!state.arenas || state.arenas.length===0)){
        // try to load arenas once, non-blocking on errors
        try{
          const arenas = await loadArenasForCompetition(state.competitionId);
          renderArenaSelect(arenas);
          setStatus(arenas.length ? `Arene: ${arenas.map(a=>a.name).join(" | ")}` : "Nessuna arena trovata");
        }catch(e){ console.error(e); }
      }
      await tick();
    });
  }

  $("startBtn").addEventListener("click", async () => {
    applySetup();
    hideSetup();
    await tick();
    setInterval(tick, state.refreshMs);
  });

  function forceReload(){
    // force a full reload (like Cmd/Ctrl+R) with cache-busting param
    const url = `${window.location.origin}${window.location.pathname}?rnd=${Date.now()}`;
    window.location.assign(url);
  }

  // floating button to reopen setup
  const openBtn = $("openSetup");
  if(openBtn){
    openBtn.addEventListener("click", (e) => {
      e.preventDefault();
      forceReload();
    });
  }

});
