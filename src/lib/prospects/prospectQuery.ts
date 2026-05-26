import type { SupabaseClient } from "@supabase/supabase-js";

import {
  normalizeEmail,
  normalizeEmailValidationStatus,
  stringValue,
} from "@/lib/hubspot/normalizers";

export type ProspectFilters = {
  runId?: string;
  runIds?: string[];
  prospectIds?: string[];
  city?: string;
  state?: string;
  schoolType?: string;
  enrichmentStatus?: string;
  emailValidationStatus?: string;
  sequencePick?: boolean;
  contactRank?: number;
  dataConfidence?: string;
  hasEmail?: boolean;
  minStudents?: number;
};

export type ProspectRecord = Record<string, unknown> & {
  id: string | number;
  prospect_contacts?: ProspectContactRecord[];
};

export type ProspectContactRecord = Record<string, unknown> & {
  id?: string | number | null;
  prospect_id?: string | number | null;
};

type LoadOptions = {
  limit?: number;
  narrowContacts?: boolean;
};

export function parseProspectFilters(searchParams: URLSearchParams) {
  const filters: ProspectFilters = {};
  const runId = getParam(searchParams, "runId");
  const runIds = getParam(searchParams, "runIds")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  const prospectIds = getParam(searchParams, "prospectIds")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);

  if (runId) filters.runId = runId;
  if (runIds.length > 0) filters.runIds = runIds;
  if (prospectIds.length > 0) filters.prospectIds = prospectIds;
  setStringFilter(filters, "city", searchParams);
  setStringFilter(filters, "state", searchParams);
  setStringFilter(filters, "schoolType", searchParams);
  setStringFilter(filters, "enrichmentStatus", searchParams);
  setStringFilter(filters, "emailValidationStatus", searchParams);
  setStringFilter(filters, "dataConfidence", searchParams);

  const sequencePick = getParam(searchParams, "sequencePick");

  if (sequencePick === "true" || sequencePick === "false") {
    filters.sequencePick = sequencePick === "true";
  }

  const hasEmail = getParam(searchParams, "hasEmail");

  if (hasEmail === "true" || hasEmail === "false") {
    filters.hasEmail = hasEmail === "true";
  }

  const contactRank = Number.parseInt(getParam(searchParams, "contactRank"), 10);

  if (Number.isFinite(contactRank) && contactRank > 0) {
    filters.contactRank = contactRank;
  }

  const minStudents = Number.parseInt(getParam(searchParams, "minStudents"), 10);

  if (Number.isFinite(minStudents) && minStudents > 0) {
    filters.minStudents = minStudents;
  }

  return filters;
}

export async function loadProspectsForFilters(
  supabase: SupabaseClient,
  filters: ProspectFilters,
  options: LoadOptions = {},
) {
  const candidateIds = await getCandidateProspectIds(supabase, filters);

  if (candidateIds && candidateIds.length === 0) {
    return { prospects: [] as ProspectRecord[], error: null };
  }

  let query = supabase
    .from("prospects")
    .select("*")
    .order("created_at", { ascending: false });

  if (candidateIds) {
    query = query.in("id", candidateIds);
  }

  const { data, error } = await query.limit(10_000);

  if (error) {
    return { prospects: [] as ProspectRecord[], error };
  }

  const prospects = ((data ?? []) as ProspectRecord[]).filter((row) => row.id);
  const { contactsByProspectId, error: contactsError } =
    await loadContactsByProspectId(supabase, prospects);

  if (contactsError) {
    return { prospects: [] as ProspectRecord[], error: contactsError };
  }

  const filteredProspects = prospects
    .map((prospect) =>
      attachContacts(prospect, contactsByProspectId, filters, options.narrowContacts),
    )
    .filter((prospect) => doesProspectMatchFilters(prospect, filters));

  return {
    prospects:
      typeof options.limit === "number"
        ? filteredProspects.slice(0, options.limit)
        : filteredProspects,
    error: null,
  };
}

