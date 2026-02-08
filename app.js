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
const HEARTBEAT_TTL = 60;
const BASE_W = 1920;
const BASE_H = 1080;

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
  refreshMs: 1000,  // 1 secondo - aggiornamento classifica più frequente
  livePollMs: 500,
  liveGraceMs: 3000,
  headBaseline: new Map(), // baseline: head_number -> faults
  lastDetected: null,      // last detected rider (persists until a new one appears)
  lastAnimKey: "",
  liveCurrent: null,
  liveCurrentAt: 0,
  liveErrorAt: 0,
  livePollHandle: null,
  liveClockHandle: null,
  lastFinish: null,          // snapshot of last finish to keep rank visible
  lastCurrentBib: null,      // last known bib from server (for bib change detection)
  phaseFinishPending: false,  // true when phase 1 finished (time but no rank) - next start uses 6s offset
  // Live timing integration (chrono/monotonic anchors)
  liveTiming: {
    bib: null,
    startKey: null,
    t0Site: null,
    startOffset: 0,
    driftOffset: 0,
    smooth: null,
    lastAnchorToken: null,
    lastAnchorMono: null,
    phaseWindowUntil: null,
    phaseRawTime: null,
    lastPhaseKey: null,
    waitingForAnchor: false,
  },
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

// Scale the 1920x1080 canvas to fit any viewport (including HiDPI 1080x720)
function applyCanvasScale(){
  const canvas = document.querySelector(".canvas");
  if(!canvas) return;
  const w = window.innerWidth;
  const h = window.innerHeight;
  // Mobile portrait: don't downscale, let responsive CSS handle it
  if(w < 900 && h > w){
    canvas.style.setProperty("--canvas-scale", 1);
    canvas.style.position = "relative";
    canvas.style.left = "0";
    canvas.style.top = "0";
    return;
  }
  const scale = Math.min(w / BASE_W, h / BASE_H);
  canvas.style.setProperty("--canvas-scale", scale);
  const left = Math.max(0, (w - BASE_W * scale) / 2);
  const top = Math.max(0, (h - BASE_H * scale) / 2);
  canvas.style.position = "absolute";
  canvas.style.left = `${left}px`;
  canvas.style.top = `${top}px`;
}

window.addEventListener("resize", applyCanvasScale);

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
function setStateClass(el, state){
  if(!el) return;
  el.className = "liveState";
  const s = (state || "unknown").toLowerCase();
  el.classList.add(`state-${s}`);
}
function setPenaltyClass(el, val){
  if(!el) return;
  el.className = "livePenalty";
  const s = String(val ?? "").toLowerCase();
  if(["elim","rit","np"].includes(s)){
    el.classList.add("penalty-flag");
  }else{
    const n = Number(val);
    if(Number.isFinite(n) && n > 0) el.classList.add("penalty-nonzero");
  }
}

function isLiveAvailable(){
  const live = state.liveCurrent;
  const nowMs = Date.now();
  const nowS = nowMs / 1000;
  const fetchStale = (nowMs - (state.liveCurrentAt || 0)) > state.liveGraceMs;
  const errorStale = state.liveErrorAt && (nowMs - state.liveErrorAt) < state.liveGraceMs;
  const hbStale = !live || (live.last_heartbeat && (nowS - live.last_heartbeat) > (HEARTBEAT_TTL || 60));
  return !!(live && live.available && !hbStale && !fetchStale && !errorStale);
}

