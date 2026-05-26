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
  email_validation_status?: string | null;
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
};

const requestSchema = z.object({
  limit: z.coerce.number().int().optional(),
  prospectIds: z.array(z.union([z.string(), z.number()])).optional(),
  runId: z.string().trim().optional(),
  runIds: z.array(z.string().trim().min(1)).optional(),
  retryErrors: z.boolean().optional(),
  minStudents: z.coerce.number().int().positive().optional(),
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

export async function POST(request: Request) {
  try {
    const parsedBody = requestSchema.safeParse(await request.json().catch(() => ({})));

    if (!parsedBody.success) {
      return jsonError("Invalid request body.", 400);
    }

    const body = parsedBody.data;
    const limit = clampLimit(body.limit ?? 50);
    const supabase = createSupabaseServerClient();
    const { targets, skippedResults, scope } = await loadValidationTargets(
      supabase,
      {
        limit,
        prospectIds: body.prospectIds?.map((id) => String(id)) ?? [],
        runId: body.runId?.trim() ?? "",
        runIds: body.runIds ?? [],
        retryErrors: body.retryErrors ?? false,
        minStudents: body.minStudents,
      },
    );

    const summary: ValidationSummary = {
      checked: 0,
      valid: 0,
      invalid: 0,
      unknown: 0,
      errors: 0,
      skipped: skippedResults.length,
    };
    const results: ValidationResultItem[] = [...skippedResults];

    for (const [index, target] of targets.entries()) {
      const result = await validateTargetEmail(supabase, target);
      results.push(result);

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

    return Response.json({
      ...summary,
      scope,
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
  },
): Promise<CandidateLoadResult> {
  const scopedProspectIds = await resolveScopedProspectIds(supabase, options);
  const isScoped = Boolean(
    options.prospectIds.length > 0 || options.runId || options.runIds.length > 0,
  );
  const scope = getScopeLabel(options, scopedProspectIds);

  if (scopedProspectIds && scopedProspectIds.length === 0) {
    return { targets: [], skippedResults: [], scope };
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

  for (const contact of filteredContacts) {
    const prospectId = String(contact.prospect_id ?? "");
    const prospect = prospectsById.get(prospectId);
    const schoolName = stringValue(prospect?.school_name);
    const contactName = getContactName(contact);
    const email = extractEmail(contact.email);
    const currentStatus = normalizeStatus(contact.email_validation_status);

    if (!email) {
      if (isScoped) {
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
      if (isScoped) {
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
      if (isScoped) {
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
      if (isScoped) {
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

  return { targets, skippedResults, scope };
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

  const { data, error } = await supabase
    .from("prospect_run_prospects")
    .select("prospect_id")
    .in("run_id", runIds)
    .limit(10_000);

  if (error) {
    throw new Error("Unable to load run prospect membership.");
  }

  return uniqueStrings(
    (data ?? [])
      .map((row: { prospect_id?: string | number | null }) => row.prospect_id)
      .filter((id): id is string | number => id !== null && id !== undefined)
      .map((id) => String(id)),
  );
}

async function loadContacts(
  supabase: SupabaseClient,
  scopedProspectIds: string[] | null,
) {
  let query = supabase
    .from("prospect_contacts")
    .select("*")
    .order("contact_rank", { ascending: true })
    .order("created_at", { ascending: true });

  if (scopedProspectIds) {
    if (scopedProspectIds.length === 0) {
      return [] as ProspectContactRecord[];
    }

    query = query.in("prospect_id", scopedProspectIds);
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

    const { data, error } = await supabase
      .from("prospects")
      .select("*")
      .in("id", scopedProspectIds)
      .limit(10_000);

    if (error) {
      throw new Error("Unable to load scoped prospects.");
    }

    return (data ?? []) as ProspectRecord[];
  }

  const contactIds = uniqueStrings(contactProspectIds);
  const prospectsById = new Map<string, ProspectRecord>();

  if (contactIds.length > 0) {
    const { data, error } = await supabase
      .from("prospects")
      .select("*")
      .in("id", contactIds)
      .limit(10_000);

    if (error) {
      throw new Error("Unable to load contact prospects.");
    }

    for (const prospect of (data ?? []) as ProspectRecord[]) {
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

function nullableString(value: unknown) {
  if (typeof value !== "string") {
    return null;
  }

  return value;
}

function uniqueStrings(values: string[]) {
  return Array.from(new Set(values.filter(Boolean)));
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