export function getDisplayProspect(prospect: ProspectRecord) {
  const contacts = getSortedContacts(prospect.prospect_contacts ?? []);
  const bestContact = getBestContact(contacts);
  const contactName = bestContact
    ? [stringValue(bestContact.first_name), stringValue(bestContact.last_name)]
        .filter(Boolean)
        .join(" ")
    : "";

  return {
    ...prospect,
    prospect_contacts: contacts,
    best_contact_id: bestContact?.id ?? null,
    best_contact_first_name: bestContact?.first_name ?? null,
    best_contact_last_name: bestContact?.last_name ?? null,
    best_contact_name: contactName || prospect.contact_name || null,
    best_contact_email: bestContact?.email ?? prospect.contact_email ?? null,
    best_contact_title: bestContact?.job_title ?? prospect.contact_title ?? null,
    best_contact_phone:
      bestContact?.phone_number ?? prospect.contact_phone ?? null,
    best_contact_rank: bestContact?.contact_rank ?? null,
    best_contact_sequence_pick: bestContact?.sequence_pick ?? null,
    best_contact_email_validation_status:
      bestContact?.email_validation_status ??
      prospect.contact_email_validation_status ??
      prospect.email_validation_status ??
      null,
    best_contact_reason: bestContact?.best_contact_reason ?? null,
    best_contact_confidence: bestContact?.contact_confidence ?? null,
    best_contact_notes: bestContact?.notes ?? null,
    contact_count: contacts.length,
    contact_name: contactName || prospect.contact_name,
    contact_title: bestContact?.job_title ?? prospect.contact_title,
    contact_email: bestContact?.email ?? prospect.contact_email,
    contact_phone: bestContact?.phone_number ?? prospect.contact_phone,
    contact_source_url: bestContact?.contact_source_url ?? prospect.contact_source_url,
    contact_confidence:
      bestContact?.contact_confidence ?? prospect.contact_confidence,
    contact_email_validation_status:
      bestContact?.email_validation_status ??
      prospect.contact_email_validation_status,
  };
}

function attachContacts(
  prospect: ProspectRecord,
  contactsByProspectId: Map<string, ProspectContactRecord[]>,
  filters: ProspectFilters,
  narrowContacts = false,
) {
  const contacts = getSortedContacts(
    contactsByProspectId.get(String(prospect.id)) ?? [],
  );
  const shouldNarrowContacts =
    narrowContacts && hasContactSpecificFilter(filters);

  return {
    ...prospect,
    prospect_contacts: shouldNarrowContacts
      ? contacts.filter((contact) => doesContactMatchFilters(contact, filters))
      : contacts,
  };
}

async function getCandidateProspectIds(
  supabase: SupabaseClient,
  filters: ProspectFilters,
) {
  if (filters.prospectIds && filters.prospectIds.length > 0) {
    return filters.prospectIds;
  }

  const runIds = Array.from(
    new Set([
      ...(filters.runIds ?? []),
      ...(filters.runId ? [filters.runId] : []),
    ]),
  );

  if (runIds.length === 0) {
    return null;
  }

  const { data, error } = await supabase
    .from("prospect_run_prospects")
    .select("prospect_id")
    .in("run_id", runIds)
    .limit(10_000);

  if (error) {
    return [];
  }

  return (data ?? [])
    .map((row: { prospect_id?: string | number | null }) => row.prospect_id)
    .filter((id): id is string | number => id !== null && id !== undefined)
    .map((id) => String(id));
}

async function loadContactsByProspectId(
  supabase: SupabaseClient,
  prospects: ProspectRecord[],
) {
  const contactsByProspectId = new Map<string, ProspectContactRecord[]>();

  if (prospects.length === 0) {
    return { contactsByProspectId, error: null };
  }

  const prospectIds = prospects.map((prospect) => prospect.id);
  const { data, error } = await supabase
    .from("prospect_contacts")
    .select("*")
    .in("prospect_id", prospectIds)
    .order("contact_rank", { ascending: true })
    .order("created_at", { ascending: true })
    .limit(10_000);

  if (error) {
    return { contactsByProspectId, error };
  }

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

  return { contactsByProspectId, error: null };
}

function doesProspectMatchFilters(
  prospect: ProspectRecord,
  filters: ProspectFilters,
) {
  if (filters.city && normalizeText(prospect.city) !== normalizeText(filters.city)) {
    return false;
  }

  if (filters.state && normalizeText(prospect.state) !== normalizeText(filters.state)) {
    return false;
  }

  if (
    filters.schoolType &&
    normalizeText(prospect.school_type) !== normalizeText(filters.schoolType)
  ) {
    return false;
  }

  if (
    filters.enrichmentStatus &&
    normalizeText(prospect.enrichment_status) !==
      normalizeText(filters.enrichmentStatus)
  ) {
    return false;
  }

  if (
    filters.dataConfidence &&
    normalizeText(prospect.data_confidence) !== normalizeText(filters.dataConfidence)
  ) {
    return false;
  }

  if (filters.hasEmail !== undefined) {
    const hasEmail = hasUsableProspectEmail(prospect);

    if (hasEmail !== filters.hasEmail) {
      return false;
    }
  }

  if (filters.minStudents !== undefined) {
    const studentCount = getProspectStudentCount(prospect);

    if (studentCount === null || studentCount < filters.minStudents) {
      return false;
    }
  }

  if (!hasContactSpecificFilter(filters)) {
    return true;
  }

  const contacts = prospect.prospect_contacts ?? [];

  if (contacts.some((contact) => doesContactMatchFilters(contact, filters))) {
    return true;
  }

  if (contacts.length > 0) {
    return false;
  }

  return doesLegacyContactMatchFilters(prospect, filters);
}

