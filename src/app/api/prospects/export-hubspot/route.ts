import { buildHubspotCsv } from "@/lib/hubspot/buildHubspotCsv";
import {
  loadProspectsForFilters,
  parseProspectFilters,
  type ProspectFilters,
} from "@/lib/prospects/prospectQuery";
import {
  createSupabaseServerClient,
  MissingServerEnvError,
} from "@/lib/supabaseServer";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const supabase = createSupabaseServerClient();
    const filters = parseProspectFilters(new URL(request.url).searchParams);
    const { prospects, error } = await loadProspectsForFilters(
      supabase,
      filters,
      { narrowContacts: true },
    );

    if (error) {
      return jsonError(getLoadErrorMessage(error), 500);
    }

    return csvResponse(buildHubspotCsv(prospects, { includeBlockedRows: true }));
  } catch (error) {
    if (error instanceof MissingServerEnvError) {
      return jsonError(`Missing ${error.envName}`, 500);
    }

    return jsonError("Unexpected server error.", 500);
  }
}

export async function POST(request: Request) {
  try {
    const supabase = createSupabaseServerClient();
    const body = (await request.json().catch(() => null)) as
      | Record<string, unknown>
      | null;
    const filters = parsePostFilters(body);
    const { prospects, error } = await loadProspectsForFilters(
      supabase,
      filters,
      { narrowContacts: true },
    );

    if (error) {
      return jsonError(getLoadErrorMessage(error), 500);
    }

    return csvResponse(buildHubspotCsv(prospects, { includeBlockedRows: true }));
  } catch (error) {
    if (error instanceof MissingServerEnvError) {
      return jsonError(`Missing ${error.envName}`, 500);
    }

    return jsonError("Unexpected server error.", 500);
  }
}

function parsePostFilters(body: Record<string, unknown> | null): ProspectFilters {
  const filters = toRecord(body?.filters);
  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(filters)) {
    if (typeof value === "string" && value.trim()) {
      params.set(key, value.trim());
    } else if (typeof value === "number" && Number.isFinite(value)) {
      params.set(key, String(value));
    } else if (typeof value === "boolean") {
      params.set(key, String(value));
    }
  }

  setArrayParam(params, "prospectIds", body?.prospectIds);
  setArrayParam(params, "runIds", body?.runIds);

  if (typeof body?.runId === "string" && body.runId.trim()) {
    params.set("runId", body.runId.trim());
  }

  return parseProspectFilters(params);
}

function setArrayParam(params: URLSearchParams, key: string, value: unknown) {
  if (!Array.isArray(value)) {
    return;
  }

  const values = value
    .map((item) => String(item).trim())
    .filter(Boolean);

  if (values.length > 0) {
    params.set(key, values.join(","));
  }
}

function toRecord(value: unknown) {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function csvResponse(csv: string) {
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition":
        'attachment; filename="club-hub-hubspot-upload.csv"',
    },
  });
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