function renderCurrentBox(live, starting){
  const available = isLiveAvailable();
  const hasFinish = live && live.finish_time !== undefined && live.finish_time !== null;
  const fallbackMsg = available ? null : "Dati live non disponibili";

  // DEBUG: Log availability status
  if(!available){
    console.log(`[CURRENT] Data NOT available - live:${!!live} available:${live?.available} hbStale:${hbStale} fetchStale:${fetchStale} errorStale:${errorStale}`);
  }

  const setRiderHorse = (bib, riderEl, horseEl, flagEl, bibEl) => {
    const entry = findStartingByBib(starting, bib);
    if(entry){
      riderEl.textContent = fmtRider(entry.rider);
      horseEl.textContent = entry.horse?.full_name || "—";
      const nat = entry.rider?.nationality || entry.rider?.country_code || entry.nationality || entry.country_code;
      const src = flagSrc(nat);
      if(flagEl){ if(src){ flagEl.src = src; flagEl.style.display=""; } else { flagEl.removeAttribute("src"); flagEl.style.display="none"; } }
    }else{
      riderEl.textContent = fallbackMsg || "—";
      horseEl.textContent = fallbackMsg ? "" : "—";
      if(flagEl){ flagEl.removeAttribute("src"); flagEl.style.display="none"; }
    }
    if(bibEl) bibEl.textContent = bib ? `(${bib})` : "";
  };

  const isIdle = available && (live.state === "idle" || !live.state);
  const bib = available ? live.current_bib : (state.lastFinish?.bib || null);
  const penalty = available ? (isIdle ? "—" : fmtPenaltyLive(live.penalty)) : (state.lastFinish?.penalty ?? "—");
  const stateLabel = available ? (live.state || "idle").toUpperCase() : "N/D";

  // CURRENT box
  setRiderHorse(bib, $("currentRider"), $("currentHorse"), $("currentFlag"), $("currentBib"));
  const rankVal = isIdle ? null
    : (available && live && live.rank != null) ? live.rank
    : (state.lastFinish?.rank ?? null);
  if(available && live){
    console.log(`[DISPLAY] State: ${live.state}, Rank: ${live.rank}, Bib: ${bib}, Penalty: ${penalty}, finish_time: ${live.finish_time}`);
  }
  console.log(`[RANK] rankVal=${rankVal}, live.rank=${live?.rank}, lastFinish.rank=${state.lastFinish?.rank}`);
  $("currentRank").textContent = rankVal != null ? `Rank ${rankVal}` : "—";
  $("currentScore").textContent = penalty;
  setPenaltyClass($("currentScore"), penalty);

  let timeStr;
  if(!available){
    console.log(`[TIME] Not available - showing "—"`);
    timeStr = "—";
  }else if(isIdle){
    console.log(`[TIME] State is idle - showing "—" (no fallback)`);
    timeStr = "—";
  }else if(live.state === "running"){
    const t = timingCurrentSeconds();
    console.log(`[TIMER] State=running, timingCurrentSeconds=${t}, t0Site=${state.liveTiming.t0Site}, startOffset=${state.liveTiming.startOffset}, lastAnchorMono=${state.liveTiming.lastAnchorMono}`);
    if(t === null){
      console.log(`[TIME] Running but no timing data - showing "—". Did you receive a 'start' event?`);
      timeStr = "—";
      setStateClass($("currentTime"), "idle");
    }else if(phaseWindowActive()){
      timeStr = `${t.toFixed(2)} s`; // show centesimi durante la finestra di fase
    }else{
      timeStr = `${Math.floor(t)} s`; // solo secondi durante il running normale
    }
  }else{
    const fTime = live.finish_time ?? state.lastFinish?.time;
    console.log(`[TIME] State=${live.state}, finish_time=${live.finish_time}, lastFinish.time=${state.lastFinish?.time}, showing: ${fmtLiveTime(fTime)}`);
    if(!fTime){
      console.warn(`[TIME] State is ${live.state} but no finish_time available! Did you receive a 'finish' event with time field?`);
    }
    timeStr = fmtLiveTime(fTime);
  }
  $("currentTime").textContent = timeStr;
  setStateClass($("currentTime"), live?.state);
}

function isPointsClass(meta, standings){
  const n = (meta?.class_name || "").toLowerCase();
  // match by name: accumulator / punti / points / art 269 / art 229
  if(n.includes("accum") || n.includes("punti") || n.includes("points")
    || n.includes("a punti") || n.includes("art 269") || n.includes("art 229")) return true;

  // euristica: se più rider hanno punti diversi da 0 e faults sono tutti "0" o vuoti
  let ptsNonZero = 0, faultsReal = 0;
  for(const r of (standings||[])){
    const p = safeStr(r.points).trim();
    if(p && p !== "0" && p !== "0.0") ptsNonZero++;
    const f = safeStr(r.faults).trim().toLowerCase();
    if(f && f !== "0" && f !== "0.0" && !f.includes("elim") && !f.includes("rit") && !f.includes("n.p")) faultsReal++;
  }
  if(ptsNonZero >= 2 && faultsReal === 0) return true;
  return false;
}

