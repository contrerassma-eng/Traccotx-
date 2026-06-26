"use client";
import { useEffect, useState } from "react";
import { supabase } from "../../lib/supabaseClient";

type Periodo = {
  periodo: string;
  litros: number | null;
  iepd_total: number | null;
  credito_544: number | null;
  ingresos: number | null;
  ingreso_por_litro: number | null;
};

// Dashboard: litros por mes, ingreso/litro y crédito IEPD. Lee de tx_periodos
// (RLS por RUT). Mientras no haya datos cargados muestra el estado vacío.
type Empresa = { rut: string; razon_social: string };

export default function Dashboard() {
  const [rows, setRows] = useState<Periodo[]>([]);
  const [estado, setEstado] = useState("Cargando…");
  const [empresas, setEmpresas] = useState<Empresa[]>([]);
  const [rut, setRut] = useState<string>("");

  useEffect(() => {
    try { setEmpresas(JSON.parse(localStorage.getItem("tx_empresas") || "[]")); } catch { /* */ }
    setRut(localStorage.getItem("tx_rut") || "");
  }, []);

  useEffect(() => {
    if (!rut) return;
    localStorage.setItem("tx_rut", rut);
    (async () => {
      setEstado("Cargando…");
      const { data, error } = await supabase
        .from("tx_periodos")
        .select("periodo, litros, iepd_total, credito_544, ingresos, ingreso_por_litro")
        .eq("rut", rut)
        .order("periodo", { ascending: false })
        .limit(24);
      if (error) setEstado("No se pudo cargar (revisa sesión/permisos): " + error.message);
      else { setRows(data || []); setEstado((data || []).length ? "" : "Aún no hay periodos cargados para este RUT. Ejecuta la ingesta del SII."); }
    })();
  }, [rut]);

  const clp = (n: number | null) => (n == null ? "—" : "$" + n.toLocaleString("es-CL"));
  const num = (n: number | null) => (n == null ? "—" : n.toLocaleString("es-CL"));

  return (
    <main style={{ maxWidth: 1000, margin: "0 auto", padding: 24 }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20, gap: 12, flexWrap: "wrap" }}>
        <h1 style={{ fontSize: 24, margin: 0 }}>Dashboard — Tracco Tx</h1>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          {empresas.length > 0 && (
            <select
              value={rut}
              onChange={(e) => setRut(e.target.value)}
              style={{ padding: 8, borderRadius: 8, border: "1px solid #2a3658", background: "#0e1530", color: "#e8ecf5", fontSize: 13 }}
            >
              {empresas.map((em) => (
                <option key={em.rut} value={em.rut}>{em.razon_social} ({em.rut})</option>
              ))}
            </select>
          )}
          <a href="/" style={{ color: "#9aa6c4", fontSize: 13 }}>Salir</a>
        </div>
      </header>
      {estado && <p style={{ color: "#9aa6c4" }}>{estado}</p>}
      {rows.length > 0 && (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
          <thead>
            <tr style={{ textAlign: "right", color: "#9aa6c4" }}>
              <th style={{ textAlign: "left", padding: 8 }}>Periodo</th>
              <th style={{ padding: 8 }}>Litros</th>
              <th style={{ padding: 8 }}>IEPD</th>
              <th style={{ padding: 8 }}>Crédito 544</th>
              <th style={{ padding: 8 }}>Ingresos</th>
              <th style={{ padding: 8 }}>$/Litro</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.periodo} style={{ textAlign: "right", borderTop: "1px solid #222c4a" }}>
                <td style={{ textAlign: "left", padding: 8 }}>{r.periodo}</td>
                <td style={{ padding: 8 }}>{num(r.litros)}</td>
                <td style={{ padding: 8 }}>{clp(r.iepd_total)}</td>
                <td style={{ padding: 8, color: "#7ee0a1" }}>{clp(r.credito_544)}</td>
                <td style={{ padding: 8 }}>{clp(r.ingresos)}</td>
                <td style={{ padding: 8 }}>{clp(r.ingreso_por_litro)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
