import { z } from "zod";

import { createSupabaseServerClient, MissingServerEnvError } from "@/lib/supabaseServer";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

type ProspectRecord = Record<string, unknown> & {
  id: string | number;
  contact_email?: string | null;
  email_validation_attempts?: number | null;
};

type BecResult = {
  status: string;
  event: string | null;
  details: string | null;
  raw: unknown;
};

type ValidationSummary = {
  checked: number;
  valid: number;
  invalid_moved: number;
  unknown: number;
  errors: number;
  skipped: number;
};

const requestSchema = z.object({
  limit: z.coerce.number().int().optional(),
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

const ALLOWED_CONTACT_VALIDATION_STATUSES = new Set([
  "",
  "public source",
  "public_source_unverified",
  "unknown",
]);

const FINAL_EMAIL_VALIDATION_STATUSES = new Set([
  "valid",
  "unknown",
  "invalid",
  "skipped_no_email",
  "checking",
]);

export async function POST(request: Request) {
  try {
    const parsedBody = requestSchema.safeParse(await request.json().catch(() => ({})));

    if (!parsedBody.success) {
      return jsonError("Invalid request body.", 400);
    }

    const limit = clampLimit(parsedBody.data.limit ?? 50);
    const supabase = createSupabaseServerClient();
    const { data, error } = await supabase
      .from("prospects")
      .select("*")
      .not("contact_email", "is", null)
      .neq("contact_email", "")
      .or(
        "email_validation_status.is.null,email_validation_status.eq.not_checked,email_validation_status.eq.public_source_unverified,email_validation_status.eq.error",
      )
      .order("created_at", { ascending: true })
      .limit(limit);

    if (error) {
      return jsonError("Supabase select failure.", 500);
    }

    const prospects = ((data ?? []) as ProspectRecord[]).filter(shouldValidateRow);

    if (prospects.length === 0) {
      return Response.json({
        checked: 0,
        valid: 0,
        invalid_moved: 0,
        unknown: 0,
        errors: 0,
        skipped: 0,
        message: "No emails need validation.",
      });
    }

    const summary: ValidationSummary = {
      checked: 0,
      valid: 0,
      invalid_moved: 0,
      unknown: 0,
      errors: 0,
      skipped: 0,
    };

    for (const [index, prospect] of prospects.entries()) {
      await validateProspectEmail(prospect, summary);

      if (index < prospects.length - 1) {
        await delay(300);
      }
    }

    return Response.json({
      ...summary,
      message: `Checked ${summary.checked} emails. Valid kept: ${summary.valid}. Invalid moved: ${summary.invalid_moved}. Unknown kept: ${summary.unknown}. Errors kept: ${summary.errors}.`,
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

async function validateProspectEmail(
  prospect: ProspectRecord,
  summary: ValidationSummary,
) {
  const supabase = createSupabaseServerClient();
  const normalizedEmail = extractEmail(prospect.contact_email);
  const attempts = (numberValue(prospect.email_validation_attempts) ?? 0) + 1;
  const checkedAt = new Date().toISOString();

  if (!normalizedEmail) {
    const { error } = await supabase
      .from("prospects")
      .update({
        email_validation_status: "skipped_no_email",
        contact_email_validation_status: "Skipped - No Email",
        email_validation_checked_at: checkedAt,
        email_validation_attempts: attempts,
      })
      .eq("id", prospect.id);

    if (error) {
      summary.errors += 1;
      return;
    }

    summary.skipped += 1;
    return;
  }

  summary.checked += 1;

  const { error: checkingError } = await supabase
    .from("prospects")
    .update({
      email_validation_status: "checking",
      email_validation_error: null,
      email_validation_attempts: attempts,
    })
    .eq("id", prospect.id);

  if (checkingError) {
    summary.errors += 1;
    return;
  }

  const result = await checkEmailWithBulkEmailChecker(normalizedEmail);
  const status = result.status.toLowerCase();

  if (status === "passed") {
    const updated = await updateProspectValidation(prospect.id, {
      email_validation_status: "valid",
      contact_email_validation_status: "Valid",
      email_validation_checked_at: checkedAt,
      email_validation_provider: "bulk_email_checker",
      email_validation_checked_email: normalizedEmail,
      bec_status: result.status,
      bec_event: result.event,
      bec_details: result.details,
      bec_raw_json: result.raw,
      email_validation_error: null,
    });

    summary[updated ? "valid" : "errors"] += 1;
    return;
  }

  if (status === "failed") {
    const moved = await archiveAndDeleteInvalidEmail(
      prospect,
      normalizedEmail,
      result,
      checkedAt,
    );

    summary[moved ? "invalid_moved" : "errors"] += 1;
    return;
  }

  if (status === "unknown") {
    const updated = await updateProspectValidation(prospect.id, {
      email_validation_status: "unknown",
      contact_email_validation_status: result.event
        ? `Unknown - ${result.event}`
        : "Unknown",
      email_validation_checked_at: checkedAt,
      email_validation_provider: "bulk_email_checker",
      email_validation_checked_email: normalizedEmail,
      bec_status: result.status,
      bec_event: result.event,
      bec_details: result.details,
      bec_raw_json: result.raw,
      email_validation_error: null,
    });

    summary[updated ? "unknown" : "errors"] += 1;
    return;
  }

  await updateProspectValidation(prospect.id, {
    email_validation_status: "error",
    contact_email_validation_status: "Error",
    email_validation_checked_at: checkedAt,
    email_validation_provider: "bulk_email_checker",
    email_validation_checked_email: normalizedEmail,
    bec_status: "error",
    bec_event: result.event,
    bec_details: result.details,
    bec_raw_json: result.raw,
    email_validation_error: getSafeError(result),
  });

  summary.errors += 1;
}

async function archiveAndDeleteInvalidEmail(
  prospect: ProspectRecord,
  normalizedEmail: string,
  result: BecResult,
  checkedAt: string,
) {
  const supabase = createSupabaseServerClient();
  const archiveRow = {
    ...prospect,
    original_prospect_id: prospect.id,
    checked_email: normalizedEmail,
    bec_status_archived: result.status,
    bec_event_archived: result.event,
    bec_details_archived: result.details,
    bec_raw_json_archived: result.raw,
    moved_to_invalid_emails_at: checkedAt,
    email_validation_status: "invalid",
    contact_email_validation_status: "Invalid",
    email_validation_checked_at: checkedAt,
    email_validation_provider: "bulk_email_checker",
    email_validation_checked_email: normalizedEmail,
    bec_status: result.status,
    bec_event: result.event,
    bec_details: result.details,
    bec_raw_json: result.raw,
    email_validation_error: null,
  };
  const { error: archiveError } = await supabase
    .from("prospects_invalid_emails")
    .upsert(archiveRow, { onConflict: "original_prospect_id" });

  if (archiveError) {
    await updateProspectValidation(prospect.id, {
      email_validation_status: "error",
      email_validation_error: "Failed to archive invalid email before delete.",
    });
    return false;
  }

  const { error: deleteError } = await supabase
    .from("prospects")
    .delete()
    .eq("id", prospect.id);

  if (deleteError) {
    await updateProspectValidation(prospect.id, {
      email_validation_status: "error",
      email_validation_error: "Failed to delete invalid email after archive.",
    });
    return false;
  }

  return true;
}

async function updateProspectValidation(
  id: string | number,
  values: Record<string, unknown>,
) {
  const supabase = createSupabaseServerClient();
  const { error } = await supabase.from("prospects").update(values).eq("id", id);
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

function shouldValidateRow(prospect: ProspectRecord) {
  const emailStatus = stringValue(prospect.email_validation_status).toLowerCase();
  const contactStatus = stringValue(
    prospect.contact_email_validation_status,
  ).toLowerCase();

  if (FINAL_EMAIL_VALIDATION_STATUSES.has(emailStatus)) {
    return false;
  }

  if (emailStatus) {
    return true;
  }

  return (
    !contactStatus || ALLOWED_CONTACT_VALIDATION_STATUSES.has(contactStatus)
  );
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

function stringValue(value: unknown) {
  return typeof value === "string" ? value : "";
}

function nullableString(value: unknown) {
  if (typeof value !== "string") {
    return null;
  }

  return value;
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
