// Tracco Tx - Edge Function v11 (Deno / Supabase)
// v11: el SII confirmo "No ha seleccionado una Empresa". mipeLaunchPage no traia el
// <form> esperado, asi que se vuelca su HTML completo para ubicar el form/select
// real de seleccion de empresa. (v10 agrego seleccionarEmpresa; aqui se diagnostica
// por que no encontro el formulario.) RUT por ?rut= o secreto RUT_CONTRIBUYENTE.
// Lee el certificado desde Storage (bucket "certs") y la clave desde el secreto
// CERT_PASS. Autentica contra el SII y devuelve JSON (Supabase no reescribe JSON).
// Abrir la URL en el navegador muestra el resultado. Firma con node-forge puro.
import forge from "npm:node-forge@1.3.1";
import { unzipSync } from "npm:fflate@0.8.2";

const NS = "http://www.w3.org/2000/09/xmldsig#";
const C14N = "http://www.w3.org/TR/2001/REC-xml-c14n-20010315";
const ENV = "http://www.w3.org/2000/09/xmldsig#enveloped-signature";
const RSA_SHA1 = "http://www.w3.org/2000/09/xmldsig#rsa-sha1";
const SHA1 = "http://www.w3.org/2000/09/xmldsig#sha1";
const URL_SEMILLA = "https://palena.sii.cl/DTEWS/CrSeed.jws";
const URL_TOKEN = "https://palena.sii.cl/DTEWS/GetTokenFromSeed.jws";
// El RUT del contribuyente NO se hardcodea. Se toma del secreto
// RUT_CONTRIBUYENTE en Supabase, o del parametro ?rut= de la URL (lo que venga).

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "content-type, authorization, apikey" };

function sha1b64(s: string): string { const md = forge.md.sha1.create(); md.update(s, "utf8"); return forge.util.encode64(md.digest().bytes()); }
function certB64(pem: string): string { return pem.replace(/-----BEGIN CERTIFICATE-----/g, "").replace(/-----END CERTIFICATE-----/g, "").replace(/\s+/g, ""); }

function leerPfxBinary(binary: string, clave: string) {
  const p12 = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(binary), false, clave);
  const kb = p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag];
  const keyBag = (kb && kb[0]) || (p12.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag] || [])[0];
  if (!keyBag || !keyBag.key) throw new Error("Clave incorrecta o el .pfx no tiene llave privada");
  const certBag = p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag][0];
  if (!certBag || !certBag.cert) throw new Error("El .pfx no tiene certificado");
  const certPem = forge.pki.certificateToPem(certBag.cert);
  const cn = (certBag.cert.subject.getField("CN") || {}).value || "";
  return { privateKey: keyBag.key, certPem, cn };
}
function firmarSemilla(semilla: string, privateKey: any, certPem: string): string {
  const canon = "<getToken><item><Semilla>" + semilla + "</Semilla></item></getToken>";
  const dv = sha1b64(canon);
  const siDoc = '<SignedInfo><CanonicalizationMethod Algorithm="' + C14N + '"/><SignatureMethod Algorithm="' + RSA_SHA1 + '"/><Reference URI=""><Transforms><Transform Algorithm="' + ENV + '"/><Transform Algorithm="' + C14N + '"/></Transforms><DigestMethod Algorithm="' + SHA1 + '"/><DigestValue>' + dv + "</DigestValue></Reference></SignedInfo>";
  const siCanon = '<SignedInfo xmlns="' + NS + '"><CanonicalizationMethod Algorithm="' + C14N + '"></CanonicalizationMethod><SignatureMethod Algorithm="' + RSA_SHA1 + '"></SignatureMethod><Reference URI=""><Transforms><Transform Algorithm="' + ENV + '"></Transform><Transform Algorithm="' + C14N + '"></Transform></Transforms><DigestMethod Algorithm="' + SHA1 + '"></DigestMethod><DigestValue>' + dv + "</DigestValue></Reference></SignedInfo>";
  const md = forge.md.sha1.create(); md.update(siCanon, "utf8");
  const sv = forge.util.encode64(privateKey.sign(md));
  return '<?xml version="1.0" encoding="UTF-8"?><getToken><item><Semilla>' + semilla + "</Semilla></item><Signature xmlns=\"" + NS + "\">" + siDoc + "<SignatureValue>" + sv + "</SignatureValue><KeyInfo><X509Data><X509Certificate>" + certB64(certPem) + "</X509Certificate></X509Data></KeyInfo></Signature></getToken>";
}
function entre(t: string, tag: string): string | null { const m = t.match(new RegExp("<" + tag + ">([^<]*)</" + tag + ">", "i")); return m ? m[1].trim() : null; }
const desesc = (t: string) => t.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");

