import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { createSupabaseServerClient, MissingServerEnvError } from "@/lib/supabaseServer";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 120;

type ProspectRecord = Record<string, unknown> & {
  id: string | number;
  school_name?: string | null;
  contact_name?: string | null;
  contact_email?: string | null;
  email_validation_status?: string | null;
  contact_email_validation_status?: string | null;
  email_validation_attempts?: number | null;
};

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

type BecResult = {
  status: string;
  event: string | null;
  details: string | null;
  raw: unknown;
};

type ValidationTarget = {
  target_type: "contact" | "legacy";
  prospect_id: string | number;
  contact_id?: string | number;
  school_name: string;
  contact_name: string;
  email: string;
  current_status: string;
  prospect?: ProspectRecord;
};

type ValidationResultItem = {
  target_type: "contact" | "legacy";
  prospect_id: string | number;
  contact_id?: string | number;
  school_name: string;
  contact_name: string;
  email: string;
  status: "Valid" | "Invalid" | "Unknown" | "Error" | "Skipped";
  event?: string | null;
  details?: string | null;
  error?: string | null;
};

type ValidationSummary = {
  checked: number;
  valid: number;
  invalid: number;
  unknown: number;
  errors: number;
  skipped: number;
};

type CandidateLoadResult = {
  targets: ValidationTarget[];
  skippedResults: ValidationResultItem[];
  scope: string;
  remainingValidatable: number;
};

const requestSchema = z.object({
  limit: z.coerce.number().int().optional(),
  prospectIds: z.array(z.union([z.string(), z.number()])).optional(),
  runId: z.string().trim().optional(),
  runIds: z.array(z.string().trim().min(1)).optional(),
  retryErrors: z.boolean().optional(),
  minStudents: z.coerce.number().int().positive().optional(),
  excludeContactIds: z.array(z.union([z.string(), z.number()])).optional(),
  excludeLegacyProspectIds: z.array(z.union([z.string(), z.number()])).optional(),
  includeSkipped: z.boolean().optional(),
});

const BAD_EMAIL_VALUES = new Set([
  "unknown",
  "n/a",
  "na",
  "none",
  "null",
  "undefined",
  "-",
  "invalid",
]);

const VALIDATABLE_STATUSES = new Set([
  "",
  "not_checked",
  "public source",
  "public_source_unverified",
  "unknown",
  "error",
  "checking",
]);

const FINAL_STATUSES = new Set(["valid", "invalid"]);
const SUPABASE_PAGE_SIZE = 1_000;
const SUPABASE_IN_CHUNK_SIZE = 100;

