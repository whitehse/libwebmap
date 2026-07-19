/**
 * Optical path budget helpers (host-only).
 *
 * Light direction: Tier A path walks start at the plant/source side
 * (OLT / feeder). Equipment hops carry port_name_type + split_db from the
 * design DB (Input / Pass Through / Drop). Aggregate loss today is the
 * exported total_loss_db (equipment splits); distance attenuation is planned.
 *
 * See docs/designs/optical-budget.md
 */

/** @typedef {{ kind:string, seq?:number, cable_guid?:string, fiber?:number, sp_guid?:string, station_id?:string, port_name?:string, port_name_type?:string, split_db?:number|null }} PathHop */
/** @typedef {{ seq:number, kind:string, label:string, role:string, loss_db:number, cumulative_db:number, cable_guid?:string, fiber?:number, sp_guid?:string, station_id?:string, port_name?:string }} BudgetStep */

/**
 * Normalize port role from path hop or splice_detail link.
 * @param {string} [portNameType]
 * @param {string} [portName]
 */
export function classifyPortRole(portNameType, portName) {
  const t = String(portNameType || "").toLowerCase().replace(/\s+/g, "_");
  const n = String(portName || "").toLowerCase();
  if (t === "input" || n === "input" || n.startsWith("in ")) return "input";
  if (
    t === "pass_through" ||
    t === "passthrough" ||
    t === "through" ||
    n.includes("pass through") ||
    n === "pt"
  )
    return "pass_through";
  if (t === "drop" || n.startsWith("drop")) return "drop";
  if (t === "fuse" || n.includes("fusion")) return "fuse";
  return t || "equipment";
}

/**
 * Build hop-by-hop budget from a path_index path object.
 * Cumulative is sum of equipment split_db (negative = loss).
 * Cable hops contribute 0 today (distance model is planned).
 *
 * @param {object} path
 * @returns {{
 *   source: { cable_guid?:string, fiber?:number, label:string },
 *   end: { cable_guid?:string, fiber?:number, end_kind?:string },
 *   light_direction: "start_to_end",
 *   steps: BudgetStep[],
 *   total_loss_db: number,
 *   equipment_loss_db: number,
 *   notes: string[]
 * }}
 */
export function buildPathBudget(path) {
  const notes = [];
  const hops = Array.isArray(path?.hops) ? path.hops.slice() : [];
  hops.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));

  const source = {
    cable_guid: path?.start?.cable_guid || hops.find((h) => h.kind === "cable")?.cable_guid,
    fiber: path?.start?.fiber ?? hops.find((h) => h.kind === "cable")?.fiber,
    label: "source (path start)",
  };
  const end = {
    cable_guid: path?.end?.cable_guid,
    fiber: path?.end?.fiber,
    end_kind: path?.end_kind || "",
  };

  /** @type {BudgetStep[]} */
  const steps = [];
  let cum = 0;
  let equipLoss = 0;

  // Implicit source marker
  steps.push({
    seq: -1,
    kind: "source",
    label: source.fiber != null ? `Source · f${source.fiber}` : "Source",
    role: "source",
    loss_db: 0,
    cumulative_db: 0,
    cable_guid: source.cable_guid,
    fiber: source.fiber,
  });

  for (const h of hops) {
    if (h.kind === "cable") {
      steps.push({
        seq: h.seq ?? steps.length,
        kind: "cable",
        label:
          h.fiber != null
            ? `Cable · f${h.fiber}`
            : "Cable",
        role: "cable",
        loss_db: 0, // distance attenuation planned
        cumulative_db: cum,
        cable_guid: h.cable_guid,
        fiber: h.fiber,
      });
    } else {
      const role = classifyPortRole(h.port_name_type, h.port_name);
      const loss =
        h.split_db != null && Number.isFinite(Number(h.split_db))
          ? Number(h.split_db)
          : 0;
      cum += loss;
      equipLoss += loss;
      const st = h.station_id || (h.sp_guid ? String(h.sp_guid).slice(0, 8) : "");
      const port = h.port_name || role;
      steps.push({
        seq: h.seq ?? steps.length,
        kind: "equipment",
        label: st ? `${st} · ${port}` : port,
        role,
        loss_db: loss,
        cumulative_db: cum,
        sp_guid: h.sp_guid,
        station_id: h.station_id,
        port_name: h.port_name,
      });
    }
  }

  const total =
    path?.total_loss_db != null && Number.isFinite(Number(path.total_loss_db))
      ? Number(path.total_loss_db)
      : equipLoss;

  if (Math.abs(total - equipLoss) > 0.05 && path?.total_loss_db != null) {
    notes.push(
      `hop sum ${equipLoss.toFixed(2)} dB vs path total ${total.toFixed(2)} dB`
    );
  }
  notes.push("Distance (dB/km) not yet applied — equipment splits only");
  notes.push("Light direction: path start → end (Tier A optical walk)");

  return {
    source,
    end,
    light_direction: "start_to_end",
    steps,
    total_loss_db: total,
    equipment_loss_db: equipLoss,
    notes,
  };
}

