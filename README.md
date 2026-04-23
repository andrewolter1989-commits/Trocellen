# Trocellen Preisrechner

- Einstieg direkt über `index.html`
- Eingaben: Land, PLZ Empfänger, Transportart, optional Lademeter bei Teilladung
- Zusätzliche Felder: `Abholdatum`, `Liefertermin`, `Freitext`
- Ausgabe: alle berechenbaren Dienstleister, sortiert nach Gesamtpreis
- Floater wird automatisch aus `floater.json` gelesen
- E-Mail-Aktionen je Dienstleister:
  - `Verfügbarkeit anfragen`
  - `Sendung buchen`
- E-Mail-Adressen werden in `emails.json` gepflegt
- `Morrisson` nutzt automatisch die eigene Zoneneinteilung, alle anderen `ALL`

Zum lokalen Start z. B.:

```bash
python -m http.server 8000
```

Dann im Browser öffnen:

```text
http://localhost:8000/
```


v12:
- zurück auf die funktionierende Eingabemaske
- leere Preise in rates.csv werden als 'kein Angebot' behandelt
- alte 99.999-Platzhalter werden weiterhin ignoriert
- Ergebnisbereich optisch bereinigt


v14:
- Abholdatum entfernt
- zurück auf stabile v12-Basis
- Tabelle vereinfacht (Zone unter Dienstleister, Grund entfernt)
- leere Preise in rates.csv werden korrekt als kein Angebot behandelt


v15:
- Abholdatum vollständig entfernt
- Hinweistext unter Lademeter entfernt
- Zone aus Ergebnisliste entfernt
- Zusammenfassung oben kompakter gestaltet
