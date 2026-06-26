"use client";
import { useEffect, useMemo, useState } from "react";
import { supabase, FUNCTIONS_URL } from "../../lib/supabaseClient";

// ---------- tipos ----------
type Periodo = {
  periodo: string;
  litros: number | null;
  iepd_total: number | null;
  credito_544: number | null;
  ingresos: number | null;
  ingreso_por_litro: number | null;
};
type Empresa = { rut: string; razon_social: string };
type Factura = {
  folio: string; tipo_dte: number | null; razon_social: string | null;
  fecha_emision: string | null; categoria: string | null; neto: number | null;
  iepd: number | null; litros: number | null; total: number | null;
};
type Camion = {
  id?: string; rut?: string; patente: string; caja_rol: string | null;
  vigente_desde: string | null; vigente_hasta: string | null; activo?: boolean;
};
type Config = {
  rut: string; razon_social: string | null; giro: string | null;
  tramo_iepd_pct: number | null; paga_ppm: boolean | null; ppm_tasa: number | null;
  renta_efectiva: boolean | null;
};

// ---------- helpers ----------
const clp = (n: number | null | undefined) => (n == null ? "—" : "$" + Math.round(n).toLocaleString("es-CL"));
const numL = (n: number | null | undefined) => (n == null ? "—" : Number(n).toLocaleString("es-CL", { maximumFractionDigits: 0 }));
const MESES = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"];
const C = { card: "#1e293b", border: "#283548", sub: "#94a3b8", accent: "#5eead4", ink: "#f1f5f9" };
// Años disponibles para los selectores (2025 → año actual).
const ANIOS = (() => { const a: string[] = []; for (let y = 2025; y <= new Date().getFullYear(); y++) a.push(String(y)); return a.reverse(); })();
// Lista de períodos "AAAAMM" entre desde y hasta (inclusive); vacía si desde > hasta.
function mesesEntre(desde: string, hasta: string): string[] {
  if (!/^\d{6}$/.test(desde) || !/^\d{6}$/.test(hasta) || desde > hasta) return [];
  const out: string[] = []; let y = +desde.slice(0, 4), m = +desde.slice(4, 6); const yh = +hasta.slice(0, 4), mh = +hasta.slice(4, 6);
  for (let i = 0; i < 120; i++) { out.push("" + y + String(m).padStart(2, "0")); if (y === yh && m === mh) break; m++; if (m > 12) { m = 1; y++; } }
  return out;
}

// ---------- mini gráfico de barras (sin librerías) ----------
function Bars({ data, color, fmt }: { data: { label: string; value: number }[]; color: string; fmt: (v: number) => string }) {
  const max = Math.max(1, ...data.map((d) => d.value));
  return (
    <div style={{ display: "flex", alignItems: "flex-end", gap: 8, height: 180, paddingTop: 8 }}>
      {data.map((d, i) => (
        <div key={i} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "flex-end", height: "100%" }}>
          <div style={{ fontSize: 9, color: C.sub, marginBottom: 4 }}>{d.value ? fmt(d.value) : ""}</div>
          <div style={{ width: "62%", borderRadius: "5px 5px 0 0", background: color, height: (d.value / max) * 82 + "%", minHeight: d.value ? 2 : 0 }} />
          <div style={{ fontSize: 10, color: "#64748b", marginTop: 6 }}>{d.label}</div>
        </div>
      ))}
    </div>
  );
}

// barras horizontales por categoría (etiquetas largas)
const PALETA = ["#2dd4bf", "#38bdf8", "#a78bfa", "#fb7185", "#fbbf24", "#34d399", "#f472b6", "#60a5fa", "#f59e0b", "#4ade80", "#c084fc", "#22d3ee", "#94a3b8"];
function HBars({ data, fmt }: { data: { label: string; value: number }[]; fmt: (v: number) => string }) {
  const max = Math.max(1, ...data.map((d) => d.value));
  if (!data.length) return <p style={{ color: C.sub, margin: 0 }}>Sin gastos en este período.</p>;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {data.map((d, i) => (
        <div key={d.label} style={{ display: "grid", gridTemplateColumns: "150px 1fr 90px", alignItems: "center", gap: 10 }}>
          <div style={{ fontSize: 12, color: "#cbd5e1", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={d.label}>{d.label}</div>
          <div style={{ background: "#0e1530", borderRadius: 6, height: 18 }}>
            <div style={{ width: Math.max(2, (d.value / max) * 100) + "%", height: "100%", borderRadius: 6, background: PALETA[i % PALETA.length] }} />
          </div>
          <div style={{ fontSize: 12, color: "#e2e8f0", textAlign: "right" }}>{fmt(d.value)}</div>
        </div>
      ))}
    </div>
  );
}

function Card({ title, children, span }: { title?: string; children: React.ReactNode; span?: number }) {
  return (
    <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 14, padding: "18px 20px", gridColumn: span ? `span ${span}` : undefined }}>
      {title && <h2 style={{ fontSize: 14, color: "#cbd5e1", margin: "0 0 16px", fontWeight: 600 }}>{title}</h2>}
      {children}
    </div>
  );
}

