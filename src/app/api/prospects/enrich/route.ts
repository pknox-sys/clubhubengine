import type { SupabaseClient } from "@supabase/supabase-js";
import OpenAI from "openai";
import type { ResponseCreateParamsNonStreaming } from "openai/resources/responses/responses";
import { z } from "zod";

import {
  normalizeDomain,
  normalizeEmail,
  normalizeEmployeeRange,
  normalizeNumber,
  normalizeReligion,
  normalizeSchoolDivisions,
  normalizeSchoolStructureBoyGirl,
  normalizeSchoolType,
} from "@/lib/hubspot/normalizers";
import { ENRICHMENT_SYSTEM_PROMPT } from "@/lib/openai/enrichment-prompt";
import {
  enrichmentResultSchema,
  enrichmentSchema,
  type EnrichmentContact,
  type EnrichmentResult,
} from "@/lib/openai/enrichment-schema";
import { REFERENCE_SCHOOLS } from "@/lib/openai/reference-schools";
import {
  createSupabaseServerClient,
  MissingServerEnvError,
} from "@/lib/supabaseServer";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

const MODEL = process.env.OPENAI_ENRICH_MODEL || "gpt-5.4-mini";
const DEFAULT_CONTACT_OWNER = "Paul Knox";
const DEFAULT_COMPANY_OWNER = "Paul Knox";
const DEFAULT_LEAD_STATUS = "New";
const DEFAULT_RECORD_SOURCE = "Import";
const DEFAULT_INDUSTRY = "Education Management";
const DEFAULT_SEQUENCE_NAME = "Club Hub - V1 School Outreach";
const PATTERN_INFERRED_NOTE =
  "Email pattern inferred from public staff emails; needs validation.";
const EMAIL_NOT_FOUND_NOTE =
  "Email not found; use school main phone or validate pattern manually.";
const CONSUMER_EMAIL_EXCLUDED_NOTE =
  "Private/consumer email excluded; use school email or validate manually.";

const CONSUMER_EMAIL_DOMAINS = new Set([
  "gmail.com",
  "yahoo.com",
  "icloud.com",
  "hotmail.com",
  "outlook.com",
  "aol.com",
]);

const FINAL_CONTACT_EMAIL_STATUSES = new Set([
  "Valid",
  "Unknown",
  "Error",
  "Invalid",
]);

const enrichRequestSchema = z.object({
  limit: z.coerce.number().int().optional(),
  runId: z.string().trim().min(1).optional(),
  runIds: z.array(z.string().trim().min(1)).optional(),
  prospectIds: z.array(z.union([z.string(), z.number()])).optional(),
  minStudents: z.coerce.number().int().positive().optional(),
});

type ProspectToEnrich = Record<string, unknown> & {
  id: string | number;
  school_name?: string | null;
  website?: string | null;
  main_phone?: string | null;
  full_address?: string | null;
  city?: string | null;
  state?: string | null;
  google_place_id?: string | null;
  google_maps_url?: string | null;
  source_urls?: string[] | null;
  raw_google_json?: unknown;
  enrichment_status?: string | null;
  enrichment_attempts?: number | null;
};

type EnrichmentResultItem = {
  id: string | number;
  prospect_id: string | number;
  school_name: string;
  status: "enriched" | "enrichment_failed" | "skipped";
  contacts_returned: number;
  contacts_written: number;
  contacts_with_email: number;
  contacts_without_email: number;
  contacts_dropped: number;
  best_contact_name: string | null;
  best_contact_email: string | null;
  prospect_update_success: boolean;
  contact_upsert_success: boolean;
  error?: string;
};

type ContactRecord = Record<string, unknown> & {
  id?: string | number;
  email?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  job_title?: string | null;
  email_validation_status?: string | null;
};

type ContactWriteRow = {
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone_number: string | null;
  job_title: string | null;
  contact_owner: string;
  lead_status: string;
  contact_rank: number;
  sequence_pick: boolean;
  sequence_name: string;
  best_contact_reason: string | null;
  email_validation_status: "Valid" | "Unknown" | "Error" | "Invalid";
  contact_source_url: string | null;
  contact_confidence: string | null;
  notes: string | null;
};

class MissingOpenAIEnvError extends Error {
  constructor() {
    super("Missing OPENAI_API_KEY");
    this.name = "MissingOpenAIEnvError";
  }
}

class ProspectEnrichmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProspectEnrichmentError";
  }
}

