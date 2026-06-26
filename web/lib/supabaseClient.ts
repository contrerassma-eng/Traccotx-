import { createClient } from "@supabase/supabase-js";

// Las claves PUBLICAS (URL + anon) se inyectan como variables de entorno en Vercel.
// NUNCA poner aqui la service_role.
const url = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";

export const supabase = createClient(url, anon, {
  auth: { persistSession: true, autoRefreshToken: true },
});

// URL base de las Edge Functions (login SII, compras, etc.).
export const FUNCTIONS_URL = url ? url + "/functions/v1" : "";