export async function POST(request: Request) {
  try {
    const parsedBody = requestSchema.safeParse(await request.json().catch(() => ({})));

    if (!parsedBody.success) {
      return jsonError("Invalid request body.", 400);
    }

    const body = parsedBody.data;
    const limit = clampLimit(body.limit ?? 50);
    const supabase = createSupabaseServerClient();
    const { targets, skippedResults, scope, remainingValidatable } =
      await loadValidationTargets(supabase, {
        limit,
        prospectIds: body.prospectIds?.map((id) => String(id)) ?? [],
        runId: body.runId?.trim() ?? "",
        runIds: body.runIds ?? [],
        retryErrors: body.retryErrors ?? false,
        minStudents: body.minStudents,
        excludeContactIds:
          body.excludeContactIds?.map((id) => String(id)) ?? [],
        excludeLegacyProspectIds:
          body.excludeLegacyProspectIds?.map((id) => String(id)) ?? [],
        includeSkipped: body.includeSkipped ?? true,
      });

    const summary: ValidationSummary = {
      checked: 0,
      valid: 0,
      invalid: 0,
      unknown: 0,
      errors: 0,
      skipped: skippedResults.length,
    };
    const results: ValidationResultItem[] = [...skippedResults];
    const affectedProspectIds = new Set<string>(
      skippedResults.map((result) => String(result.prospect_id)),
    );

    for (const [index, target] of targets.entries()) {
      const result = await validateTargetEmail(supabase, target);
      results.push(result);
      affectedProspectIds.add(String(result.prospect_id));

      if (result.status === "Valid") summary.valid += 1;
      if (result.status === "Invalid") summary.invalid += 1;
      if (result.status === "Unknown") summary.unknown += 1;
      if (result.status === "Error") summary.errors += 1;
      if (result.status === "Skipped") summary.skipped += 1;
      if (result.status !== "Skipped") summary.checked += 1;

      if (index < targets.length - 1) {
        await delay(300);
      }
    }
    const rerankResult = await rerankContactsForProspects(
      supabase,
      Array.from(affectedProspectIds),
    );

    return Response.json({
      ...summary,
      scope,
      remaining_validatable: remainingValidatable,
      reranked_prospects: rerankResult.reranked,
      rerank_errors: rerankResult.errors,
      results,
      message: `Checked ${summary.checked} emails for ${scope}. Valid: ${summary.valid}. Invalid: ${summary.invalid}. Unknown: ${summary.unknown}. Errors: ${summary.errors}. Skipped: ${summary.skipped}.`,
    });
  } catch (error) {
    if (error instanceof MissingServerEnvError) {
      return jsonError(`Missing ${error.envName}`, 500);
    }

    if (error instanceof MissingBecEnvError) {
      return jsonError("Missing BEC_API_KEY", 500);
    }

    return jsonError("Unexpected server error.", 500);
  }
}