type EnrichRequestBody = z.infer<typeof enrichRequestSchema>;

type EnrichRequestScope = {
  hasScope: boolean;
  prospectIds: string[];
  runIds: string[];
  minStudents?: number;
};

export async function POST(request: Request) {
  try {
    const parsedBody = enrichRequestSchema.safeParse(
      await request.json().catch(() => ({})),
    );

    if (!parsedBody.success) {
      return jsonError("Invalid request body.", 400);
    }

    const requestScope = getRequestScope(parsedBody.data);
    const limit = requestScope.hasScope
      ? getScopedLimit(parsedBody.data.limit)
      : clampLimit(parsedBody.data.limit ?? 5);
    const openai = createOpenAIClient();
    const supabase = createSupabaseServerClient();
    const prospectLoad = await loadProspectsToEnrich(
      supabase,
      requestScope,
      limit,
    );

    if (prospectLoad.error) {
      return jsonError("Supabase query failure.", 500);
    }

    const prospects = prospectLoad.prospects;
    const skippedResults = prospectLoad.skipped.map((prospect) => ({
      id: prospect.id,
      prospect_id: prospect.id,
      school_name: textValue(prospect.school_name) || "Unknown School",
      status: "skipped" as const,
      contacts_returned: 0,
      contacts_written: 0,
      contacts_with_email: 0,
      contacts_without_email: 0,
      contacts_dropped: 0,
      best_contact_name: null,
      best_contact_email: null,
      prospect_update_success: false,
      contact_upsert_success: false,
      error: "Prospect is already enriched or currently enriching.",
    }));

    if (prospects.length === 0 && skippedResults.length === 0) {
      return Response.json({
        attempted: 0,
        enriched: 0,
        failed: 0,
        skipped: 0,
        message: "No unenriched prospects found.",
        results: [],
      });
    }

    const results: EnrichmentResultItem[] = [...skippedResults];

    for (const prospect of prospects) {
      const schoolName = textValue(prospect.school_name) || "Unknown School";
      const started = await markProspectEnriching(prospect);

      if (!started) {
        results.push({
          id: prospect.id,
          prospect_id: prospect.id,
          school_name: schoolName,
          status: "enrichment_failed",
          contacts_returned: 0,
          contacts_written: 0,
          contacts_with_email: 0,
          contacts_without_email: 0,
          contacts_dropped: 0,
          best_contact_name: null,
          best_contact_email: null,
          prospect_update_success: false,
          contact_upsert_success: false,
          error: "Supabase update failure.",
        });
        continue;
      }

      try {
        const enrichment = await enrichProspect(openai, prospect);
        const updateResult = await updateProspectWithEnrichment(prospect, enrichment);

        if (!updateResult.success) {
          throw new ProspectEnrichmentError("Supabase update failure.");
        }

        results.push({
          id: prospect.id,
          prospect_id: prospect.id,
          school_name: schoolName,
          status: "enriched",
          contacts_returned: updateResult.contactsReturned,
          contacts_written: updateResult.contactsWritten,
          contacts_with_email: updateResult.contactsWithEmail,
          contacts_without_email: updateResult.contactsWithoutEmail,
          contacts_dropped: updateResult.contactsDropped,
          best_contact_name: updateResult.bestContactName,
          best_contact_email: updateResult.bestContactEmail,
          prospect_update_success: updateResult.prospectUpdateSuccess,
          contact_upsert_success: updateResult.contactUpsertSuccess,
        });
      } catch (error) {
        const safeError = getSafeErrorMessage(error);
        await markProspectFailed(prospect.id, safeError);
        results.push({
          id: prospect.id,
          prospect_id: prospect.id,
          school_name: schoolName,
          status: "enrichment_failed",
          contacts_returned: 0,
          contacts_written: 0,
          contacts_with_email: 0,
          contacts_without_email: 0,
          contacts_dropped: 0,
          best_contact_name: null,
          best_contact_email: null,
          prospect_update_success: false,
          contact_upsert_success: false,
          error: safeError,
        });
      }
    }

    const enriched = results.filter((result) => result.status === "enriched").length;
    const failed = results.filter(
      (result) => result.status === "enrichment_failed",
    ).length;
    const skipped = results.filter((result) => result.status === "skipped").length;
    const attempted = enriched + failed;

    return Response.json({
      attempted,
      enriched,
      failed,
      skipped,
      message:
        attempted === 0
          ? "No unenriched prospects found."
          : `Enhanced ${enriched} prospects. ${failed} failed. ${skipped} skipped.`,
      results,
    });
  } catch (error) {
    if (error instanceof MissingOpenAIEnvError) {
      return jsonError("Missing OPENAI_API_KEY", 500);
    }

    if (error instanceof MissingServerEnvError) {
      return jsonError(`Missing ${error.envName}`, 500);
    }

    if (error instanceof ProspectEnrichmentError) {
      return jsonError(error.message, 500);
    }

    return jsonError("Unexpected server error.", 500);
  }
}

