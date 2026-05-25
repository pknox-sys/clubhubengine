# Club Hub Prospect Engine V1 Developer Guide

This document explains the Club Hub Prospect Engine V1 from end to end: what it does, how the UI works, every API route, every external service integration, the expected Supabase tables, local setup, deployment, security, and troubleshooting.

## 1. Product Summary

Club Hub Prospect Engine V1 is a one-page internal prospecting tool for finding school prospects, enriching them with public web research, de-duping records, validating contact emails, and keeping the active prospect table clean.

The application supports this workflow:

1. Search Google Places for schools by keyword, city, and state.
2. Save Google Places results into Supabase `public.prospects`.
3. Display active prospects in the homepage table.
4. Enrich raw prospects with OpenAI Responses API and web search.
5. De-dupe active prospects by conservative matching rules.
6. Move duplicate rows to `public.prospects_duplicates`.
7. Validate public contact emails with Bulk Email Checker.
8. Move invalid email rows to `public.prospects_invalid_emails`.
9. Keep valid, unknown, and error email rows active in `public.prospects`.

V1 intentionally does not include auth, CSV export, background jobs, queues, cron, Instantly, email drafting, multiple contacts per school, or a CRM-style multi-page UI.

## 2. Tech Stack

- Next.js App Router: `next@16.2.6`
- React: `react@19.2.4`
- TypeScript
- Tailwind CSS 4
- Supabase JavaScript client
- OpenAI JavaScript SDK
- Zod for request and model-output validation
- Google Places API New Text Search
- OpenAI Responses API with web search
- Bulk Email Checker real-time email API
- Vercel for deployment

## 3. Repository Layout

```txt
src/
  app/
    page.tsx
    layout.tsx
    globals.css
    api/
      prospects/
        google-search/
          route.ts
        enrich/
          route.ts
        dedupe/
          route.ts
        validate-emails/
          route.ts
  lib/
    googlePlaces.ts
    supabaseServer.ts
    openai/
      enrichment-prompt.ts
      enrichment-schema.ts
  types/
    prospect.ts
docs/
  DEVELOPER_GUIDE.md
.env.example
package.json
```

Important files:

- `src/app/page.tsx`: Client-side one-page UI.
- `src/app/api/prospects/google-search/route.ts`: Google Places search, save, and recent prospects list.
- `src/app/api/prospects/enrich/route.ts`: OpenAI enrichment flow.
- `src/app/api/prospects/dedupe/route.ts`: Duplicate archive and removal flow.
- `src/app/api/prospects/validate-emails/route.ts`: Bulk Email Checker validation flow.
- `src/lib/supabaseServer.ts`: Server-only Supabase client.
- `src/lib/googlePlaces.ts`: Google Places request, response types, address parsing, and row mapping.
- `src/lib/openai/enrichment-schema.ts`: Strict structured output schema and zod validator.
- `src/lib/openai/enrichment-prompt.ts`: OpenAI enrichment worker instructions.
- `src/types/prospect.ts`: Shared UI/API prospect list item types.

## 4. Environment Variables

Use these exact variables.

```env
NEXT_PUBLIC_SUPABASE_URL=https://abcdefghijklmnop.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_example_1234567890abcdefghijklmnopqrstuvwxyz
SUPABASE_SECRET_KEY=sb_secret_example_1234567890abcdefghijklmnopqrstuvwxyz
GOOGLE_MAPS_API_KEY=AIzaSyExampleGoogleMapsApiKey1234567890abcdef
OPENAI_API_KEY=sk-proj-example_openai_key_1234567890abcdefghijklmnopqrstuvwxyz
OPENAI_ENRICH_MODEL=gpt-5.4-mini
BEC_API_KEY=zfuqExampleBulkEmailCheckerKey1234567890
```

Rules:

- Do not put quotes around values.
- Do not use smart quotes.
- Do not add spaces around `=`.
- `.env` is local-only and must not be committed.
- `SUPABASE_SECRET_KEY`, `GOOGLE_MAPS_API_KEY`, `OPENAI_API_KEY`, and `BEC_API_KEY` must only be read server-side.
- The client page does not directly read any secret.
- `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` is currently present for future client-side Supabase use but V1 does not use it in the browser.

If a real key is pasted into chat, GitHub, logs, or screenshots, rotate it at the provider and update Vercel environment variables.

## 5. Local Setup

Install dependencies:

```bash
npm install
```

Run the local dev server:

```bash
npm run dev
```

Build production locally:

```bash
npm run build
```

Run lint:

```bash
npm run lint
```

Default local URL:

```txt
http://localhost:3000
```

If Next says another dev server is already running:

```powershell
taskkill /PID <pid> /F
```

## 6. Homepage UI

File:

```txt
src/app/page.tsx
```

The homepage is a client component because it uses state, effects, button handlers, and browser `fetch`.

Initial defaults:

```txt
keyword = private high school
city = Chicago
state = IL
```

Buttons:

- `Search`: Calls `POST /api/prospects/google-search`.
- `Load Recent`: Calls `GET /api/prospects/google-search`.
- `Enhance Unenriched Prospects`: Calls `POST /api/prospects/enrich` with `{ "limit": 5 }`.
- `De-Dupe Prospects`: Calls `POST /api/prospects/dedupe`.
- `Validate Emails`: Calls `POST /api/prospects/validate-emails` with `{ "limit": 50 }`.

Loading state:

- `isSearching`
- `isLoadingRecent`
- `isEnhancing`
- `isDedupeRunning`
- `isEmailValidationRunning`

The table shows active rows from `public.prospects` only.

Visible table columns:

- School Name
- City
- State
- Phone
- Website
- HS Enrollment
- Clubs Estimate
- Best Contact
- Contact Email
- Email Status
- Fit Score
- Status

Email Status display order:

1. `email_validation_status`
2. `contact_email_validation_status`
3. `not_checked`

Status display:

- `enrichment_status`
- Falls back to `raw`

The UI intentionally does not expose archive tables, deleted duplicates, invalid emails, CSV export, or outbound email actions.

## 7. Supabase Server Client

File:

```txt
src/lib/supabaseServer.ts
```

The app creates a server-only Supabase client with:

- `NEXT_PUBLIC_SUPABASE_URL`
- `SUPABASE_SECRET_KEY`

The helper validates:

- URL exists.
- URL parses as a valid URL.
- secret key exists.

It disables persisted auth session behavior:

```ts
auth: {
  autoRefreshToken: false,
  persistSession: false,
}
```

Client-side code does not import this file.

## 8. Database Tables

V1 expects these Supabase tables to already exist:

- `public.prospects`
- `public.prospects_duplicates`
- `public.prospects_invalid_emails`

### 8.1 `public.prospects`

This is the active working table. All homepage rows come from here.

Important fields used by the app:

```txt
id
created_at
updated_at
search_keyword
search_city
search_state
google_place_id
google_maps_url
school_name
website
main_phone
full_address
city
state
school_type
grades_served
hs_enrollment
total_enrollment
student_life_url
clubs_activities_url
clubs_count_estimate
club_activity_signal
fit_score
personalization_angle
source_urls
research_notes
target_persona
contact_name
contact_title
contact_email
contact_email_validation_status
contact_phone
contact_source_url
contact_confidence
enrichment_status
enrichment_attempts
enrichment_error
enriched_at
email_validation_status
email_validation_error
email_validation_checked_at
email_validation_attempts
email_validation_provider
email_validation_checked_email
dedupe_key
fields_not_found
bec_status
bec_event
bec_details
bec_raw_json
raw_google_json
raw_openai_json
```

Recommended unique index:

```sql
create unique index if not exists prospects_google_place_id_key
on public.prospects (google_place_id);
```

The Google save route has a fallback if this index is missing, but production should have it.