async function loadValidationTargets(
  supabase: SupabaseClient,
  options: {
    limit: number;
    prospectIds: string[];
    runId: string;
    runIds: string[];
    retryErrors: boolean;
    minStudents?: number;
    excludeContactIds: string[];
    excludeLegacyProspectIds: string[];
    includeSkipped: boolean;
  },
): Promise<CandidateLoadResult> {
  const scopedProspectIds = await resolveScopedProspectIds(supabase, options);
  const isScoped = Boolean(
    options.prospectIds.length > 0 || options.runId || options.runIds.length > 0,
  );
  const scope = getScopeLabel(options, scopedProspectIds);

  if (scopedProspectIds && scopedProspectIds.length === 0) {
    return { targets: [], skippedResults: [], scope, remainingValidatable: 0 };
  }

  const contacts = await loadContacts(supabase, scopedProspectIds);
  const prospectIdsFromContacts = contacts
    .map((contact) => contact.prospect_id)
    .filter((id): id is string | number => id !== null && id !== undefined)
    .map((id) => String(id));
  const prospects = await loadProspectsForValidation(
    supabase,
    scopedProspectIds,
    prospectIdsFromContacts,
  );
  const filteredProspects = prospects.filter((prospect) =>
    meetsMinimumStudents(prospect, options.minStudents),
  );
  const allowedProspectIds = new Set(
    filteredProspects.map((prospect) => String(prospect.id)),
  );
  const filteredContacts = contacts.filter((contact) =>
    allowedProspectIds.has(String(contact.prospect_id ?? "")),
  );
  const prospectsById = new Map(
    filteredProspects.map((prospect) => [String(prospect.id), prospect]),
  );
  const contactCountsByProspectId = new Map<string, number>();

  for (const contact of filteredContacts) {
    const prospectId = String(contact.prospect_id ?? "");

    if (!prospectId) {
      continue;
    }

    contactCountsByProspectId.set(
      prospectId,
      (contactCountsByProspectId.get(prospectId) ?? 0) + 1,
    );
  }

  const targets: ValidationTarget[] = [];
  const skippedResults: ValidationResultItem[] = [];
  const excludedContactIds = new Set(options.excludeContactIds);
  const excludedLegacyProspectIds = new Set(options.excludeLegacyProspectIds);
  let validatableCount = 0;

  for (const contact of filteredContacts) {
    const prospectId = String(contact.prospect_id ?? "");
    const prospect = prospectsById.get(prospectId);
    const schoolName = stringValue(prospect?.school_name);
    const contactName = getContactName(contact);
    const email = extractEmail(contact.email);
    const currentStatus = normalizeStatus(contact.email_validation_status);

    if (!email) {
      if (isScoped && options.includeSkipped) {
        skippedResults.push({
          target_type: "contact",
          prospect_id: prospectId,
          contact_id: contact.id,
          school_name: schoolName,
          contact_name: contactName,
          email: "",
          status: "Skipped",
          event: "no_email",
          details: "Contact has no email to validate.",
        });
      }

      continue;
    }

    if (!shouldValidateStatus(currentStatus, options.retryErrors)) {
      if (isScoped && options.includeSkipped) {
        skippedResults.push({
          target_type: "contact",
          prospect_id: prospectId,
          contact_id: contact.id,
          school_name: schoolName,
          contact_name: contactName,
          email,
          status: "Skipped",
          event: "status_final",
          details: `Current status is ${currentStatus || "blank"}.`,
        });
      }

      continue;
    }

    if (excludedContactIds.has(String(contact.id))) {
      continue;
    }

    validatableCount += 1;

    if (targets.length < options.limit) {
      targets.push({
        target_type: "contact",
        prospect_id: prospectId,
        contact_id: contact.id,
        school_name: schoolName,
        contact_name: contactName,
        email,
        current_status: currentStatus,
      });
    }
  }

  for (const prospect of filteredProspects) {
    const prospectId = String(prospect.id);

    if (contactCountsByProspectId.has(prospectId)) {
      continue;
    }

    const email = extractEmail(prospect.contact_email);
    const currentStatus = normalizeStatus(
      prospect.email_validation_status ||
        prospect.contact_email_validation_status,
    );

    if (!email) {
      if (isScoped && options.includeSkipped) {
        skippedResults.push({
          target_type: "legacy",
          prospect_id: prospect.id,
          school_name: stringValue(prospect.school_name),
          contact_name: stringValue(prospect.contact_name),
          email: "",
          status: "Skipped",
          event: "no_email",
          details: "Legacy prospect has no email to validate.",
        });
      }

      continue;
    }

    if (!shouldValidateStatus(currentStatus, options.retryErrors)) {
      if (isScoped && options.includeSkipped) {
        skippedResults.push({
          target_type: "legacy",
          prospect_id: prospect.id,
          school_name: stringValue(prospect.school_name),
          contact_name: stringValue(prospect.contact_name),
          email,
          status: "Skipped",
          event: "status_final",
          details: `Current status is ${currentStatus || "blank"}.`,
        });
      }

      continue;
    }

    if (excludedLegacyProspectIds.has(prospectId)) {
      continue;
    }

    validatableCount += 1;

    if (targets.length < options.limit) {
      targets.push({
        target_type: "legacy",
        prospect_id: prospect.id,
        school_name: stringValue(prospect.school_name),
        contact_name: stringValue(prospect.contact_name),
        email,
        current_status: currentStatus,
        prospect,
      });
    }
  }

  return {
    targets,
    skippedResults,
    scope,
    remainingValidatable: Math.max(0, validatableCount - targets.length),
  };
}

async function resolveScopedProspectIds(
  supabase: SupabaseClient,
  options: {
    prospectIds: string[];
    runId: string;
    runIds: string[];
  },
) {
  if (options.prospectIds.length > 0) {
    return uniqueStrings(options.prospectIds);
  }

  const runIds = uniqueStrings([
    ...options.runIds,
    ...(options.runId ? [options.runId] : []),
  ]);

  if (runIds.length === 0) {
    return null;
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
      throw new Error("Unable to load run prospect membership.");
    }

    rows.push(...data);
  }

  return uniqueStrings(
    rows
      .map((row: { prospect_id?: string | number | null }) => row.prospect_id)
      .filter((id): id is string | number => id !== null && id !== undefined)
      .map((id) => String(id)),
  );
}

