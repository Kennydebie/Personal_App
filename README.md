# Regelradar

Regelradar is een lokale, Nederlandstalige webapp voor concrete acties, afspraken en zaken waarop je wacht. De eerste versie gebruikt een eigen Google-koppeling voor Gmail en Google Calendar. Je bepaalt zelf wanneer je met **Nu controleren** een scan start; er is geen automatische achtergrondcontrole of melding.

## Lokaal starten

Vereisten: Node.js 24 of nieuwer, pnpm en een Google-account waarvoor je de OAuth-instellingen kunt maken.

1. Maak in [Google Cloud Console](https://console.cloud.google.com/) een project, schakel de **Gmail API** en **Google Calendar API** in en configureer het OAuth-toestemmingsscherm. Voeg je eigen Google-account toe als testgebruiker als de app in testmodus staat.
2. Maak een OAuth 2.0-client van het type **Web application**. Voeg `http://localhost:3000/api/auth/google/callback` toe als *Authorized redirect URI*. Bewaar de client-ID en het clientgeheim.
3. Kopieer `.env.example` naar `.env.local`. Vul `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` en `ALLOWED_EMAIL` (je eigen Google-mailadres) in. Houd `GOOGLE_REDIRECT_URI` voor lokaal gebruik op de waarde uit het voorbeeld.
4. Genereer een willekeurige sleutel van precies 32 bytes, bijvoorbeeld met `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"`, en zet de uitvoer in `APP_ENCRYPTION_KEY`. Bewaar deze sleutel veilig: zonder dezelfde sleutel zijn eerder opgeslagen OAuth-tokens niet meer leesbaar.
5. Voer `pnpm install` en `pnpm dev` uit. Open [http://localhost:3000](http://localhost:3000), koppel Google en kies **Nu controleren**.

De OAuth-aanvraag gebruikt `openid` en `email` om het account te herkennen, plus de alleen-lezen scopes `https://www.googleapis.com/auth/gmail.readonly`, `https://www.googleapis.com/auth/calendar.calendarlist.readonly` en `https://www.googleapis.com/auth/calendar.events.readonly`. Regelradar verstuurt geen e-mail en wijzigt geen agenda-afspraken. De eerste handmatige scan richt zich op Gmail van de afgelopen 90 dagen (ook verzonden berichten) en agenda-afspraken in de komende 90 dagen. Voor een gevonden specifieke zaak kan de app gericht oudere berichten van dezelfde contactpersoon zoeken. Bij veel Gmail-threads zijn meerdere handmatige controles nodig om alle pagina’s te verwerken; de bronstatus meldt wanneer de controle nog gedeeltelijk is. Een latere controle start je opnieuw met **Nu controleren**. Resultaten en eventuele ontbrekende toegang worden in de app getoond; een leeg overzicht betekent alleen dat in de gecontroleerde bronnen geen open acties zijn gevonden.

## Gegevens en toegang

Regelradar bewaart items, keuzes en broninformatie in een lokale SQLite-database (`data/regelradar.sqlite`, of `DATABASE_PATH` als je dat instelt). De OAuth-tokens worden daarin versleuteld met `APP_ENCRYPTION_KEY`; het SQLite-bestand als geheel is niet versleuteld en kan gevoelige titels, toelichtingen en bronmetadata bevatten. Bescherm daarom de computer en maak geen openbare kopie van de database of `.env.local`. Voor een externe installatie zijn HTTPS, een blijvende opslaglocatie voor SQLite en dezelfde geheime instellingen na herstart nodig.

De database wordt aan `ALLOWED_EMAIL` gekoppeld. Als je dit account verandert, blokkeert de app toegang tot de bestaande gegevens. Herstel het oorspronkelijke adres of verplaats het oude databasebestand en begin met een nieuwe, lege database.

Herkende werk- en cliëntinhoud wordt standaard niet als item verwerkt. Die herkenning is gebaseerd op regels en kan iets missen. Alleen als je de benodigde toestemming hebt, kun je deze uitsluiting bewust opheffen met `INCLUDE_WORK_CONTENT=true` in `.env.local`.

Via de app kun je **Google loskoppelen** en **Gegevens verwijderen**. Loskoppelen stopt de toegang vanuit Regelradar maar laat eerder gevonden items staan; gegevens verwijderen wist ook de lokaal opgeslagen items en bronstatus. De Google-verbindingen die je eventueel in Codex hebt, zijn apart: Regelradar kan die niet overnemen. De Codex Calendar-connector heeft bovendien niet de leesscopes die deze app nodig heeft. Totdat je de eigen OAuth-koppeling in Regelradar hebt voltooid, verschijnt de bron als *niet verbonden*.

Deze versie richt zich op Gmail en Google Calendar. Google Drive, Contacts en andere bronnen zijn nog niet gekoppeld. Gerelateerde mailgesprekken worden alleen samengevoegd wanneer een specifiek onderwerp en dezelfde contactpersoon sterk op dezelfde zaak wijzen. Bijlagen worden op naam herkend maar niet inhoudelijk gelezen; de bronstatus geeft aan wanneer dit de dekking beperkt.