const SECCIONES = [
  { id: "dashboard", label: "Dashboard", icon: "▦" },
  { id: "facturas", label: "Facturas", icon: "🧾" },
  { id: "camiones", label: "Camiones", icon: "🚚" },
  { id: "f29", label: "F29", icon: "📄" },
  { id: "dj", label: "DJ 1866 / 1867", icon: "📑" },
  { id: "config", label: "Configuración", icon: "⚙" },
];

export default function App() {
  const [seccion, setSeccion] = useState("dashboard");
  const [empresas, setEmpresas] = useState<Empresa[]>([]);
  const [rut, setRut] = useState("");
  const [anio, setAnio] = useState(new Date().getFullYear());
  const [mes, setMes] = useState(""); // "" = todo el año, o "01".."12"
  const [periodos, setPeriodos] = useState<Periodo[]>([]);
  const [gastos, setGastos] = useState<{ label: string; value: number }[]>([]);
  const [estado, setEstado] = useState("Cargando…");

  // sincronización por rango con barra de progreso
  const [desdeSync, setDesdeSync] = useState("");
  const [hastaSync, setHastaSync] = useState("");
  const [sincronizando, setSincronizando] = useState(false);
  const [prog, setProg] = useState<{ done: number; total: number; label: string } | null>(null);
  const [syncLog, setSyncLog] = useState<string[]>([]);
  const [msg, setMsg] = useState("");

  useEffect(() => {
    try { setEmpresas(JSON.parse(localStorage.getItem("tx_empresas") || "[]")); } catch { /* */ }
    setRut(localStorage.getItem("tx_rut") || "");
    const h = new Date(); let y = h.getFullYear(), m = h.getMonth(); if (m === 0) { m = 12; y -= 1; }
    const per = "" + y + String(m).padStart(2, "0");
    setDesdeSync(per); setHastaSync(per);
  }, []);

  async function cargarPeriodos() {
    if (!rut) return;
    const { data, error } = await supabase
      .from("tx_periodos")
      .select("periodo, litros, iepd_total, credito_544, ingresos, ingreso_por_litro")
      .eq("rut", rut).order("periodo", { ascending: true });
    if (error) setEstado("No se pudo cargar: " + error.message);
    else { setPeriodos(data || []); setEstado((data || []).length ? "" : "Aún no hay datos. Usa “Actualizar mes”."); }
  }

  useEffect(() => { if (rut) { localStorage.setItem("tx_rut", rut); setEstado("Cargando…"); cargarPeriodos(); } }, [rut]);

  // Gasto por tipo (categoría) para el alcance año / año+mes.
  useEffect(() => {
    if (!rut) { setGastos([]); return; }
    (async () => {
      let q = supabase.from("tx_facturas").select("categoria, total").eq("rut", rut).eq("tipo", "compra");
      q = mes ? q.eq("periodo", String(anio) + mes) : q.gte("periodo", String(anio) + "01").lte("periodo", String(anio) + "12");
      const { data } = await q;
      const acc: Record<string, number> = {};
      (data || []).forEach((f: any) => { const k = f.categoria || "Otros"; acc[k] = (acc[k] || 0) + (Number(f.total) || 0); });
      setGastos(Object.entries(acc).map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value));
    })();
  }, [rut, anio, mes]);

  // Sincroniza mes por mes (barra de progreso real) llamando a la ingesta por período,
  // con una pausa entre meses para ser suave con el SII.
  async function sincronizar() {
    if (!rut) return;
    const lista = mesesEntre(desdeSync, hastaSync);
    if (!lista.length) { setMsg("✗ El 'desde' no puede ser mayor que el 'hasta'."); return; }
    setSincronizando(true); setSyncLog([]); setMsg("");
    const { data: s } = await supabase.auth.getSession();
    const token = s.session?.access_token || "";
    for (let i = 0; i < lista.length; i++) {
      const per = lista[i];
      // Reintenta el mismo período si el SII limita, con espera creciente, para no
      // dejarlo vacío. Hasta 4 intentos por período.
      let logged = false;
      for (let intento = 1; intento <= 4 && !logged; intento++) {
        setProg({ done: i, total: lista.length, label: per + (intento > 1 ? ` (reintento ${intento})` : "") });
        try {
          const r = await fetch(FUNCTIONS_URL + "/tracco-ingesta?rut=" + encodeURIComponent(rut) + "&periodo=" + per, { method: "POST", headers: { Authorization: "Bearer " + token } });
          const d = await r.json();
          if (d.ok) {
            const x = d.resumen?.[0];
            setSyncLog((l) => [...l, `${per}  ✓  ${x?.compras ?? 0} compras · ${numL(x?.litrosTotal)} L · crédito ${clp(x?.credito544)}`]);
            logged = true;
          } else if (d.rateLimited || r.status === 503 || r.status === 429) {
            // SII limitando: esperar más y reintentar el mismo período.
            if (intento < 4) { setSyncLog((l) => [...l, `${per}  …  SII limitando, esperando para reintentar`]); await new Promise((res) => setTimeout(res, 15000 * intento)); }
            else setSyncLog((l) => [...l, `${per}  ✗  el SII siguió limitando (queda pendiente, vuelve a sincronizar)`]);
          } else { setSyncLog((l) => [...l, `${per}  ✗  ${d.error || "error"}`]); logged = true; }
        } catch { if (intento >= 4) setSyncLog((l) => [...l, `${per}  ✗  error de red`]); else await new Promise((res) => setTimeout(res, 8000)); }
      }
      if (i < lista.length - 1) await new Promise((res) => setTimeout(res, 2500));
    }
    setProg({ done: lista.length, total: lista.length, label: "listo" });
    await cargarPeriodos();
    setSincronizando(false);
    setMsg("✓ Sincronización completa.");
  }

  // datos del año seleccionado
  const delAnio = useMemo(() => periodos.filter((p) => p.periodo.startsWith(String(anio))), [periodos, anio]);
  const aniosDisp = useMemo(() => {
    const s = new Set(periodos.map((p) => p.periodo.slice(0, 4)));
    const arr = [...s].sort().reverse();
    return arr.length ? arr : [String(anio)];
  }, [periodos]);
  const tot = useMemo(() => ({
    iepd: delAnio.reduce((a, p) => a + (p.iepd_total || 0), 0),
    credito: delAnio.reduce((a, p) => a + (p.credito_544 || 0), 0),
    litros: delAnio.reduce((a, p) => a + (Number(p.litros) || 0), 0),
    ingresos: delAnio.reduce((a, p) => a + (p.ingresos || 0), 0),
  }), [delAnio]);

  const serieMes = (campo: keyof Periodo) => MESES.map((label, i) => {
    const per = String(anio) + String(i + 1).padStart(2, "0");
    const row = delAnio.find((p) => p.periodo === per);
    return { label, value: Number(row?.[campo] || 0) };
  });

  const empresaActual = empresas.find((e) => e.rut === rut);

  return (
    <div style={{ display: "flex", minHeight: "100vh" }}>
      {/* Sidebar */}
      <aside style={{ width: 220, background: "#0b1220", borderRight: `1px solid ${C.border}`, padding: "22px 14px", flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "0 6px 22px" }}>
          <div style={{ width: 38, height: 38, borderRadius: 10, background: "linear-gradient(135deg,#14b8a6,#0ea5e9)", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 800, color: "#04212b" }}>Tx</div>
          <div><div style={{ fontWeight: 800, letterSpacing: 0.5 }}>TRACCO TX</div><div style={{ fontSize: 10, color: C.sub }}>SII · IEPD · F29</div></div>
        </div>
        {SECCIONES.map((s) => (
          <button key={s.id} onClick={() => setSeccion(s.id)}
            style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", textAlign: "left", padding: "10px 12px", marginBottom: 4, border: 0, borderRadius: 9, cursor: "pointer",
              background: seccion === s.id ? "#0d3b40" : "transparent", color: seccion === s.id ? C.accent : "#cbd5e1", fontWeight: seccion === s.id ? 600 : 400, fontSize: 14 }}>
            <span style={{ width: 18, textAlign: "center" }}>{s.icon}</span>{s.label}
          </button>
        ))}
        <a href="/" style={{ display: "block", marginTop: 18, padding: "0 12px", color: "#64748b", fontSize: 13 }}>← Salir</a>
      </aside>

      {/* Contenido */}
      <main style={{ flex: 1, padding: "26px 32px", maxWidth: 1280 }}>
        <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 22, gap: 12, flexWrap: "wrap" }}>
          <h1 style={{ fontSize: 22, margin: 0 }}>{SECCIONES.find((s) => s.id === seccion)?.label}</h1>
          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            {empresas.length > 0 && (
              <select value={rut} onChange={(e) => setRut(e.target.value)} style={selStyle}>
                {empresas.map((em) => <option key={em.rut} value={em.rut}>{em.razon_social} ({em.rut})</option>)}
              </select>
            )}
            <select value={anio} onChange={(e) => setAnio(Number(e.target.value))} style={selStyle}>
              {aniosDisp.map((y) => <option key={y} value={y}>{y}</option>)}
            </select>
            <select value={mes} onChange={(e) => setMes(e.target.value)} style={selStyle}>
              <option value="">Todo el año</option>
              {MESES.map((m, i) => <option key={m} value={String(i + 1).padStart(2, "0")}>{m}</option>)}
            </select>
          </div>
        </header>

        {seccion === "dashboard" && (
          <>
            <div style={{ marginBottom: 18 }}>
              <Card title="Sincronizar con el SII">
                <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                  <span style={{ fontSize: 12, color: C.sub }}>Desde</span><PerSelect value={desdeSync} onChange={setDesdeSync} />
                  <span style={{ fontSize: 12, color: C.sub }}>Hasta</span><PerSelect value={hastaSync} onChange={setHastaSync} />
                  <button onClick={sincronizar} disabled={sincronizando} style={{ padding: "9px 18px", border: 0, borderRadius: 9, background: "#14b8a6", color: "#04212b", fontWeight: 700, cursor: "pointer", opacity: sincronizando ? 0.6 : 1 }}>
                    {sincronizando ? "Sincronizando…" : "Sincronizar"}
                  </button>
                </div>
                {prog && (
                  <div style={{ marginTop: 14 }}>
                    <div style={{ height: 10, background: "#0e1530", borderRadius: 6, overflow: "hidden" }}>
                      <div style={{ height: "100%", width: (prog.total ? prog.done / prog.total * 100 : 0) + "%", background: "linear-gradient(90deg,#2dd4bf,#0ea5e9)", transition: "width .3s" }} />
                    </div>
                    <div style={{ fontSize: 12, color: C.sub, marginTop: 6 }}>{prog.done}/{prog.total}{prog.label !== "listo" ? ` · ${prog.label}…` : " · listo ✓"}</div>
                  </div>
                )}
                {syncLog.length > 0 && <div style={{ marginTop: 10, maxHeight: 150, overflow: "auto", fontSize: 12, color: "#cbd5e1", fontFamily: "ui-monospace, monospace", lineHeight: 1.6 }}>{syncLog.map((l, i) => <div key={i}>{l}</div>)}</div>}
                {msg && <div style={{ fontSize: 13, color: C.accent, marginTop: 8 }}>{msg}</div>}
              </Card>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 16, marginBottom: 18 }}>
              <Kpi label="Crédito 544 (recuperable)" value={clp(tot.credito)} accent sub={`IEPD × tramo · ${anio}`} />
              <Kpi label="IEPD total (código 28)" value={clp(tot.iepd)} sub="impuesto específico diésel" />
              <Kpi label="Litros diésel" value={numL(tot.litros) + " L"} sub={`${delAnio.length} períodos`} />
              <Kpi label="Ingresos (ventas)" value={clp(tot.ingresos)} sub="neto + exento" />
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 18 }}>
              <Card title={`Litros de diésel por mes · ${anio}`}><Bars data={serieMes("litros")} color="linear-gradient(180deg,#2dd4bf,#0e7490)" fmt={(v) => Math.round(v).toLocaleString("es-CL")} /></Card>
              <Card title={`Crédito 544 por mes · ${anio}`}><Bars data={serieMes("credito_544")} color="linear-gradient(180deg,#38bdf8,#0369a1)" fmt={(v) => Math.round(v / 1000) + "k"} /></Card>
            </div>

            <div style={{ marginBottom: 18 }}>
              <Card title={`Gasto por tipo · ${mes ? MESES[Number(mes) - 1] + " " : ""}${anio} (total con IVA)`}>
                <HBars data={gastos} fmt={clp} />
              </Card>
            </div>

            <Card title={`Detalle mensual ${anio}`}>
              {estado && <p style={{ color: C.sub }}>{estado}</p>}
              {delAnio.length > 0 && (
                <Tabla cols={["Período", "Litros", "IEPD", "Crédito 544", "Ingresos", "$/Litro"]}>
                  {delAnio.map((r) => (
                    <tr key={r.periodo} style={trStyle}>
                      <td style={tdL}>{r.periodo}</td>
                      <td style={td}><span style={{ color: C.accent }}>{numL(r.litros)}</span></td>
                      <td style={td}>{clp(r.iepd_total)}</td>
                      <td style={td}>{clp(r.credito_544)}</td>
                      <td style={td}>{clp(r.ingresos)}</td>
                      <td style={td}>{clp(r.ingreso_por_litro)}</td>
                    </tr>
                  ))}
                  <tr style={{ fontWeight: 700, color: C.ink }}>
                    <td style={{ ...tdL, borderTop: "2px solid #334155" }}>Total {anio}</td>
                    <td style={{ ...td, borderTop: "2px solid #334155" }}>{numL(tot.litros)}</td>
                    <td style={{ ...td, borderTop: "2px solid #334155" }}>{clp(tot.iepd)}</td>
                    <td style={{ ...td, borderTop: "2px solid #334155" }}>{clp(tot.credito)}</td>
                    <td style={{ ...td, borderTop: "2px solid #334155" }}>{clp(tot.ingresos)}</td>
                    <td style={{ ...td, borderTop: "2px solid #334155" }}>—</td>
                  </tr>
                </Tabla>
              )}
            </Card>
          </>
        )}

        {seccion === "facturas" && <Facturas rut={rut} anio={anio} />}
        {seccion === "camiones" && <Camiones rut={rut} />}
        {seccion === "config" && <Configuracion rut={rut} onEmpresas={(e, nuevoRut) => { setEmpresas(e); localStorage.setItem("tx_empresas", JSON.stringify(e)); if (nuevoRut) setRut(nuevoRut); }} />}
        {seccion === "f29" && <F29 delAnio={delAnio} anio={anio} empresa={empresaActual} />}
        {seccion === "dj" && <Placeholder titulo="Declaraciones Juradas 1866 / 1867" detalle="Genera los borradores de la DJ 1866 (crédito IEPD) y DJ 1867 a partir de las facturas clasificadas. En construcción — los datos base (IEPD, litros, crédito 544) ya están disponibles por período." />}
      </main>
    </div>
  );
}

