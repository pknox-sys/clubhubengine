import type { SupabaseClient } from "@supabase/supabase-js";

import {
  normalizeEmail,
  normalizeEmailValidationStatus,
  normalizeDomain,
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
  highGrade?: string;
  companyDomain?: string;
  exportReadiness?: string;
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

type ProspectQueryError = {
  message: string;
  stage: "prospects" | "run memberships" | "contacts";
  detail?: string;
};

const SUPABASE_PAGE_SIZE = 1_000;
const SUPABASE_IN_CHUNK_SIZE = 100;
const CONTACT_QUERY_CONCURRENCY = 4;

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
  setStringFilter(filters, "highGrade", searchParams);
  setStringFilter(filters, "companyDomain", searchParams);
  setStringFilter(filters, "exportReadiness", searchParams);

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
  const { ids: candidateIds, error: candidateError } =
    await getCandidateProspectIds(supabase, filters);

  if (candidateError) {
    return { prospects: [] as ProspectRecord[], error: candidateError };
  }

  if (candidateIds && candidateIds.length === 0) {
    return { prospects: [] as ProspectRecord[], error: null };
  }

  const { prospects, error } = await loadProspectRows(supabase, candidateIds);

  if (error) {
    return { prospects: [] as ProspectRecord[], error };
  }

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
    return { ids: filters.prospectIds, error: null };
  }

  const runIds = Array.from(
    new Set([
      ...(filters.runIds ?? []),
      ...(filters.runId ? [filters.runId] : []),
    ]),
  );

  if (runIds.length === 0) {
    return { ids: null, error: null };
  }

  const rows: Array<{ prospect_id?: string | number | null }> = [];

  for (const runIdChunk of chunkArray(runIds, SUPABASE_IN_CHUNK_SIZE)) {
    const { data, error } = await fetchAllRows<{
      prospect_id?: string | number | null;
    }>((from, to) =>
      supabase
        .from("prospect_run_prospects")
        .select("prospect_id")
        .in("run_id", runIdChunk)
        .range(from, to),
    );

    if (error) {
      return {
        ids: [] as string[],
        error: {
          message: "Unable to load run memberships.",
          stage: "run memberships",
          detail: error.message,
        } satisfies ProspectQueryError,
      };
    }

    rows.push(...data);
  }

  return {
    ids: Array.from(
      new Set(
        rows
          .map((row) => row.prospect_id)
          .filter((id): id is string | number => id !== null && id !== undefined)
          .map((id) => String(id)),
      ),
    ),
    error: null,
  };
}

async function loadProspectRows(
  supabase: SupabaseClient,
  candidateIds: string[] | null,
) {
  if (!candidateIds) {
    const { data, error } = await fetchAllRows<ProspectRecord>((from, to) =>
      supabase
        .from("prospects")
        .select("*")
        .order("created_at", { ascending: false })
        .range(from, to),
    );

    return {
      prospects: data.filter((row) => row.id),
      error: error
        ? ({
            message: "Unable to load prospects.",
            stage: "prospects",
            detail: error.message,
          } satisfies ProspectQueryError)
        : null,
    };
  }

  const prospects: ProspectRecord[] = [];

  for (const idChunk of chunkArray(candidateIds, SUPABASE_IN_CHUNK_SIZE)) {
    const { data, error } = await fetchAllRows<ProspectRecord>((from, to) =>
      supabase
        .from("prospects")
        .select("*")
        .in("id", idChunk)
        .order("created_at", { ascending: false })
        .range(from, to),
    );

    if (error) {
      return {
        prospects: [] as ProspectRecord[],
        error: {
          message: "Unable to load prospects.",
          stage: "prospects",
          detail: error.message,
        } satisfies ProspectQueryError,
      };
    }

    prospects.push(...data.filter((row) => row.id));
  }

  const seenIds = new Set<string>();

  return {
    prospects: prospects.filter((prospect) => {
      const id = String(prospect.id);

      if (seenIds.has(id)) {
        return false;
      }

      seenIds.add(id);
      return true;
    }),
    error: null,
  };
}

async function loadContactsByProspectId(
  supabase: SupabaseClient,
  prospects: ProspectRecord[],
) {
  const contactsByProspectId = new Map<string, ProspectContactRecord[]>();

  if (prospects.length === 0) {
    return { contactsByProspectId, error: null };
  }

  const prospectIds = prospects.map((prospect) => String(prospect.id));

  for (const chunkBatch of chunkArray(
    chunkArray(prospectIds, SUPABASE_IN_CHUNK_SIZE),
    CONTACT_QUERY_CONCURRENCY,
  )) {
    const results = await Promise.all(
      chunkBatch.map((idChunk) => loadContactChunk(supabase, idChunk)),
    );

    for (const { data, error } of results) {
      if (error) {
        return {
          contactsByProspectId,
          error,
        };
      }

      for (const contact of data) {
        const prospectId = String(contact.prospect_id ?? "");

        if (!prospectId) {
          continue;
        }

        contactsByProspectId.set(prospectId, [
          ...(contactsByProspectId.get(prospectId) ?? []),
          contact,
        ]);
      }
    }
  }

  return { contactsByProspectId, error: null };
}

