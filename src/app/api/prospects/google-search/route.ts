import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import {
  GooglePlacesError,
  mapGooglePlaceToProspect,
  searchGooglePlaces,
} from "@/lib/googlePlaces";
import {
  createSupabaseServerClient,
  MissingServerEnvError,
} from "@/lib/supabaseServer";
import {
  getDisplayProspect,
  loadProspectsForFilters,
  parseProspectFilters,
} from "@/lib/prospects/prospectQuery";
import type { ProspectInsertRow, ProspectListItem } from "@/types/prospect";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

const PROSPECT_SELECT_FIELDS = `
  id,
  created_at,
  search_keyword,
  search_city,
  search_state,
  google_place_id,
  google_maps_url,
  school_name,
  website,
  main_phone,
  full_address,
  city,
  state,
  school_type,
  hs_enrollment,
  clubs_count_estimate,
  target_persona,
  contact_name,
  contact_title,
  contact_email,
  fit_score,
  enrichment_error,
  email_validation_error,
  enriched_at,
  enrichment_status,
  contact_email_validation_status,
  email_validation_status,
  dedupe_key
`;

const searchSchema = z.object({
  keyword: z.string().trim().min(2, "Keyword must be at least 2 characters."),
  city: z.string().trim().min(2, "City must be at least 2 characters."),
  state: z.string().trim().min(2, "State must be at least 2 characters."),
});

export async function GET(request: Request) {
  try {
    const supabase = createSupabaseServerClient();
    const filters = parseProspectFilters(new URL(request.url).searchParams);
    const { prospects, error } = await loadProspectsForFilters(supabase, filters);

    if (error) {
      return jsonError(getLoadErrorMessage(error), 500);
    }

    return Response.json({
      prospects: prospects.map(getDisplayProspect),
    });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => null);
    const parsed = searchSchema.safeParse(body);

    if (!parsed.success) {
      const message = parsed.error.issues[0]?.message ?? "Invalid request body.";
      return jsonError(message, 400);
    }

    const keyword = parsed.data.keyword.trim();
    const city = parsed.data.city.trim();
    const trimmedState = parsed.data.state.trim();
    const state =
      trimmedState.length <= 3 ? trimmedState.toUpperCase() : trimmedState;
    const textQuery = `${keyword} ${city} ${state}`;
    const supabase = createSupabaseServerClient();
    const run = await createProspectRun(supabase, { keyword, city, state });
    const googleResponse = await searchGooglePlaces(textQuery);
    const places = googleResponse.places ?? [];

    if (places.length === 0) {
      await updateProspectRunCounts(supabase, run.id, 0, 0);
      return jsonError("Google Places API returned no places.", 404);
    }

    const rows = places.map((place) =>
      mapGooglePlaceToProspect(place, { keyword, city, state }),
    );
    const prospects = await saveProspects(supabase, rows);
    await linkProspectsToRun(supabase, run.id, prospects);
    await updateProspectRunCounts(supabase, run.id, places.length, prospects.length);

    return Response.json({
      count: prospects.length,
      run_id: run.id,
      run_name: run.name,
      prospects,
    });
  } catch (error) {
    return handleRouteError(error);
  }
}

async function createProspectRun(
  supabase: SupabaseClient,
  values: { keyword: string; city: string; state: string },
) {
  const name = `${values.city} — ${values.keyword} — ${formatRunTimestamp(new Date())}`;
  const { data, error } = await supabase
    .from("prospect_runs")
    .insert({
      name,
      keyword: values.keyword,
      city: values.city,
      state: values.state,
      status: "running",
    })
    .select("id, name")
    .single();

  if (error || !data) {
    throw new Error("Supabase run save failure.");
  }

  return data as { id: string; name: string };
}

async function updateProspectRunCounts(
  supabase: SupabaseClient,
  runId: string,
  resultCount: number,
  savedCount: number,
) {
  const { error } = await supabase
    .from("prospect_runs")
    .update({
      result_count: resultCount,
      saved_count: savedCount,
      status: "completed",
    })
    .eq("id", runId);

  if (error) {
    throw new Error("Supabase run save failure.");
  }
}