async function loadContacts(
  supabase: SupabaseClient,
  scopedProspectIds: string[] | null,
) {
  const query = supabase
    .from("prospect_contacts")
    .select("*")
    .order("contact_rank", { ascending: true })
    .order("created_at", { ascending: true });

  if (scopedProspectIds) {
    if (scopedProspectIds.length === 0) {
      return [] as ProspectContactRecord[];
    }

    const contacts: ProspectContactRecord[] = [];

    for (const idChunk of chunkArray(scopedProspectIds, SUPABASE_IN_CHUNK_SIZE)) {
      const { data, error } = await fetchAllRows<ProspectContactRecord>(
        (from, to) =>
          supabase
            .from("prospect_contacts")
            .select("*")
            .in("prospect_id", idChunk)
            .order("contact_rank", { ascending: true })
            .order("created_at", { ascending: true })
            .range(from, to),
      );

      if (error) {
        throw new Error("Unable to load prospect contacts.");
      }

      contacts.push(...data);
    }

    return contacts;
  }

  const { data, error } = await query.limit(10_000);

  if (error) {
    throw new Error("Unable to load prospect contacts.");
  }

  return (data ?? []) as ProspectContactRecord[];
}

async function loadProspectsForValidation(
  supabase: SupabaseClient,
  scopedProspectIds: string[] | null,
  contactProspectIds: string[],
) {
  if (scopedProspectIds) {
    if (scopedProspectIds.length === 0) {
      return [] as ProspectRecord[];
    }

    return loadProspectsByIds(supabase, scopedProspectIds, "scoped prospects");
  }

  const contactIds = uniqueStrings(contactProspectIds);
  const prospectsById = new Map<string, ProspectRecord>();

  if (contactIds.length > 0) {
    const contactProspects = await loadProspectsByIds(
      supabase,
      contactIds,
      "contact prospects",
    );

    for (const prospect of contactProspects) {
      prospectsById.set(String(prospect.id), prospect);
    }
  }

  const { data: legacyProspects, error: legacyError } = await supabase
    .from("prospects")
    .select("*")
    .not("contact_email", "is", null)
    .neq("contact_email", "")
    .order("created_at", { ascending: true })
    .limit(1_000);

  if (legacyError) {
    throw new Error("Unable to load legacy prospects.");
  }

  for (const prospect of (legacyProspects ?? []) as ProspectRecord[]) {
    prospectsById.set(String(prospect.id), prospect);
  }

  return Array.from(prospectsById.values());
}

async function loadProspectsByIds(
  supabase: SupabaseClient,
  prospectIds: string[],
  label: string,
) {
  const prospects: ProspectRecord[] = [];

  for (const idChunk of chunkArray(prospectIds, SUPABASE_IN_CHUNK_SIZE)) {
    const { data, error } = await fetchAllRows<ProspectRecord>((from, to) =>
      supabase
        .from("prospects")
        .select("*")
        .in("id", idChunk)
        .range(from, to),
    );

    if (error) {
      throw new Error(`Unable to load ${label}.`);
    }

    prospects.push(...data);
  }

  return prospects;
}

async function validateTargetEmail(
  supabase: SupabaseClient,
  target: ValidationTarget,
): Promise<ValidationResultItem> {
  const result = await checkEmailWithBulkEmailChecker(target.email);
  const mappedStatus = mapBecStatus(result.status);
  const checkedAt = new Date().toISOString();
  const updateOk =
    target.target_type === "contact"
      ? await updateContactValidation(supabase, target, mappedStatus)
      : await updateLegacyProspectValidation(
          supabase,
          target,
          mappedStatus,
          result,
          checkedAt,
        );

  return {
    target_type: target.target_type,
    prospect_id: target.prospect_id,
    contact_id: target.contact_id,
    school_name: target.school_name,
    contact_name: target.contact_name,
    email: target.email,
    status: updateOk ? mappedStatus : "Error",
    event: result.event,
    details: result.details,
    error: updateOk ? null : "Supabase validation update failed.",
  };
}