// Available flag files (lowercase, without extension) taken from assets/flags
const FLAG_CODES = [
  "afg","aho","alb","alg","and","ang","ant","arg","arm","aru","asa","aus","aut","aze","bah","ban","bar","bdi","bel","ben","ber","bhu","bih","biz","blr","bol","bot","bra","brn","bru","bul","bur","caf","cam","can","cay","cgo","cha","chi","chn","civ","cmr","cod","cok","col","com","cpv","crc","cro","cub","cyp","cze","dan","den","dji","dma","dom","ecu","egy","eri","esa","esp","est","eth","fij","fin","fra","fsm","gab","gam","gbr","gbs","geo","geq","ger","gha","gre","grn","gua","gui","gum","guy","hai","hkg","hon","hun","ina","ind","ira","ire","iri","irl","irq","isl","isr","isv","ita","ivb","jam","jor","jpn","kaz","ken","kgz","kir","kor","kos","ksa","kuw","lao","lat","lba","lbn","lbr","lca","les","lib","lie","ltu","lux","mac","macau","mad","mar","mas","maw","mda","mdv","mex","mgl","mhl","mkd","mli","mlt","mne","mon","moz","mri","mtn","mya","nam","nca","ned","nep","ngr","nig","nor","nru","nzl","oma","pak","pan","par","per","phi","phy","ple","plw","png","pol","por","prk","pur","qat","rom","rou","rsa","rsm","rus","rwa","sam","sen","sey","sgp","sin","skn","sle","slo","smr","sol","som","spa","srb","sri","stp","sud","sui","sur","svk","swe","swz","syr","taiwan","tan","tga","tha","tjk","tkm","tls","tog","tpe","tri","tto","tun","tur","tuv","twn","uae","uga","ukr","uru","usa","uzb","van","ven","vie","vin","yem","zam","zim"
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
  ROM:"rou", ROU:"rou",  // Romania: both ROM (old IOC) and ROU (ISO-3) → same file
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

// Normalizza i valori delle penalità per confronti affidabili
function normalizeFaults(faults){
  const s = safeStr(faults).trim();
  if(!s) return "0";
  // Gestisce formati: "0", "0.0", "0/0", "4", "4.0", "4/0", ecc.
  if(s.toLowerCase() === "elim" || s.toLowerCase() === "rit" || s.toLowerCase() === "np") return s.toLowerCase();
  // Estrae solo il numero principale dalle penalità (es. "4/0" -> "4")
  const match = s.match(/^(\d+\.?\d*)/);
  if(match){
    const num = parseFloat(match[1]);
    return num === 0 ? "0" : num.toString();
  }
  return s; // mantieni formato originale se non riconosciuto
}

// Normalizza il tempo per confronti affidabili
function normalizeTime(time){
  const s = safeStr(time).trim();
  if(!s) return "";
  const n = parseFloat(s);
  return Number.isFinite(n) ? n.toFixed(2) : s;
}

function rowKey(r){
  return r?.id ?? `${r?.head_number||""}-${r?.updated||""}-${r?.time||""}`;
}
async function fetchSavedLast(){
  if(!state.competitionId || !state.arenaName) return;
  try{
    const url = `/live/last?competition_id=${encodeURIComponent(state.competitionId)}&arena_name=${encodeURIComponent(state.arenaName)}`;
    const resp = await fetch(url, { cache: "no-store" });
    const data = await resp.json();
    if(data.available && data.last){
      state.lastDetected = data.last;
      console.log(`[LAST] Loaded saved last from server: head_number=${data.last.head_number}`);
    }
  }catch(e){
    console.log("[LAST] Could not fetch saved last:", e.message);
  }
}

function saveLast(result){
  if(!state.competitionId || !state.arenaName || !result) return;
  fetch("/live/last", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      competition_id: state.competitionId,
      arena_name: state.arenaName,
      last: result
    })
  }).catch(() => {});
}

