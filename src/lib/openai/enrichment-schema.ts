import { z } from "zod";

const nullableString = { type: ["string", "null"] };
const nullableInteger = { type: ["integer", "null"] };
const nullableScore = { type: ["integer", "null"], minimum: 0, maximum: 100 };
const stringArray = {
  type: "array",
  items: { type: "string" },
};
const schoolType = { type: ["string", "null"], enum: ["Private", "Charter", "Public", "", null] };
const religion = { type: ["string", "null"], enum: ["Christian", "Jewish", "Other", "", null] };
const boyGirl = { type: ["string", "null"], enum: ["All Boys", "All Girls", "", null] };
const dayBoarding = {
  type: ["string", "null"],
  enum: ["Day", "Boarding", "Boarding & Day", "", null],
};
const employeeRange = {
  type: ["string", "null"],
  enum: [
    "1-5",
    "5-25",
    "25-50",
    "50-100",
    "100-500",
    "500-1000",
    "1000-5000",
    "5000-10000",
    "10000+",
    "",
    null,
  ],
};
const confidence = {
  type: ["string", "null"],
  enum: ["High", "Medium", "Low", "", null],
};
const emailValidationStatus = {
  type: ["string", "null"],
  enum: ["Valid", "Unknown", "Error", "", null],
};
const emailSource = {
  type: ["string", "null"],
  enum: ["public_source", "pattern_inferred", "", null],
};

function described<T extends Record<string, unknown>>(
  schema: T,
  description: string,
) {
  return { ...schema, description };
}

const schoolProperties = {
  company_name: nullableString,
  company_domain_name: nullableString,
  company_owner: nullableString,
  street_address: nullableString,
  state_region_code: nullableString,
  postal_code: nullableString,
  time_zone: nullableString,
  industry: nullableString,
  company_type: nullableString,
  record_source: nullableString,
  school_type: schoolType,
  religion,
  school_structure: nullableString,
  school_structure_boy_girl: boyGirl,
  school_structure_day_boarding: dayBoarding,
  school_divisions: nullableString,
  low_grade: nullableString,
  high_grade: nullableString,
  number_of_students: described(
    nullableString,
    "Priority field. Clean number-only total student enrollment from official profile/facts page first, then Niche, Private School Review, GreatSchools, NCES, or state directory. No commas or text.",
  ),
  number_of_clubs: described(
    nullableString,
    "Priority field. Clean number-only club/activity count. Use stated count when available; otherwise count a visible official club/activity list and note caveats in export_notes.",
  ),
  list_of_clubs: described(
    nullableString,
    "Semicolon-separated top 10-25 club or student organization names from official or profile sources when available.",
  ),
  clubs_letter_grade: nullableString,
  percent_clubs_get_funding: nullableString,
  percent_lots_of_participation: nullableString,
  percent_plenty_of_clubs: nullableString,
  tuition: nullableString,
  niche_ranking: nullableString,
  number_of_employees_range: employeeRange,
  annual_revenue: nullableString,
  subscription_year: nullableString,
  description: nullableString,
  linkedin_company_page: nullableString,
  reference_school: nullableString,
  reference_school_reason: nullableString,
  ai_fit_reason: nullableString,
  source_url: described(
    nullableString,
    "Best evidence URL for enrollment, club/activity count, student-life fit, school profile, or best contact.",
  ),
  data_confidence: confidence,
  export_notes: nullableString,
  grades_served: nullableString,
  hs_enrollment: described(
    nullableInteger,
    "High school or upper school enrollment only when the source clearly refers to grades 9-12, upper school, high school, or secondary enrollment.",
  ),
  total_enrollment: described(
    nullableInteger,
    "Whole-school enrollment as an integer when a reliable source gives total students.",
  ),
  student_life_url: described(
    nullableString,
    "Official student life URL when found.",
  ),
  clubs_activities_url: described(
    nullableString,
    "Best official clubs, activities, student organizations, club fair, handbook, or student life URL used for club evidence.",
  ),
  clubs_count_estimate: described(
    nullableInteger,
    "Integer club count estimate. Mirror number_of_clubs when count is from a list or profile rather than a directly stated official total.",
  ),
  club_activity_signal: described(
    nullableString,
    "Qualitative evidence of student life or club activity when exact club count is unavailable.",
  ),
  fit_score: nullableScore,
  personalization_angle: nullableString,
  research_notes: nullableString,
  source_urls: stringArray,
  target_persona: nullableString,
  fields_not_found: stringArray,
};

