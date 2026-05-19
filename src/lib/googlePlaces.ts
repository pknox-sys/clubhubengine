import type { ProspectInsertRow } from "@/types/prospect";

export const GOOGLE_PLACES_FIELD_MASK =
  "places.id,places.displayName,places.formattedAddress,places.addressComponents,places.websiteUri,places.internationalPhoneNumber,places.nationalPhoneNumber,places.googleMapsUri,places.businessStatus,places.types,places.rating,places.userRatingCount,places.location";

export type GoogleAddressComponent = {
  longText?: string;
  shortText?: string;
  types?: string[];
};

export type GooglePlace = {
  id?: string;
  displayName?: { text?: string; languageCode?: string };
  formattedAddress?: string;
  addressComponents?: GoogleAddressComponent[];
  websiteUri?: string;
  internationalPhoneNumber?: string;
  nationalPhoneNumber?: string;
  googleMapsUri?: string;
  businessStatus?: string;
  types?: string[];
  rating?: number;
  userRatingCount?: number;
  location?: { latitude?: number; longitude?: number };
};

export type GooglePlacesTextSearchResponse = {
  places?: GooglePlace[];
};

type SearchValues = {
  keyword: string;
  city: string;
  state: string;
};

type GoogleErrorPayload = {
  error?: {
    message?: string;
  };
};

export class GooglePlacesError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "GooglePlacesError";
  }
}

export function getGoogleMapsApiKey(): string {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;

  if (!apiKey) {
    throw new GooglePlacesError("Missing GOOGLE_MAPS_API_KEY");
  }

  return apiKey;
}

export async function searchGooglePlaces(
  textQuery: string,
): Promise<GooglePlacesTextSearchResponse> {
  const response = await fetch("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": getGoogleMapsApiKey(),
      "X-Goog-FieldMask": GOOGLE_PLACES_FIELD_MASK,
    },
    body: JSON.stringify({
      textQuery,
      pageSize: 20,
    }),
    cache: "no-store",
  });

  const payload = (await response.json().catch(() => null)) as
    | GooglePlacesTextSearchResponse
    | GoogleErrorPayload
    | null;

  if (!response.ok) {
    const googleMessage =
      payload && "error" in payload ? payload.error?.message : undefined;

    throw new GooglePlacesError(
      googleMessage
        ? `Google Places API request failed: ${googleMessage}`
        : `Google Places API request failed with status ${response.status}`,
      response.status,
    );
  }

  return (payload ?? {}) as GooglePlacesTextSearchResponse;
}

export function getCityState(
  addressComponents: GoogleAddressComponent[] | undefined,
  fallbackCity: string,
  fallbackState: string,
) {
  const components = addressComponents ?? [];
  const cityComponent =
    components.find((component) => component.types?.includes("locality")) ??
    components.find((component) =>
      component.types?.includes("administrative_area_level_3"),
    );
  const stateComponent = components.find((component) =>
    component.types?.includes("administrative_area_level_1"),
  );

  return {
    city: cityComponent?.longText ?? cityComponent?.shortText ?? fallbackCity,
    state: stateComponent?.shortText ?? fallbackState,
  };
}

export function mapGooglePlaceToProspect(
  place: GooglePlace,
  searchValues: SearchValues,
): ProspectInsertRow {
  const googlePlaceId = cleanString(place.id);
  const googleMapsUrl = cleanString(place.googleMapsUri);
  const website = cleanString(place.websiteUri);
  const schoolName = cleanString(place.displayName?.text) ?? "Unknown School";
  const fullAddress = cleanString(place.formattedAddress);
  const { city, state } = getCityState(
    place.addressComponents,
    searchValues.city,
    searchValues.state,
  );
  const sourceUrls = [website, googleMapsUrl].filter(
    (url): url is string => Boolean(url),
  );

  return {
    search_keyword: searchValues.keyword,
    search_city: searchValues.city,
    search_state: searchValues.state,
    google_place_id: googlePlaceId,
    google_maps_url: googleMapsUrl,
    school_name: schoolName,
    website,
    main_phone:
      cleanString(place.internationalPhoneNumber) ??
      cleanString(place.nationalPhoneNumber),
    full_address: fullAddress,
    city,
    state,
    school_type: getSchoolType(place.types),
    source_urls: sourceUrls,
    enrichment_status: "raw",
    email_validation_status: "not_checked",
    dedupe_key: googlePlaceId
      ? `google:${googlePlaceId}`
      : `fallback:${normalizeDedupePart(schoolName)}:${normalizeDedupePart(
          fullAddress,
        )}`,
    raw_google_json: place,
  };
}

function getSchoolType(types: string[] | undefined): string | null {
  if (types?.includes("secondary_school")) {
    return "secondary_school";
  }

  if (types?.includes("school")) {
    return "school";
  }

  return null;
}

function cleanString(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function normalizeDedupePart(value: string | null): string {
  const normalized = (value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, "-");

  return normalized || "unknown";
}
