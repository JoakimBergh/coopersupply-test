# Cooper Supply ZV8.3.1.1

ZV8.2 is a follow-up commerce/UX patch built directly on the ZV8.1 baseline. Existing Klarna Playground, Stripe Test, server-side payment validation, Stripe webhook and fitment system are retained.


## ZV8.3.1.1
- Handlekurv-popup har direkte `TIL BETALING` i tillegg til `SE HANDLEKURV`.
- Kundegrensesnittet bruker `BESTILLING` og norsk terminologi der det er naturlig.
- Checkout-produktinformasjon bruker `KOMPATIBILITET` og oversetter kjente demo-tekster til norsk.
- Tømming av handlekurven fra bestillingssiden sender kunden tilbake til forsiden.
- Skjulte UI-elementer bruker en felles `hidden`-regel.
- Checkout-toppen har ryddet spacing mellom tilbake-lenke, eyebrow og hovedoverskrift.

## ZV8.2
- Catalog MINI selector now follows the same progressive selection logic as the homepage while keeping the catalog's compact stacked shape.
- Conditional drivetrain/transmission fields are only shown when more than one valid choice exists.
- Catalog selector adds a `VELG MED REG. NR` entry point; the current UI prepares the Vegvesen lookup flow without pretending a live lookup exists before integration is connected.
- Admin history handling is strengthened for list/new/edit states, including direct URLs, refresh and Back/Forward navigation.
- Price modal closes with `Esc` or by clicking the backdrop; clicks inside the modal remain open.


ZV8 er en større commerce/UX-oppgradering bygget direkte på ZV7.2.9-baseline. Eksisterende Klarna Playground, Stripe Test, server-side betalingsvalidering, Stripe webhook og fitment-system beholdes.

## ZV8.1
- Katalog-selector bruker samme logikk som hovedvelgeren; entydig drivlinje/girkasse vises automatisk og overflødige felt skjules.
- Katalog-selector viser kjøretøysammendrag med modell, år, motor, HK, drivlinje og girkasse når valgene er entydige.
- Admin-produktlisten er komprimert for å unngå horisontal scrolling; SKU ligger under produktnavnet, gruppe under kategori og markedspris under pris.
- Handlekurvbekreftelsen reduseres fra 4 til 2 sekunder.

## ZV8
- Forenklede produktkort med direkte `LEGG I HANDLEKURV` og `SE DETALJER`.
- Liten 2-sekunders handlekurvbekreftelse i stedet for stor modal ved kjøp.
- Egen `Produktstatus` og `Lagerstatus` i backend. Dropshipping bruker `På eksternt lager`.
- Grønt CS Verified-emblem.
- MINI-selector åpnes direkte i katalogen: `Velg din MINI` / `Endre modell`.
- Individuelle produkt-URL-er beholdes som detaljerute.
- Checkout viser full produktinformasjon og har tydelig fraktlinje som kan kobles til fraktberegning senere.
- Browser Back/Forward i admin er koblet til reelle history states for liste, nytt produkt og redigering.
- Alle aktive versjonsreferanser er oppdatert til ZV8.1 for denne patchen.

## Betaling
- Klarna Playground
- Stripe Test / Checkout
- Stripe webhook med signaturverifisering
- Vipps er ikke inkludert.

## Start
`npm install`
`npm start`

Storefront: `http://localhost:3001/`
Admin: `http://localhost:3001/admin/`
