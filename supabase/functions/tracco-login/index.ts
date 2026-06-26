// Tracco Tx - Edge Function tracco-login (Deno / Supabase)
// Login: valida RUT+clave contra el SII (CAutInicio) Y exige que el correo este en
// tx_usuarios (activo). Si ambos OK, emite una sesion Supabase (passwordless) y
// devuelve los RUTs autorizados del correo para el selector de empresa.
// POST { rut, clave, email }  -> { ok, email, ruts, access_token, refresh_token }
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "content-type, authorization, apikey" };
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json; charset=utf-8", ...cors } });
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

class Jar {
  cookies = new Map<string, string>();
  add(scs: string[]) { for (const sc of scs) { const f = sc.split(";")[0]; const eq = f.indexOf("="); if (eq > 0) { const n = f.slice(0, eq).trim(); const v = f.slice(eq + 1).trim(); if (v && v !== "deleted") this.cookies.set(n, v); } } }
  header() { return [...this.cookies.entries()].map(([k, v]) => k + "=" + v).join("; "); }
}
async function fetchJar(jar: Jar, url: string, opts: RequestInit, maxRedir = 5): Promise<Response> {
  let cur = url; let o: RequestInit = { ...opts };
  for (let i = 0; i < maxRedir; i++) {
    const h = new Headers(o.headers || {});
    if (jar.cookies.size) h.set("Cookie", jar.header());
    const r = await fetch(cur, { ...o, headers: h, redirect: "manual" });
    try { const sc = (r.headers as any).getSetCookie ? (r.headers as any).getSetCookie() : []; jar.add(sc); } catch { /* */ }
    if (r.status >= 300 && r.status < 400) { const loc = r.headers.get("location"); if (!loc) return r; cur = new URL(loc, cur).toString(); await r.body?.cancel(); o = { method: "GET", headers: { "User-Agent": UA } }; continue; }
    return r;
  }
  throw new Error("Demasiados redirects");
}
// Valida la clave tributaria: si el SII abre sesion, vuelven cookies de auth
// (CSESSIONID / NETSCAPE_LIVEWIRE.clave / TOKEN). Si la clave es mala, solo vuelven
// cookies de balanceador (TS...) y/o un mensaje de rechazo.
async function validarSII(rutCompleto: string, clave: string): Promise<boolean> {
  const [rut, dv] = rutCompleto.split("-");
  const jar = new Jar();
  const body = new URLSearchParams({ rut, dv, referencia: "https://www1.sii.cl/cgi-bin/Portal001/mipeAdminDocsRcp.cgi", "411": "", rutcntr: rutCompleto, clave }).toString();
  const r = await fetchJar(jar, "https://zeusr.sii.cl/cgi_AUT2000/CAutInicio.cgi", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": UA, "Origin": "https://zeusr.sii.cl", "Referer": "https://zeusr.sii.cl/cgi_AUT2000/CAutInicio.cgi" }, body });
  const txt = await r.text();
  const tieneAuth = jar.cookies.has("CSESSIONID") || jar.cookies.has("TOKEN") || [...jar.cookies.keys()].some((k) => k.startsWith("NETSCAPE_LIVEWIRE"));
  const rechazo = /clave.{0,20}(incorrect|inv[aá]lid|no coincide)|usuario.{0,20}bloquead|rut.{0,20}(incorrect|inv[aá]lid)/i.test(txt);
  return tieneAuth && !rechazo;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ ok: false, error: "Usa POST" }, 405);
  try {
    const { rut, clave, email } = await req.json().catch(() => ({}));
    const em = String(email || "").trim().toLowerCase();
    const rutN = String(rut || "").trim();
    if (!rutN || !clave || !em) return json({ ok: false, error: "Faltan RUT, clave o correo" }, 400);

    const URL_S = Deno.env.get("SUPABASE_URL")!, KEY_S = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const admin = createClient(URL_S, KEY_S, { auth: { persistSession: false } });

    // 1) Correo autorizado y activo (un admin lo habilita una vez en tx_usuarios).
    const { data: u } = await admin.from("tx_usuarios").select("email, activo, nombre, rol").eq("email", em).maybeSingle();
    if (!u || !u.activo) return json({ ok: false, error: "Correo no autorizado" }, 403);

    // 2) Validar RUT + clave contra el SII (prueba que la persona controla ese RUT).
    let okSII = false;
    try { okSII = await validarSII(rutN, clave); } catch { okSII = false; }
    if (!okSII) return json({ ok: false, error: "RUT o clave del SII no válidos (o el SII está limitando; reintenta en un minuto)" }, 401);

    // 3) Auto-provision: como el SII valido la identidad, aseguramos el contribuyente
    //    y el vinculo correo<->RUT (sin que un admin tenga que pre-cargar cada RUT).
    await admin.from("tx_contribuyentes").upsert({ rut: rutN }, { onConflict: "rut", ignoreDuplicates: true });
    await admin.from("tx_usuario_rut").upsert({ email: em, rut: rutN, rol: u.rol || "cliente" }, { onConflict: "email,rut", ignoreDuplicates: true });

    // 4) RUTs autorizados del correo (incluye el recien provisionado) -> selector.
    const { data: urs } = await admin.from("tx_usuario_rut").select("rut").eq("email", em);
    const ruts = (urs || []).map((x: any) => x.rut);
    if (!ruts.length) return json({ ok: false, error: "El correo no tiene RUT asignado" }, 403);

    // 4) Emitir sesion Supabase passwordless (sin enviar correo).
    try { await admin.auth.admin.createUser({ email: em, email_confirm: true }); } catch { /* ya existe */ }
    const { data: link, error: e1 } = await admin.auth.admin.generateLink({ type: "magiclink", email: em });
    const otp = (link as any)?.properties?.email_otp;
    if (e1 || !otp) return json({ ok: false, error: "No se pudo generar la sesión" }, 500);
    const { data: sess, error: e2 } = await admin.auth.verifyOtp({ email: em, token: otp, type: "email" });
    if (e2 || !sess?.session) return json({ ok: false, error: "No se pudo iniciar sesión: " + (e2?.message || "") }, 500);

    // Nombres de las empresas para el selector.
    const { data: contribs } = await admin.from("tx_contribuyentes").select("rut, razon_social").in("rut", ruts);
    return json({ ok: true, email: em, nombre: u.nombre, rol: u.rol, ruts, empresas: contribs || [], access_token: sess.session.access_token, refresh_token: sess.session.refresh_token });
  } catch (e) {
    return json({ ok: false, error: (e as Error).message }, 500);
  }
});