/**
 * Severity band for total path loss (more negative = more loss).
 * @param {number} totalDb
 * @returns {"ok"|"warn"|"critical"|"unknown"}
 */
export function lossSeverity(totalDb) {
  if (totalDb == null || !Number.isFinite(Number(totalDb))) return "unknown";
  const a = Math.abs(Number(totalDb));
  if (a < 12) return "ok";
  if (a < 22) return "warn";
  return "critical";
}

/**
 * Extract through-tap topology from splice_detail links for magnifier.
 * Light convention at a tap: Input (upstream) → Pass Through (downstream)
 * and/or Drop (customer, high split).
 *
 * @param {object} detail
 * @returns {{
 *   through: Array<{in:{cable:string,fiber:number}, out:{cable:string,fiber:number}, pt_loss_db:number|null}>,
 *   drops: Array<{from:{cable:string,fiber:number}|null, drop:{cable:string,fiber:number}|null, drop_port?:number, loss_db:number|null}>,
 *   feed_fiber: number|null
 * }}
 */
export function tapLightTopology(detail) {
  const links = detail?.links || [];
  const ingress = links.filter((l) => l.role === "ingress" && l.a?.cable);
  const egress = links.filter((l) => l.role === "egress" && l.a?.cable);
  const drops = links.filter((l) => l.role === "drop");

  /** @type {Array<{in:any,out:any,pt_loss_db:number|null}>} */
  const through = [];
  // Pair IN and PT by matching fiber when possible, else first-of each
  for (const inn of ingress) {
    const fn = inn.a.fiber;
    let out =
      egress.find((e) => e.a.fiber === fn) ||
      (egress.length === 1 ? egress[0] : null);
    if (!out && egress.length) {
      // same cable pair regardless of fiber number
      out = egress[0];
    }
    if (out) {
      through.push({
        in: { cable: inn.a.cable, fiber: inn.a.fiber },
        out: { cable: out.a.cable, fiber: out.a.fiber },
        pt_loss_db:
          out.loss_db != null
            ? Number(out.loss_db)
            : inn.loss_db != null
              ? Number(inn.loss_db)
              : null,
      });
    }
  }

  const dropRows = drops.map((d) => ({
    from: ingress[0]?.a
      ? { cable: ingress[0].a.cable, fiber: ingress[0].a.fiber }
      : null,
    drop: d.a?.cable
      ? { cable: d.a.cable, fiber: d.a.fiber }
      : null,
    drop_port: d.drop_port,
    loss_db: d.loss_db != null ? Number(d.loss_db) : detail?.tap?.loss_db ?? null,
  }));

  const feed_fiber =
    through[0]?.in?.fiber ??
    ingress[0]?.a?.fiber ??
    null;

  return { through, drops: dropRows, feed_fiber };
}

export function fmtLossDb(db) {
  if (db == null || db === "" || !Number.isFinite(Number(db))) return "—";
  const n = Number(db);
  if (n === 0) return "0 dB";
  return `${n.toFixed(2)} dB`;
}
