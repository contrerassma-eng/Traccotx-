// Tracco Tx - Edge Function tracco-dte (Deno / Supabase)
// Devuelve el PDF OFICIAL del DTE recibido, pidiéndolo al SII en vivo:
//   login (representante via login_rut) -> selecciona empresa -> descarga el PDF
//   del documento (mipeDownLoad.cgi DOWNLOAD=PDF por FOLIO + RUT_EMI + TPO_DOC).
//   ?rut=&folio=   (Authorization: Bearer del usuario, o ?k= temporal)
//   &inspect=1 -> diagnostico (qué devolvió el SII y enlaces de la lista).
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Allow-Headers": "content-type, authorization, apikey" };
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o, null, 2), { status: s, headers: { "Content-Type": "application/json; charset=utf-8", ...cors } });
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class Jar { cookies = new Map<string, string>(); add(scs: string[]) { for (const sc of scs) { const f = sc.split(";")[0]; const eq = f.indexOf("="); if (eq > 0) { const n = f.slice(0, eq).trim(); const v = f.slice(eq + 1).trim(); if (v && v !== "deleted") this.cookies.set(n, v); } } } header() { return [...this.cookies.entries()].map(([k, v]) => k + "=" + v).join("; "); } }
async function fetchJar(jar: Jar, url: string, opts: RequestInit, maxRedir = 6): Promise<Response> { let cur = url; let o: RequestInit = { ...opts }; for (let i = 0; i < maxRedir; i++) { const h = new Headers(o.headers || {}); if (jar.cookies.size) h.set("Cookie", jar.header()); const r = await fetch(cur, { ...o, headers: h, redirect: "manual" }); try { const sc = (r.headers as any).getSetCookie ? (r.headers as any).getSetCookie() : []; jar.add(sc); } catch { /* */ } if (r.status >= 300 && r.status < 400) { const loc = r.headers.get("location"); if (!loc) return r; cur = new URL(loc, cur).toString(); await r.body?.cancel(); o = { method: "GET", headers: { "User-Agent": UA } }; continue; } return r; } throw new Error("redirects"); }
async function loginClave(rutCompleto: string, clave: string, jar: Jar): Promise<string> {
  const [rut, dv] = rutCompleto.split("-");
  const body = new URLSearchParams({ rut, dv, referencia: "https://www1.sii.cl/cgi-bin/Portal001/mipeAdminDocsRcp.cgi", "411": "", rutcntr: rutCompleto, clave }).toString();
  await fetchJar(jar, "https://zeusr.sii.cl/cgi_AUT2000/CAutInicio.cgi", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": UA, "Origin": "https://zeusr.sii.cl", "Referer": "https://zeusr.sii.cl/cgi_AUT2000/CAutInicio.cgi" }, body });
  return jar.cookies.get("TOKEN") || "";
}
async function loginConReintentos(rutCompleto: string, clave: string, max = 3): Promise<{ token: string; jar: Jar }> {
  const esperas = [0, 12000, 28000, 45000]; let jar = new Jar();
  for (let i = 0; i < max; i++) { if (esperas[i]) await sleep(esperas[i]); jar = new Jar(); const t = await loginClave(rutCompleto, clave, jar).catch(() => ""); if (t) return { token: t, jar }; }
  return { token: "", jar };
}
async function seleccionarEmpresa(rutCompleto: string, jar: Jar): Promise<void> {
  const selUrl = "https://www1.sii.cl/cgi-bin/Portal001/mipeSelEmpresa.cgi?DESDE_DONDE_URL=OPCION%3D1%26TIPO%3D4";
  const r = await fetchJar(jar, selUrl, { method: "GET", headers: { "User-Agent": UA, "Referer": "https://www1.sii.cl/Portal001/menuFacturaElectronica.html" } });
  const html = new TextDecoder("iso-8859-1").decode(new Uint8Array(await r.arrayBuffer()));
  const form = html.match(/<form[^>]*>[\s\S]*?<\/form>/i); if (!form) return;
  const action = (form[0].match(/action=["']?([^"'\s>]+)/i) || [])[1] || "mipeSelEmpresa.cgi";
  const actionUrl = new URL(action.replace(/&amp;/g, "&"), "https://www1.sii.cl/cgi-bin/Portal001/").toString();
  const params = new URLSearchParams();
  for (const h of form[0].matchAll(/<input[^>]*>/gi)) { const tag = h[0]; if (!/type=["']?hidden/i.test(tag) && !/type=["']?submit/i.test(tag) && /type=/i.test(tag)) continue; const n = (tag.match(/name=["']?([^"'\s>]+)/i) || [])[1]; const v = (tag.match(/value=["']?([^"'>]*)/i) || [])[1] || ""; if (n) params.set(n, v.replace(/&amp;/g, "&")); }
  const sel = form[0].match(/<select[^>]*name=["']?([^"'\s>]+)["']?[^>]*>([\s\S]*?)<\/select>/i);
  params.set(sel ? sel[1] : "RUT_EMP", rutCompleto);
  const pr = await fetchJar(jar, actionUrl, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": UA, "Origin": "https://www1.sii.cl", "Referer": selUrl }, body: params.toString() }); await pr.body?.cancel();
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const url = new URL(req.url);
    const rutContrib = (url.searchParams.get("rut") || "").trim();
    const folio = (url.searchParams.get("folio") || "").replace(/\D/g, "");
    const inspect = url.searchParams.get("inspect") === "1";
    if (!rutContrib || !folio) return json({ ok: false, error: "Faltan ?rut= y ?folio=" }, 400);

    const URL_S = Deno.env.get("SUPABASE_URL")!, KEY_S = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const claveSII = Deno.env.get("CLAVE_SII"); if (!claveSII) return json({ ok: false, error: "Falta CLAVE_SII" }, 500);
    const admin = createClient(URL_S, KEY_S, { auth: { persistSession: false } });

    // Auth: usuario autorizado al RUT (o service_role / llave temporal de prueba).
    const bearer = (req.headers.get("Authorization") || "").replace("Bearer ", "").trim();
    let allowed = bearer && bearer === KEY_S;
    if (!allowed && bearer) { const { data: ures } = await admin.auth.getUser(bearer); const em = ures?.user?.email?.toLowerCase(); if (em) { const { data: link } = await admin.from("tx_usuario_rut").select("rut").eq("email", em).eq("rut", rutContrib).maybeSingle(); allowed = !!link; } }
    if (!allowed) return json({ ok: false, error: "No autorizado para este RUT" }, 403);

    // Datos del documento desde tx_facturas (emisor, tipo, periodo).
    const { data: fac } = await admin.from("tx_facturas").select("tipo_dte, rut_contraparte, periodo, fecha_emision").eq("rut", rutContrib).eq("tipo", "compra").eq("folio", folio).maybeSingle();
    if (!fac) return json({ ok: false, error: "No encuentro esa factura" }, 404);
    const tipo = String((fac as any).tipo_dte || "").replace(/\D/g, "");
    const emisor = String((fac as any).rut_contraparte || "").trim();
    const emisorNum = emisor.split("-")[0].replace(/\D/g, "");
    const periodo = String((fac as any).periodo || "");
    const fe = String((fac as any).fecha_emision || ""); // yyyy-mm-dd
    const y = (fe.slice(0, 4) || periodo.slice(0, 4)); const m = (fe.slice(5, 7) || periodo.slice(4, 6));
    const last = String(new Date(+y, +m, 0).getDate()).padStart(2, "0");
    const desde = y + "-" + m + "-01", hasta = y + "-" + m + "-" + last;

    // login representante + seleccionar empresa.
    const { data: contrib } = await admin.from("tx_contribuyentes").select("login_rut").eq("rut", rutContrib).maybeSingle();
    const loginRut = ((contrib as any)?.login_rut || rutContrib).trim();
    const { token, jar } = await loginConReintentos(loginRut, claveSII);
    if (!token) return json({ ok: false, error: "El SII está limitando el acceso. Reintenta en un minuto.", rateLimited: true }, 503);
    await seleccionarEmpresa(rutContrib, jar).catch(() => {});

    // 1) Lista de recibidos del período -> CODIGO interno del documento (por folio).
    const listUrl = "https://www1.sii.cl/cgi-bin/Portal001/mipeAdminDocsRcp.cgi?RUT_EMI=&FOLIO=&RZN_SOC=&FEC_DESDE=" + desde + "&FEC_HASTA=" + hasta + "&TPO_DOC=&ESTADO=&ORDEN=&NUM_PAG=1";
    const lr = await fetchJar(jar, listUrl, { method: "GET", headers: { "User-Agent": UA } });
    const lhtml = new TextDecoder("iso-8859-1").decode(new Uint8Array(await lr.arrayBuffer()));
    let codigo = "";
    for (const tr of lhtml.split(/<tr[\s>]/i)) { if (tr.includes(">" + folio + "<")) { const cm = tr.match(/mipeGesDocRcp\.cgi\?CODIGO=(\d+)/i); if (cm) { codigo = cm[1]; break; } } }
    if (!codigo) return json({ ok: false, error: "No encontré ese documento en el SII para el período (¿folio/fecha?)." }, 404);

    // 2) PDF oficial del documento.
    const pr = await fetchJar(jar, "https://www1.sii.cl/cgi-bin/Portal001/mipeShowPdf.cgi?CODIGO=" + codigo, { method: "GET", headers: { "User-Agent": UA, "Referer": "https://www1.sii.cl/cgi-bin/Portal001/mipeGesDocRcp.cgi?CODIGO=" + codigo } });
    const pdf = new Uint8Array(await pr.arrayBuffer());
    const esPdf = pdf.length > 4 && pdf[0] === 0x25 && pdf[1] === 0x50 && pdf[2] === 0x44 && pdf[3] === 0x46; // %PDF
    if (inspect) return json({ folio, tipo, emisor, codigo, status: pr.status, ct: pr.headers.get("content-type"), bytes: pdf.length, esPdf, muestra: esPdf ? "PDF!" : new TextDecoder("iso-8859-1").decode(pdf.slice(0, 200)).replace(/\s+/g, " ") });
    if (esPdf) return new Response(pdf, { status: 200, headers: { "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="DTE-${tipo}-${folio}.pdf"`, ...cors } });
    return json({ ok: false, error: "El SII no devolvió un PDF para ese documento." }, 502);
  } catch (e) {
    return json({ ok: false, error: (e as Error).message }, 500);
  }
});