### 8.2 `public.prospects_duplicates`

Archive table for duplicate rows moved out of `public.prospects`.

It should include the original prospect columns plus:

```txt
original_prospect_id
canonical_prospect_id
duplicate_reason
duplicate_confidence
duplicate_group_key
moved_to_duplicates_at
```

Recommended unique key:

```txt
original_prospect_id
```

The de-dupe route uses upsert on `original_prospect_id`.

### 8.3 `public.prospects_invalid_emails`

Archive table for rows whose `contact_email` fails Bulk Email Checker validation.

It should include the original prospect columns plus:

```txt
original_prospect_id
checked_email
bec_status_archived
bec_event_archived
bec_details_archived
bec_raw_json_archived
moved_to_invalid_emails_at
```

Recommended unique key:

```txt
original_prospect_id
```

The email validation route uses upsert on `original_prospect_id`.

## 9. API Routes

All API routes use the App Router route handler convention:

```txt
src/app/api/.../route.ts
```

All routes return JSON.

### 9.1 `GET /api/prospects/google-search`

Purpose:

- Load recent active prospects for the homepage table.

Supabase query:

- Table: `prospects`
- Order: `created_at desc`
- Limit: `50`

Selected fields:

```txt
id
created_at
search_keyword
search_city
search_state
google_place_id
google_maps_url
school_name
website
main_phone
full_address
city
state
school_type
hs_enrollment
clubs_count_estimate
target_persona
contact_name
contact_title
contact_email
fit_score
enrichment_error
email_validation_error
enriched_at
enrichment_status
contact_email_validation_status
email_validation_status
dedupe_key
```

Success response:

```json
{
  "prospects": []
}
```

Errors:

- Missing Supabase URL.
- Missing Supabase secret key.
- Supabase read failure.
- Unexpected server error.

### 9.2 `POST /api/prospects/google-search`

Purpose:

- Search Google Places New Text Search.
- Map results into `public.prospects`.
- Upsert by `google_place_id`.
- Return saved rows for display.

Request:

```json
{
  "keyword": "private high school",
  "city": "Chicago",
  "state": "IL"
}
```

Validation:

- `keyword`: string, trimmed, minimum length 2.
- `city`: string, trimmed, minimum length 2.
- `state`: string, trimmed, minimum length 2.
- State is uppercased if length is `<= 3`.

Google text query:

```txt
{keyword} {city} {state}
```

Google endpoint:

```txt
POST https://places.googleapis.com/v1/places:searchText
```

Google request body:

```json
{
  "textQuery": "private high school Chicago IL",
  "pageSize": 20
}
```

Google field mask:

```txt
places.id,places.displayName,places.formattedAddress,places.addressComponents,places.websiteUri,places.internationalPhoneNumber,places.nationalPhoneNumber,places.googleMapsUri,places.businessStatus,places.types,places.rating,places.userRatingCount,places.location
```

Fields not requested:

- reviews
- generative summaries
- editorial summaries
- atmosphere fields
- wildcard `*`

Prospect mapping:

```txt
search_keyword = submitted keyword
search_city = submitted city
search_state = submitted state
google_place_id = place.id
google_maps_url = place.googleMapsUri
school_name = place.displayName.text or Unknown School
website = place.websiteUri
main_phone = international phone or national phone
full_address = place.formattedAddress
city = locality or administrative_area_level_3 or submitted city
state = administrative_area_level_1 shortText or submitted state
school_type = secondary_school, school, or null
source_urls = website and Google Maps URL when present
enrichment_status = raw
email_validation_status = not_checked
dedupe_key = google:{place.id} or fallback:{school_name}:{full_address}
raw_google_json = complete place object
```

Dedupe/save behavior:

1. Preferred path: Supabase upsert on `google_place_id`.
2. If Supabase reports missing unique constraint, fallback to manual select/update/insert.
3. Manual fallback checks `google_place_id`; if unavailable, checks `dedupe_key`.

