# Trocellen Preisrechner

## Enthaltene Dateien
- `index.html` – Startseite
- `preisrechner.html` – Hauptrechner
- `floater_editor.html` – Editor für `floater.json`
- `app.js` – komplette Logik
- `style.css` – Styling
- `rates.csv` – Tarife
- `zones.csv` – Zonenzuordnung
- `floater.json` – Standard-Floater je Dienstleister

## Fachliche Logik
1. Origin ist fest `DE`.
2. Der Dienstleister bestimmt die Zonenlogik:
   - `Morrisson` => `Morrisson`
   - alle anderen => `ALL`
3. Über Land + PLZ wird die Zone gesucht.
4. Über Dienstleister + Land + Lademeter wird das passende Tarifband gesucht.
5. Preis wird aus der passenden Zonenspalte gelesen.
6. Dieselfloater wird als Prozentaufschlag berechnet.

## Nutzung
Am einfachsten lokal mit einem kleinen Webserver öffnen, z. B.:

```bash
python -m http.server 8000
```

Dann im Browser `http://localhost:8000` öffnen.

## Hinweis
Die CSV-Dateien sind direkt eingebunden. Wenn sich Tarife oder Zonen ändern, einfach `rates.csv` und `zones.csv` ersetzen.
