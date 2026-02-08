# Architettura Live Timing — Documentazione Tecnica

## Panoramica

Il sistema ha 3 componenti:

```
main.py (locale, campo gara)
    │  HTTP POST (JSON)
    ▼
server.py (cloud, porta 8080)
    │  HTTP GET (polling ogni 500ms)
    ▼
app.js (browser, visualizzazione)
```

---

## 1. MAIN.PY → SERVER (invio eventi)

Tutte le richieste sono **POST** con header `Authorization: Bearer <LIVE_TOKEN>` e body JSON.

### 1a. Registrazione (all'avvio)
```json
POST /live/register
{
  "competition_id": "15467",
  "arena_name": "DANTE",
  "source_id": "main-py-uuid-univoco"
}
```
Crea una sessione live nel server. Senza questa, tutti gli eventi vengono rifiutati con 404.

### 1b. Heartbeat (ogni ~30s)
```json
POST /live/heartbeat
{
  "source_id": "main-py-uuid-univoco"
}
```
Mantiene la sessione attiva. Se non arriva per 60 secondi (`HEARTBEAT_TTL`), il server considera la sessione morta e il frontend mostra "dati non disponibili".

### 1c. Eventi (la parte centrale)
```json
POST /live/event
{
  "type": "<tipo_evento>",
  "source_id": "...",
  "competition_id": "15467",
  "arena_name": "DANTE",
  "bib": 52,
  "...campi specifici per tipo..."
}
```

### Tipi di evento

| Tipo | Quando si invia | Campi extra | Cosa fa sul server |
|------|----------------|-------------|-------------------|
| `bib_change` | Nuova testiera entra in campo | `bib` | Resetta state→idle, azzera penalty/rank/finish_time/start_time |
| `start` | Cavaliere parte (cronometro inizia) | `bib`, `chrono_time`, `mono_ts` | State→running, salva start_time, **accoda evento nel buffer timing** |
| `time_anchor` | Ogni 2-3 secondi durante il percorso | `bib`, `chrono_time`, `mono_ts` | **Accoda evento nel buffer timing** (nessun cambio di stato) |
| `phase_reset` | Cambio fase (gara a fasi) | `bib`, `raw_time`, `mono_ts`, `window_sec` | **Accoda evento nel buffer timing** |
| `penalty` | Penalità rilevata (abbattimento) | `bib`, `penalty` (intero, es. 4, 8) | Aggiorna penalty nello stato |
| `finish` | Cavaliere taglia il traguardo | `bib`, `time` (stringa "45.23"), `penalty`, `rank` | State→finished, salva finish_time/rank/penalty |

### Campi chiave per il timing

- **`chrono_time`** (float, secondi): il tempo letto dal cronometro in quel momento (es. `12.45` = 12 secondi e 45 centesimi). Questo è il "tempo vero" del cronometro.
- **`mono_ts`** (float, secondi): timestamp monotono del PC di main.py (`time.monotonic()`). Serve al frontend per calcolare la latenza e sincronizzarsi.

### Esempio payload per ogni tipo

**bib_change:**
```json
{
  "type": "bib_change",
  "source_id": "abc-123",
  "competition_id": "15467",
  "arena_name": "DANTE",
  "bib": 52
}
```

**start:**
```json
{
  "type": "start",
  "source_id": "abc-123",
  "competition_id": "15467",
  "arena_name": "DANTE",
  "bib": 52,
  "chrono_time": 0.0,
  "mono_ts": 12345.678
}
```

**time_anchor (inviare ogni 2-3 secondi durante il percorso):**
```json
{
  "type": "time_anchor",
  "source_id": "abc-123",
  "competition_id": "15467",
  "arena_name": "DANTE",
  "bib": 52,
  "chrono_time": 14.56,
  "mono_ts": 12360.234
}
```

**phase_reset (cambio fase):**
```json
{
  "type": "phase_reset",
  "source_id": "abc-123",
  "competition_id": "15467",
  "arena_name": "DANTE",
  "bib": 52,
  "raw_time": 32.45,
  "mono_ts": 12377.890,
  "window_sec": 5
}
```

**penalty:**
```json
{
  "type": "penalty",
  "source_id": "abc-123",
  "competition_id": "15467",
  "arena_name": "DANTE",
  "bib": 52,
  "penalty": 4
}
```

**finish:**
```json
{
  "type": "finish",
  "source_id": "abc-123",
  "competition_id": "15467",
  "arena_name": "DANTE",
  "bib": 52,
  "time": "45.23",
  "penalty": 4,
  "rank": 3
}
```