Success response:

```json
{
  "count": 20,
  "prospects": []
}
```

### 9.3 `POST /api/prospects/enrich`

Purpose:

- Enrich raw, failed, or null-status prospects using OpenAI Responses API with web search.
- Update the same row in `public.prospects`.
- Never create new prospect rows.

Route config:

```ts
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;
```

Request:

```json
{
  "limit": 5
}
```

Limit rules:

- Optional.
- Default `5`.
- Minimum `1`.
- Maximum `10`.
- Sequential processing only.

Supabase query:

- Table: `prospects`
- Rows where `enrichment_status` is null, `raw`, or `enrichment_failed`.
- Order: `created_at asc`.
- Limit: requested limit.

Per-prospect flow:

1. Mark row `enriching`.
2. Clear `enrichment_error`.
3. Increment `enrichment_attempts`.
4. Call OpenAI Responses API.
5. Require completed `web_search_call`.
6. Parse `response.output_text` as JSON.
7. Validate parsed JSON with zod.
8. Update prospect enrichment fields.
9. Set `enrichment_status = enriched`.
10. Set `enriched_at`.
11. On failure, set `enrichment_status = enrichment_failed`.
12. Continue to the next prospect even if one fails.

OpenAI model:

```txt
OPENAI_ENRICH_MODEL || gpt-5.4-mini
```

OpenAI tool config:

- Tool type: `web_search`.
- Search context size: `medium`.
- Tool choice: `required`.
- Include: `web_search_call.action.sources`.
- Approximate user location:
  - Country: `US`
  - City: prospect city
  - Region: prospect state
  - Timezone: `America/Chicago`

Structured output:

- Uses `text.format.type = json_schema`.
- Schema name: `club_hub_prospect_enrichment`.
- `strict = true`.
- Schema defined in `src/lib/openai/enrichment-schema.ts`.
- No markdown parsing.
- No commentary parsing.

OpenAI prompt:

- Defined in `src/lib/openai/enrichment-prompt.ts`.
- Requires web research.
- Forbids guessing.
- Forbids student/minor personal data.
- Forbids invented or pattern-guessed emails.
- Prioritizes official school sources.

Enrichment fields written:

```txt
school_type
grades_served
hs_enrollment
total_enrollment
student_life_url
clubs_activities_url
clubs_count_estimate
club_activity_signal
fit_score
personalization_angle
research_notes
source_urls
target_persona
contact_name
contact_title
contact_email
contact_phone
contact_source_url
contact_confidence
fields_not_found
raw_openai_json
contact_email_validation_status
enrichment_status
enriched_at
enrichment_error
```

Contact email validation status after enrichment:

- If `contact_email` exists: `public_source_unverified`
- If no `contact_email`: `unknown`

Success response:

```json
{
  "attempted": 5,
  "enriched": 4,
  "failed": 1,
  "message": "Enhanced 4 prospects. 1 failed.",
  "results": [
    {
      "id": "...",
      "school_name": "...",
      "status": "enriched"
    }
  ]
}
```

No work response:

```json
{
  "attempted": 0,
  "enriched": 0,
  "failed": 0,
  "message": "No unenriched prospects found.",
  "results": []
}
```

### 9.4 `POST /api/prospects/dedupe`

Purpose:

- Find conservative duplicate groups in `public.prospects`.
- Keep one canonical row.
- Merge missing useful data into the canonical row.
- Archive duplicates into `public.prospects_duplicates`.
- Delete duplicates from `public.prospects` only after archive succeeds.

Route config:

```ts
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
```

Request:

- No body required.

Supabase query:

- Table: `prospects`
- Select: `*`

Duplicate matching tiers:

1. Exact Google Place ID
   - Both rows have `google_place_id`.
   - IDs exactly match.
   - Reason: `same_google_place_id`
   - Confidence: `100`

2. Same normalized school name, city, and state
   - Normalized names exactly match.
   - Normalized cities exactly match.
   - Normalized states exactly match.
   - Reason: `same_school_city_state`
   - Confidence: `95`