async function linkProspectsToRun(
  supabase: SupabaseClient,
  runId: string,
  prospects: ProspectListItem[],
) {
  if (prospects.length === 0) {
    return;
  }

  const rows = prospects.map((prospect) => ({
    run_id: runId,
    prospect_id: prospect.id,
    google_place_id: prospect.google_place_id,
  }));
  const { error } = await supabase
    .from("prospect_run_prospects")
    .upsert(rows, { onConflict: "run_id,prospect_id" });

  if (error) {
    throw new Error("Supabase run save failure.");
  }
}

async function saveProspects(
  supabase: SupabaseClient,
  rows: ProspectInsertRow[],
): Promise<ProspectListItem[]> {
  // Production should have a unique index on prospects.google_place_id for the
  // preferred upsert path to dedupe duplicate Google results efficiently.
  const { data, error } = await supabase
    .from("prospects")
    .upsert(rows, {
      onConflict: "google_place_id",
      ignoreDuplicates: false,
    })
    .select(PROSPECT_SELECT_FIELDS);

  if (!error) {
    return (data ?? []) as ProspectListItem[];
  }

  if (isMissingUniqueConstraintError(error)) {
    return saveProspectsWithManualDedupe(supabase, rows);
  }

  throw new Error("Supabase save failure.");
}

async function saveProspectsWithManualDedupe(
  supabase: SupabaseClient,
  rows: ProspectInsertRow[],
): Promise<ProspectListItem[]> {
  const saved: ProspectListItem[] = [];

  for (const row of rows) {
    const lookupColumn = row.google_place_id ? "google_place_id" : "dedupe_key";
    const lookupValue = row.google_place_id ?? row.dedupe_key;
    const { data: existing, error: selectError } = await supabase
      .from("prospects")
      .select("id")
      .eq(lookupColumn, lookupValue)
      .limit(1)
      .maybeSingle();

    if (selectError) {
      throw new Error("Supabase save failure.");
    }

    const result = existing
      ? await supabase
          .from("prospects")
          .update(row)
          .eq("id", existing.id)
          .select(PROSPECT_SELECT_FIELDS)
          .single()
      : await supabase
          .from("prospects")
          .insert(row)
          .select(PROSPECT_SELECT_FIELDS)
          .single();

    if (result.error) {
      throw new Error("Supabase save failure.");
    }

    if (result.data) {
      saved.push(result.data as ProspectListItem);
    }
  }

  return saved;
}

function isMissingUniqueConstraintError(error: { code?: string; message?: string }) {
  const message = error.message?.toLowerCase() ?? "";

  return (
    error.code === "42P10" ||
    message.includes("no unique or exclusion constraint") ||
    message.includes("there is no unique or exclusion constraint")
  );
}

function handleRouteError(error: unknown) {
  if (error instanceof MissingServerEnvError) {
    return jsonError(`Missing ${error.envName}`, 500);
  }

  if (error instanceof GooglePlacesError) {
    const status = error.message.includes("Missing GOOGLE_MAPS_API_KEY")
      ? 500
      : error.status && error.status >= 400 && error.status < 500
        ? 502
        : 500;

    return jsonError(error.message, status);
  }

  if (error instanceof Error && error.message === "Supabase save failure.") {
    return jsonError("Supabase save failure.", 500);
  }

  if (error instanceof Error && error.message === "Supabase run save failure.") {
    return jsonError("Supabase run save failure.", 500);
  }

  return jsonError("Unexpected server error.", 500);
}

function jsonError(message: string, status: number) {
  return Response.json({ error: message }, { status });
}

function getLoadErrorMessage(error: unknown) {
  const stage =
    typeof error === "object" && error && "stage" in error
      ? String((error as { stage?: unknown }).stage)
      : "prospects";

  return `Supabase read failure while loading ${stage}.`;
}

function formatRunTimestamp(date: Date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })
    .formatToParts(date)
    .reduce<Record<string, string>>((accumulator, part) => {
      accumulator[part.type] = part.value;
      return accumulator;
    }, {});

  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}