**finish di fase (senza rank = fine fase 1, non definitivo):**
```json
{
  "type": "finish",
  "source_id": "abc-123",
  "competition_id": "15467",
  "arena_name": "DANTE",
  "bib": 52,
  "time": "32.45",
  "penalty": 0,
  "rank": null
}
```

---

## 2. SERVER.PY — Cosa fa con gli eventi

Il server mantiene in memoria un **registry** (dizionario) con chiave `(competition_id, arena_name)`.

Ogni entry ha:
```python
{
  "source_id": "...",
  "competition_id": "15467",
  "arena_name": "DANTE",
  "last_heartbeat": 1738000123.45,
  "live_state": {
    "current_bib": 52,
    "state": "running",       # idle | running | finished
    "penalty": 0,
    "start_time": 1738000100.0,
    "finish_time": null,
    "rank": null,
    "pending_events": [...]   # BUFFER di eventi timing
  }
}
```

### Il buffer `pending_events`

Questo è il meccanismo fondamentale: gli eventi `start`, `time_anchor` e `phase_reset` vengono **accodati** nel buffer. Quando il frontend li legge via GET, vengono **svuotati** (consumati una sola volta). Questo garantisce che il browser non perda nessun evento anche se il polling è più lento degli invii.

Il buffer è limitato a 50 eventi per evitare crescita illimitata.

### Endpoint di lettura (usato dal frontend)
```
GET /live/current?competition_id=15467&arena_name=DANTE
```

Risposta:
```json
{
  "available": true,
  "source_id": "...",
  "current_bib": 52,
  "state": "running",
  "penalty": 0,
  "start_time": 1738000100.0,
  "finish_time": null,
  "rank": null,
  "timing_events": [
    {"type": "start", "bib": 52, "chrono_time": 0.0, "mono_ts": 12345.67},
    {"type": "time_anchor", "bib": 52, "chrono_time": 2.34, "mono_ts": 12348.01},
    {"type": "time_anchor", "bib": 52, "chrono_time": 4.78, "mono_ts": 12350.45}
  ]
}
```

Dopo questa GET, `pending_events` viene azzerato a `[]` sul server. Il prossimo poll riceverà solo i nuovi eventi arrivati nel frattempo.

---

## 3. APP.JS (Frontend) — Come visualizza il tempo

### 3a. Polling
Il browser chiama `GET /live/current` ogni **500ms**. Ad ogni risposta chiama `applyTimingEvents(data)`.

### 3b. Elaborazione eventi timing

Per ogni evento nel array `timing_events`:

- **`start`** → chiama `timingHandleStart(ev)`:
  - Salva `t0Site = performance.now() / 1000` (momento locale in cui il browser riceve lo start)
  - Salva `startOffset = chrono_time` (il tempo del cronometro allo start, di solito 0)
  - Se è **fase 2** (fase 1 finita con tempo ma senza rank), `startOffset = 6.0` come default
  - Azzera `driftOffset = 0`

- **`time_anchor`** → chiama `timingHandleAnchor(ev)`:
  - Calcola il tempo che il browser sta mostrando: `elapsedSite = (now - t0Site) + startOffset + driftOffset`
  - Calcola l'errore: `error = chrono_time - elapsedSite`
  - Se errore > 0.12s → **snap**: corregge immediatamente (`driftOffset += error`)
  - Se errore tra 0.08s e 0.12s → **ease**: corregge gradualmente con animazione cubic (300ms)
  - Se errore < 0.08s → ignora (troppo piccolo)

- **`phase_reset`** → chiama `timingHandlePhaseReset(ev)`:
  - Per `window_sec` secondi mostra il `raw_time` fisso (es. il tempo di fine fase 1 con centesimi)
  - Dopo la finestra, il timer integrato riprende

### 3c. Calcolo tempo visualizzato (ogni frame)

La funzione `timingCurrentSeconds()` calcola:

```
tempo_mostrato = (performance.now()/1000 - t0Site) + startOffset + driftOffset
```

Dove:
- `performance.now()/1000 - t0Site` = secondi trascorsi localmente dal browser
- `startOffset` = tempo cronometro allo start (normalmente 0, oppure 6 per fase 2)
- `driftOffset` = correzione accumulata dagli anchor

### 3d. Visualizzazione nel blocco CURRENT

| Stato server | Cosa mostra il frontend |
|-------------|------------------------|
| `idle` | Nome/cavallo del rider corrente, tempo "—", penalità "—", rank "—" |
| `running` | Nome/cavallo, **timer che scorre** (secondi interi, centesimi solo nella finestra phase_reset) |
| `finished` | Nome/cavallo, **tempo finale** con centesimi (es. "45.23"), penalità, rank |

