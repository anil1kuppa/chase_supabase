This is an automated version of EMA on Nifty futures.
## Environment variables

### `LOCAL_DEV_SUPABASE_URL`
Local supabase dev url to run locally. We can't directly use **SUPABASE_URL** beause of supabase restrictions
### `LOCAL_DEV_SUPABASE_SERVICE_ROLE_KEY`
Local supabase dev url to run locally. We can't directly use **SUPABASE_SERVICE_ROLE_KEY** beause of supabase restrictions
### `KITE_API_KEY`
Static key of kite dev. Access token would be refreshed daily and picked from table - ***accesstoken***
### `SLACK_WEBHOOK_URL`
URL to which alerts would be sent