async function updateContactValidation(
  supabase: SupabaseClient,
  target: ValidationTarget,
  status: "Valid" | "Invalid" | "Unknown" | "Error",
) {
  if (!target.contact_id) {
    return false;
  }

  const { error } = await supabase
    .from("prospect_contacts")
    .update({ email_validation_status: status })
    .eq("id", target.contact_id);

  return !error;
}

async function updateLegacyProspectValidation(
  supabase: SupabaseClient,
  target: ValidationTarget,
  status: "Valid" | "Invalid" | "Unknown" | "Error",
  result: BecResult,
  checkedAt: string,
) {
  const attempts =
    (numberValue(target.prospect?.email_validation_attempts) ?? 0) + 1;
  const { error } = await supabase
    .from("prospects")
    .update({
      email_validation_status: status,
      contact_email_validation_status: status,
      email_validation_checked_at: checkedAt,
      email_validation_provider: "bulk_email_checker",
      email_validation_checked_email: target.email,
      email_validation_attempts: attempts,
      bec_status: result.status,
      bec_event: result.event,
      bec_details: result.details,
      bec_raw_json: result.raw,
      email_validation_error:
        status === "Error" ? getSafeError(result) : null,
    })
    .eq("id", target.prospect_id);

  return !error;
}

async function rerankContactsForProspects(
  supabase: SupabaseClient,
  prospectIds: string[],
) {
  const uniqueProspectIds = uniqueStrings(prospectIds);

  if (uniqueProspectIds.length === 0) {
    return { reranked: 0, errors: [] as string[] };
  }

  const contacts: ProspectContactRecord[] = [];

  for (const idChunk of chunkArray(uniqueProspectIds, SUPABASE_IN_CHUNK_SIZE)) {
    const { data, error } = await fetchAllRows<ProspectContactRecord>(
      (from, to) =>
        supabase
          .from("prospect_contacts")
          .select("*")
          .in("prospect_id", idChunk)
          .order("contact_rank", { ascending: true })
          .order("created_at", { ascending: true })
          .range(from, to),
    );

    if (error) {
      return { reranked: 0, errors: ["Unable to load contacts for rerank."] };
    }

    contacts.push(...data);
  }

  const contactsByProspectId = new Map<string, ProspectContactRecord[]>();

  for (const contact of contacts) {
    const prospectId = String(contact.prospect_id ?? "");

    if (!prospectId) {
      continue;
    }

    contactsByProspectId.set(prospectId, [
      ...(contactsByProspectId.get(prospectId) ?? []),
      contact,
    ]);
  }

  let reranked = 0;
  const errors: string[] = [];

  for (const [prospectId, contacts] of contactsByProspectId) {
    const sortedContacts = [...contacts].sort(compareValidatedContacts);
    let changed = false;

    for (const [index, contact] of sortedContacts.entries()) {
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
        errors.push(`Unable to rerank contact ${contact.id}.`);
        continue;
      }

      changed = true;
    }

    const bestContact = sortedContacts[0];

    if (bestContact) {
      const { error: prospectUpdateError } = await supabase
        .from("prospects")
        .update({
          contact_name: getContactName(bestContact) || null,
          contact_title: stringValue(bestContact.job_title) || null,
          contact_email: extractEmail(bestContact.email) || null,
          contact_phone: stringValue(bestContact.phone_number) || null,
          contact_source_url: stringValue(bestContact.contact_source_url) || null,
          contact_email_validation_status:
            normalizeDisplayStatus(bestContact.email_validation_status),
          email_validation_status:
            normalizeDisplayStatus(bestContact.email_validation_status),
        })
        .eq("id", prospectId);

      if (prospectUpdateError) {
        errors.push(`Unable to update best contact for prospect ${prospectId}.`);
      }
    }

    if (changed) {
      reranked += 1;
    }
  }

  return { reranked, errors };
}