async function leerCertDeStorage(logs: string[]): Promise<string> {
  const base = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!base || !key) throw new Error("Faltan variables internas de Supabase");
  const lr = await fetch(base + "/storage/v1/object/list/certs", {
    method: "POST", headers: { Authorization: "Bearer " + key, apikey: key, "Content-Type": "application/json" },
    body: JSON.stringify({ prefix: "", limit: 100, offset: 0 }),
  });
  if (!lr.ok) throw new Error("No pude listar el bucket 'certs' (HTTP " + lr.status + ")");
  const files = await lr.json();
  const pfx = (files || []).find((f: any) => /\.(pfx|p12)$/i.test(f.name)) || (files || [])[0];
  if (!pfx || !pfx.name) throw new Error("El bucket 'certs' está vacío. Sube ahí el certificado .pfx.");
  logs.push("      Archivo en Storage: " + pfx.name);
  const dr = await fetch(base + "/storage/v1/object/certs/" + encodeURIComponent(pfx.name), { headers: { Authorization: "Bearer " + key, apikey: key } });
  if (!dr.ok) throw new Error("No pude bajar " + pfx.name + " (HTTP " + dr.status + ")");
  const buf = new Uint8Array(await dr.arrayBuffer());
  let bin = ""; for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
  return bin;
}