function computeLastByBaseline(results){
  // Costruisci la mappa attuale: head_number -> { faults, result }
  const currentHeads = new Map();
  for(const r of results){
    if(r.head_number && safeStr(r.time).trim() !== ""){
      const hn = String(r.head_number);
      const faults = safeStr(r.faults).trim().toLowerCase();
      currentHeads.set(hn, { faults, result: r });
    }
  }

  // Prima chiamata: inizializza la baseline, carica LAST dal server
  if(state.headBaseline.size === 0 && currentHeads.size > 0){
    state.headBaseline = new Map();
    for(const [hn, data] of currentHeads){
      state.headBaseline.set(hn, data.faults);
    }
    // Carica il LAST salvato dal server (async, verrà mostrato al prossimo refresh)
    if(!state.lastDetected) fetchSavedLast();
    return state.lastDetected;
  }

  // Cerca testiere NUOVE o con penalità CAMBIATE
  const changed = [];
  for(const [hn, data] of currentHeads){
    const prevFaults = state.headBaseline.get(hn);
    if(prevFaults === undefined){
      // Testiera completamente nuova
      changed.push(data.result);
      console.log(`[LAST] Nuova testiera: ${hn}`);
    }else if(prevFaults !== data.faults){
      // Penalità cambiate (barrage, ELIM, RIT, NP...)
      changed.push(data.result);
      console.log(`[LAST] Penalità cambiate per testiera ${hn}: "${prevFaults}" → "${data.faults}"`);
    }
  }

  // Filtra N.P. (non partito) — non deve apparire come LAST
  const valid = changed.filter(r => {
    const f = safeStr(r.faults).trim().toUpperCase();
    const p = safeStr(r.ranking_position_explained || "").trim().toUpperCase();
    return !f.includes("N.P") && !p.includes("N.P");
  });

  // Se ci sono cambiamenti validi, il più recente diventa il LAST e lo salviamo sul server
  if(valid.length > 0){
    const newest = valid.sort((a,b) => Number(b.updated||0) - Number(a.updated||0))[0];
    state.lastDetected = newest;
    saveLast(newest);
  }

  // Aggiorna la baseline
  state.headBaseline = new Map();
  for(const [hn, data] of currentHeads){
    state.headBaseline.set(hn, data.faults);
  }

  // Ritorna sempre l'ultimo rilevato (persiste fino a nuova aggiunta)
  return state.lastDetected;
}
function computeNext(starting, results, excludeBib){
  const finished = new Set(results.filter(r => safeStr(r.time).trim() !== "").map(r => r.head_number));
  const excl = excludeBib ? String(excludeBib) : null;
  return starting
    .slice()
    .sort((a,b)=>Number(a.entry_order||0)-Number(b.entry_order||0))
    .find(e => !finished.has(e.head_number) && e.not_in_competition === false
      && (!excl || String(e.head_number) !== excl)) || null;
}
function computeNextN(starting, results, count, excludeBib){
  const finished = new Set(results.filter(r => safeStr(r.time).trim() !== "").map(r => r.head_number));
  const excl = excludeBib ? String(excludeBib) : null;
  return starting
    .slice()
    .sort((a,b)=>Number(a.entry_order||0)-Number(b.entry_order||0))
    .filter(e => !finished.has(e.head_number) && e.not_in_competition === false
      && (!excl || String(e.head_number) !== excl))
    .slice(0, count);
}
function findStartingByBib(starting, bib){
  if(!bib) return null;
  return (starting||[]).find(s => String(s.head_number) === String(bib)) || null;
}
function fmtPenaltyLive(val){
  if(val === null || val === undefined) return "0";
  const s = String(val).trim();
  if(!s) return "0";
  if(["elim","rit","np"].includes(s.toLowerCase())) return s.toUpperCase();
  const n = Number(s);
  return Number.isFinite(n) ? n.toString() : s;
}
function fmtLiveTime(val){
  const n = safeNum(val);
  if(n === null) return (val ? String(val) : "—");
  return `${n.toFixed(2)} s`;
}
function fmtLiveElapsedSeconds(start, nowS){
  const base = safeNum(start) ?? nowS;
  const s = Math.max(0, Math.floor((nowS) - base));
  return `${s}s`;
}