3. Same website domain plus strong name match
   - Both rows have website domains.
   - Domains match.
   - Normalized states match.
   - Names are exact or token overlap is at least `0.85`.
   - If both rows have different street numbers, names must be exactly equal.
   - Reason: `same_domain_similar_name`
   - Confidence: `85`

4. Same phone plus strong name match
   - Normalized phones match.
   - Normalized states match.
   - Names are exact or token overlap is at least `0.85`.
   - If both rows have different street numbers, names must be exactly equal.
   - Reason: `same_phone_similar_name`
   - Confidence: `80`

Things intentionally not used by themselves:

- City only.
- State only.
- Contact name.
- Contact email.
- Address only.
- Website domain only.
- Phone only.
- Broad school network name only.

Grouping:

- Uses union-find.
- If A matches B and B matches C, all become one duplicate group.

Canonical scoring:

```txt
+50 enrichment_status = enriched
+25 contact_email exists
+20 contact_name exists
+15 contact_title exists
+15 hs_enrollment exists
+10 website exists
+10 main_phone exists
+10 clubs_activities_url exists
+10 student_life_url exists
+10 personalization_angle exists
+5 source_urls has values
```

Tie-breaker:

- Earliest `created_at` wins.

Canonical merge:

- Only fills blank canonical values.
- Does not overwrite populated canonical values.
- Merges scalar fields such as website, phone, enrollment, contact, validation, and enrichment fields.
- Merges arrays:
  - `source_urls`
  - `fields_not_found`
- Raw JSON fields are fill-blank-only:
  - `raw_google_json`
  - `raw_openai_json`
  - `bec_raw_json`

Archive row fields:

```txt
original_prospect_id
canonical_prospect_id
duplicate_reason
duplicate_confidence
duplicate_group_key
moved_to_duplicates_at
```

Archive behavior:

- Upsert into `prospects_duplicates` on `original_prospect_id`.
- If archive fails, do not delete anything.

Delete behavior:

- Delete duplicate IDs from `prospects`.
- Never delete canonical IDs.
- Delete happens only after archive insert/upsert succeeds.

Success response:

```json
{
  "total_checked": 120,
  "duplicate_groups_found": 8,
  "duplicates_moved": 14,
  "canonical_records_updated": 7,
  "active_prospects_remaining": 106,
  "message": "Moved 14 duplicates into prospects_duplicates. 106 active prospects remain."
}
```

No duplicate response:

```json
{
  "total_checked": 120,
  "duplicate_groups_found": 0,
  "duplicates_moved": 0,
  "canonical_records_updated": 0,
  "active_prospects_remaining": 120,
  "message": "No duplicates found."
}
```

### 9.5 `POST /api/prospects/validate-emails`

Purpose:

- Validate active prospect `contact_email` values with Bulk Email Checker.
- Keep valid, unknown, and error rows active.
- Archive invalid rows into `prospects_invalid_emails`.
- Delete invalid rows from `prospects` only after archive succeeds.

Route config:

```ts
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;
```

Request:

```json
{
  "limit": 50
}
```

Limit rules:

- Optional.
- Default `50`.
- Minimum `1`.
- Maximum `100`.
- Sequential processing only.
- 300 ms delay between requests.

Supabase query:

- Table: `prospects`
- Select: `*`
- `contact_email` is present.
- `email_validation_status` is null, `not_checked`, `public_source_unverified`, or `error`.
- Order: `created_at asc`.
- Limit: requested limit.

Additional row filtering:

- Skip rows already final:
  - `valid`
  - `unknown`
  - `invalid`
  - `skipped_no_email`
  - `checking`

Email extraction:

- Uses first email matching:

```txt
/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i
```

Bad values treated as no email:

```txt
unknown
n/a
na
none
null
undefined
-
invalid
```

Bulk Email Checker endpoint:

```txt
GET https://api.bulkemailchecker.com/real-time/?key={BEC_API_KEY}&email={encodedEmail}
```

Timeout:

```txt
15000 ms
```

Status mapping:

Bulk Email Checker `passed`:

```txt
email_validation_status = valid
contact_email_validation_status = Valid
email_validation_provider = bulk_email_checker
```

Bulk Email Checker `failed`:

- Archive row to `prospects_invalid_emails`.
- Delete original row only after archive succeeds.
- Archived row has:
  - `email_validation_status = invalid`
  - `contact_email_validation_status = Invalid`
  - BEC status/event/details/raw JSON fields.

Bulk Email Checker `unknown`:

```txt
email_validation_status = unknown
contact_email_validation_status = Unknown or Unknown - {event}
email_validation_provider = bulk_email_checker
```

HTTP, timeout, fetch, or JSON errors:

```txt
email_validation_status = error
contact_email_validation_status = Error
bec_status = error
bec_event = http_{code}, json_parse_error, timeout, or fetch_error
email_validation_error = short safe message
```

No usable email:

```txt
email_validation_status = skipped_no_email
contact_email_validation_status = Skipped - No Email
```

Response:

```json
{
  "checked": 40,
  "valid": 31,
  "invalid_moved": 5,
  "unknown": 3,
  "errors": 1,
  "skipped": 0,
  "message": "Checked 40 emails. Valid kept: 31. Invalid moved: 5. Unknown kept: 3. Errors kept: 1."
}
```

No work response:

```json
{
  "checked": 0,
  "valid": 0,
  "invalid_moved": 0,
  "unknown": 0,
  "errors": 0,
  "skipped": 0,
  "message": "No emails need validation."
}
```

## 10. External API Integrations

### 10.1 Google Places API New Text Search

Used only by:

```txt
src/app/api/prospects/google-search/route.ts
src/lib/googlePlaces.ts
```

Secret:

```txt
GOOGLE_MAPS_API_KEY
```

Never used client-side.

API:

```txt
POST https://places.googleapis.com/v1/places:searchText
```

Only first page is used. V1 does not implement pagination.

### 10.2 OpenAI Responses API

Used only by:

```txt
src/app/api/prospects/enrich/route.ts
src/lib/openai/enrichment-prompt.ts
src/lib/openai/enrichment-schema.ts
```

Secret:

```txt
OPENAI_API_KEY
```

Optional model override:

```txt
OPENAI_ENRICH_MODEL
```

Default model:

```txt
gpt-5.4-mini
```

The route uses:

- `openai.responses.create`
- `web_search`
- `tool_choice: required`
- strict structured outputs

### 10.3 Bulk Email Checker

Used only by:

```txt
src/app/api/prospects/validate-emails/route.ts
```

Secret:

```txt
BEC_API_KEY
```

API:

```txt
GET https://api.bulkemailchecker.com/real-time/
```

Query params:

```txt
key={BEC_API_KEY}
email={email}
```

Never used client-side.

## 11. Data Lifecycle

### 11.1 New Google prospect

```txt
Google Places -> map row -> prospects
```

Initial statuses:

```txt
enrichment_status = raw
email_validation_status = not_checked
```

### 11.2 Enriched prospect

```txt
prospects raw/failed/null -> OpenAI web search -> prospects enriched
```

Successful status:

```txt
enrichment_status = enriched
```

Failed status:

```txt
enrichment_status = enrichment_failed
```

### 11.3 Duplicate prospect

```txt
prospects duplicate -> prospects_duplicates archive -> delete duplicate from prospects
```

Canonical row remains in `prospects`.

### 11.4 Invalid email prospect

```txt
prospects invalid email -> prospects_invalid_emails archive -> delete invalid row from prospects
```

Valid, unknown, skipped, and error rows remain in `prospects`.

## 12. Error Handling Strategy

All routes return clean JSON errors. They do not expose secret values.

Common error shape:

