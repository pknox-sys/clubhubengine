import { z } from "zod";

const nullableString = { type: ["string", "null"] };
const nullableInteger = { type: ["integer", "null"] };
const nullableScore = { type: ["integer", "null"], minimum: 0, maximum: 100 };
const stringArray = {
  type: "array",
  items: { type: "string" },
};

export const enrichmentSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    school_type: nullableString,
    grades_served: nullableString,
    hs_enrollment: nullableInteger,
    total_enrollment: nullableInteger,
    student_life_url: nullableString,
    clubs_activities_url: nullableString,
    clubs_count_estimate: nullableInteger,
    club_activity_signal: nullableString,
    fit_score: nullableScore,
    personalization_angle: nullableString,
    research_notes: nullableString,
    source_urls: stringArray,
    target_persona: nullableString,
    contact_name: nullableString,
    contact_title: nullableString,
    contact_email: nullableString,
    contact_phone: nullableString,
    contact_source_url: nullableString,
    contact_confidence: nullableScore,
    fields_not_found: stringArray,
  },
  required: [
    "school_type",
    "grades_served",
    "hs_enrollment",
    "total_enrollment",
    "student_life_url",
    "clubs_activities_url",
    "clubs_count_estimate",
    "club_activity_signal",
    "fit_score",
    "personalization_angle",
    "research_notes",
    "source_urls",
    "target_persona",
    "contact_name",
    "contact_title",
    "contact_email",
    "contact_phone",
    "contact_source_url",
    "contact_confidence",
    "fields_not_found",
  ],
};

export const enrichmentResultSchema = z.object({
  school_type: z.string().nullable(),
  grades_served: z.string().nullable(),
  hs_enrollment: z.number().int().nullable(),
  total_enrollment: z.number().int().nullable(),
  student_life_url: z.string().nullable(),
  clubs_activities_url: z.string().nullable(),
  clubs_count_estimate: z.number().int().nullable(),
  club_activity_signal: z.string().nullable(),
  fit_score: z.number().int().min(0).max(100).nullable(),
  personalization_angle: z.string().nullable(),
  research_notes: z.string().nullable(),
  source_urls: z.array(z.string()),
  target_persona: z.string().nullable(),
  contact_name: z.string().nullable(),
  contact_title: z.string().nullable(),
  contact_email: z.string().nullable(),
  contact_phone: z.string().nullable(),
  contact_source_url: z.string().nullable(),
  contact_confidence: z.number().int().min(0).max(100).nullable(),
  fields_not_found: z.array(z.string()),
});

export type EnrichmentResult = z.infer<typeof enrichmentResultSchema>;