### 3e. Safeguard anti-drift

Se il browser è in stato `running` ma non riceve anchor per **più di 7 secondi**, il timer viene disabilitato (`t0Site = null`) → mostra "—". Riprende al prossimo anchor o start. Questo evita che il timer derivi senza controllo se main.py ha problemi.

**IMPORTANTE**: main.py deve inviare `time_anchor` ogni 2-3 secondi durante il percorso, altrimenti il timer si spegne dopo 7 secondi.

---

## 4. Comportamento senza cronometro collegato (NEXT RIDERS)

Quando **main.py non è attivo** (nessun heartbeat, sessione scaduta, o errori di connessione), il frontend rileva automaticamente che i dati live non sono disponibili tramite la funzione `isLiveAvailable()`.

### Cosa controlla `isLiveAvailable()`:
- `live.available` è true
- L'heartbeat non è scaduto (< 60 secondi)
- L'ultimo fetch non è troppo vecchio (< 3 secondi)
- Non ci sono errori recenti

### Cosa succede quando live NON è disponibile:

1. **Il blocco CURRENT viene nascosto** (non viene mostrato il box del rider corrente con timer/penalità/rank perché non ci sono dati live)

2. **Il blocco NEXT si espande** e mostra la lista dei **prossimi cavalieri** dalla starting list:
   - Header cambia da "NEXT" a **"NEXT RIDERS"**
   - Mostra il **conteggio dei cavalieri rimanenti** (quelli non ancora in classifica)
   - Elenca i prossimi N cavalieri con: bandiera, nome, cognome, cavallo, numero testiera
   - I cavalieri sono ordinati per `entry_order` e filtrati (esclusi quelli già finiti e `not_in_competition`)

3. **Quando main.py si riconnette**, il layout torna automaticamente al normale:
   - CURRENT riappare con timer live
   - NEXT torna alla visualizzazione singola del prossimo rider

Questo avviene ad ogni ciclo di refresh (1 secondo), quindi la transizione è fluida.

### Schema visuale:

```
CON cronometro collegato:          SENZA cronometro collegato:
┌──────────────────────┐           ┌──────────────────────┐
│  LAST                │           │  LAST                │
│  Coata - Holly       │           │  Coata - Holly       │
├──────────────────────┤           ├──────────────────────┤
│  NEXT                │           │  NEXT RIDERS (12)    │
│  Philippaerts        │           │  🇧🇪 Philippaerts    │
│  Qualithina          │           │  🇮🇹 Pezzoli         │
├──────────────────────┤           │  🇬🇧 Whitaker        │
│  CURRENT RIDER       │           │  🇫🇷 Richard         │
│  Rolli - Eiffel      │           │  🇦🇹 Kühner          │
│  ▶ 23 s    Pen: 0    │           │  ...                 │
│  Rank: —              │           └──────────────────────┘
└──────────────────────┘           (CURRENT non visibile)
```

---

## 5. Ciclo di vita completo di un percorso

```
main.py                    server.py                   browser
  │                           │                           │
  ├─ POST bib_change ────────►│ state=idle, bib=52        │
  │                           │◄── GET /live/current ─────┤ mostra rider, "—"
  │                           │                           │
  ├─ POST start ─────────────►│ state=running             │
  │   chrono_time=0.0         │ pending_events=[start]    │
  │   mono_ts=12345.0         │◄── GET /live/current ─────┤ riceve start event
  │                           │ pending_events=[] (svuot.) │ t0Site=now, timer parte da 0
  │                           │                           │
  ├─ POST time_anchor ───────►│ pending_events=[anchor]   │
  │   chrono_time=2.34        │◄── GET /live/current ─────┤ corregge drift
  │   mono_ts=12347.3         │                           │ timer mostra ~2s
  │                           │                           │
  ├─ POST time_anchor ───────►│ pending_events=[anchor]   │
  │   chrono_time=5.12        │◄── GET /live/current ─────┤ corregge drift
  │                           │                           │ timer mostra ~5s
  │                           │                           │
  ├─ POST penalty ───────────►│ penalty=4                 │
  │   penalty=4               │◄── GET /live/current ─────┤ mostra "4" in rosso
  │                           │                           │
  ├─ POST finish ────────────►│ state=finished            │
  │   time="45.23"            │ finish_time="45.23"       │
  │   penalty=4, rank=3       │◄── GET /live/current ─────┤ mostra 45.23, Rank 3, pen 4
  │                           │                           │
  ├─ POST bib_change ────────►│ state=idle, bib=53        │
  │   bib=53                  │◄── GET /live/current ─────┤ reset tutto, mostra nuovo rider
```