```json
{
  "error": "Safe error message."
}
```

Examples:

- `Missing NEXT_PUBLIC_SUPABASE_URL`
- `Missing SUPABASE_SECRET_KEY`
- `Missing GOOGLE_MAPS_API_KEY`
- `Missing OPENAI_API_KEY`
- `Missing BEC_API_KEY`
- `Supabase select failure.`
- `Supabase query failure.`
- `Google Places API returned no places.`
- `OpenAI returned invalid JSON.`
- `Duplicate archive insert failure.`
- `Duplicate delete failure.`

Batch routes continue per row where appropriate:

- Enrichment continues if one prospect fails.
- Email validation continues if one email fails.

Archive routes fail closed:

- De-dupe does not delete duplicates unless archive succeeds.
- Email validation does not delete invalid email rows unless archive succeeds.

## 13. Security Model

Server-only secrets:

```txt
SUPABASE_SECRET_KEY
GOOGLE_MAPS_API_KEY
OPENAI_API_KEY
BEC_API_KEY
```

Client-safe variable:

```txt
NEXT_PUBLIC_SUPABASE_URL
```

Present but not currently used by client:

```txt
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
```

Security checks to run:

```bash
rg -n "BEC_API_KEY|SUPABASE_SECRET_KEY|GOOGLE_MAPS_API_KEY|OPENAI_API_KEY" src .env.example -g "!node_modules" -g "!.next" -g "!.env"
rg -n "BEC_API_KEY|SUPABASE_SECRET_KEY|GOOGLE_MAPS_API_KEY|OPENAI_API_KEY" src/app/page.tsx
```

Expected:

- Secrets appear in server route/helper files and `.env.example`.
- Secrets do not appear in `src/app/page.tsx`.

Never commit:

```txt
.env
.env.local
.env.*.local
```

These are ignored by `.gitignore`.

## 14. Deployment on Vercel

Recommended Vercel settings:

```txt
Framework Preset: Next.js
Root Directory: blank / repository root
Build Command: npm run build
Output Directory: blank/default
Install Command: npm install or default
Production Branch: main
```

Required Vercel environment variables:

```txt
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
SUPABASE_SECRET_KEY
GOOGLE_MAPS_API_KEY
OPENAI_API_KEY
OPENAI_ENRICH_MODEL
BEC_API_KEY
```

If Vercel shows a platform page like:

```txt
404: NOT_FOUND
```

Check:

1. The production deployment is from the finished app commit.
2. Production branch is `main`.
3. The latest `main` deployment is promoted to production.
4. Root Directory is not set to `src`.
5. Output Directory is not set to `out`.
6. The custom domain is assigned to the correct Vercel project.

The deployment commit that contains the full app includes:

```txt
src/app/api/prospects/google-search/route.ts
src/app/api/prospects/enrich/route.ts
src/app/api/prospects/dedupe/route.ts
src/app/api/prospects/validate-emails/route.ts
```

If production is a redeploy of an old starter commit, promote a fresh deployment from `main`.

## 15. Manual Test Plan

### 15.1 Google search

1. Open homepage.
2. Enter:

```txt
keyword: private high school
city: Chicago
state: IL
```

3. Click `Search`.
4. Confirm message:

```txt
{count} prospects saved from Google Places.
```

5. Confirm table reloads with raw rows.

### 15.2 Load recent

1. Click `Load Recent`.
2. Confirm latest 50 active prospects display.

### 15.3 OpenAI enrichment

1. Ensure at least one row has `enrichment_status = raw`, null, or `enrichment_failed`.
2. Click `Enhance Unenriched Prospects`.
3. Confirm rows change to `enriched` or `enrichment_failed`.
4. Confirm enrichment fields appear:
   - HS Enrollment
   - Clubs Estimate
   - Best Contact
   - Contact Email
   - Fit Score

### 15.4 De-dupe