async function pedirSemilla(logs: string[]): Promise<string> {
  const env = '<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:def="http://DefaultNamespace"><soapenv:Header/><soapenv:Body><def:getSeed/></soapenv:Body></soapenv:Envelope>';
  const r = await fetch(URL_SEMILLA, { method: "POST", headers: { "Content-Type": "text/xml; charset=utf-8", "SOAPAction": "" }, body: env });
  logs.push("      SII semilla -> HTTP " + r.status);
  const txt = await r.text();
  const semilla = entre(desesc(txt), "SEMILLA");
  if (!semilla) {
    const e = entre(desesc(txt), "ESTADO"), g = entre(desesc(txt), "GLOSA");
    if (e || g) logs.push("      SII estado=" + e + " glosa=" + g);
    logs.push("      respuesta (recorte): " + txt.slice(0, 350).replace(/\s+/g, " "));
    throw new Error("No se pudo leer la SEMILLA del SII");
  }
  return semilla;
}
async function pedirToken(xml: string, logs: string[]): Promise<string> {
  const env = '<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:def="http://DefaultNamespace"><soapenv:Header/><soapenv:Body><def:getToken><pszXml><![CDATA[' + xml + "]]></pszXml></def:getToken></soapenv:Body></soapenv:Envelope>";
  const r = await fetch(URL_TOKEN, { method: "POST", headers: { "Content-Type": "text/xml; charset=utf-8", "SOAPAction": "" }, body: env });
  logs.push("      SII token -> HTTP " + r.status);
  const txt = await r.text();
  const token = entre(desesc(txt), "TOKEN");
  if (!token) {
    const e = entre(desesc(txt), "ESTADO"), g = entre(desesc(txt), "GLOSA");
    if (e || g) logs.push("      SII estado=" + e + " glosa=" + g);
    logs.push("      respuesta (recorte): " + txt.slice(0, 450).replace(/\s+/g, " "));
    throw new Error("No se pudo leer el TOKEN (la firma pudo ser rechazada)");
  }
  return token;
}
// Baja el detalle de compras del periodo (endpoint validado getDetalleCompraExport)
// y extrae las facturas de diesel (Codigo Otro Impuesto = 28 -> IEPD).
async function extraerCompras(token: string, rutCompleto: string, periodo: string, logs: string[]) {
  const [rut, dv] = rutCompleto.split("-");
  const body = {
    metaData: { namespace: "cl.sii.sdi.lob.diii.consdcv.data.api.interfaces.FacadeService/getDetalleCompraExport", conversationId: token, transactionId: crypto.randomUUID(), page: null },
    data: { rutEmisor: rut, dvEmisor: dv, ptributario: periodo, codTipoDoc: 0, operacion: "COMPRA", estadoContab: "REGISTRO", accionRecaptcha: "RCV_DDETC", tokenRecaptcha: "t-o-k-e-n-web" },
  };
  const r = await fetch("https://www4.sii.cl/consdcvinternetui/services/data/facadeService/getDetalleCompraExport", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json, text/plain, */*", "Origin": "https://www4.sii.cl", "Referer": "https://www4.sii.cl/consdcvinternetui/", "Cookie": "TOKEN=" + token + "; CSESSIONID=" + token },
    body: JSON.stringify(body),
  });
  logs.push("      RCV www4 (getDetalleCompraExport) -> HTTP " + r.status);
  const txt = await r.text();
  if (r.status !== 200) {
    logs.push("      respuesta (recorte): " + txt.slice(0, 300).replace(/\s+/g, " "));
    throw new Error("getDetalleCompraExport devolvio HTTP " + r.status);
  }
  logs.push("      Respuesta: " + txt.length + " bytes | inicio: " + txt.slice(0, 300).replace(/\s+/g, " "));
  let parsed: any;
  try { parsed = JSON.parse(txt); } catch { throw new Error("La respuesta del RCV no es JSON: " + txt.slice(0, 200)); }
  let arr: any[] | null = null;
  if (Array.isArray(parsed)) arr = parsed;
  else if (parsed && typeof parsed === "object") {
    for (const k of Object.keys(parsed)) { if (Array.isArray(parsed[k])) { arr = parsed[k]; logs.push("      (filas en la clave '" + k + "')"); break; } }
    if (!arr) logs.push("      (objeto con claves: " + Object.keys(parsed).join(", ") + ")");
  }
  if (!arr || arr.length === 0) { logs.push("      RCV sin documentos para el periodo " + periodo); return { totalDocumentos: 0, diesel: [] as any[], totalIEPD: 0 }; }
  const header = String(arr[0]).split(";").map((h) => h.trim());
  const col = (name: string) => header.findIndex((h) => h.toLowerCase() === name.toLowerCase());
  const iRut = col("RUT Proveedor"), iRazon = col("Razon Social"), iFolio = col("Folio"), iFecha = col("Fecha Docto"), iTipo = col("Tipo Doc"), iCod = col("Codigo Otro Impuesto"), iVal = col("Valor Otro Impuesto");
  const docs = arr.slice(1).map((l: any) => String(l).split(";"));
  logs.push("      Documentos en el periodo: " + docs.length);
  const diesel: any[] = [];
  let totalIEPD = 0;
  for (const c of docs) {
    if (iCod >= 0 && c[iCod] && c[iCod].trim() === "28") {
      const iepd = parseInt(String(c[iVal] || "0").replace(/\D/g, ""), 10) || 0;
      totalIEPD += iepd;
      diesel.push({ rut: c[iRut], razonSocial: c[iRazon], folio: c[iFolio], fecha: c[iFecha], tipoDoc: c[iTipo], iepd });
    }
  }
  logs.push("      Facturas de diesel (codigo 28): " + diesel.length + " | IEPD total: $" + totalIEPD.toLocaleString("es-CL"));
  return { totalDocumentos: docs.length, diesel, totalIEPD };
}

// Lee los XML del bucket "dte" y arma un mapa folio -> litros (suma QtyItem de lineas de diesel).
async function leerXmlsLitros(logs: string[]): Promise<Record<string, number>> {
  const base = Deno.env.get("SUPABASE_URL"); const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const map: Record<string, number> = {};
  if (!base || !key) return map;
  const lr = await fetch(base + "/storage/v1/object/list/dte", {
    method: "POST", headers: { Authorization: "Bearer " + key, apikey: key, "Content-Type": "application/json" },
    body: JSON.stringify({ prefix: "", limit: 1000, offset: 0 }),
  });
  if (!lr.ok) { logs.push("      (no pude listar el bucket dte: HTTP " + lr.status + ")"); return map; }
  const files = ((await lr.json()) || []).filter((f: any) => f.name && /\.xml$/i.test(f.name));
  if (files.length === 0) { logs.push("      (bucket 'dte' vacio: sube el respaldo XML del SII para tener litros)"); return map; }
  logs.push("      XML en Storage: " + files.length + " archivo(s)");
  for (const f of files) {
    const dr = await fetch(base + "/storage/v1/object/dte/" + encodeURIComponent(f.name), { headers: { Authorization: "Bearer " + key, apikey: key } });
    if (!dr.ok) continue;
    parseXmlLitros(await dr.text(), map);
  }
  return map;
}
function parseXmlLitros(xml: string, map: Record<string, number>) {
  const docs = xml.split(/<Documento[\s>]/).slice(1);
  for (const d of docs) {
    const fm = d.match(/<Folio>(\d+)<\/Folio>/);
    if (!fm) continue;
    const folio = fm[1];
    let litros = 0;
    const dets = d.split(/<Detalle>/).slice(1);
    for (const det of dets) {
      const body = det.split(/<\/Detalle>/)[0];
      const nombre = (body.match(/<NmbItem>([^<]*)<\/NmbItem>/) || ["", ""])[1];
      const unidad = (body.match(/<UnmdItem>([^<]*)<\/UnmdItem>/) || ["", ""])[1];
      const qm = body.match(/<QtyItem>([\d.,]+)<\/QtyItem>/);
      const esDiesel = /diesel|petr[oó]leo/i.test(nombre) || /^(lt|lts|litro|litros|l)$/i.test(unidad.trim());
      if (qm && esDiesel) { const q = qm[1].includes(",") && !qm[1].includes(".") ? qm[1].replace(",", ".") : qm[1]; litros += parseFloat(q) || 0; }
    }
    if (litros > 0) map[folio] = +litros.toFixed(2);
  }
}

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
// Frasco de cookies + fetch que sigue redirects manualmente acumulando cookies (Deno no maneja jar).
class Jar {
  cookies = new Map<string, string>();
  add(scs: string[]) { for (const sc of scs) { const first = sc.split(";")[0]; const eq = first.indexOf("="); if (eq > 0) { const n = first.slice(0, eq).trim(); const v = first.slice(eq + 1).trim(); if (v && v !== "deleted") this.cookies.set(n, v); } } }
  header() { return [...this.cookies.entries()].map(([k, v]) => k + "=" + v).join("; "); }
}
async function fetchJar(jar: Jar, url: string, opts: RequestInit, maxRedir = 6): Promise<Response> {
  let cur = url; let o: RequestInit = { ...opts };
  for (let i = 0; i < maxRedir; i++) {
    const h = new Headers(o.headers || {});
    if (jar.cookies.size) h.set("Cookie", jar.header());
    const r = await fetch(cur, { ...o, headers: h, redirect: "manual" });
    try { const sc = (r.headers as any).getSetCookie ? (r.headers as any).getSetCookie() : []; jar.add(sc); } catch { /* */ }
    if (r.status >= 300 && r.status < 400) { const loc = r.headers.get("location"); if (!loc) return r; cur = new URL(loc, cur).toString(); await r.body?.cancel(); o = { method: "GET", headers: { "User-Agent": UA } }; continue; }
    return r;
  }
  throw new Error("Demasiados redirects en " + url);
}
async function loginClave(rutCompleto: string, clave: string, jar: Jar, logs: string[]) {
  const [rut, dv] = rutCompleto.split("-");
  const body = new URLSearchParams({ rut, dv, referencia: "https://www1.sii.cl/cgi-bin/Portal001/mipeAdminDocsRcp.cgi", "411": "", rutcntr: rutCompleto, clave }).toString();
  const r = await fetchJar(jar, "https://zeusr.sii.cl/cgi_AUT2000/CAutInicio.cgi", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": UA, "Origin": "https://zeusr.sii.cl", "Referer": "https://zeusr.sii.cl/cgi_AUT2000/CAutInicio.cgi" }, body });
  const txt = await r.text();
  logs.push("      Login SII -> HTTP " + r.status + " | cookies: [" + [...jar.cookies.keys()].join(",") + "]");
  if (txt && /incorrect|inv[aá]lid|no coincide|bloquead/i.test(txt)) logs.push("      AVISO: el SII pudo rechazar el login (revisa la clave en CLAVE_SII)");
}
// Tras el login, el portal MIPYME exige ELEGIR la empresa (el contribuyente puede
// tener varios RUT) y apretar "Enviar". Ese POST "genera el acceso" (fija el RUT
// de trabajo). Sin esto, mipeAdminDocsRcp devuelve "Error al contribuyente".
async function seleccionarEmpresa(rutCompleto: string, jar: Jar, logs: string[]): Promise<void> {
  const decFull = (b: Uint8Array) => new TextDecoder("iso-8859-1").decode(b);
  const r = await fetchJar(jar, "https://www1.sii.cl/cgi-bin/Portal001/mipeLaunchPage.cgi", { method: "GET", headers: { "User-Agent": UA } });
  const html = decFull(new Uint8Array(await r.arrayBuffer()));
  logs.push("      Seleccion empresa (mipeLaunchPage) -> HTTP " + r.status + " | " + html.length + " bytes");
  logs.push("      launch HTML: " + html.replace(/\s+/g, " ").slice(0, 1200));

  const form = html.match(/<form[^>]*>[\s\S]*?<\/form>/i);
  if (!form) { logs.push("      (no hay form de seleccion en mipeLaunchPage)"); return; }
  const formHtml = form[0];
  const action = (formHtml.match(/action=["']?([^"'\s>]+)/i) || [])[1] || "mipeLaunchPage.cgi";
  const actionUrl = new URL(action.replace(/&amp;/g, "&"), "https://www1.sii.cl/cgi-bin/Portal001/").toString();

  const params = new URLSearchParams();
  for (const h of formHtml.matchAll(/<input[^>]*>/gi)) {
    const tag = h[0];
    if (!/type=["']?hidden/i.test(tag) && !/type=["']?submit/i.test(tag) && /type=/i.test(tag)) continue;
    const n = (tag.match(/name=["']?([^"'\s>]+)/i) || [])[1];
    const v = (tag.match(/value=["']?([^"'>]*)/i) || [])[1] || "";
    if (n) params.set(n, v.replace(/&amp;/g, "&"));
  }

  const rutNum = rutCompleto.split("-")[0].replace(/\D/g, "");
  const rutDot = rutNum.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  const sel = formHtml.match(/<select[^>]*name=["']?([^"'\s>]+)["']?[^>]*>([\s\S]*?)<\/select>/i);
  if (sel) {
    const selName = sel[1];
    let chosen = "", first = "";
    for (const o of sel[2].matchAll(/<option[^>]*value=["']?([^"'>]*)["']?[^>]*>([^<]*)</gi)) {
      const val = (o[1] || "").trim(), label = (o[2] || "").trim();
      if (!first) first = val;
      logs.push("      opcion empresa: value=" + val + " | " + label.slice(0, 40));
      if (val.includes(rutCompleto) || val.includes(rutNum) || label.includes(rutNum) || label.includes(rutDot)) { chosen = val; break; }
    }
    params.set(selName, chosen || first);
    logs.push("      Empresa elegida: " + selName + "=" + (chosen || first) + (chosen ? " (match RUT)" : " (fallback 1ra)"));
  } else {
    logs.push("      (no encontre <select> de empresa en el form)");
  }

  const pr = await fetchJar(jar, actionUrl, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": UA, "Origin": "https://www1.sii.cl", "Referer": "https://www1.sii.cl/cgi-bin/Portal001/mipeLaunchPage.cgi" }, body: params.toString() });
  logs.push("      Enviar empresa -> HTTP " + pr.status + " | action=" + actionUrl + " | cookies:[" + [...jar.cookies.keys()].join(",") + "]");
  await pr.body?.cancel();
}
async function bajarRespaldoZip(rutCompleto: string, periodo: string, jar: Jar, logs: string[]): Promise<Uint8Array | null> {
  const y = periodo.slice(0, 4), m = periodo.slice(4, 6);
  const last = new Date(+y, +m, 0).getDate();
  const desde = y + "-" + m + "-01", hasta = y + "-" + m + "-" + String(last).padStart(2, "0");
  const dec = (b: Uint8Array) => new TextDecoder("iso-8859-1").decode(b).replace(/\s+/g, " ");

  // Paso 0: seleccionar la EMPRESA (apretar "Enviar") para fijar el RUT de trabajo.
  try {
    await seleccionarEmpresa(rutCompleto, jar, logs);
  } catch (e) { logs.push("      (seleccion de empresa fallo: " + (e as Error).message + ")"); }

  // Paso 1: sembrar la sesión listando los documentos recibidos del rango.
  // Logueamos la respuesta para saber si la sesión www1 quedo realmente activa
  // y, sobre todo, para extraer el link de descarga REAL que arma el portal.
  const seedUrl = "https://www1.sii.cl/cgi-bin/Portal001/mipeAdminDocsRcp.cgi?RUT_EMI=&FOLIO=&RZN_SOC=&FEC_DESDE=" + desde + "&FEC_HASTA=" + hasta + "&TPO_DOC=&ESTADO=&ORDEN=&NUM_PAG=1";
  const sr = await fetchJar(jar, seedUrl, { method: "GET", headers: { "User-Agent": UA, "Referer": "https://www1.sii.cl/cgi-bin/Portal001/mipeLaunchPage.cgi" } });
  const seedBuf = new Uint8Array(await sr.arrayBuffer());
  const seedTxt = dec(seedBuf);
  logs.push("      mipeAdminDocsRcp (seed) -> HTTP " + sr.status + " | " + (sr.headers.get("content-type") || "") + " | " + seedBuf.length + " bytes");
  logs.push("      seed (recorte): " + seedTxt.slice(0, 500));
  const linkMatch = seedTxt.match(/mipeDownLoad\.cgi[^"'\s>)]*/i);
  if (linkMatch) logs.push("      LINK REAL de descarga en la pagina: " + linkMatch[0]);

  // Paso 2: descargar. Si el portal expuso un link real, usamos ESE (trae los
  // parametros exactos que el SII espera); si no, caemos al armado manual.
  const url = linkMatch
    ? new URL(linkMatch[0].replace(/&amp;/g, "&"), "https://www1.sii.cl/cgi-bin/Portal001/").toString()
    : "https://www1.sii.cl/cgi-bin/Portal001/mipeDownLoad.cgi?ORIGEN=RCP&RUT_EMI=&FOLIO=&RZN_SOC=&FEC_DESDE=" + desde + "&FEC_HASTA=" + hasta + "&TPO_DOC=&ESTADO=&ORDEN=&DOWNLOAD=XML";
  const r = await fetchJar(jar, url, { method: "GET", headers: { "User-Agent": UA, "Referer": seedUrl } });
  const ct = r.headers.get("content-type") || "";
  const buf = new Uint8Array(await r.arrayBuffer());
  logs.push("      mipeDownLoad -> HTTP " + r.status + " | " + ct + " | " + buf.length + " bytes");
  if (buf.length >= 2 && buf[0] === 0x50 && buf[1] === 0x4b) return buf;
  logs.push("      (la respuesta no es ZIP) cuerpo: " + dec(buf).slice(0, 1500));
  return buf;
}
function litrosDesdeZip(buf: Uint8Array, logs: string[]): Record<string, number> {
  const map: Record<string, number> = {};
  if (buf.length >= 2 && buf[0] === 0x50 && buf[1] === 0x4b) {
    try {
      const files = unzipSync(buf);
      let n = 0;
      for (const name of Object.keys(files)) { if (/\.xml$/i.test(name)) { parseXmlLitros(new TextDecoder().decode(files[name]), map); n++; } }
      logs.push("      XML dentro del ZIP: " + n + " | folios con litros: " + Object.keys(map).length);
    } catch (e) { logs.push("      error descomprimiendo: " + (e as Error).message); }
  } else {
    parseXmlLitros(new TextDecoder().decode(buf), map);
    logs.push("      (interpretado como XML directo) folios con litros: " + Object.keys(map).length);
  }
  return map;
}

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj, null, 2), { status, headers: { "Content-Type": "application/json; charset=utf-8", ...cors } });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const logs: string[] = [];
  try {
    const url = new URL(req.url);
    const rutContrib = (url.searchParams.get("rut") || Deno.env.get("RUT_CONTRIBUYENTE") || "").trim();
    const clave = Deno.env.get("CERT_PASS");
    if (!clave) return json({ ok: false, logs: ["Falta el secreto CERT_PASS. Agregalo en Supabase > Project Settings > Edge Functions > Secrets (o Functions > Secrets)."] });
    if (!rutContrib) return json({ ok: false, logs: ["Falta el RUT del contribuyente: agregalo como secreto RUT_CONTRIBUYENTE (formato 12345678-9) o pasalo en la URL (&rut=12345678-9)."] });

    logs.push("[1/5] Bajando certificado desde Storage (bucket certs)...");
    const binary = await leerCertDeStorage(logs);

    logs.push("[2/5] Leyendo certificado...");
    const { privateKey, certPem, cn } = leerPfxBinary(binary, clave);
    logs.push("      Titular: " + (cn || "(sin nombre)"));

    logs.push("[3/5] Pidiendo SEMILLA al SII...");
    const semilla = await pedirSemilla(logs);
    logs.push("      Semilla: " + semilla);

    logs.push("[4/5] Firmando la semilla y pidiendo TOKEN...");
    const firmado = firmarSemilla(semilla, privateKey, certPem);
    const token = await pedirToken(firmado, logs);
    logs.push("      TOKEN OBTENIDO: " + token);

    let periodo = url.searchParams.get("periodo") || "";
    if (!/^\d{6}$/.test(periodo)) {
      const hoy = new Date();
      let y = hoy.getFullYear(), m = hoy.getMonth();
      if (m === 0) { m = 12; y -= 1; }
      periodo = "" + y + String(m).padStart(2, "0");
    }
    logs.push("[5/5] Bajando compras del periodo " + periodo + "...");
    const { totalDocumentos, diesel, totalIEPD } = await extraerCompras(token, rutContrib, periodo, logs);
    const credito544 = Math.round(totalIEPD * 0.8);

    logs.push("      Obteniendo litros por folio...");
    let litrosMap: Record<string, number> = {};
    const claveSII = Deno.env.get("CLAVE_SII");
    if (claveSII && diesel.length) {
      const jar = new Jar();
      logs.push("      Iniciando sesion en el SII con clave...");
      await loginClave(rutContrib, claveSII, jar, logs);
      const zip = await bajarRespaldoZip(rutContrib, periodo, jar, logs);
      if (zip) litrosMap = litrosDesdeZip(zip, logs);
    } else {
      litrosMap = await leerXmlsLitros(logs);
    }
    let totalLitros = 0, conLitros = 0;
    for (const d of diesel) { d.litros = litrosMap[d.folio] ?? null; if (d.litros) { totalLitros += d.litros; conLitros++; } }
    logs.push("      Litros cruzados: " + conLitros + "/" + diesel.length + " facturas | total " + (+totalLitros.toFixed(2)).toLocaleString("es-CL") + " L");

    return json({ ok: true, titular: cn, periodo, totalDocumentos, facturasDiesel: diesel.length, totalIEPD, credito544_80pct: credito544, totalLitros: +totalLitros.toFixed(2), diesel, logs });
  } catch (e) {
    logs.push("ERROR: " + ((e as Error).message || String(e)));
    return json({ ok: false, error: (e as Error).message, logs });
  }
});