function getRequestScope(body: EnrichRequestBody): EnrichRequestScope {
  const prospectIds = uniqueStrings(
    (body.prospectIds ?? []).map((id) => String(id)),
  );
  const runIds = uniqueStrings([
    ...(body.runIds ?? []),
    ...(body.runId ? [body.runId] : []),
  ]);

  if (prospectIds.length > 0) {
    return {
      hasScope: true,
      prospectIds,
      runIds: [],
      minStudents: body.minStudents,
    };
  }

  if (runIds.length > 0) {
    return {
      hasScope: true,
      prospectIds: [],
      runIds,
      minStudents: body.minStudents,
    };
  }

  return {
    hasScope: false,
    prospectIds: [],
    runIds: [],
    minStudents: body.minStudents,
  };
}

async function loadProspectsToEnrich(
  supabase: SupabaseClient,
  scope: EnrichRequestScope,
  limit: number | null,
) {
  if (!scope.hasScope) {
    const query = supabase
      .from("prospects")
      .select("*")
      .or(
        "enrichment_status.is.null,enrichment_status.eq.raw,enrichment_status.eq.enrichment_failed",
      )
      .order("created_at", { ascending: true });
    const { data, error } = scope.minStudents
      ? await query.limit(10_000)
      : typeof limit === "number"
        ? await query.limit(limit)
        : await query;

    const prospects = ((data ?? []) as ProspectToEnrich[])
      .filter(Boolean)
      .filter((prospect) => meetsMinimumStudents(prospect, scope.minStudents));

    return {
      prospects: typeof limit === "number" ? prospects.slice(0, limit) : prospects,
      skipped: [] as ProspectToEnrich[],
      error,
    };
  }

  const scopedProspectIds =
    scope.prospectIds.length > 0
      ? scope.prospectIds
      : await getProspectIdsForRuns(supabase, scope.runIds);

  if (scopedProspectIds.length === 0) {
    return {
      prospects: [] as ProspectToEnrich[],
      skipped: [] as ProspectToEnrich[],
      error: null,
    };
  }

  const query = supabase
    .from("prospects")
    .select("*")
    .in("id", scopedProspectIds)
    .order("created_at", { ascending: true });
  const { data, error } =
    typeof limit === "number" ? await query.limit(limit) : await query;

  if (error) {
    return {
      prospects: [] as ProspectToEnrich[],
      skipped: [] as ProspectToEnrich[],
      error,
    };
  }

  const scopedProspects = ((data ?? []) as ProspectToEnrich[])
    .filter(Boolean)
    .filter((prospect) => meetsMinimumStudents(prospect, scope.minStudents));
  const prospects = scopedProspects.filter(isEligibleForEnrichment);
  const skipped = scopedProspects.filter(
    (prospect) => !isEligibleForEnrichment(prospect),
  );

  return { prospects, skipped, error: null };
}

async function getProspectIdsForRuns(
  supabase: SupabaseClient,
  runIds: string[],
) {
  if (runIds.length === 0) {
    return [];
  }

  const { data, error } = await supabase
    .from("prospect_run_prospects")
    .select("prospect_id")
    .in("run_id", runIds)
    .limit(10_000);

  if (error) {
    throw new ProspectEnrichmentError("Supabase query failure.");
  }

  return uniqueStrings(
    (data ?? [])
      .map((row: { prospect_id?: string | number | null }) => row.prospect_id)
      .filter((id): id is string | number => id !== null && id !== undefined)
      .map((id) => String(id)),
  );
}

function isEligibleForEnrichment(prospect: ProspectToEnrich) {
  const status = textValue(prospect.enrichment_status).toLowerCase();

  return !status || status === "raw" || status === "enrichment_failed";
}

function meetsMinimumStudents(
  prospect: ProspectToEnrich,
  minStudents: number | undefined,
) {
  if (!minStudents) {
    return true;
  }

  const studentCount =
    numberFromLooseText(prospect.number_of_students) ??
    numberFromLooseText(prospect.hs_enrollment) ??
    numberFromLooseText(prospect.total_enrollment);

  return studentCount !== null && studentCount >= minStudents;
}