1. Ensure duplicate rows exist in `prospects`.
2. Click `De-Dupe Prospects`.
3. Confirm summary message.
4. Confirm active table row count reloads.
5. Confirm duplicates were moved into `prospects_duplicates`.
6. Confirm canonical rows remain in `prospects`.

### 15.5 Email validation

1. Ensure at least one active row has `contact_email`.
2. Click `Validate Emails`.
3. Confirm summary message.
4. Confirm valid rows remain with `email_validation_status = valid`.
5. Confirm unknown rows remain with `email_validation_status = unknown`.
6. Confirm error rows remain with `email_validation_status = error`.
7. Confirm invalid rows move into `prospects_invalid_emails`.
8. Confirm invalid rows disappear from active table.

## 16. Troubleshooting

### 16.1 Missing Supabase URL

Symptom:

```txt
Missing NEXT_PUBLIC_SUPABASE_URL
```

Fix:

```env
NEXT_PUBLIC_SUPABASE_URL=https://your-project-ref.supabase.co
```

No quotes. No smart quotes. No spaces.

### 16.2 Supabase save/read failure

Common causes:

- Wrong `SUPABASE_SECRET_KEY`.
- Smart quotes around env var values.
- Missing table columns.
- RLS/policies blocking server key.
- Missing unique index for `google_place_id`.
- Wrong Supabase project URL.

### 16.3 Google Places failure

Common causes:

- Missing or malformed `GOOGLE_MAPS_API_KEY`.
- Places API New not enabled.
- API key restricted to the wrong API.
- Billing not enabled.
- Domain/referrer restriction used for a server-side key.

Recommended Google key restriction:

- Restrict to Places API.
- Do not use website referrer restriction for this server-side key.

### 16.4 OpenAI enrichment fails

Common causes:

- Missing `OPENAI_API_KEY`.
- Model unavailable to account.
- Web search not available for selected model.
- OpenAI returns invalid JSON.
- Response does not include completed web search call.
- Supabase row update fails due to missing enrichment columns.

### 16.5 Email validation fails

Common causes:

- Missing or malformed `BEC_API_KEY`.
- Bulk Email Checker returns non-2xx.
- Timeout.
- JSON parse error.
- Missing validation columns in Supabase.
- Invalid archive table missing expected columns.

### 16.6 Vercel 404

If production URL shows:

```txt
404: NOT_FOUND
```

Check Vercel deployment source:

- It must deploy the finished app commit.
- Production branch should be `main`.
- If the finished app is only a preview deployment, promote that deployment to production.

### 16.7 Dark Reader hydration warning

If browser console shows `data-darkreader-*` hydration mismatch, it is caused by the Dark Reader browser extension modifying the HTML. It is not an app error.

## 17. Development Rules and Boundaries

V1 does not include:

- Auth/login.
- CSV export.
- Instantly push.
- Background jobs.
- Cron.
- Queues.
- Multiple contacts per school.
- Separate contacts table.
- Manual review queue.
- Email drafting.
- Email validation beyond Bulk Email Checker.
- OpenAI batch API.
- Assistants API.
- Google Maps calls from enrichment, de-dupe, or email validation.

Do not add these unless V2 explicitly requires them.

## 18. Recommended Next Improvements

These are not implemented in V1:

1. Add admin auth before public use.
2. Add audit tables for every destructive move.
3. Add pagination to the homepage table.
4. Add a review screen for duplicates before moving them.
5. Add restore flows for duplicate and invalid-email archives.
6. Add rate limiting on mutation routes.
7. Add job queue for large enrichment and validation batches.
8. Add CSV export after data quality gates.
9. Add contact review before outbound automation.

## 19. Quick Route Reference

```txt
GET  /api/prospects/google-search
POST /api/prospects/google-search
POST /api/prospects/enrich
POST /api/prospects/dedupe
POST /api/prospects/validate-emails
```

## 20. Current Validation Status

The current app has been validated with:

```bash
npm run lint
npm run build
```

Both passed after the V1 route and UI implementation.