function compareValidatedContacts(
  left: ProspectContactRecord,
  right: ProspectContactRecord,
) {
  const scoreDifference =
    scoreValidatedContact(right) - scoreValidatedContact(left);

  if (scoreDifference !== 0) {
    return scoreDifference;
  }

  const rankDifference =
    contactRankValue(left.contact_rank) - contactRankValue(right.contact_rank);

  if (rankDifference !== 0) {
    return rankDifference;
  }

  return stringValue(left.created_at).localeCompare(stringValue(right.created_at));
}

function scoreValidatedContact(contact: ProspectContactRecord) {
  const email = extractEmail(contact.email);
  const status = normalizeStatus(contact.email_validation_status);
  const roleScore = getRoleScore(contact);
  const genericPenalty = isGenericEmail(email) ? 180 : 0;

  if (email && status === "valid") {
    return 1000 + roleScore - genericPenalty;
  }

  if (email && status !== "invalid") {
    return 450 + roleScore - Math.round(genericPenalty / 2);
  }

  if (!email) {
    return 120 + roleScore;
  }

  return -500 + roleScore;
}

function getRoleScore(contact: ProspectContactRecord) {
  const roleText = normalizeKey(
    [
      contact.job_title,
      contact.first_name,
      contact.last_name,
      contact.notes,
    ]
      .map(stringValue)
      .join(" "),
  );

  if (
    includesAny(roleText, [
      "student life",
      "student activities",
      "student activity",
      "clubs",
      "club",
      "student organization",
      "student government",
      "activities coordinator",
      "activity coordinator",
      "after school",
      "after school care",
      "programming",
      "program coordinator",
    ])
  ) {
    return 170;
  }

  if (
    includesAny(roleText, [
      "dean of students",
      "dean students",
      "upper school dean",
      "student dean",
      "assistant dean",
    ])
  ) {
    return 145;
  }

  if (
    includesAny(roleText, [
      "principal",
      "assistant principal",
      "associate principal",
      "head of school",
      "assistant head",
      "school leader",
    ])
  ) {
    return 125;
  }

  if (
    includesAny(roleText, [
      "athletic director",
      "athletics director",
      "activities director",
      "activity director",
      "operations",
      "technology",
      "counselor",
      "administrator",
      "administration",
    ])
  ) {
    return 90;
  }

  if (
    includesAny(roleText, [
      "board",
      "president",
      "vice president",
      "founder",
      "founding",
      "co founder",
      "cofounder",
      "coordinator",
    ])
  ) {
    return 60;
  }

  if (contact.job_title || contact.first_name || contact.last_name) {
    return 30;
  }

  return 0;
}

function includesAny(value: string, needles: string[]) {
  return needles.some((needle) => value.includes(needle));
}

function isGenericEmail(email: string) {
  const localPart = email.split("@")[0]?.toLowerCase() ?? "";

  return [
    "info",
    "office",
    "contact",
    "admissions",
    "admin",
    "hello",
    "school",
    "support",
  ].includes(localPart);
}

function contactRankValue(value: unknown) {
  const rank = numberValue(value);

  return rank && rank > 0 ? rank : Number.MAX_SAFE_INTEGER;
}

function normalizeDisplayStatus(value: unknown) {
  const status = normalizeStatus(value);

  if (status === "valid") return "Valid";
  if (status === "invalid") return "Invalid";
  if (status === "error") return "Error";

  return "Unknown";
}

