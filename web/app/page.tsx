"use client";
import { useState } from "react";
import { FUNCTIONS_URL } from "../lib/supabaseClient";

// Login: valida RUT + clave contra el SII y exige correo autorizado.
// Llama a la Edge Function tracco-login (a implementar en el backend).
export default function Login() {
  const [rut, setRut] = useState("");
  const [clave, setClave] = useState("");
  const [email, setEmail] = useState("");
  const [estado, setEstado] = useState<string>("");
  const [cargando, setCargando] = useState(false);

  async function entrar(e: React.FormEvent) {
    e.preventDefault();
    setCargando(true);
    setEstado("Validando con el SII…");
    try {
      const r = await fetch(FUNCTIONS_URL + "/tracco-login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rut, clave, email }),
      });
      const data = await r.json();
      if (data.ok) {
        setEstado("✓ Acceso concedido. Redirigiendo…");
        window.location.href = "/dashboard";
      } else {
        setEstado("✗ " + (data.error || "No autorizado"));
      }
    } catch (err) {
      setEstado("✗ Error de red. ¿La función tracco-login está desplegada?");
    } finally {
      setCargando(false);
    }
  }

  return (
    <main style={{ display: "grid", placeItems: "center", minHeight: "100vh", padding: 24 }}>
      <form
        onSubmit={entrar}
        style={{ width: 360, maxWidth: "100%", background: "#141b33", padding: 28, borderRadius: 16, boxShadow: "0 10px 40px rgba(0,0,0,.4)" }}
      >
        <h1 style={{ margin: "0 0 4px", fontSize: 26 }}>Tracco Tx</h1>
        <p style={{ margin: "0 0 20px", color: "#9aa6c4", fontSize: 14 }}>
          Ingreso con tu Clave Tributaria del SII
        </p>
        <Field label="RUT" value={rut} onChange={setRut} placeholder="12345678-9" />
        <Field label="Clave Tributaria" value={clave} onChange={setClave} type="password" placeholder="••••••••" />
        <Field label="Correo autorizado" value={email} onChange={setEmail} type="email" placeholder="tu@correo.cl" />
        <button
          type="submit"
          disabled={cargando}
          style={{ width: "100%", padding: 12, marginTop: 8, border: 0, borderRadius: 10, background: "#3b6cff", color: "#fff", fontSize: 15, fontWeight: 600, cursor: "pointer", opacity: cargando ? 0.6 : 1 }}
        >
          {cargando ? "Validando…" : "Entrar"}
        </button>
        {estado && <p style={{ marginTop: 14, fontSize: 13, color: "#cdd6ef" }}>{estado}</p>}
        <p style={{ marginTop: 18, fontSize: 11, color: "#6b769a" }}>
          Tu clave se valida directo contra el SII; no se almacena salvo que lo autorices para descargas automáticas.
        </p>
      </form>
    </main>
  );
}

function Field(props: { label: string; value: string; onChange: (v: string) => void; type?: string; placeholder?: string }) {
  return (
    <label style={{ display: "block", marginBottom: 12 }}>
      <span style={{ fontSize: 12, color: "#9aa6c4" }}>{props.label}</span>
      <input
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        type={props.type || "text"}
        placeholder={props.placeholder}
        style={{ width: "100%", boxSizing: "border-box", marginTop: 4, padding: 10, borderRadius: 8, border: "1px solid #2a3658", background: "#0e1530", color: "#e8ecf5", fontSize: 14 }}
      />
    </label>
  );
}
