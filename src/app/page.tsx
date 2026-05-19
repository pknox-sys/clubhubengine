"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";

import type { ProspectListItem } from "@/types/prospect";

type ProspectsResponse = {
  prospects?: ProspectListItem[];
  count?: number;
  error?: string;
};

type EnrichResponse = {
  attempted?: number;
  enriched?: number;
  failed?: number;
  message?: string;
  error?: string;
};

type ActionResponse = {
  message?: string;
  error?: string;
};

const DEFAULT_KEYWORD = "private high school";
const DEFAULT_CITY = "Chicago";
const DEFAULT_STATE = "IL";

export default function Home() {
  const [keyword, setKeyword] = useState(DEFAULT_KEYWORD);
  const [city, setCity] = useState(DEFAULT_CITY);
  const [state, setState] = useState(DEFAULT_STATE);
  const [prospects, setProspects] = useState<ProspectListItem[]>([]);
  const [isLoadingRecent, setIsLoadingRecent] = useState(false);
  const [isSearching, setIsSearching] = useState(false);
  const [isEnhancing, setIsEnhancing] = useState(false);
  const [isDedupeRunning, setIsDedupeRunning] = useState(false);
  const [isEmailValidationRunning, setIsEmailValidationRunning] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const loadRecentProspects = useCallback(async () => {
    setIsLoadingRecent(true);
    setError("");

    try {
      setProspects(await fetchRecentProspects());
      setMessage("");
    } catch (loadError) {
      setError(getReadableError(loadError));
    } finally {
      setIsLoadingRecent(false);
    }
  }, []);

  useEffect(() => {
    let isMounted = true;

    async function loadInitialProspects() {
      try {
        const loadedProspects = await fetchRecentProspects();

        if (isMounted) {
          setProspects(loadedProspects);
        }
      } catch (loadError) {
        if (isMounted) {
          setError(getReadableError(loadError));
        }
      }
    }

    void loadInitialProspects();

    return () => {
      isMounted = false;
    };
  }, []);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsSearching(true);
    setMessage("");
    setError("");

    try {
      const response = await fetch("/api/prospects/google-search", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ keyword, city, state }),
      });
      const payload = (await response.json()) as ProspectsResponse;

      if (!response.ok) {
        throw new Error(payload.error ?? "Unable to save prospects.");
      }

      const savedProspects = payload.prospects ?? [];
      setProspects(savedProspects);
      setMessage(
        `${payload.count ?? savedProspects.length} prospects saved from Google Places.`,
      );
    } catch (searchError) {
      setError(getReadableError(searchError));
    } finally {
      setIsSearching(false);
    }
  }

  async function handleEnhance() {
    setIsEnhancing(true);
    setMessage("");
    setError("");

    try {
      const response = await fetch("/api/prospects/enrich", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ limit: 5 }),
      });
      const payload = (await response.json()) as EnrichResponse;

      if (!response.ok) {
        throw new Error(payload.error ?? "Unable to enhance prospects.");
      }

      setProspects(await fetchRecentProspects());
      setMessage(payload.message ?? "Enhancement completed.");
    } catch (enhanceError) {
      setError(getReadableError(enhanceError));
    } finally {
      setIsEnhancing(false);
    }
  }

  async function handleDedupe() {
    setIsDedupeRunning(true);
    setMessage("");
    setError("");

    try {
      const response = await fetch("/api/prospects/dedupe", {
        method: "POST",
      });
      const payload = (await response.json()) as ActionResponse;

      if (!response.ok) {
        throw new Error(payload.error ?? "Unable to de-dupe prospects.");
      }

      setProspects(await fetchRecentProspects());
      setMessage(payload.message ?? "De-dupe completed.");
    } catch (dedupeError) {
      setError(getReadableError(dedupeError));
    } finally {
      setIsDedupeRunning(false);
    }
  }

  async function handleValidateEmails() {
    setIsEmailValidationRunning(true);
    setMessage("");
    setError("");

    try {
      const response = await fetch("/api/prospects/validate-emails", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ limit: 50 }),
      });
      const payload = (await response.json()) as ActionResponse;

      if (!response.ok) {
        throw new Error(payload.error ?? "Unable to validate emails.");
      }

      setProspects(await fetchRecentProspects());
      setMessage(payload.message ?? "Email validation completed.");
    } catch (validationError) {
      setError(getReadableError(validationError));
    } finally {
      setIsEmailValidationRunning(false);
    }
  }

  const isLoading =
    isLoadingRecent ||
    isSearching ||
    isEnhancing ||
    isDedupeRunning ||
    isEmailValidationRunning;

  return (
    <main className="min-h-screen bg-slate-50 px-6 py-8 text-slate-950">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-6">
        <header className="border-b border-slate-200 pb-5">
          <h1 className="text-3xl font-semibold tracking-normal">
            Club Hub Prospect Engine V1
          </h1>
          <p className="mt-2 max-w-3xl text-base leading-7 text-slate-600">
            Google Places prospect search for finding and saving school records
            into Supabase.
          </p>
        </header>

        <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
          <form
            className="grid gap-4 xl:grid-cols-[minmax(220px,1.2fr)_minmax(160px,0.8fr)_100px_repeat(5,minmax(140px,auto))]"
            onSubmit={handleSubmit}
          >
            <label className="flex flex-col gap-2 text-sm font-medium text-slate-700">
              Keyword
              <input
                className="h-11 rounded-md border border-slate-300 px-3 text-base text-slate-950 outline-none transition focus:border-slate-900 focus:ring-2 focus:ring-slate-200"
                minLength={2}
                name="keyword"
                onChange={(event) => setKeyword(event.target.value)}
                required
                type="text"
                value={keyword}
              />
            </label>

            <label className="flex flex-col gap-2 text-sm font-medium text-slate-700">
              City
              <input
                className="h-11 rounded-md border border-slate-300 px-3 text-base text-slate-950 outline-none transition focus:border-slate-900 focus:ring-2 focus:ring-slate-200"
                minLength={2}
                name="city"
                onChange={(event) => setCity(event.target.value)}
                required
                type="text"
                value={city}
              />
            </label>

            <label className="flex flex-col gap-2 text-sm font-medium text-slate-700">
              State
              <input
                className="h-11 rounded-md border border-slate-300 px-3 text-base uppercase text-slate-950 outline-none transition focus:border-slate-900 focus:ring-2 focus:ring-slate-200"
                minLength={2}
                name="state"
                onChange={(event) => setState(event.target.value)}
                required
                type="text"
                value={state}
              />
            </label>

            <div className="flex items-end">
              <button
                className="h-11 w-full rounded-md bg-slate-950 px-4 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-400"
                disabled={isLoading}
                type="submit"
              >
                {isSearching ? "Searching..." : "Search"}
              </button>
            </div>

            <div className="flex items-end">
              <button
                className="h-11 w-full rounded-md border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-900 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:text-slate-400"
                disabled={isLoading}
                onClick={loadRecentProspects}
                type="button"
              >
                {isLoadingRecent ? "Loading..." : "Load Recent"}
              </button>
            </div>

            <div className="flex items-end">
              <button
                className="h-11 w-full rounded-md bg-emerald-700 px-4 text-sm font-semibold text-white transition hover:bg-emerald-800 disabled:cursor-not-allowed disabled:bg-emerald-300"
                disabled={isLoading}
                onClick={handleEnhance}
                type="button"
              >
                {isEnhancing ? "Enhancing..." : "Enhance Unenriched Prospects"}
              </button>
            </div>

            <div className="flex items-end">
              <button
                className="h-11 w-full rounded-md bg-indigo-700 px-4 text-sm font-semibold text-white transition hover:bg-indigo-800 disabled:cursor-not-allowed disabled:bg-indigo-300"
                disabled={isLoading}
                onClick={handleDedupe}
                type="button"
              >
                {isDedupeRunning ? "De-duping..." : "De-Dupe Prospects"}
              </button>
            </div>

            <div className="flex items-end">
              <button
                className="h-11 w-full rounded-md bg-amber-600 px-4 text-sm font-semibold text-white transition hover:bg-amber-700 disabled:cursor-not-allowed disabled:bg-amber-300"
                disabled={isLoading}
                onClick={handleValidateEmails}
                type="button"
              >
                {isEmailValidationRunning ? "Validating..." : "Validate Emails"}
              </button>
            </div>
          </form>

          <div className="mt-4 min-h-6 text-sm">
            {message ? <p className="text-emerald-700">{message}</p> : null}
            {error ? <p className="text-red-700">{error}</p> : null}
          </div>
        </section>

        <section className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
          <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
            <h2 className="text-lg font-semibold">Saved Prospects</h2>
            <p className="text-sm text-slate-500">
              {isLoading ? "Loading..." : `${prospects.length} loaded`}
            </p>
          </div>

          {prospects.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="min-w-[1380px] table-fixed border-collapse text-left text-sm">
                <thead className="bg-slate-100 text-xs uppercase tracking-normal text-slate-600">
                  <tr>
                    <TableHeader className="w-56">School Name</TableHeader>
                    <TableHeader className="w-36">City</TableHeader>
                    <TableHeader className="w-20">State</TableHeader>
                    <TableHeader className="w-40">Phone</TableHeader>
                    <TableHeader className="w-28">Website</TableHeader>
                    <TableHeader className="w-32">HS Enrollment</TableHeader>
                    <TableHeader className="w-32">Clubs Estimate</TableHeader>
                    <TableHeader className="w-56">Best Contact</TableHeader>
                    <TableHeader className="w-48">Contact Email</TableHeader>
                    <TableHeader className="w-36">Email Status</TableHeader>
                    <TableHeader className="w-24">Fit Score</TableHeader>
                    <TableHeader className="w-40">Status</TableHeader>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {prospects.map((prospect) => (
                    <tr className="align-top" key={prospect.id}>
                      <TableCell className="font-medium text-slate-950">
                        {prospect.school_name || "Unknown School"}
                      </TableCell>
                      <TableCell>{prospect.city || "-"}</TableCell>
                      <TableCell>{prospect.state || "-"}</TableCell>
                      <TableCell>{prospect.main_phone || "-"}</TableCell>
                      <TableCell>
                        {prospect.website ? (
                          <a
                            className="font-medium text-blue-700 underline-offset-4 hover:underline"
                            href={prospect.website}
                            rel="noopener noreferrer"
                            target="_blank"
                          >
                            Website
                          </a>
                        ) : (
                          "-"
                        )}
                      </TableCell>
                      <TableCell>{prospect.hs_enrollment ?? "-"}</TableCell>
                      <TableCell>
                        {prospect.clubs_count_estimate ?? "-"}
                      </TableCell>
                      <TableCell>
                        {renderBestContact(prospect)}
                      </TableCell>
                      <TableCell>
                        {prospect.contact_email ? (
                          <a
                            className="font-medium text-blue-700 underline-offset-4 hover:underline"
                            href={`mailto:${prospect.contact_email}`}
                          >
                            {prospect.contact_email}
                          </a>
                        ) : (
                          "-"
                        )}
                      </TableCell>
                      <TableCell>
                        <span>{formatEmailStatus(prospect)}</span>
                        {prospect.email_validation_error ? (
                          <span className="mt-1 block text-xs text-red-700">
                            {prospect.email_validation_error}
                          </span>
                        ) : null}
                      </TableCell>
                      <TableCell>{prospect.fit_score ?? "-"}</TableCell>
                      <TableCell>
                        <span>{prospect.enrichment_status || "raw"}</span>
                        {prospect.enrichment_status === "enrichment_failed" &&
                        prospect.enrichment_error ? (
                          <span className="mt-1 block text-xs text-red-700">
                            {prospect.enrichment_error}
                          </span>
                        ) : null}
                      </TableCell>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="px-5 py-12 text-center text-sm text-slate-500">
              No prospects loaded yet. Run a Google Places search.
            </div>
          )}
        </section>

        <p className="text-xs text-slate-500">Results powered by Google Maps.</p>
      </div>
    </main>
  );
}

function TableHeader({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <th className={`px-4 py-3 font-semibold ${className}`} scope="col">
      {children}
    </th>
  );
}

function TableCell({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <td className={`break-words px-4 py-3 leading-6 text-slate-700 ${className}`}>
      {children}
    </td>
  );
}

function getReadableError(error: unknown) {
  return error instanceof Error ? error.message : "Something went wrong.";
}

function formatBestContact(prospect: ProspectListItem) {
  if (prospect.contact_name && prospect.contact_title) {
    return `${prospect.contact_name}, ${prospect.contact_title}`;
  }

  return prospect.contact_name ?? prospect.contact_title ?? "—";
}

function renderBestContact(prospect: ProspectListItem) {
  if (prospect.contact_name && prospect.contact_title) {
    return (
      <span>
        <span className="block text-slate-900">{prospect.contact_name}</span>
        <span className="block text-xs text-slate-500">
          {prospect.contact_title}
        </span>
      </span>
    );
  }

  return prospect.contact_name || prospect.contact_title
    ? formatBestContact(prospect)
    : "-";
}

function formatEmailStatus(prospect: ProspectListItem) {
  return (
    prospect.email_validation_status ||
    prospect.contact_email_validation_status ||
    "not_checked"
  );
}

async function fetchRecentProspects() {
  const response = await fetch("/api/prospects/google-search", {
    method: "GET",
    cache: "no-store",
  });
  const payload = (await response.json()) as ProspectsResponse;

  if (!response.ok) {
    throw new Error(payload.error ?? "Unable to load saved prospects.");
  }

  return payload.prospects ?? [];
}
