import OpenAI from "openai";
import type { ResponseCreateParamsNonStreaming } from "openai/resources/responses/responses";
import { z } from "zod";

import { ENRICHMENT_SYSTEM_PROMPT } from "@/lib/openai/enrichment-prompt";
import {
  enrichmentResultSchema,
  enrichmentSchema,
  type EnrichmentResult,
} from "@/lib/openai/enrichment-schema";
import {
  createSupabaseServerClient,
  MissingServerEnvError,
} from "@/lib/supabaseServer";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

const MODEL = process.env.OPENAI_ENRICH_MODEL || "gpt-5.4-mini";

const ENRICH_SELECT_FIELDS = `
  id,
  school_name,
  website,
  main_phone,
  full_address,
  city,
  state,
  google_place_id,
  google_maps_url,
  source_urls,
  raw_google_json,
  enrichment_status,
  enrichment_attempts
`;

const enrichRequestSchema = z.object({
  limit: z.coerce.number().int().optional(),
});

type ProspectToEnrich = {
  id: string | number;
  school_name: string | null;
  website: string | null;
  main_phone: string | null;
  full_address: string | null;
  city: string | null;
  state: string | null;
  google_place_id: string | null;
  google_maps_url: string | null;
  source_urls: string[] | null;
  raw_google_json: unknown;
  enrichment_status: string | null;
  enrichment_attempts: number | null;
};

type EnrichmentResultItem = {
  id: string | number;
  school_name: string;
  status: "enriched" | "enrichment_failed";
  error?: string;
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

export async function POST(request: Request) {
  try {
    const parsedBody = enrichRequestSchema.safeParse(
      await request.json().catch(() => ({})),
    );

    if (!parsedBody.success) {
      return jsonError("Invalid request body.", 400);
    }

    const limit = clampLimit(parsedBody.data.limit ?? 5);
    const openai = createOpenAIClient();
    const supabase = createSupabaseServerClient();
    const { data, error } = await supabase
      .from("prospects")
      .select(ENRICH_SELECT_FIELDS)
      .or(
        "enrichment_status.is.null,enrichment_status.eq.raw,enrichment_status.eq.enrichment_failed",
      )
      .order("created_at", { ascending: true })
      .limit(limit);

    if (error) {
      return jsonError("Supabase query failure.", 500);
    }

    const prospects = ((data ?? []) as ProspectToEnrich[]).filter(Boolean);

    if (prospects.length === 0) {
      return Response.json({
        attempted: 0,
        enriched: 0,
        failed: 0,
        message: "No unenriched prospects found.",
        results: [],
      });
    }

    const results: EnrichmentResultItem[] = [];

    for (const prospect of prospects) {
      const schoolName = prospect.school_name ?? "Unknown School";
      const started = await markProspectEnriching(prospect);

      if (!started) {
        results.push({
          id: prospect.id,
          school_name: schoolName,
          status: "enrichment_failed",
          error: "Supabase update failure.",
        });
        continue;
      }

      try {
        const enrichment = await enrichProspect(openai, prospect);
        const updated = await updateProspectWithEnrichment(prospect, enrichment);

        if (!updated) {
          throw new ProspectEnrichmentError("Supabase update failure.");
        }

        results.push({
          id: prospect.id,
          school_name: schoolName,
          status: "enriched",
        });
      } catch (error) {
        const safeError = getSafeErrorMessage(error);
        await markProspectFailed(prospect.id, safeError);
        results.push({
          id: prospect.id,
          school_name: schoolName,
          status: "enrichment_failed",
          error: safeError,
        });
      }
    }

    const enriched = results.filter((result) => result.status === "enriched").length;
    const failed = results.length - enriched;

    return Response.json({
      attempted: results.length,
      enriched,
      failed,
      message:
        results.length === 0
          ? "No unenriched prospects found."
          : `Enhanced ${enriched} prospects. ${failed} failed.`,
      results,
    });
  } catch (error) {
    if (error instanceof MissingOpenAIEnvError) {
      return jsonError("Missing OPENAI_API_KEY", 500);
    }

    if (error instanceof MissingServerEnvError) {
      return jsonError(`Missing ${error.envName}`, 500);
    }

    return jsonError("Unexpected server error.", 500);
  }
}

async function markProspectEnriching(prospect: ProspectToEnrich) {
  const supabase = createSupabaseServerClient();
  const nextAttempts = (prospect.enrichment_attempts ?? 0) + 1;
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
  };
  const webSearchTool = {
    type: "web_search",
    search_context_size: "medium",
    external_web_access: true,
    user_location: {
      type: "approximate",
      country: "US",
      city: prospect.city || undefined,
      region: prospect.state || undefined,
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
  const parsed = enrichment.parsed;
  const { error } = await supabase
    .from("prospects")
    .update({
      school_type: parsed.school_type,
      grades_served: parsed.grades_served,
      hs_enrollment: parsed.hs_enrollment,
      total_enrollment: parsed.total_enrollment,
      student_life_url: parsed.student_life_url,
      clubs_activities_url: parsed.clubs_activities_url,
      clubs_count_estimate: parsed.clubs_count_estimate,
      club_activity_signal: parsed.club_activity_signal,
      fit_score: parsed.fit_score,
      personalization_angle: parsed.personalization_angle,
      research_notes: parsed.research_notes,
      source_urls: parsed.source_urls,
      target_persona: parsed.target_persona,
      contact_name: parsed.contact_name,
      contact_title: parsed.contact_title,
      contact_email: parsed.contact_email,
      contact_phone: parsed.contact_phone,
      contact_source_url: parsed.contact_source_url,
      contact_confidence: parsed.contact_confidence,
      fields_not_found: parsed.fields_not_found,
      contact_email_validation_status: parsed.contact_email
        ? "public_source_unverified"
        : "unknown",
      raw_openai_json: {
        parsed,
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

  return !error;
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
