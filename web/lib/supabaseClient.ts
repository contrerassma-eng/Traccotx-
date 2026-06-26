import { createClient } from "@supabase/supabase-js";

// Las claves PUBLICAS (URL + anon) se inyectan como variables de entorno en Vercel.
// NUNCA poner aqui la service_role.
// Fallback inocuo para que el prerender del build no falle si la env no está
// presente en ese momento; en el navegador (Vercel) se reemplazan por las reales.
const url = process.env.NEXT_PUBLIC_SUPABASE_URL || "https://placeholder.supabase.co";
const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "placeholder-anon-key";

export const supabase = createClient(url, anon, {
  auth: { persistSession: true, autoRefreshToken: true },
});

// URL base de las Edge Functions (login SII, compras, etc.).
export const FUNCTIONS_URL = url ? url + "/functions/v1" : "";