## 6. Gara a fasi (FASE 1 → FASE 2)

In una gara a fasi, il rider completa prima la fase 1 e poi (se qualificato) la fase 2. Il tempo totale accumula.

```
main.py                    server.py                   browser
  │                           │                           │
  │  === FASE 1 ===           │                           │
  ├─ POST start ─────────────►│ state=running             │ timer parte da 0
  │   chrono_time=0.0         │                           │
  ├─ POST time_anchor ×N ────►│                           │ timer scorre, anchor correggono
  ├─ POST finish ────────────►│ state=finished            │
  │   time="32.45"            │ finish_time="32.45"       │
  │   rank=null  ← NESSUN     │ rank=null                 │ vede finish SENZA rank
  │   RANK = FINE FASE 1      │                           │ → phaseFinishPending=true
  │                           │                           │
  │  === FASE 2 ===           │                           │
  ├─ POST start ─────────────►│ state=running             │ phaseFinishPending=true
  │   chrono_time=0           │                           │ → startOffset=6 (default)
  │                           │                           │ timer parte da ~6s
  │                           │                           │
  ├─ POST time_anchor ───────►│                           │ chrono_time=8.50
  │   chrono_time=8.50        │                           │ errore = 8.50 - ~8.0 = ~0.5s
  │                           │                           │ → SNAP a 8.50 (errore > 0.12s)
  │                           │                           │ timer ora allineato al reale
  │                           │                           │
  ├─ POST time_anchor ×N ────►│                           │ timer preciso grazie agli anchor
  ├─ POST finish ────────────►│ state=finished            │
  │   time="45.23"            │                           │
  │   rank=3     ← CON RANK   │                           │ finish definitivo con rank
  │   = FINISH DEFINITIVO     │                           │
```

Il valore di **6 secondi** è un'approssimazione: il timer parte da lì e il primo `time_anchor` della fase 2 lo corregge (snap) al tempo reale entro 2-3 secondi.

---

## 7. Autenticazione

Tutti i POST a `/live/*` (tranne `/live/last`) richiedono:
```
Authorization: Bearer <LIVE_TOKEN>
```

Il token è definito dalla variabile d'ambiente `LIVE_TOKEN` sul server. Default: `"secret-token-change-me"`.

---

## 8. Riepilogo endpoint server

| Metodo | Path | Auth | Descrizione |
|--------|------|------|-------------|
| POST | `/live/register` | Si | Registra sessione live |
| POST | `/live/unregister` | Si | Rimuove sessione |
| POST | `/live/heartbeat` | Si | Mantiene sessione attiva |
| POST | `/live/event` | Si | Invia evento (bib_change/start/time_anchor/phase_reset/penalty/finish) |
| GET | `/live/current?competition_id=X&arena_name=Y` | No | Frontend legge stato + eventi timing |
| GET | `/live/last?competition_id=X&arena_name=Y` | No | Legge ultimo rider inserito (LAST) |
| POST | `/live/last` | No | Salva ultimo rider (dal browser) |
| GET | `/live/registry` | No | Debug: mostra tutte le sessioni attive |

---

## 9. Requisiti per main.py

### Frequenza invio eventi
- **`time_anchor`**: ogni **2-3 secondi** durante il percorso (OBBLIGATORIO, altrimenti il timer si spegne dopo 7s)
- **`heartbeat`**: ogni **~30 secondi** (OBBLIGATORIO, altrimenti la sessione scade dopo 60s)
- **`bib_change`**: appena una nuova testiera entra in campo
- **`start`**: appena il cronometro parte
- **`penalty`**: appena viene rilevata una penalità
- **`finish`**: appena il cavaliere taglia il traguardo

### Ordine tipico
1. `register` (una volta all'avvio)
2. `bib_change` (nuova testiera)
3. `start` (partenza)
4. `time_anchor` ogni 2-3s (durante il percorso)
5. `penalty` (se abbattimento)
6. `finish` (arrivo)
7. Torna al punto 2 per il prossimo cavaliere
8. `heartbeat` ogni 30s in background (anche tra un cavaliere e l'altro)

### Valori di `chrono_time` e `mono_ts`
- `chrono_time` deve essere il tempo in **secondi** letto dal cronometro (es. `14.56`)
- `mono_ts` deve essere `time.monotonic()` di Python al momento della lettura
- Entrambi devono corrispondere allo **stesso istante**: quando leggi il cronometro, prendi anche il monotonic