function doesContactMatchFilters(
  contact: ProspectContactRecord,
  filters: ProspectFilters,
) {
  if (
    filters.emailValidationStatus &&
    normalizeEmailValidationStatus(contact.email_validation_status) !==
      filters.emailValidationStatus
  ) {
    return false;
  }

  if (
    filters.sequencePick !== undefined &&
    Boolean(contact.sequence_pick) !== filters.sequencePick
  ) {
    return false;
  }

  if (
    filters.contactRank !== undefined &&
    numberValue(contact.contact_rank) !== filters.contactRank
  ) {
    return false;
  }

  if (filters.hasEmail !== undefined) {
    const hasEmail = Boolean(normalizeEmail(contact.email));

    if (hasEmail !== filters.hasEmail) {
      return false;
    }
  }

  return true;
}

function doesLegacyContactMatchFilters(
  prospect: ProspectRecord,
  filters: ProspectFilters,
) {
  if (
    filters.emailValidationStatus &&
    normalizeEmailValidationStatus(
      prospect.email_validation_status ||
        prospect.contact_email_validation_status,
    ) !== filters.emailValidationStatus
  ) {
    return false;
  }

  if (filters.sequencePick !== undefined || filters.contactRank !== undefined) {
    return false;
  }

  if (filters.hasEmail !== undefined) {
    return Boolean(normalizeEmail(prospect.contact_email)) === filters.hasEmail;
  }

  return Boolean(filters.emailValidationStatus);
}

function hasContactSpecificFilter(filters: ProspectFilters) {
  return Boolean(
    filters.emailValidationStatus ||
      filters.sequencePick !== undefined ||
      filters.contactRank !== undefined,
  );
}

function hasUsableProspectEmail(prospect: ProspectRecord) {
  const contacts = prospect.prospect_contacts ?? [];

  return (
    contacts.some((contact) => normalizeEmail(contact.email)) ||
    Boolean(normalizeEmail(prospect.contact_email))
  );
}

function getProspectStudentCount(prospect: ProspectRecord) {
  return (
    numberFromLooseText(prospect.number_of_students) ??
    numberFromLooseText(prospect.hs_enrollment) ??
    numberFromLooseText(prospect.total_enrollment)
  );
}

function numberFromLooseText(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  const normalized = stringValue(value).replace(/[^0-9.]+/g, "");

  if (!normalized) {
    return null;
  }

  const parsed = Number.parseFloat(normalized);

  return Number.isFinite(parsed) ? parsed : null;
}

function getSortedContacts(contacts: ProspectContactRecord[]) {
  return [...contacts].sort((left, right) => {
    const rankDifference = numberValue(left.contact_rank) - numberValue(right.contact_rank);

    if (rankDifference !== 0) {
      return rankDifference;
    }

    return stringValue(left.created_at).localeCompare(stringValue(right.created_at));
  });
}

function getBestContact(contacts: ProspectContactRecord[]) {
  const sequencePick = contacts.find((contact) => contact.sequence_pick === true);

  return sequencePick ?? contacts[0] ?? null;
}

function normalizeText(value: unknown) {
  return stringValue(value).toLowerCase().trim();
}

function numberValue(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  const parsed = Number.parseInt(stringValue(value), 10);

  return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
}

function getParam(searchParams: URLSearchParams, key: string) {
  return searchParams.get(key)?.trim() ?? "";
}

function setStringFilter(
  filters: ProspectFilters,
  key:
    | "city"
    | "state"
    | "schoolType"
    | "enrichmentStatus"
    | "emailValidationStatus"
    | "dataConfidence",
  searchParams: URLSearchParams,
) {
  const value = getParam(searchParams, key);

  if (value) {
    filters[key] = value;
  }
}
