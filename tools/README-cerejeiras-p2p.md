# Cerejeiras P2P pilot

Isolated one-shot compatibility test using OpenDahua 1.0.8 and psycopg2-binary 2.9.10 on Python 3.13. No production worker changes.

The script queries only the single active DVR belonging to Cerejeiras, validates the credential reference, tries one bounded Cloud/P2P connection, searches a 30-second window one day earlier using America/Sao_Paulo local time, and downloads at most one existing recording file with duration <=120 seconds. Files are temporary and deleted after validation. A search interval does not imply a cropped download: OpenDahua exports entire recording files.

Environment: DATABASE_URL (Postgres reference), DVR_PASSWORD (reference to cop-web-ingest.COP_DVR_CEREJEIRAS_PASSWORD). No credential literals. Restart policy NEVER. Overall deadline 150 seconds. Database session read-only. No DVR setting changes, financial alerts, WhatsApp messages, or AI calls.

The pilot contains a local compatibility patch postponing annotation evaluation in the installed package. Logging excludes serial, username, password and database URL.

Important: the default OpenDahua signaling server is Dahua Easy4IP. Failure here does not establish that Intelbras Cloud itself is offline or that the official Intelbras client cannot play recordings. Intelbras-specific signaling and relay support remain separate validation requirements.