// ---- Live timing with anchors and phase reset ----
function nowMono(){
  // performance.now has better monotonicity if available
  if(typeof performance !== "undefined" && performance.now){
    return performance.now() / 1000;
  }
  return Date.now() / 1000;
}

function timingReset(){
  state.liveTiming = {
    bib: null,
    startKey: null,
    t0Site: null,
    startOffset: 0,
    driftOffset: 0,
    smooth: null,
    lastAnchorToken: null,
    lastAnchorMono: null,
    phaseWindowUntil: null,
    phaseRawTime: null,
    lastPhaseKey: null,
  };
  state.phaseFinishPending = false;
}

function timingHandleStart(ev){
  const PHASE2_DEFAULT_OFFSET = 6; // seconds: default offset when phase 2 starts
  const { bib, chrono_time, mono_ts } = ev;
  const t0 = nowMono();
  // If phase 1 just finished (time arrived but no rank), use 6s offset as starting point
  // unless chrono_time already carries the real offset
  let offset = safeNum(chrono_time) || 0;
  if(state.phaseFinishPending && offset === 0){
    offset = PHASE2_DEFAULT_OFFSET;
    console.log(`[TIMING] Phase 2 start detected - using ${PHASE2_DEFAULT_OFFSET}s default offset (anchors will correct)`);
  }
  state.phaseFinishPending = false;
  state.liveTiming = {
    ...state.liveTiming,
    bib,
    startKey: `${bib||"?"}-${t0}`,
    t0Site: t0,
    startOffset: offset,
    driftOffset: 0,
    smooth: null,
    lastAnchorToken: null,
    lastAnchorMono: null,
    phaseWindowUntil: null,
    phaseRawTime: null,
    lastPhaseKey: null,
    waitingForAnchor: true,
  };
}

function timingHandleAnchor(ev){
  const { chrono_time, mono_ts } = ev;
  if(state.liveTiming.t0Site === null) return; // no start yet
  const siteNow = nowMono();
  const anchorMono = safeNum(mono_ts) ?? siteNow;
  const elapsedSite = (siteNow - state.liveTiming.t0Site) + state.liveTiming.startOffset + state.liveTiming.driftOffset;
  const target = safeNum(chrono_time);
  if(target === null) return;
  const error = target - elapsedSite;
  const absErr = Math.abs(error);
  state.liveTiming.lastAnchorMono = anchorMono;
  state.liveTiming.lastAnchorToken = `${anchorMono}-${target}`;
  state.liveTiming.waitingForAnchor = false;

  const SNAP_THR = 0.12;
  const EASE_THR = 0.08;
  const EASE_MS = 300;

  if(absErr >= SNAP_THR){
    state.liveTiming.driftOffset += error;
    state.liveTiming.smooth = null;
  }else if(absErr >= EASE_THR){
    const startMs = performance.now();
    const from = state.liveTiming.driftOffset;
    const to = from + error;
    state.liveTiming.smooth = { startMs, duration: EASE_MS, from, to };
  }else{
    // tiny error, ignore
  }
}

function timingHandlePhaseReset(ev){
  const { bib, raw_time, mono_ts, window_sec } = ev;
  const t0 = nowMono();
  const win = safeNum(window_sec) || 5;
  state.liveTiming.phaseWindowUntil = (safeNum(mono_ts) ?? t0) + win;
  state.liveTiming.phaseRawTime = safeNum(raw_time) ?? null;
  state.liveTiming.lastPhaseKey = `${bib||"?"}-${t0}`;
}

function timingCurrentSeconds(){
  const lt = state.liveTiming;
  if(lt.t0Site === null) return null;
  const siteNow = nowMono();

  // apply easing if present
  if(lt.smooth){
    const nowMs = performance.now();
    const { startMs, duration, from, to } = lt.smooth;
    const t = Math.min(1, Math.max(0, (nowMs - startMs) / duration));
    if(t >= 1){
      lt.driftOffset = to;
      lt.smooth = null;
    }else{
      // ease-out cubic
      const k = 1 - Math.pow(1 - t, 3);
      lt.driftOffset = from + (to - from) * k;
    }
  }

  const integrated = (siteNow - lt.t0Site) + lt.startOffset + lt.driftOffset;

  // phase window override
  if(lt.phaseWindowUntil && siteNow <= lt.phaseWindowUntil){
    if(lt.phaseRawTime !== null) return Math.max(0, lt.phaseRawTime);
  }

  return Math.max(0, integrated);
}

