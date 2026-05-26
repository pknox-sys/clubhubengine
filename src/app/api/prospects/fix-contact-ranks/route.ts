import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import {
  createSupabaseServerClient,
  MissingServerEnvError,
} from "@/lib/supabaseServer";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type ProspectContactRecord = Record<string, unknown> & {
  id: string | number;
  prospect_id?: string | number | null;
  first_name?: string | null;
  last_name?: string | null;
  email?: string | null;
  phone_number?: string | null;
  job_title?: string | null;
  contact_rank?: number | null;
  sequence_pick?: boolean | null;
  contact_source_url?: string | null;
  email_validation_status?: string | null;
  created_at?: string | null;
};

const requestSchema = z.object({
  prospectIds: z.array(z.union([z.string(), z.number()])).optional(),
});

export async function POST(request: Request) {
  try {
    const parsedBody = requestSchema.safeParse(
      await request.json().catch(() => ({})),
    );

    if (!parsedBody.success) {
      return jsonError("Invalid request body.", 400);
    }

    const prospectIds = uniqueStrings(
      (parsedBody.data.prospectIds ?? []).map((id) => String(id)),
    );
    const supabase = createSupabaseServerClient();
    const result = await fixContactRanks(supabase, prospectIds);

    return Response.json({
      ...result,
      message: `Checked ${result.checked} prospects. Fixed ${result.fixed}. Skipped ${result.skipped_no_valid_email} without a valid contact email.`,
    });
  } catch (error) {
    if (error instanceof MissingServerEnvError) {
      return jsonError(`Missing ${error.envName}`, 500);
    }

    return jsonError("Unexpected server error.", 500);
  }
}

async function fixContactRanks(
  supabase: SupabaseClient,
  prospectIds: string[],
) {
  const { data, error } = await loadContacts(supabase, prospectIds);

  if (error) {
    return {
      checked: 0,
      fixed: 0,
      skipped_no_valid_email: 0,
      errors: ["Unable to load contacts."],
    };
  }

  const contactsByProspectId = new Map<string, ProspectContactRecord[]>();

  for (const contact of (data ?? []) as ProspectContactRecord[]) {
    const prospectId = String(contact.prospect_id ?? "");

    if (!prospectId) {
      continue;
    }

    contactsByProspectId.set(prospectId, [
      ...(contactsByProspectId.get(prospectId) ?? []),
      contact,
    ]);
  }

  let fixed = 0;
  let skippedNoValidEmail = 0;
  const errors: string[] = [];

  for (const [prospectId, contacts] of contactsByProspectId) {
    const sortedContacts = sortByCurrentRank(contacts);
    const validContact = sortedContacts.find(
      (contact) =>
        normalizeStatus(contact.email_validation_status) === "valid" &&
        Boolean(extractEmail(contact.email)),
    );

    if (!validContact) {
      skippedNoValidEmail += 1;
      continue;
    }

    const reorderedContacts = [
      validContact,
      ...sortedContacts.filter((contact) => contact.id !== validContact.id),
    ];
    let changed = false;

    for (const [index, contact] of reorderedContacts.entries()) {
      const nextRank = index + 1;
      const nextSequencePick = index === 0;

      if (
        numberValue(contact.contact_rank) === nextRank &&
        Boolean(contact.sequence_pick) === nextSequencePick
      ) {
        continue;
      }

      const { error: updateError } = await supabase
        .from("prospect_contacts")
        .update({
          contact_rank: nextRank,
          sequence_pick: nextSequencePick,
        })
        .eq("id", contact.id);

      if (updateError) {
        errors.push(`Unable to update contact ${contact.id}.`);
        continue;
      }

      changed = true;
    }

    const { error: prospectUpdateError } = await supabase
      .from("prospects")
      .update({
        contact_name: getContactName(validContact) || null,
        contact_title: stringValue(validContact.job_title) || null,
        contact_email: extractEmail(validContact.email) || null,
        contact_phone: stringValue(validContact.phone_number) || null,
        contact_source_url: stringValue(validContact.contact_source_url) || null,
        contact_email_validation_status: "Valid",
        email_validation_status: "Valid",
      })
      .eq("id", prospectId);

    if (prospectUpdateError) {
      errors.push(`Unable to update best contact for prospect ${prospectId}.`);
      continue;
    }

    if (changed) {
      fixed += 1;
    }
  }

  return {
    checked: contactsByProspectId.size,
    fixed,
    skipped_no_valid_email: skippedNoValidEmail,
    errors,
  };
}

async function loadContacts(
  supabase: SupabaseClient,
  prospectIds: string[],
) {
  let query = supabase
    .from("prospect_contacts")
    .select("*")
    .order("contact_rank", { ascending: true })
    .order("created_at", { ascending: true });

  if (prospectIds.length > 0) {
    query = query.in("prospect_id", prospectIds);
  }

  return query.limit(10_000);
}

function sortByCurrentRank(contacts: ProspectContactRecord[]) {
  return [...contacts].sort((left, right) => {
    const rankDifference =
      contactRankValue(left.contact_rank) - contactRankValue(right.contact_rank);

    if (rankDifference !== 0) {
      return rankDifference;
    }

    return stringValue(left.created_at).localeCompare(stringValue(right.created_at));
  });
}

function getContactName(contact: ProspectContactRecord) {
  return [contact.first_name, contact.last_name]
    .map((value) => stringValue(value))
    .filter(Boolean)
    .join(" ");
}

function extractEmail(value: unknown) {
  const raw = stringValue(value).trim();

  return (
    raw.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0].toLowerCase() ?? ""
  );
}

function normalizeStatus(value: unknown) {
  return stringValue(value).toLowerCase();
}

function contactRankValue(value: unknown) {
  const rank = numberValue(value);

  return rank && rank > 0 ? rank : Number.MAX_SAFE_INTEGER;
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringValue(value: unknown) {
  if (typeof value === "string") {
    return value.trim();
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }

  return "";
}

function uniqueStrings(values: string[]) {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function jsonError(message: string, status: number) {
  return Response.json({ error: message }, { status });
}