async function loadContactChunk(supabase: SupabaseClient, prospectIds: string[]) {
  const { data, error } = await fetchAllRows<ProspectContactRecord>((from, to) =>
    supabase
      .from("prospect_contacts")
      .select("*")
      .in("prospect_id", prospectIds)
      .order("contact_rank", { ascending: true })
      .order("created_at", { ascending: true })
      .range(from, to),
  );

  return {
    data,
    error: error
      ? ({
          message: "Unable to load prospect contacts.",
          stage: "contacts",
          detail: error.message,
        } satisfies ProspectQueryError)
      : null,
  };
}

async function fetchAllRows<T>(
  fetchPage: (
    from: number,
    to: number,
  ) => PromiseLike<{ data: unknown[] | null; error: { message?: string } | null }>,
) {
  const rows: T[] = [];

  for (let from = 0; ; from += SUPABASE_PAGE_SIZE) {
    const to = from + SUPABASE_PAGE_SIZE - 1;
    const { data, error } = await fetchPage(from, to);

    if (error) {
      return { data: [] as T[], error };
    }

    const page = (data ?? []) as T[];
    rows.push(...page);

    if (page.length < SUPABASE_PAGE_SIZE) {
      return { data: rows, error: null };
    }
  }
}

function chunkArray<T>(values: T[], size: number) {
  const chunks: T[][] = [];

  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }

  return chunks;
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

  if (
    filters.highGrade &&
    !doesHighGradeMatch(prospect.high_grade, filters.highGrade)
  ) {
    return false;
  }

  if (filters.companyDomain) {
    const hasDomain = Boolean(getProspectCompanyDomain(prospect));

    if (filters.companyDomain === "has" && !hasDomain) {
      return false;
    }

    if (filters.companyDomain === "missing" && hasDomain) {
      return false;
    }
  }

  if (filters.exportReadiness) {
    const isReady = isProspectExportReady(prospect);

    if (filters.exportReadiness === "ready" && !isReady) {
      return false;
    }

    if (filters.exportReadiness === "missing" && isReady) {
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

function isProspectExportReady(prospect: ProspectRecord) {
  return Boolean(
    stringValue(prospect.school_name) &&
      getProspectCompanyDomain(prospect) &&
      hasNonInvalidContactEmail(prospect),
  );
}

function getProspectCompanyDomain(prospect: ProspectRecord) {
  return normalizeDomain(
    prospect.company_domain_name,
    prospect.website,
    prospect.source_url,
  );
}

function hasNonInvalidContactEmail(prospect: ProspectRecord) {
  const contacts = prospect.prospect_contacts ?? [];

  if (contacts.length > 0) {
    return contacts.some(
      (contact) =>
        Boolean(normalizeEmail(contact.email)) &&
        normalizeEmailValidationStatus(contact.email_validation_status) !==
          "Invalid",
    );
  }

  return (
    Boolean(normalizeEmail(prospect.contact_email)) &&
    normalizeEmailValidationStatus(
      prospect.email_validation_status ||
        prospect.contact_email_validation_status,
    ) !== "Invalid"
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

function doesHighGradeMatch(value: unknown, filterValue: string) {
  const filterGrade = gradeNumberFromText(filterValue);
  const prospectGrade = gradeNumberFromText(value);

  if (filterGrade !== null) {
    return prospectGrade === filterGrade;
  }

  return normalizeText(value) === normalizeText(filterValue);
}

function gradeNumberFromText(value: unknown) {
  const normalized = stringValue(value).toLowerCase();
  const matches = normalized.match(/\d+/g);

  if (!matches) {
    return null;
  }

  const parsedGrades = matches
    .map((match) => Number.parseInt(match, 10))
    .filter((grade) => Number.isFinite(grade));

  if (parsedGrades.length === 0) {
    return null;
  }

  return Math.max(...parsedGrades);
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
    | "dataConfidence"
    | "highGrade"
    | "companyDomain"
    | "exportReadiness",
  searchParams: URLSearchParams,
) {
  const value = getParam(searchParams, key);

  if (value) {
    filters[key] = value;
  }
}
