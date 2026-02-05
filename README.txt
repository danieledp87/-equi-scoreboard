EQUI-SCOREBOARD (cartella demo)

Avvio consigliato (server locale):
  cd ..
  python3 -m http.server 8080
Poi apri:
  http://localhost:8080/equi-scoreboard/

Cosa trovi:
- index.html + styles.css + app.js  -> pagina scoreboard (LIVE / FINAL)
- assets/bg.png                     -> sfondo di esempio
- assets/flags/*.svg                -> bandiere SVG (subset)
- data/demo_*.json                  -> dati demo (offline)

Modalità:
- Demo: usa i file in /data e vedi subito un risultato simile alle tue foto.
- API: chiama Equiresults. Se il browser blocca CORS, ti preparo il proxy (Node/Flask) e la UI resta identica.


AGGIUNTO: Mode 'Equiresults sample (14277 / 322284)' per testare direttamente i JSON online indicati.
Se in browser vedi errori CORS, avvia un proxy locale o usa la variante proxy.


=== API live (Safari) ===
Usa lo script server.py (include proxy /api per evitare CORS).

Mac: doppio click su start.command (potrebbe chiedere permessi).
Oppure da terminale:
  cd equi-scoreboard
  python3 server.py
Poi apri: http://localhost:8080/