async function markProspectEnriching(prospect: ProspectToEnrich) {
  const supabase = createSupabaseServerClient();
  const nextAttempts = numberValue(prospect.enrichment_attempts) + 1;
  const { error } = await supabase
    .from("prospects")
    .update({
      enrichment_status: "enriching",
      enrichment_error: null,
      enrichment_attempts: nextAttempts,
    })
    .eq("id", prospect.id);

  return !error;
}

async function enrichProspect(openai: OpenAI, prospect: ProspectToEnrich) {
  const payload = {
    prospect: {
      id: prospect.id,
      school_name: prospect.school_name,
      website: prospect.website,
      main_phone: prospect.main_phone,
      full_address: prospect.full_address,
      city: prospect.city,
      state: prospect.state,
      google_place_id: prospect.google_place_id,
      google_maps_url: prospect.google_maps_url,
      source_urls: Array.isArray(prospect.source_urls) ? prospect.source_urls : [],
      raw_google_json: prospect.raw_google_json,
    },
    reference_schools: REFERENCE_SCHOOLS,
  };
  const webSearchTool = {
    type: "web_search",
    search_context_size: "medium",
    external_web_access: true,
    user_location: {
      type: "approximate",
      country: "US",
      city: textValue(prospect.city) || undefined,
      region: textValue(prospect.state) || undefined,
      timezone: "America/Chicago",
    },
    filters: {
      blocked_domains: ["reddit.com", "quora.com", "wikipedia.org"],
    },
  } as unknown as NonNullable<
    ResponseCreateParamsNonStreaming["tools"]
  >[number];

  const response = await openai.responses.create({
    model: MODEL,
    instructions: ENRICHMENT_SYSTEM_PROMPT,
    input: JSON.stringify(payload, null, 2),
    tools: [webSearchTool],
    tool_choice: "required",
    include: ["web_search_call.action.sources"],
    text: {
      format: {
        type: "json_schema",
        name: "club_hub_prospect_enrichment",
        strict: true,
        schema: enrichmentSchema,
      },
    },
  });

  if (!didUseWebSearch(response)) {
    throw new ProspectEnrichmentError("OpenAI did not complete web search.");
  }

  let parsedJson: unknown;

  try {
    parsedJson = JSON.parse(response.output_text);
  } catch {
    throw new ProspectEnrichmentError("OpenAI returned invalid JSON.");
  }

  const validation = enrichmentResultSchema.safeParse(parsedJson);

  if (!validation.success) {
    throw new ProspectEnrichmentError("OpenAI returned invalid enrichment data.");
  }

  return {
    parsed: validation.data,
    responseId: response.id,
    usage: response.usage ?? null,
    webSearchSources: extractWebSearchSources(response),
  };
}