// ---------- subcomponentes ----------
const selStyle: React.CSSProperties = { padding: 8, borderRadius: 8, border: "1px solid #2a3658", background: "#0e1530", color: "#e8ecf5", fontSize: 13 };
const td: React.CSSProperties = { padding: 8, borderBottom: "1px solid #1e2a3d", textAlign: "right", color: "#cbd5e1" };
const tdL: React.CSSProperties = { ...td, textAlign: "left" };
const trStyle: React.CSSProperties = {};

// Selector de período como dos listas desplegables (año + mes) sobre "AAAAMM".
function PerSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const y = value.slice(0, 4) || ANIOS[0];
  const m = value.slice(4, 6) || "01";
  return (
    <span style={{ display: "inline-flex", gap: 6 }}>
      <select value={y} onChange={(e) => onChange(e.target.value + m)} style={selStyle}>{ANIOS.map((yy) => <option key={yy} value={yy}>{yy}</option>)}</select>
      <select value={m} onChange={(e) => onChange(y + e.target.value)} style={selStyle}>{MESES.map((mm, i) => <option key={mm} value={String(i + 1).padStart(2, "0")}>{mm}</option>)}</select>
    </span>
  );
}

function Kpi({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: boolean }) {
  return (
    <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 14, padding: "16px 18px" }}>
      <div style={{ fontSize: 11, color: C.sub, textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 8 }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 700, color: accent ? C.accent : C.ink }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: "#64748b", marginTop: 6 }}>{sub}</div>}
    </div>
  );
}