function phaseWindowActive(){
  const lt = state.liveTiming;
  if(!lt.phaseWindowUntil) return false;
  return nowMono() <= lt.phaseWindowUntil;
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

async function pollLiveCurrent(){
  if(!state.competitionId || !state.arenaName) return;
  const controller = new AbortController();
  const to = setTimeout(()=>controller.abort(), 800);
  try{
    const url = `/live/current?competition_id=${encodeURIComponent(state.competitionId)}&arena_name=${encodeURIComponent(state.arenaName)}`;
    const resp = await fetch(url, { signal: controller.signal, cache:"no-store" });
    const data = await resp.json();
    state.liveCurrent = data;
    state.liveCurrentAt = Date.now();
    state.liveErrorAt = 0;
    applyTimingEvents(data);
  }catch(e){
    state.liveErrorAt = Date.now();
  }finally{
    clearTimeout(to);
  }
}

function applyTimingEvents(live){
  if(!live || !live.available){
    console.log(`[TIMING] applyTimingEvents skipped - live not available`);
    return;
  }
  // the backend now can send optional timing_events array
  const events = live.timing_events || [];
  if(events.length > 0){
    console.log(`[TIMING] Received ${events.length} events:`, events.map(e => e.type));
    // Log full payload so we see esattamente cosa manda main.py
    console.log("[TIMING] Raw events payload:", JSON.stringify(events));
    events.forEach((ev, idx) => console.log(`[TIMING] Event[${idx}]`, ev));
  }else{
    console.log(`[TIMING] No timing events in this poll`);
  }
  for(const ev of events){
    switch(ev?.type){
      case "start":
        console.log(`[TIMING] Processing start: bib=${ev.bib} chrono_time=${ev.chrono_time} mono_ts=${ev.mono_ts}`);
        timingHandleStart(ev);
        state.lastFinish = null; // new run starts, clear old finish snapshot
        break;
      case "time_anchor":
        console.log(`[TIMING] Processing anchor: chrono_time=${ev.chrono_time} mono_ts=${ev.mono_ts}`);
        timingHandleAnchor(ev);
        break;
      case "phase_reset":
        console.log(`[TIMING] Processing phase_reset: raw_time=${ev.raw_time} window_sec=${ev.window_sec}`);
        timingHandlePhaseReset(ev);
        break;
      default:
        // ignore unknown
        break;
    }
  }

  // if bib changes (detected from either liveTiming.bib or lastCurrentBib), reset timing
  const curBib = live.current_bib;
  const prevBib = state.liveTiming.bib || state.lastCurrentBib;
  if(prevBib && curBib && String(prevBib) !== String(curBib)){
    console.log(`[TIMING] Bib changed: ${prevBib} -> ${curBib}, resetting timing and lastFinish`);
    timingReset();
    state.lastFinish = null; // reset old finish data for new rider
  }
  state.lastCurrentBib = curBib; // always track latest bib from server

  // prevent false running when no start has been received client-side
  if(live.state === "running" && state.liveTiming.t0Site === null){
    console.warn(`[TIMING] Backend says 'running' but no start event received yet - forcing state to 'idle'`);
    live.state = "idle";
  }

  // stale anchors safeguard: if running and no anchor >7s, suspend integration to avoid drift
  if(live.state === "running"){
    const lt = state.liveTiming;
    const nowM = nowMono();
    if(lt.lastAnchorMono && (nowM - lt.lastAnchorMono) > 7){
      console.warn(`[TIMER] No anchor for ${(nowM - lt.lastAnchorMono).toFixed(1)}s - disabling timer. Make sure main.py sends time_anchor every 2-3s!`);
      lt.t0Site = null; // disables timer until next start/anchor
    }
  }

  // capture last finish snapshot to keep rank/time visible until next start
  if(live.state === "finished" && live.finish_time != null){
    console.log(`[TIMING] Captured finish snapshot - bib:${live.current_bib} time:${live.finish_time} rank:${live.rank} penalty:${live.penalty}`);
    state.lastFinish = {
      bib: live.current_bib,
      rank: live.rank,
      time: live.finish_time,
      penalty: live.penalty,
    };
    // Detect phase finish: time present but NO rank → end of phase 1
    if(live.rank == null){
      state.phaseFinishPending = true;
      console.log(`[TIMING] Phase 1 finish detected (time=${live.finish_time}, no rank) - next start will use phase 2 offset`);
    }else{
      state.phaseFinishPending = false; // definitive finish with rank, no phase pending
    }
  }else if(live.state === "finished" && live.finish_time == null){
    console.warn(`[TIMING] State is 'finished' but finish_time is null! The 'finish' event may be missing the 'time' field.`);
  }
}

function startLiveClock(){
  if(state.liveClockHandle) return;
  state.liveClockHandle = setInterval(() => {
    const live = state.liveCurrent;
    const nowMs = Date.now();
    const nowS = nowMs / 1000;
    const fetchStale = (nowMs - (state.liveCurrentAt || 0)) > state.liveGraceMs;
    const errorFresh = state.liveErrorAt && (nowMs - state.liveErrorAt) < state.liveGraceMs;
    const hbStale = !live || (live.last_heartbeat && (nowS - live.last_heartbeat) > (HEARTBEAT_TTL || 60));
    const available = live && live.available && !hbStale && !fetchStale && !errorFresh;
    if(!available) return;
    if(live.state === "running"){
      const t = timingCurrentSeconds();
      const el = $("currentTime");
      if(el){
        if(t === null){
          el.textContent = "—";
          setStateClass(el, "idle");
        }else if(phaseWindowActive()){
          el.textContent = `${t.toFixed(2)} s`;
          setStateClass(el, "running");
        }else{
          el.textContent = `${Math.floor(t)} s`;
          setStateClass(el, "running");
        }
      }
    }
  }, 250);
}

document.addEventListener("DOMContentLoaded", () => {
  applyCanvasScale();
});

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

function isBarrageClass(meta){
  const n = (meta?.class_name || "").toUpperCase();
  return n.includes("JUMP OFF") || n.includes("MISTA");
}

function buildRow(r, highlight=false){
  const row = document.createElement("div");
  row.className = "row" + (highlight ? " last" : "");

  const pos = document.createElement("div");
  pos.className = "pos";
  let posLabel = safeStr(r.ranking_position_explained || r.ranking_position || "—").trim();
  // Mista/Jump Off: rider con faults esattamente "0" → ex aequo 1° posto
  if(isBarrageClass(state._currentClassMeta)){
    const f = safeStr(r.faults).trim();
    if(f === "0") posLabel = "1";
  }
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
  // Conservative approach: only fit rows that are guaranteed to be fully visible
  const usable = rect.height - 20; // larger safety margin to prevent truncation
  let fit = Math.floor(usable / rh);
  // Only add extra row if there's at least 90% of space (almost a full row)
  const leftover = usable - fit * rh;
  if(leftover > rh * 0.90) fit += 1;
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
  // mobile: mostra tutti i risultati, scrollabili a mano, senza paging
  const isMobile = window.innerWidth <= 768;
  let pageItems;
  if(isMobile){
    pageItems = sorted;
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
    const isLastRow = isLive && last && (
      (r.id && last.id && r.id === last.id) ||
      (r.head_number && last.head_number && String(r.head_number) === String(last.head_number))
    );
    const el = buildRow(r, isLastRow);
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

  const liveUp = isLiveAvailable();
  const nextBoxEl = document.querySelector(".nextBox");
  const currentBoxEl = document.querySelector(".currentBox");
  const expandedList = $("nextExpandedList");

  // --- Popola sempre il NEXT singolo (primo prossimo rider) ---
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

  if(liveUp){
    // --- Live attivo: NEXT singolo + CURRENT visibile ---
    if(nextBoxEl) nextBoxEl.classList.remove("expanded");
    if(currentBoxEl) currentBoxEl.classList.remove("hidden");
    if(expandedList) expandedList.innerHTML = "";
    $("nextTitle").textContent = "NEXT";
    renderCurrentBox(state.liveCurrent, state._startingList);
  }else{
    // --- Live NON attivo: nascondi CURRENT, espandi NEXT con rider aggiuntivi ---
    if(currentBoxEl) currentBoxEl.classList.add("hidden");
    if(nextBoxEl) nextBoxEl.classList.add("expanded");
    $("nextTitle").textContent = "NEXT RIDERS";
    const remaining = (totalAll || 0) - (totalDone || 0);
    $("nextOrder").textContent = remaining > 0 ? `${remaining} to go` : "—";

    const starting = state._startingList || [];
    // Prendi i prossimi rider DOPO il primo (che è già nel NEXT singolo)
    const allNext = computeNextN(starting, standings, 7);
    const extraRiders = allNext.slice(1); // salta il primo, già mostrato in #nextSingle
    if(expandedList){
      expandedList.innerHTML = "";
      for(const entry of extraRiders){
        const row = document.createElement("div");
        row.className = "nextExpandedRow";

        const order = document.createElement("span");
        order.className = "nextExpOrder";
        order.textContent = `#${entry.entry_order || "—"}`;

        const flagImg = document.createElement("img");
        flagImg.className = "flagIcon";
        const nat = entry.rider?.nationality || entry.rider?.country_code || entry.nationality || entry.country_code;
        const src = flagSrc(nat);
        if(src){ flagImg.src = src; } else { flagImg.style.display = "none"; }

        const rider = document.createElement("span");
        rider.className = "nextExpRider";
        rider.textContent = fmtRider(entry.rider);

        const horse = document.createElement("span");
        horse.className = "nextExpHorse";
        horse.textContent = entry.horse?.full_name || "—";

        const bib = document.createElement("span");
        bib.className = "nextExpBib";
        bib.textContent = entry.head_number ? `(${entry.head_number})` : "";

        row.append(order, flagImg, rider, horse, bib);
        expandedList.appendChild(row);
      }
    }
  }

  setStats(totalDone, totalAll, standings);
}

function renderFinal(standings, totalDone, totalAll, pageKey){
  $("layoutLive").style.display = "none";
  $("layoutFinal").style.display = "";

  const sorted = standings.slice().sort((a,b)=>Number(a.ranking_position||9999)-Number(b.ranking_position||9999));
  const isMobile = window.innerWidth <= 768;
  let left, right;
  if(isMobile){
    // Mobile: tutti i risultati in una colonna, scroll manuale
    left = sorted;
    right = [];
    state.page = 0;
  }else{
    const perCol = rowsThatFit("rowsFinalLeft", sorted[0] || dummyRow());
    const perPage = perCol * 2;
    const pageCount = Math.max(1, Math.ceil(sorted.length / perPage));
    advancePageIfDue(pageCount, pageKey);
    state.page = state.page % pageCount;
    const start = state.page * perPage;
    const items = sorted.slice(start, start + perPage);
    left = items.slice(0, perCol);
    right = items.slice(perCol, perPage);
  }
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
    state.headBaseline = new Map();
    state.lastDetected = null;
    state.lastFinish = null;
    state.lastCurrentBib = null;
  }

  state._currentClassMeta = pick.classMeta;
  state._currentStandings = standings;
  const starting = (startJson.starting_lists || []);
  state._startingList = starting;
  const totalAll = startJson.starting_list_count || pick.classMeta.starting_list_count || starting.length || null;
  const totalDone = standings.filter(r => safeStr(r.time).trim() !== "").length;

  let last = computeLastByBaseline(standings);

  const isLive = (pick.mode === "live");
  const liveBib = isLiveAvailable() ? state.liveCurrent?.current_bib : null;
  const next = isLive ? computeNext(starting, standings, liveBib) : null;
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
    if(state.livePollHandle) clearInterval(state.livePollHandle);
    state.livePollHandle = setInterval(pollLiveCurrent, state.livePollMs);
    pollLiveCurrent(); // fire once immediately
    startLiveClock();  // lightweight local chrono refresher
  });

  // Setup toggle buttons - reopen setup overlay without reload
  const openBtns = document.querySelectorAll("#openSetup, .setupToggle");
  openBtns.forEach(btn => {
    if(btn){
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        fillSetup(); // refresh values from current state
        showSetup();
      });
    }
  });

});