async function updateProspectWithEnrichment(
  prospect: ProspectToEnrich,
  enrichment: {
    parsed: EnrichmentResult;
    responseId: string;
    usage: unknown;
    webSearchSources: string[];
  },
) {
  const supabase = createSupabaseServerClient();
  const school = enrichment.parsed.school;
  const contactBuild = buildContactRows(enrichment.parsed.contacts, prospect);
  const contacts = contactBuild.rows;
  const bestContact = contacts[0] ?? null;

  const contactsUpdated = await upsertProspectContacts(
    supabase,
    prospect.id,
    contacts,
  );

  if (!contactsUpdated.success) {
    return {
      success: false,
      contactsReturned: contactBuild.contactsReturned,
      contactsWritten: contactsUpdated.contactsWritten,
      contactsWithEmail: contactBuild.contactsWithEmail,
      contactsWithoutEmail: contactBuild.contactsWithoutEmail,
      contactsDropped: contactBuild.contactsDropped,
      bestContactName: getContactName(bestContact),
      bestContactEmail: bestContact?.email ?? null,
      prospectUpdateSuccess: false,
      contactUpsertSuccess: false,
    };
  }

  const companyDomainName = normalizeDomain(
    school.company_domain_name,
    prospect.website,
    school.source_url,
  );
  const sourceUrls = uniqueStrings([
    ...arrayStrings(prospect.source_urls),
    ...school.source_urls,
    ...enrichment.webSearchSources,
  ]);
  const numberOfStudents = normalizeNumber(school.number_of_students);
  const numberOfClubs = normalizeNumber(school.number_of_clubs);
  const totalEnrollment =
    school.total_enrollment ??
    nullableNumberValue(prospect.total_enrollment) ??
    numberFromText(numberOfStudents);
  const hsEnrollment =
    school.hs_enrollment ??
    nullableNumberValue(prospect.hs_enrollment) ??
    numberFromText(numberOfStudents);
  const clubsCountEstimate =
    school.clubs_count_estimate ??
    nullableNumberValue(prospect.clubs_count_estimate) ??
    numberFromText(numberOfClubs);
  const aiFitReason =
    textValue(school.ai_fit_reason) || textValue(school.personalization_angle);

  const { error } = await supabase
    .from("prospects")
    .update({
      school_name:
        textValue(school.company_name) ||
        textValue(prospect.school_name) ||
        "Unknown School",
      company_domain_name: companyDomainName || null,
      company_owner: textValue(school.company_owner) || DEFAULT_COMPANY_OWNER,
      street_address: textValue(school.street_address) || null,
      state_region_code:
        textValue(school.state_region_code) || textValue(prospect.state) || null,
      postal_code: textValue(school.postal_code) || null,
      time_zone: textValue(school.time_zone) || null,
      industry: textValue(school.industry) || DEFAULT_INDUSTRY,
      company_type: textValue(school.company_type) || null,
      record_source: textValue(school.record_source) || DEFAULT_RECORD_SOURCE,
      school_type: normalizeSchoolType(school.school_type) || null,
      religion: normalizeReligion(school.religion) || null,
      school_structure: textValue(school.school_structure) || null,
      school_structure_boy_girl:
        normalizeSchoolStructureBoyGirl(school.school_structure_boy_girl) || null,
      school_structure_day_boarding:
        normalizeDayBoarding(school.school_structure_day_boarding) || null,
      school_divisions: normalizeSchoolDivisions(school.school_divisions) || null,
      low_grade: textValue(school.low_grade) || null,
      high_grade: textValue(school.high_grade) || null,
      number_of_students: numberOfStudents || null,
      number_of_clubs: numberOfClubs || null,
      list_of_clubs: textValue(school.list_of_clubs) || null,
      clubs_letter_grade: textValue(school.clubs_letter_grade) || null,
      percent_clubs_get_funding:
        normalizeNumber(school.percent_clubs_get_funding) || null,
      percent_lots_of_participation:
        normalizeNumber(school.percent_lots_of_participation) || null,
      percent_plenty_of_clubs:
        normalizeNumber(school.percent_plenty_of_clubs) || null,
      tuition: normalizeNumber(school.tuition) || null,
      niche_ranking: normalizeNumber(school.niche_ranking) || null,
      number_of_employees_range:
        normalizeEmployeeRange(school.number_of_employees_range) || null,
      annual_revenue: normalizeNumber(school.annual_revenue) || null,
      subscription_year: textValue(school.subscription_year) || null,
      description: textValue(school.description) || null,
      linkedin_company_page: textValue(school.linkedin_company_page) || null,
      reference_school: textValue(school.reference_school) || null,
      reference_school_reason: textValue(school.reference_school_reason) || null,
      ai_fit_reason: aiFitReason || null,
      source_url: textValue(school.source_url) || firstString(sourceUrls) || null,
      data_confidence: normalizeConfidence(school.data_confidence) || null,
      export_notes: textValue(school.export_notes) || null,
      grades_served: textValue(school.grades_served) || null,
      hs_enrollment: hsEnrollment,
      total_enrollment: totalEnrollment,
      student_life_url: textValue(school.student_life_url) || null,
      clubs_activities_url: textValue(school.clubs_activities_url) || null,
      clubs_count_estimate: clubsCountEstimate,
      club_activity_signal: textValue(school.club_activity_signal) || null,
      fit_score: school.fit_score,
      personalization_angle: aiFitReason || textValue(school.personalization_angle) || null,
      research_notes: textValue(school.research_notes) || null,
      source_urls: sourceUrls,
      target_persona:
        textValue(school.target_persona) ||
        textValue(bestContact?.job_title) ||
        null,
      contact_name: bestContact
        ? `${bestContact.first_name ?? ""} ${bestContact.last_name ?? ""}`.trim() ||
          null
        : textValue(prospect.contact_name) || null,
      contact_title:
        bestContact?.job_title ?? (textValue(prospect.contact_title) || null),
      contact_email:
        bestContact?.email ?? (textValue(prospect.contact_email) || null),
      contact_phone:
        bestContact?.phone_number ?? (textValue(prospect.contact_phone) || null),
      contact_source_url:
        bestContact?.contact_source_url ??
        (textValue(prospect.contact_source_url) || null),
      contact_confidence: bestContact
        ? confidenceToScore(bestContact.contact_confidence)
        : nullableNumberValue(prospect.contact_confidence),
      fields_not_found: school.fields_not_found,
      contact_email_validation_status: bestContact
        ? bestContact.email_validation_status
        : textValue(prospect.contact_email_validation_status) || "unknown",
      raw_openai_json: {
        parsed: enrichment.parsed,
        contact_processing: {
          contacts_returned: contactBuild.contactsReturned,
          contacts_written: contactsUpdated.contactsWritten,
          contacts_with_email: contactBuild.contactsWithEmail,
          contacts_without_email: contactBuild.contactsWithoutEmail,
          contacts_dropped: contactBuild.contactsDropped,
        },
        openai_response_id: enrichment.responseId,
        model: MODEL,
        usage: enrichment.usage,
        web_search_sources: enrichment.webSearchSources,
      },
      enrichment_status: "enriched",
      enriched_at: new Date().toISOString(),
      enrichment_error: null,
    })
    .eq("id", prospect.id);

  return {
    success: !error,
    contactsReturned: contactBuild.contactsReturned,
    contactsWritten: contactsUpdated.contactsWritten,
    contactsWithEmail: contactBuild.contactsWithEmail,
    contactsWithoutEmail: contactBuild.contactsWithoutEmail,
    contactsDropped: contactBuild.contactsDropped,
    bestContactName: getContactName(bestContact),
    bestContactEmail: bestContact?.email ?? null,
    prospectUpdateSuccess: !error,
    contactUpsertSuccess: contactsUpdated.success,
  };
}

