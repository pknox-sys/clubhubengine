import { buildHubspotCsv } from "@/lib/hubspot/buildHubspotCsv";
import {
  loadProspectsForFilters,
  parseProspectFilters,
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
      return jsonError("Supabase select failure.", 500);
    }

    return csvResponse(buildHubspotCsv(prospects));
  } catch (error) {
    if (error instanceof MissingServerEnvError) {
      return jsonError(`Missing ${error.envName}`, 500);
    }

    return jsonError("Unexpected server error.", 500);
  }
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
