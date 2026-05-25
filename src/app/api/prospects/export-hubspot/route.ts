import {
  buildHubspotCsv,
  type ProspectContactExportRecord,
  type ProspectExportRecord,
} from "@/lib/hubspot/buildHubspotCsv";
import {
  createSupabaseServerClient,
  MissingServerEnvError,
} from "@/lib/supabaseServer";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    const supabase = createSupabaseServerClient();
    const { data: prospectsData, error: prospectsError } = await supabase
      .from("prospects")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(10_000);

    if (prospectsError) {
      return jsonError("Supabase select failure.", 500);
    }

    const prospects = ((prospectsData ?? []) as ProspectExportRecord[]).filter(
      (prospect) => prospect.id,
    );

    if (prospects.length === 0) {
      return csvResponse(buildHubspotCsv([]));
    }

    const prospectIds = prospects.map((prospect) => prospect.id);
    const { data: contactsData, error: contactsError } = await supabase
      .from("prospect_contacts")
      .select("*")
      .in("prospect_id", prospectIds)
      .order("contact_rank", { ascending: true })
      .order("created_at", { ascending: true })
      .limit(10_000);

    if (contactsError) {
      return jsonError("Supabase contact select failure.", 500);
    }

    const contactsByProspectId = new Map<string, ProspectContactExportRecord[]>();

    for (const contact of (contactsData ?? []) as ProspectContactExportRecord[]) {
      const prospectId = String(contact.prospect_id ?? "");

      if (!prospectId) {
        continue;
      }

      contactsByProspectId.set(prospectId, [
        ...(contactsByProspectId.get(prospectId) ?? []),
        contact,
      ]);
    }

    const prospectsWithContacts = prospects.map((prospect) => ({
      ...prospect,
      prospect_contacts: contactsByProspectId.get(String(prospect.id)) ?? [],
    }));

    return csvResponse(buildHubspotCsv(prospectsWithContacts));
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