async function upsertProspectContacts(
  supabase: SupabaseClient,
  prospectId: string | number,
  contacts: ContactWriteRow[],
) {
  const { data, error } = await supabase
    .from("prospect_contacts")
    .select("*")
    .eq("prospect_id", prospectId);

  if (error) {
    return { success: false, contactsWritten: 0 };
  }

  const existingByEmail = new Map<string, ContactRecord>();
  const existingByNoEmailKey = new Map<string, ContactRecord>();

  for (const existing of (data ?? []) as ContactRecord[]) {
    const email = normalizeEmail(existing.email);

    if (email) {
      existingByEmail.set(email, existing);
      continue;
    }

    const noEmailKey = noEmailContactKey(existing);

    if (noEmailKey) {
      existingByNoEmailKey.set(noEmailKey, existing);
    }
  }

  let contactsWritten = 0;

  for (const contact of contacts) {
    const existing = contact.email
      ? existingByEmail.get(contact.email)
      : existingByNoEmailKey.get(noEmailContactKey(contact));
    const preservedStatus = normalizeExistingEmailStatus(
      existing?.email_validation_status,
    );
    const row = {
      prospect_id: prospectId,
      ...contact,
      email_validation_status:
        preservedStatus ?? contact.email_validation_status,
    };
    const result = existing?.id
      ? await supabase
          .from("prospect_contacts")
          .update(row)
          .eq("id", existing.id)
      : await supabase.from("prospect_contacts").insert(row);

    if (result.error) {
      return { success: false, contactsWritten };
    }

    contactsWritten += 1;
  }

  return { success: true, contactsWritten };
}

function buildContactRows(
  contacts: EnrichmentContact[],
  prospect: ProspectToEnrich,
) {
  const rows: ContactWriteRow[] = [];
  let contactsDropped = 0;

  for (const contact of contacts) {
    const row = buildContactRow(contact, prospect);

    if (row) {
      rows.push(row);
    } else {
      contactsDropped += 1;
    }
  }

  const sortedRows = rows.sort((left, right) => left.contact_rank - right.contact_rank);
  const seenKeys = new Set<string>();
  const uniqueRows: ContactWriteRow[] = [];

  for (const row of sortedRows) {
    const dedupeKey = contactDedupeKey(row);

    if (seenKeys.has(dedupeKey)) {
      contactsDropped += 1;
      continue;
    }

    seenKeys.add(dedupeKey);
    uniqueRows.push(row);
  }

  const rowsWithFallback =
    uniqueRows.length > 0 ? uniqueRows : [buildFallbackContactRow(prospect)];
  const finalRows = rowsWithFallback.map((row, index) => ({
    ...row,
    contact_rank: index + 1,
    sequence_pick: index === 0,
  }));

  return {
    rows: finalRows,
    contactsReturned: contacts.length,
    contactsWithEmail: finalRows.filter((row) => Boolean(row.email)).length,
    contactsWithoutEmail: finalRows.filter((row) => !row.email).length,
    contactsDropped,
  };
}

