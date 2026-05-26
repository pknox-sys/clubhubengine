import {
  createSupabaseServerClient,
  MissingServerEnvError,
} from "@/lib/supabaseServer";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const RUN_SELECT_FIELDS = `
  id,
  name,
  keyword,
  city,
  state,
  result_count,
  saved_count,
  status,
  created_at
`;

export async function GET() {
  try {
    const supabase = createSupabaseServerClient();
    const { data, error } = await supabase
      .from("prospect_runs")
      .select(RUN_SELECT_FIELDS)
      .order("created_at", { ascending: false })
      .limit(100);

    if (error) {
      return jsonError("Supabase run select failure.", 500);
    }

    return Response.json({ runs: data ?? [] });
  } catch (error) {
    if (error instanceof MissingServerEnvError) {
      return jsonError(`Missing ${error.envName}`, 500);
    }

    return jsonError("Unexpected server error.", 500);
  }
}

function jsonError(message: string, status: number) {
  return Response.json({ error: message }, { status });
}