function Tabla({ cols, children }: { cols: string[]; children: React.ReactNode }) {
  return (
    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
      <thead><tr>{cols.map((c, i) => <th key={i} style={{ textAlign: i === 0 ? "left" : "right", color: C.sub, fontWeight: 600, padding: "9px 8px", borderBottom: "1px solid #334155", fontSize: 11, textTransform: "uppercase", letterSpacing: 0.4 }}>{c}</th>)}</tr></thead>
      <tbody>{children}</tbody>
    </table>
  );
}

function Placeholder({ titulo, detalle }: { titulo: string; detalle: string }) {
  return <Card title={titulo}><p style={{ color: C.sub, fontSize: 14, lineHeight: 1.6, margin: 0 }}>{detalle}</p></Card>;
}

// ---------- Facturas ----------
function Facturas({ rut, anio }: { rut: string; anio: number }) {
  const [periodo, setPeriodo] = useState("");
  const [rows, setRows] = useState<Factura[]>([]);
  const [cat, setCat] = useState("");
  const [estado, setEstado] = useState("Selecciona un período.");

  useEffect(() => {
    // por defecto el último período del año con datos
    setPeriodo(String(anio) + "12");
  }, [anio]);

  useEffect(() => {
    if (!rut || !/^\d{6}$/.test(periodo)) return;
    (async () => {
      setEstado("Cargando…");
      const { data, error } = await supabase
        .from("tx_facturas")
        .select("folio, tipo_dte, razon_social, fecha_emision, categoria, neto, iepd, litros, total")
        .eq("rut", rut).eq("tipo", "compra").eq("periodo", periodo)
        .order("iepd", { ascending: false });
      if (error) setEstado("Error: " + error.message);
      else { setRows(data || []); setEstado((data || []).length ? "" : "Sin facturas en este período."); }
    })();
  }, [rut, periodo]);

  const cats = useMemo(() => [...new Set(rows.map((r) => r.categoria || "Otros"))].sort(), [rows]);
  const filtradas = cat ? rows.filter((r) => (r.categoria || "Otros") === cat) : rows;

  return (
    <Card title="Facturas de compra clasificadas">
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 14, flexWrap: "wrap" }}>
        <PerSelect value={periodo} onChange={setPeriodo} />
        <button onClick={() => setCat("")} style={chip(cat === "")}>Todas</button>
        {cats.map((c) => <button key={c} onClick={() => setCat(c)} style={chip(cat === c)}>{c}</button>)}
      </div>
      {estado && <p style={{ color: C.sub }}>{estado}</p>}
      {filtradas.length > 0 && (
        <Tabla cols={["Fecha", "Folio", "Proveedor", "Categoría", "Neto", "IEPD", "Litros", "Total"]}>
          {filtradas.map((r, i) => (
            <tr key={i}>
              <td style={tdL}>{r.fecha_emision || "—"}</td>
              <td style={tdL}>{r.folio}</td>
              <td style={{ ...tdL, maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.razon_social || "—"}</td>
              <td style={tdL}><span style={{ fontSize: 11, color: C.accent }}>{r.categoria || "Otros"}</span></td>
              <td style={td}>{clp(r.neto)}</td>
              <td style={td}>{r.iepd ? clp(r.iepd) : "—"}</td>
              <td style={td}>{r.litros ? numL(r.litros) : "—"}</td>
              <td style={td}>{clp(r.total)}</td>
            </tr>
          ))}
        </Tabla>
      )}
    </Card>
  );
}
const chip = (active: boolean): React.CSSProperties => ({ padding: "6px 12px", borderRadius: 8, border: `1px solid ${active ? "#14b8a6" : "#334155"}`, background: active ? "#0d3b40" : "#1e293b", color: active ? C.accent : "#cbd5e1", fontSize: 12, cursor: "pointer" });

