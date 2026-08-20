Self-hosted from Google Fonts so the dashboard has no external dependency:
this is a LAN-only appliance, and on the wall tablet the three families were
costing about 750ms of blocking fetch per load before the text settled.

  Hanken Grotesk   SIL Open Font License 1.1
  Instrument Serif SIL Open Font License 1.1
  IBM Plex Mono    SIL Open Font License 1.1

Only the latin and latin-ext subsets are kept — the UI is English, and
unicode-range means a browser fetches latin-ext only if a character needs it.
Hanken Grotesk is a variable font, so one file covers both 400 and 500; that is
why it is declared with a weight *range* rather than twice.