async function checkEmailWithBulkEmailChecker(email: string): Promise<BecResult> {
  const apiKey = process.env.BEC_API_KEY;

  if (!apiKey) {
    throw new MissingBecEnvError();
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);

  try {
    const response = await fetch(
      `https://api.bulkemailchecker.com/real-time/?key=${encodeURIComponent(
        apiKey,
      )}&email=${encodeURIComponent(email)}`,
      { signal: controller.signal },
    );
    const body = await response.text();

    if (!response.ok) {
      return {
        status: "error",
        event: `http_${response.status}`,
        details: body.slice(0, 500),
        raw: { body },
      };
    }

    try {
      const parsed = JSON.parse(body) as Record<string, unknown>;

      return {
        status: stringValue(parsed.status) || "error",
        event: nullableString(parsed.event),
        details: nullableString(parsed.details),
        raw: parsed,
      };
    } catch {
      return {
        status: "error",
        event: "json_parse_error",
        details: body.slice(0, 500),
        raw: { body },
      };
    }
  } catch (error) {
    const isTimeout =
      error instanceof DOMException && error.name === "AbortError";

    return {
      status: "error",
      event: isTimeout ? "timeout" : "fetch_error",
      details: isTimeout
        ? "Bulk Email Checker request timed out."
        : getErrorDetails(error),
      raw: null,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function shouldValidateStatus(status: string, retryErrors: boolean) {
  if (FINAL_STATUSES.has(status)) {
    return false;
  }

  if (status === "error") {
    return retryErrors || VALIDATABLE_STATUSES.has(status);
  }

  return VALIDATABLE_STATUSES.has(status);
}

function meetsMinimumStudents(
  prospect: ProspectRecord,
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

function mapBecStatus(status: string): "Valid" | "Invalid" | "Unknown" | "Error" {
  const normalized = status.toLowerCase();

  if (normalized === "passed") return "Valid";
  if (normalized === "failed") return "Invalid";
  if (normalized === "unknown") return "Unknown";

  return "Error";
}

function extractEmail(value: unknown) {
  const raw = stringValue(value).trim();

  if (!raw || BAD_EMAIL_VALUES.has(raw.toLowerCase())) {
    return "";
  }

  return (
    raw.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0].toLowerCase() ??
    ""
  );
}

function getContactName(contact: ProspectContactRecord) {
  return [contact.first_name, contact.last_name]
    .map((value) => stringValue(value))
    .filter(Boolean)
    .join(" ");
}

function getScopeLabel(
  options: {
    prospectIds: string[];
    runId: string;
    runIds: string[];
  },
  scopedProspectIds: string[] | null,
) {
  if (options.prospectIds.length > 0) {
    return `${options.prospectIds.length} selected prospects`;
  }

  if (options.runIds.length > 0) {
    return `${options.runIds.length} runs`;
  }

  if (options.runId) {
    return "current run";
  }

  if (scopedProspectIds) {
    return `${scopedProspectIds.length} scoped prospects`;
  }

  return "global unvalidated contacts";
}

function normalizeStatus(value: unknown) {
  return stringValue(value).toLowerCase();
}

function clampLimit(limit: number) {
  return Math.min(100, Math.max(1, limit));
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
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

function stringValue(value: unknown) {
  if (typeof value === "string") {
    return value.trim();
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }

  return "";
}

function normalizeKey(value: unknown) {
  return stringValue(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function nullableString(value: unknown) {
  if (typeof value !== "string") {
    return null;
  }

  return value;
}

function uniqueStrings(values: string[]) {
  return Array.from(new Set(values.filter(Boolean)));
}

async function fetchAllRows<T>(
  fetchPage: (
    from: number,
    to: number,
  ) => PromiseLike<{ data: unknown[] | null; error: unknown | null }>,
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

function getSafeError(result: BecResult) {
  return `${result.event ?? "bulk_email_checker_error"}${
    result.details ? `: ${result.details}` : ""
  }`.slice(0, 240);
}

function getErrorDetails(error: unknown) {
  return error instanceof Error
    ? error.message.slice(0, 500)
    : "Bulk Email Checker fetch error.";
}

function jsonError(message: string, status: number) {
  return Response.json({ error: message }, { status });
}

class MissingBecEnvError extends Error {
  constructor() {
    super("Missing BEC_API_KEY");
    this.name = "MissingBecEnvError";
  }
}