// ---------- Camiones ----------
function Camiones({ rut }: { rut: string }) {
  const [rows, setRows] = useState<Camion[]>([]);
  const [estado, setEstado] = useState("Cargando…");
  const [form, setForm] = useState<Camion>({ patente: "", caja_rol: "", vigente_desde: "", vigente_hasta: "" });
  const [msg, setMsg] = useState("");

  async function cargar() {
    if (!rut) return;
    const { data, error } = await supabase.from("tx_camiones").select("id, patente, caja_rol, vigente_desde, vigente_hasta, activo").eq("rut", rut).order("created_at", { ascending: false });
    if (error) setEstado("Error: " + error.message);
    else { setRows(data || []); setEstado((data || []).length ? "" : "Aún no hay camiones."); }
  }
  useEffect(() => { cargar(); }, [rut]);

  async function agregar() {
    if (!form.patente.trim()) { setMsg("Indica la patente"); return; }
    const { error } = await supabase.from("tx_camiones").insert({
      rut, patente: form.patente.trim().toUpperCase(), caja_rol: form.caja_rol || null,
      vigente_desde: form.vigente_desde || null, vigente_hasta: form.vigente_hasta || null, activo: true,
    });
    if (error) setMsg("✗ " + error.message);
    else { setMsg("✓ Camión agregado"); setForm({ patente: "", caja_rol: "", vigente_desde: "", vigente_hasta: "" }); cargar(); }
  }

  return (
    <>
      <Card title="Camiones (patente y caja/rol por rango de fechas)">
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr auto", gap: 10, alignItems: "end", marginBottom: 8 }}>
          <Field label="Patente"><input value={form.patente} onChange={(e) => setForm({ ...form, patente: e.target.value })} style={inp} placeholder="ABCD12" /></Field>
          <Field label="Caja / Rol"><input value={form.caja_rol || ""} onChange={(e) => setForm({ ...form, caja_rol: e.target.value })} style={inp} placeholder="rol interno" /></Field>
          <Field label="Vigente desde"><input type="date" value={form.vigente_desde || ""} onChange={(e) => setForm({ ...form, vigente_desde: e.target.value })} style={inp} /></Field>
          <Field label="Vigente hasta"><input type="date" value={form.vigente_hasta || ""} onChange={(e) => setForm({ ...form, vigente_hasta: e.target.value })} style={inp} /></Field>
          <button onClick={agregar} style={{ padding: "9px 16px", border: 0, borderRadius: 9, background: "#14b8a6", color: "#04212b", fontWeight: 700, cursor: "pointer", height: 38 }}>Agregar</button>
        </div>
        {msg && <span style={{ fontSize: 13, color: "#cdd6ef" }}>{msg}</span>}
      </Card>
      <div style={{ height: 16 }} />
      <Card title="Flota">
        {estado && <p style={{ color: C.sub }}>{estado}</p>}
        {rows.length > 0 && (
          <Tabla cols={["Patente", "Caja / Rol", "Desde", "Hasta", "Estado"]}>
            {rows.map((c) => (
              <tr key={c.id}>
                <td style={tdL}><b>{c.patente}</b></td>
                <td style={tdL}>{c.caja_rol || "—"}</td>
                <td style={tdL}>{c.vigente_desde || "—"}</td>
                <td style={tdL}>{c.vigente_hasta || "—"}</td>
                <td style={tdL}><span style={{ color: c.activo ? C.accent : "#64748b" }}>{c.activo ? "Activo" : "Inactivo"}</span></td>
              </tr>
            ))}
          </Tabla>
        )}
      </Card>
    </>
  );
}
const inp: React.CSSProperties = { ...selStyle, width: "100%" };
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label style={{ display: "block" }}><div style={{ fontSize: 11, color: C.sub, marginBottom: 5 }}>{label}</div>{children}</label>;
}

