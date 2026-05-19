import { createClient } from "@supabase/supabase-js";

type SupabaseEnv = {
  url: string;
  secretKey: string;
};

export class MissingServerEnvError extends Error {
  constructor(public readonly envName: string) {
    super(`Missing ${envName}`);
    this.name = "MissingServerEnvError";
  }
}

export function getSupabaseServerEnv(): SupabaseEnv {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const secretKey = process.env.SUPABASE_SECRET_KEY;

  if (!url) {
    throw new MissingServerEnvError("NEXT_PUBLIC_SUPABASE_URL");
  }

  try {
    new URL(url);
  } catch {
    throw new MissingServerEnvError("NEXT_PUBLIC_SUPABASE_URL");
  }

  if (!secretKey) {
    throw new MissingServerEnvError("SUPABASE_SECRET_KEY");
  }

  return { url, secretKey };
}

export function createSupabaseServerClient() {
  const { url, secretKey } = getSupabaseServerEnv();

  return createClient(url, secretKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}