function buildContactRow(
  contact: EnrichmentContact,
  prospect: ProspectToEnrich,
): ContactWriteRow | null {
  const normalizedEmail = normalizeEmail(contact.email);
  const hasConsumerEmail = Boolean(
    normalizedEmail && isConsumerEmail(normalizedEmail),
  );
  const email = normalizedEmail && !hasConsumerEmail ? normalizedEmail : null;
  const firstName = textValue(contact.first_name);
  const lastName = textValue(contact.last_name);
  const jobTitle = textValue(contact.job_title);
  const contactSourceUrl = textValue(contact.contact_source_url);
  const bestContactReason = textValue(contact.best_contact_reason);

  if (
    !email &&
    !firstName &&
    !lastName &&
    !jobTitle &&
    !contactSourceUrl &&
    !bestContactReason
  ) {
    return null;
  }

  const isPatternInferred = contact.email_source === "pattern_inferred";
  const notes = buildContactNotes({
    notes: textValue(contact.notes),
    isPatternInferred,
    hasConsumerEmail,
    hasEmail: Boolean(email),
  });
  const contactConfidence = normalizeConfidence(contact.contact_confidence);

  return {
    first_name: firstName || null,
    last_name: lastName || null,
    email,
    phone_number:
      textValue(contact.phone_number) ||
      textValue(prospect.main_phone) ||
      textValue(prospect.contact_phone) ||
      null,
    job_title: jobTitle || null,
    contact_owner: DEFAULT_CONTACT_OWNER,
    lead_status: DEFAULT_LEAD_STATUS,
    contact_rank: positiveInteger(contact.contact_rank) ?? Number.MAX_SAFE_INTEGER,
    sequence_pick: false,
    sequence_name: DEFAULT_SEQUENCE_NAME,
    best_contact_reason: bestContactReason || null,
    email_validation_status: !email || isPatternInferred
      ? "Unknown"
      : normalizeAiEmailStatus(contact.email_validation_status),
    contact_source_url: contactSourceUrl || null,
    contact_confidence: isPatternInferred && contactConfidence === "High"
      ? "Medium"
      : contactConfidence || null,
    notes: notes || null,
  };
}

function buildFallbackContactRow(prospect: ProspectToEnrich): ContactWriteRow {
  return {
    first_name: null,
    last_name: null,
    email: null,
    phone_number:
      textValue(prospect.main_phone) || textValue(prospect.contact_phone) || null,
    job_title: "Student Life / Activities Contact",
    contact_owner: DEFAULT_CONTACT_OWNER,
    lead_status: DEFAULT_LEAD_STATUS,
    contact_rank: 1,
    sequence_pick: true,
    sequence_name: DEFAULT_SEQUENCE_NAME,
    best_contact_reason:
      "Fallback contact for student life or activities ownership; no named public contact found.",
    email_validation_status: "Unknown",
    contact_source_url:
      textValue(prospect.website) || textValue(prospect.google_maps_url) || null,
    contact_confidence: "Low",
    notes: "No named public contact found; use school main phone or research manually.",
  };
}

function getContactName(contact: ContactWriteRow | null) {
  if (!contact) {
    return null;
  }

  return [contact.first_name, contact.last_name].filter(Boolean).join(" ") || null;
}

function contactDedupeKey(contact: ContactWriteRow) {
  if (contact.email) {
    return `email:${contact.email}`;
  }

  return `person:${noEmailContactKey(contact) || normalizeKey(contact.job_title) || "fallback"}`;
}

function noEmailContactKey(contact: {
  first_name?: unknown;
  last_name?: unknown;
  job_title?: unknown;
}) {
  return normalizeKey(
    [contact.first_name, contact.last_name, contact.job_title]
      .map(textValue)
      .filter(Boolean)
      .join(" "),
  );
}