// ---------- Configuración ----------
function Configuracion({ rut, onEmpresas }: { rut: string; onEmpresas: (e: Empresa[], nuevoRut?: string) => void }) {
  const [cfg, setCfg] = useState<Config | null>(null);
  const [msg, setMsg] = useState("");
  // Agregar empresa (RUT) validando contra el SII.
  const [nuevoRut, setNuevoRut] = useState("");
  const [addMsg, setAddMsg] = useState("");
  const [agregando, setAgregando] = useState(false);

  async function agregarRut() {
    const r = nuevoRut.trim().toUpperCase().replace(/\s/g, "");
    if (!/^\d{7,8}-[\dkK]$/.test(r)) { setAddMsg("✗ Formato de RUT inválido (ej. 12345678-9)."); return; }
    setAgregando(true); setAddMsg("Validando contra el SII…");
    try {
      const { data: s } = await supabase.auth.getSession();
      const token = s.session?.access_token || "";
      const res = await fetch(FUNCTIONS_URL + "/tracco-add-rut", { method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" }, body: JSON.stringify({ rut: r }) });
      const d = await res.json();
      if (d.ok) { onEmpresas(d.empresas || [], d.rut); setAddMsg(`✓ ${r} agregado. Ya aparece en el selector de empresas.`); setNuevoRut(""); }
      else setAddMsg("✗ " + (d.error || "No se pudo agregar"));
    } catch { setAddMsg("✗ Error de red"); }
    finally { setAgregando(false); }
  }

  useEffect(() => {
    if (!rut) return;
    (async () => {
      const { data } = await supabase.from("tx_contribuyentes").select("rut, razon_social, giro, tramo_iepd_pct, paga_ppm, ppm_tasa, renta_efectiva").eq("rut", rut).maybeSingle();
      setCfg(data as Config);
    })();
  }, [rut]);

  async function guardar() {
    if (!cfg) return;
    const { error } = await supabase.from("tx_contribuyentes").update({
      razon_social: cfg.razon_social, giro: cfg.giro, tramo_iepd_pct: cfg.tramo_iepd_pct,
      paga_ppm: cfg.paga_ppm, ppm_tasa: cfg.ppm_tasa, renta_efectiva: cfg.renta_efectiva,
    }).eq("rut", rut);
    setMsg(error ? "✗ " + error.message : "✓ Guardado");
  }

  const addRutCard = (
    <Card title="Agregar empresa (RUT)">
      <p style={{ color: C.sub, fontSize: 12.5, margin: "0 0 12px" }}>Escribe un RUT que representes en el SII. Se valida contra el SII: si tienes acceso, se agrega y empieza a rescatar; si no, te avisa.</p>
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <input value={nuevoRut} onChange={(e) => setNuevoRut(e.target.value)} placeholder="12345678-9" style={{ ...inp, width: 180 }} />
        <button onClick={agregarRut} disabled={agregando} style={{ padding: "9px 18px", border: 0, borderRadius: 9, background: "#14b8a6", color: "#04212b", fontWeight: 700, cursor: "pointer", opacity: agregando ? 0.6 : 1 }}>{agregando ? "Validando…" : "Agregar"}</button>
        {addMsg && <span style={{ fontSize: 13, color: addMsg.startsWith("✓") ? C.accent : "#cdd6ef" }}>{addMsg}</span>}
      </div>
    </Card>
  );

  if (!cfg) return <>{addRutCard}<div style={{ height: 16 }} /><Card title="Configuración por RUT"><p style={{ color: C.sub }}>{rut ? "Cargando…" : "Selecciona una empresa."}</p></Card></>;
  return (
    <>
    {addRutCard}
    <div style={{ height: 16 }} />
    <Card title={`Configuración — ${cfg.razon_social || rut}`}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, maxWidth: 640 }}>
        <Field label="Razón social"><input value={cfg.razon_social || ""} onChange={(e) => setCfg({ ...cfg, razon_social: e.target.value })} style={inp} /></Field>
        <Field label="Giro"><input value={cfg.giro || ""} onChange={(e) => setCfg({ ...cfg, giro: e.target.value })} style={inp} /></Field>
        <Field label="Tramo IEPD recuperable (%)"><input type="number" value={cfg.tramo_iepd_pct ?? 80} onChange={(e) => setCfg({ ...cfg, tramo_iepd_pct: Number(e.target.value) })} style={inp} /></Field>
        <Field label="Tasa PPM (%)"><input type="number" step="0.01" value={cfg.ppm_tasa ?? 0} onChange={(e) => setCfg({ ...cfg, ppm_tasa: Number(e.target.value) })} style={inp} /></Field>
        <Field label="¿Paga PPM?"><select value={cfg.paga_ppm ? "1" : "0"} onChange={(e) => setCfg({ ...cfg, paga_ppm: e.target.value === "1" })} style={inp}><option value="1">Sí</option><option value="0">No</option></select></Field>
        <Field label="¿Renta efectiva?"><select value={cfg.renta_efectiva ? "1" : "0"} onChange={(e) => setCfg({ ...cfg, renta_efectiva: e.target.value === "1" })} style={inp}><option value="1">Sí</option><option value="0">No</option></select></Field>
      </div>
      <div style={{ marginTop: 18, display: "flex", gap: 12, alignItems: "center" }}>
        <button onClick={guardar} style={{ padding: "9px 18px", border: 0, borderRadius: 9, background: "#14b8a6", color: "#04212b", fontWeight: 700, cursor: "pointer" }}>Guardar</button>
        {msg && <span style={{ fontSize: 13, color: "#cdd6ef" }}>{msg}</span>}
      </div>
    </Card>
    </>
  );
}

// ---------- F29 ----------
function F29({ delAnio, anio, empresa }: { delAnio: Periodo[]; anio: number; empresa?: Empresa }) {
  return (
    <Card title={`F29 — código 544 (crédito IEPD) · ${anio}`}>
      <p style={{ color: C.sub, fontSize: 13, margin: "0 0 14px" }}>
        Crédito IEPD a declarar en el código 544 del F29 por período, calculado desde las facturas con código 28.
        {empresa ? ` Empresa: ${empresa.razon_social}.` : ""}
      </p>
      {delAnio.length > 0 ? (
        <Tabla cols={["Período", "IEPD (cód. 28)", "Crédito 544", "Litros"]}>
          {delAnio.map((r) => (
            <tr key={r.periodo}>
              <td style={tdL}>{r.periodo}</td>
              <td style={td}>{clp(r.iepd_total)}</td>
              <td style={td}><span style={{ color: C.accent }}>{clp(r.credito_544)}</span></td>
              <td style={td}>{numL(r.litros)}</td>
            </tr>
          ))}
        </Tabla>
      ) : <p style={{ color: C.sub }}>Sin datos para {anio}.</p>}
    </Card>
  );
}