const contactProperties = {
  first_name: described(
    nullableString,
    "Adult professional first name when known. Leave null for a department-level fallback contact.",
  ),
  last_name: described(
    nullableString,
    "Adult professional last name when known. Leave null for a department-level fallback contact.",
  ),
  email: described(
    nullableString,
    "Person-specific school/work email when public or safely pattern-inferred. Leave null when no email is available; do not drop the contact.",
  ),
  email_source: emailSource,
  email_pattern_domain: described(
    nullableString,
    "Domain used for a public staff email pattern, such as chsd218.org. Null when no pattern was found or used.",
  ),
  email_pattern_example: described(
    nullableString,
    "One public adult staff email proving the pattern, such as danita.allen@chsd218.org. Null when no pattern was found or used.",
  ),
  email_pattern_evidence: described(
    nullableString,
    "Short note naming the public source or observed pattern used to infer this contact's email. Null when no pattern was found or used.",
  ),
  phone_number: nullableString,
  job_title: described(
    nullableString,
    "Exact public title or useful department role. Required in practice for no-email contacts.",
  ),
  contact_rank: nullableInteger,
  sequence_pick: { type: ["boolean", "null"] },
  best_contact_reason: described(
    nullableString,
    "One sentence explaining why this adult is relevant for student life, activities, clubs, events, administration, or school operations.",
  ),
  email_validation_status: emailValidationStatus,
  contact_source_url: described(
    nullableString,
    "Best source URL proving the contact identity, title, department, staff page, directory, or LinkedIn match.",
  ),
  contact_confidence: confidence,
  notes: described(
    nullableString,
    "Short caveat. If email is missing, include: Email not found; use school main phone or validate pattern manually.",
  ),
};

export const enrichmentSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    school: {
      type: "object",
      additionalProperties: false,
      properties: schoolProperties,
      required: Object.keys(schoolProperties),
    },
    contacts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: contactProperties,
        required: Object.keys(contactProperties),
      },
    },
  },
  required: ["school", "contacts"],
};

const nullableTextSchema = z.string().nullable();
const confidenceSchema = z.enum(["High", "Medium", "Low", ""]).nullable();

export const enrichmentContactSchema = z.object({
  first_name: nullableTextSchema,
  last_name: nullableTextSchema,
  email: nullableTextSchema,
  email_source: z.enum(["public_source", "pattern_inferred", ""]).nullable(),
  email_pattern_domain: nullableTextSchema,
  email_pattern_example: nullableTextSchema,
  email_pattern_evidence: nullableTextSchema,
  phone_number: nullableTextSchema,
  job_title: nullableTextSchema,
  contact_rank: z.number().int().nullable(),
  sequence_pick: z.boolean().nullable(),
  best_contact_reason: nullableTextSchema,
  email_validation_status: z.enum(["Valid", "Unknown", "Error", ""]).nullable(),
  contact_source_url: nullableTextSchema,
  contact_confidence: confidenceSchema,
  notes: nullableTextSchema,
});

export const enrichmentSchoolSchema = z.object({
  company_name: nullableTextSchema,
  company_domain_name: nullableTextSchema,
  company_owner: nullableTextSchema,
  street_address: nullableTextSchema,
  state_region_code: nullableTextSchema,
  postal_code: nullableTextSchema,
  time_zone: nullableTextSchema,
  industry: nullableTextSchema,
  company_type: nullableTextSchema,
  record_source: nullableTextSchema,
  school_type: z.enum(["Private", "Charter", "Public", ""]).nullable(),
  religion: z.enum(["Christian", "Jewish", "Other", ""]).nullable(),
  school_structure: nullableTextSchema,
  school_structure_boy_girl: z.enum(["All Boys", "All Girls", ""]).nullable(),
  school_structure_day_boarding: z
    .enum(["Day", "Boarding", "Boarding & Day", ""])
    .nullable(),
  school_divisions: nullableTextSchema,
  low_grade: nullableTextSchema,
  high_grade: nullableTextSchema,
  number_of_students: nullableTextSchema,
  number_of_clubs: nullableTextSchema,
  list_of_clubs: nullableTextSchema,
  clubs_letter_grade: nullableTextSchema,
  percent_clubs_get_funding: nullableTextSchema,
  percent_lots_of_participation: nullableTextSchema,
  percent_plenty_of_clubs: nullableTextSchema,
  tuition: nullableTextSchema,
  niche_ranking: nullableTextSchema,
  number_of_employees_range: z
    .enum([
      "1-5",
      "5-25",
      "25-50",
      "50-100",
      "100-500",
      "500-1000",
      "1000-5000",
      "5000-10000",
      "10000+",
      "",
    ])
    .nullable(),
  annual_revenue: nullableTextSchema,
  subscription_year: nullableTextSchema,
  description: nullableTextSchema,
  linkedin_company_page: nullableTextSchema,
  reference_school: nullableTextSchema,
  reference_school_reason: nullableTextSchema,
  ai_fit_reason: nullableTextSchema,
  source_url: nullableTextSchema,
  data_confidence: confidenceSchema,
  export_notes: nullableTextSchema,
  grades_served: nullableTextSchema,
  hs_enrollment: z.number().int().nullable(),
  total_enrollment: z.number().int().nullable(),
  student_life_url: nullableTextSchema,
  clubs_activities_url: nullableTextSchema,
  clubs_count_estimate: z.number().int().nullable(),
  club_activity_signal: nullableTextSchema,
  fit_score: z.number().int().min(0).max(100).nullable(),
  personalization_angle: nullableTextSchema,
  research_notes: nullableTextSchema,
  source_urls: z.array(z.string()),
  target_persona: nullableTextSchema,
  fields_not_found: z.array(z.string()),
});

export const enrichmentResultSchema = z.object({
  school: enrichmentSchoolSchema,
  contacts: z.array(enrichmentContactSchema),
});

export type EnrichmentResult = z.infer<typeof enrichmentResultSchema>;
export type EnrichmentContact = z.infer<typeof enrichmentContactSchema>;
export type EnrichmentSchool = z.infer<typeof enrichmentSchoolSchema>;