function buildContactNotes({
  notes,
  isPatternInferred,
  hasConsumerEmail,
  hasEmail,
}: {
  notes: string;
  isPatternInferred: boolean;
  hasConsumerEmail: boolean;
  hasEmail: boolean;
}) {
  return uniqueStrings([
    notes,
    isPatternInferred ? PATTERN_INFERRED_NOTE : "",
    hasConsumerEmail ? CONSUMER_EMAIL_EXCLUDED_NOTE : "",
    hasEmail ? "" : EMAIL_NOT_FOUND_NOTE,
  ]).join(" ");
}

async function markProspectFailed(id: string | number, enrichmentError: string) {
  const supabase = createSupabaseServerClient();
  await supabase
    .from("prospects")
    .update({
      enrichment_status: "enrichment_failed",
      enrichment_error: enrichmentError,
    })
    .eq("id", id);
}

function createOpenAIClient() {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    throw new MissingOpenAIEnvError();
  }

  return new OpenAI({ apiKey });
}

function clampLimit(limit: number) {
  return Math.min(10, Math.max(1, limit));
}

function getScopedLimit(limit: number | undefined) {
  if (limit === undefined) {
    return null;
  }

  return Math.max(1, Math.trunc(limit));
}

function didUseWebSearch(response: {
  output?: Array<{ type?: string; status?: string | null }>;
}) {
  return response.output?.some(
    (item) => item.type === "web_search_call" && item.status === "completed",
  );
}

function extractWebSearchSources(response: {
  output?: Array<{
    type?: string;
    action?: unknown;
  }>;
}) {
  const urls = new Set<string>();

  for (const item of response.output ?? []) {
    if (item.type !== "web_search_call") {
      continue;
    }

    if (!isRecord(item.action)) {
      continue;
    }

    const sources = item.action.sources;

    if (!Array.isArray(sources)) {
      continue;
    }

    for (const source of sources) {
      if (isRecord(source) && typeof source.url === "string") {
        urls.add(source.url);
      }
    }
  }

  return Array.from(urls);
}

function textValue(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function nullableNumberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function numberFromText(value: unknown) {
  const normalized = normalizeNumber(value);

  if (!normalized) {
    return null;
  }

  const parsed = Number.parseInt(normalized, 10);

  return Number.isFinite(parsed) ? parsed : null;
}

function numberFromLooseText(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  const normalized = textValue(value).replace(/[^0-9.]+/g, "");

  if (!normalized) {
    return null;
  }

  const parsed = Number.parseFloat(normalized);

  return Number.isFinite(parsed) ? parsed : null;
}

function positiveInteger(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) {
    return null;
  }

  return Math.trunc(value);
}

function normalizeConfidence(value: unknown) {
  const text = textValue(value);

  if (text === "High" || text === "Medium" || text === "Low") {
    return text;
  }

  return "";
}

function confidenceToScore(value: unknown) {
  const confidence = normalizeConfidence(value);

  if (confidence === "High") return 85;
  if (confidence === "Medium") return 60;
  if (confidence === "Low") return 35;

  return null;
}

function normalizeDayBoarding(value: unknown) {
  const text = textValue(value);

  if (text === "Day" || text === "Boarding" || text === "Boarding & Day") {
    return text;
  }

  return "";
}

function normalizeAiEmailStatus(value: unknown): "Valid" | "Unknown" | "Error" {
  const text = textValue(value);

  if (text === "Valid" || text === "Error") {
    return text;
  }

  return "Unknown";
}

function normalizeExistingEmailStatus(value: unknown) {
  const text = textValue(value).toLowerCase();

  for (const status of FINAL_CONTACT_EMAIL_STATUSES) {
    if (status.toLowerCase() === text) {
      return status as "Valid" | "Unknown" | "Error" | "Invalid";
    }
  }

  return null;
}

function isConsumerEmail(email: string) {
  const domain = email.split("@")[1]?.toLowerCase();

  return Boolean(domain && CONSUMER_EMAIL_DOMAINS.has(domain));
}

function arrayStrings(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is string => typeof item === "string");
}

function uniqueStrings(values: string[]) {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function firstString(values: string[]) {
  return values.find(Boolean) ?? "";
}

function normalizeKey(value: unknown) {
  return textValue(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function getSafeErrorMessage(error: unknown) {
  if (error instanceof ProspectEnrichmentError) {
    return error.message;
  }

  if (error instanceof Error) {
    return error.message.slice(0, 240) || "Enrichment failed.";
  }

  return "Enrichment failed.";
}

function jsonError(message: string, status: number) {
  return Response.json({ error: message }, { status });
}
