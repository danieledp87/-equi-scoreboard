# Troubleshooting: Tempo e Ranking non visualizzati nel blocco CURRENT RIDER

## Problema
Il blocco CURRENT RIDER mostra correttamente:
- ✅ Nome cavaliere
- ✅ Nome cavallo
- ✅ Penalità

Ma NON mostra:
- ❌ Tempo (né durante il running né al finish)
- ❌ Ranking finale

## Causa
Il tempo e il ranking dipendono dagli **eventi di timing** inviati dal programma esterno al backend. Se questi eventi non arrivano, il frontend non può visualizzare i dati.

## Come Diagnosticare

### 1. Controlla i log del Browser (Frontend)
Apri la console del browser (F12 → Console) e cerca:

**Durante il running:**
```
[TIMING] Received X events: ["start"]
[TIMING] Processing start: bib=... chrono_time=... mono_ts=...
[TIMER] State=running, timingCurrentSeconds=...
```

**Durante il percorso:**
```
[TIMING] Received X events: ["time_anchor"]
[TIMING] Processing anchor: chrono_time=... mono_ts=...
```

**Al finish:**
```
[TIMING] Received X events: ["finish"]
[TIMING] Captured finish snapshot - bib:... time:... rank:... penalty:...
```

### 2. Controlla i log del Server (Backend)
Nel terminale dove gira `python server.py`, cerca:

**Quando arriva un evento start:**
```
[EVENT] start: bib=... chrono_time=... mono_ts=...
```

**Ogni 2-3 secondi durante il running:**
```
[EVENT] time_anchor: bib=... chrono_time=... mono_ts=...
```

**Al finish:**
```
[EVENT] finish: bib=... time=... penalty=... rank=...
```

**Ad ogni poll del frontend:**
```
[DEBUG] Current state - bib:... state:... rank:... penalty:...
```

### 3. Messaggi di Warning/Errore da cercare

**Frontend:**
```
[TIMING] Backend says 'running' but no start event received yet
[TIMER] No anchor for Xs - disabling timer
[TIME] State is finished but no finish_time available!
```

**Backend:**
Nessun evento ricevuto dal programma di timing esterno

## Soluzioni

### Caso 1: Nessun evento arriva al backend
**Sintomo:** Nel terminale del server non vedi mai `[EVENT] ...`

**Causa:** Il programma di timing esterno non sta inviando eventi

**Soluzione:**
1. Verifica che il programma di timing sia in esecuzione
2. Verifica che stia inviando eventi all'endpoint `/live/event` del server
3. Verifica che usi il token di autenticazione corretto (header `Authorization: Bearer <token>`)
4. Verifica che invii `competition_id` e `arena_name` corretti

### Caso 2: Eventi `penalty` arrivano ma non `start`/`time_anchor`/`finish`
**Sintomo:** Le penalità si aggiornano ma tempo e ranking no

**Causa:** Il programma di timing invia solo eventi `penalty`, non gli altri

**Soluzione:**
1. Verifica la configurazione del programma di timing
2. Assicurati che invii:
   - `start` quando inizia il percorso (con `chrono_time` e `mono_ts`)
   - `time_anchor` ogni 2-3 secondi durante il running (con `chrono_time` e `mono_ts`)
   - `finish` al termine (con `time`, `penalty`, `rank`)

### Caso 3: Eventi arrivano ma con campi mancanti
**Sintomo:** Backend riceve eventi ma frontend mostra warning tipo "no finish_time available"

**Causa:** Gli eventi non includono tutti i campi necessari

**Soluzione:**
Verifica che gli eventi includano:
- `start`: `bib`, `chrono_time`, `mono_ts`
- `time_anchor`: `bib`, `chrono_time`, `mono_ts`
- `finish`: `bib`, `time`, `penalty`, `rank`

### Caso 4: Eventi per arena sbagliata
**Sintomo:** Backend riceve eventi ma per un'arena diversa

**Causa:** Il programma di timing invia eventi per un'arena diversa da quella visualizzata

**Soluzione:**
1. Verifica che l'arena selezionata nel setup corrisponda a quella del programma di timing
2. Controlla nei log del backend il `competition_id` e `arena_name` degli eventi ricevuti

## Struttura Eventi

### Evento `start`
```json
POST /live/event
Authorization: Bearer <token>
{
  "type": "start",
  "source_id": "timing-system-1",
  "competition_id": "14277",
  "arena_name": "GIULIO CESARE",
  "bib": "42",
  "chrono_time": 0,
  "mono_ts": 123456.789,
  "ts": 1234567890.123
}
```

### Evento `time_anchor` (ogni 2-3s)
```json
POST /live/event
Authorization: Bearer <token>
{
  "type": "time_anchor",
  "source_id": "timing-system-1",
  "competition_id": "14277",
  "arena_name": "GIULIO CESARE",
  "bib": "42",
  "chrono_time": 45.67,
  "mono_ts": 123502.456,
  "ts": 1234567935.890
}
```

### Evento `finish`
```json
POST /live/event
Authorization: Bearer <token>
{
  "type": "finish",
  "source_id": "timing-system-1",
  "competition_id": "14277",
  "arena_name": "GIULIO CESARE",
  "bib": "42",
  "time": 78.45,
  "penalty": "4",
  "rank": 5,
  "ts": 1234568000.123
}
```

## Test Manuale

Puoi testare manualmente inviando eventi con `curl`:

```bash
# 1. Registra una sorgente
curl -X POST http://localhost:8080/live/register \
  -H "Authorization: Bearer secret-token-change-me" \
  -H "Content-Type: application/json" \
  -d '{
    "source_id": "test",
    "competition_id": "14277",
    "arena_name": "GIULIO CESARE"
  }'

# 2. Invia un evento start
curl -X POST http://localhost:8080/live/event \
  -H "Authorization: Bearer secret-token-change-me" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "start",
    "source_id": "test",
    "competition_id": "14277",
    "arena_name": "GIULIO CESARE",
    "bib": "1",
    "chrono_time": 0,
    "mono_ts": 123456.789
  }'

# 3. Invia un time_anchor
curl -X POST http://localhost:8080/live/event \
  -H "Authorization: Bearer secret-token-change-me" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "time_anchor",
    "source_id": "test",
    "competition_id": "14277",
    "arena_name": "GIULIO CESARE",
    "bib": "1",
    "chrono_time": 10.5,
    "mono_ts": 123467.289
  }'

# 4. Invia un evento finish
curl -X POST http://localhost:8080/live/event \
  -H "Authorization: Bearer secret-token-change-me" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "finish",
    "source_id": "test",
    "competition_id": "14277",
    "arena_name": "GIULIO CESARE",
    "bib": "1",
    "time": 45.67,
    "penalty": "0",
    "rank": 1
  }'
```

Se il test manuale funziona, il problema è nel programma di timing esterno.
