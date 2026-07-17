/**
 * Canvas2D schematics for the fiber hover magnifier.
 * Pure drawing helpers — no WebGPU, no network.
 */

import {
  MAG_TEXT,
  MAG_MUTED,
  MAG_TAP,
  MAG_DROP,
  MAG_DROP_FILL,
  MAG_SPLICE,
  MAG_MAINLINE,
  MAG_FUSE,
  MAG_HINT,
  SCHEMATIC_MAX_FIBERS,
  tiaFiberColor,
  tiaFiberIsLight,
} from "./fiber_style.js";

function shortGuid(g) {
  if (!g) return "—";
  return String(g).slice(0, 8);
}

/** Format optical loss for labels (null/undefined → null). */
export function fmtLoss(db) {
  if (db == null || db === "") return null;
  const n = Number(db);
  if (Number.isNaN(n)) return null;
  if (n === 0) return "0 dB";
  // Catalog values are typically two decimals (e.g. -11.93, -0.80)
  const s = Number.isInteger(n) ? String(n) : n.toFixed(2);
  return `${s} dB`;
}

function roundedRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/** Draw a TIA fiber chip at (cx, cy) with radius r. */
export function drawFiberChip(ctx, cx, cy, fiberNum, r = 5) {
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = tiaFiberColor(fiberNum);
  ctx.fill();
  ctx.lineWidth = 1;
  ctx.strokeStyle = tiaFiberIsLight(fiberNum)
    ? "rgba(0,0,0,0.45)"
    : "rgba(255,255,255,0.35)";
  ctx.stroke();
}

/**
 * Title strip + optional footer inside a circular clip (caller clips).
 * @returns {{ bodyTop: number, bodyBot: number }}
 */
export function drawLensChrome(ctx, cx, cy, r, title, footer) {
  const top = cy - r + 14;
  ctx.fillStyle = MAG_TEXT;
  ctx.font = `600 ${Math.max(10, r * 0.12)}px system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(title, cx, top, r * 1.7);

  let bodyBot = cy + r - 12;
  if (footer) {
    ctx.fillStyle = MAG_HINT;
    ctx.font = `${Math.max(8, r * 0.09)}px system-ui, sans-serif`;
    ctx.fillText(footer, cx, cy + r - 12, r * 1.7);
    bodyBot = cy + r - 22;
  }
  return { bodyTop: top + 12, bodyBot };
}

/** Enlarged tap circle + ports (fmap-only fallback). */
export function drawTapEnlarged(ctx, cx, cy, rBody, hit) {
  const r = rBody * 0.28;
  ctx.beginPath();
  ctx.arc(cx, cy - 4, r, 0, Math.PI * 2);
  const strand = hit.strand != null ? hit.strand : 0xff4280e0;
  const tube = hit.tube != null ? hit.tube : 0xff808080;
  ctx.fillStyle = rgbaToCss(strand);
  ctx.fill();
  ctx.lineWidth = Math.max(2, r * 0.18);
  ctx.strokeStyle = rgbaToCss(tube);
  ctx.stroke();

  const ports = hit.ports || 0;
  if (ports > 0) {
    ctx.fillStyle = "#fff";
    ctx.font = `700 ${Math.max(12, r * 0.9)}px system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.lineWidth = 3;
    ctx.strokeStyle = "rgba(0,0,0,0.5)";
    const t = String(ports);
    ctx.strokeText(t, cx, cy - 4);
    ctx.fillText(t, cx, cy - 4);
  }

  ctx.fillStyle = MAG_MUTED;
  ctx.font = `${Math.max(9, rBody * 0.1)}px system-ui, sans-serif`;
  ctx.fillText(
    ports > 0 ? `${ports}-port tap` : "Tap",
    cx,
    cy + r + 16,
    rBody * 1.6
  );
  if (hit.sp_guid) {
    ctx.fillStyle = MAG_HINT;
    ctx.font = `10px ui-monospace, monospace`;
    ctx.fillText(shortGuid(hit.sp_guid), cx, cy + r + 30, rBody * 1.6);
  }
}

/** Enlarged splice hexagon (fmap-only fallback). */
export function drawSpliceEnlarged(ctx, cx, cy, rBody, hit) {
  const r = rBody * 0.26;
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 3;
    const x = cx + r * Math.cos(a);
    const y = cy - 4 + r * Math.sin(a);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fillStyle = "rgba(30, 42, 68, 0.95)";
  ctx.fill();
  ctx.lineWidth = Math.max(2, r * 0.2);
  ctx.strokeStyle = MAG_SPLICE;
  ctx.stroke();

  ctx.fillStyle = MAG_MUTED;
  ctx.font = `${Math.max(9, rBody * 0.1)}px system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("Splice enclosure", cx, cy + r + 16, rBody * 1.6);
  if (hit.sp_guid) {
    ctx.fillStyle = MAG_HINT;
    ctx.font = `10px ui-monospace, monospace`;
    ctx.fillText(shortGuid(hit.sp_guid), cx, cy + r + 30, rBody * 1.6);
  }
}

/** Cable / drop callout (no SP detail). */
export function drawLineCallout(ctx, cx, cy, rBody, hit) {
  const isDrop = hit.kind === "drop";
  const w = rBody * 1.2;
  const y = cy - 6;
  ctx.save();
  ctx.lineWidth = isDrop ? 4 : 5;
  ctx.strokeStyle = isDrop ? MAG_DROP : MAG_MAINLINE;
  if (isDrop) ctx.setLineDash([6, 4]);
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(cx - w * 0.45, y);
  ctx.lineTo(cx + w * 0.45, y);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();

  const size = hit.cable_size || 0;
  const label = isDrop
    ? size
      ? `Drop · ${size}f`
      : "Drop fiber"
    : size
      ? `Cable · ${size}f`
      : "Mainline cable";

  ctx.fillStyle = MAG_TEXT;
  ctx.font = `600 ${Math.max(11, rBody * 0.12)}px system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(label, cx, cy + 18, rBody * 1.7);

  ctx.fillStyle = MAG_MUTED;
  ctx.font = `${Math.max(9, rBody * 0.09)}px system-ui, sans-serif`;
  ctx.fillText(
    isDrop ? "Customer drop (dashed)" : "Distribution / feeder",
    cx,
    cy + 34,
    rBody * 1.7
  );
}

/**
 * Full tap schematic from splice_detail JSON.
 * Shows tap value (e.g. 2P-14), primary light loss, feed IN / PT fibers,
 * drop ports (open vs patched), and through-fiber fuse splices — a
 * zoomed local view of the splice diagram around the tap.
 * @param {object} detail
 */
export function drawTapSchematic(ctx, cx, cy, r, detail) {
  const cables = detail.cables || [];
  const links = detail.links || [];
  const tap = detail.tap || {};
  const main = cables.filter((c) => !c.is_drop);
  const drops = cables.filter((c) => c.is_drop);

  const ingress = links.filter((l) => l.role === "ingress");
  const egress = links.filter((l) => l.role === "egress");
  const dropLinks = links.filter((l) => l.role === "drop");
  const fuses = links.filter((l) => l.role === "fuse" && l.a && l.b);

  // Reserve bottom band for through-fuse diagram (+ station footer)
  const throughH = fuses.length ? Math.min(40, r * 0.34) : 0;
  const midY = cy - 4 - throughH * 0.35;

  const pillW = Math.min(108, r * 0.95);
  const pillH = Math.min(68, r * 0.55);
  const pillX = cx - pillW / 2;
  const pillY = midY - pillH / 2;

  // Equipment pill — tap catalog value is the primary label (e.g. 2P-08)
  roundedRect(ctx, pillX, pillY, pillW, pillH, 10);
  ctx.fillStyle = "rgba(58, 40, 16, 0.95)";
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = MAG_TAP;
  ctx.stroke();

  const name = tap.name || (tap.ports ? `${tap.ports}P` : "Tap");
  ctx.fillStyle = MAG_HINT;
  ctx.font = `600 ${Math.max(7, r * 0.07)}px system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("tap value", cx, pillY + 10, pillW - 8);

  ctx.fillStyle = MAG_TAP;
  ctx.font = `700 ${Math.max(13, r * 0.145)}px system-ui, sans-serif`;
  ctx.fillText(name, cx, pillY + 26, pillW - 8);

  // Primary drop / catalog loss (e.g. −7.65 dB) + port count
  const dropLoss = fmtLoss(tap.loss_db);
  ctx.fillStyle = MAG_TEXT;
  ctx.font = `600 ${Math.max(9, r * 0.095)}px system-ui, sans-serif`;
  const lossLine = [
    tap.ports != null ? `${tap.ports}-port` : null,
    dropLoss ? `drop ${dropLoss}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  if (lossLine) ctx.fillText(lossLine, cx, pillY + 42, pillW - 8);

  // Feed tube/strand colors (matches full splice sheet header)
  if (tap.in_tube || tap.in_strand) {
    ctx.fillStyle = MAG_HINT;
    ctx.font = `${Math.max(7, r * 0.075)}px system-ui, sans-serif`;
    const feed =
      `feed ${tap.in_tube || "—"}/${tap.in_strand || "—"}` +
      (tap.out_tube || tap.out_strand
        ? ` · out ${tap.out_tube || "—"}/${tap.out_strand || "—"}`
        : "");
    ctx.fillText(feed, cx, pillY + pillH - 10, pillW - 8);
  }

  const leftX = cx - r * 0.78;
  const rightX = cx + r * 0.78;

  // Mainline rail header (size + short guid when single cable)
  let mainLabel =
    main.length === 1
      ? `${main[0].size || "?"}f`
      : main.length
        ? `${main.length}× main`
        : "mainline";
  if (main.length === 1 && main[0].guid) {
    mainLabel = `${main[0].size || "?"}f · ${shortGuid(main[0].guid)}`;
  }
  drawRailHeader(ctx, leftX, midY - 44, mainLabel, MAG_MAINLINE, false);

  // IN + pass-through (PT) on the feed side
  const leftFibers = [];
  for (const l of ingress) {
    leftFibers.push({
      fiber: l.a?.fiber || 0,
      role: "IN",
      loss: l.loss_db,
      open: !l.a,
    });
  }
  for (const l of egress) {
    leftFibers.push({
      fiber: l.a?.fiber || 0,
      role: "PT",
      loss: l.loss_db,
      open: !l.a,
    });
  }
  const seenL = new Set();
  const leftUnique = [];
  for (const f of leftFibers) {
    const k = f.role + ":" + f.fiber;
    if (seenL.has(k)) continue;
    seenL.add(k);
    leftUnique.push(f);
  }
  // Prefer IN then PT, then fiber number
  leftUnique.sort((a, b) => {
    if (a.role !== b.role) return a.role === "IN" ? -1 : 1;
    return a.fiber - b.fiber;
  });

  const slotH = Math.min(18, (r * 0.48) / Math.max(leftUnique.length, 1));
  leftUnique.forEach((f, i) => {
    const n = leftUnique.length;
    const y = midY - ((n - 1) * slotH) / 2 + i * slotH;
    const isIn = f.role === "IN";
    const color = isIn ? MAG_TAP : "rgba(106, 176, 255, 0.9)";

    if (f.fiber > 0) {
      drawFiberChip(ctx, leftX, y, f.fiber, 5);
      ctx.fillStyle = MAG_TEXT;
      ctx.font = `600 9px system-ui, sans-serif`;
      ctx.textAlign = "right";
      ctx.textBaseline = "middle";
      ctx.fillText(`f${f.fiber}`, leftX - 10, y);
    } else {
      ctx.fillStyle = MAG_HINT;
      ctx.font = `8px system-ui, sans-serif`;
      ctx.textAlign = "right";
      ctx.textBaseline = "middle";
      ctx.fillText("—", leftX, y);
    }

    // connector into pill
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(leftX + 8, y);
    ctx.lineTo(pillX, midY + (isIn ? -10 : 10));
    ctx.stroke();

    // arrow at pill edge
    const ax = pillX;
    const ay = midY + (isIn ? -10 : 10);
    ctx.fillStyle = color;
    ctx.beginPath();
    if (isIn) {
      ctx.moveTo(ax, ay);
      ctx.lineTo(ax - 5, ay - 3);
      ctx.lineTo(ax - 5, ay + 3);
    } else {
      // PT leaves the tap back to mainline
      ctx.moveTo(leftX + 8, y);
      ctx.lineTo(leftX + 13, y - 3);
      ctx.lineTo(leftX + 13, y + 3);
    }
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = color;
    ctx.font = `700 8px system-ui, sans-serif`;
    ctx.textAlign = "left";
    ctx.fillText(f.role, leftX + 10, y - 9);

    const lossStr = fmtLoss(f.loss);
    // Show PT / non-zero loss on feed side
    if (lossStr && (!isIn || (f.loss != null && Number(f.loss) !== 0))) {
      ctx.fillStyle = MAG_MUTED;
      ctx.font = `7px system-ui, sans-serif`;
      ctx.fillText(lossStr, leftX + 10, y + 8);
    }
  });

  if (!leftUnique.length) {
    ctx.fillStyle = MAG_HINT;
    ctx.font = `8px system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.fillText("no feed", leftX, midY);
  }

  // Drop rails (homes)
  drawRailHeader(ctx, rightX, midY - 44, "to home", MAG_DROP, true);

  const dropItems = dropLinks.length
    ? dropLinks.map((l) => ({
        fiber: l.a?.fiber || 0,
        port:
          l.drop_port != null
            ? `D${l.drop_port}`
            : String(l.port || "Drop").replace(/^Drop\s*/i, "D"),
        loss: l.loss_db,
        open: !l.a,
      }))
    : drops.map((d, i) => ({
        fiber: 1,
        port: `D${i + 1}`,
        loss: tap.loss_db,
        open: false,
      }));

  // If still empty, invent port slots from tap.ports
  if (!dropItems.length && tap.ports > 0) {
    for (let i = 1; i <= tap.ports; i++) {
      dropItems.push({
        fiber: 0,
        port: `D${i}`,
        loss: tap.loss_db,
        open: true,
      });
    }
  }

  const maxDrop = Math.min(dropItems.length, 6);
  const dSlot = Math.min(18, (r * 0.48) / Math.max(maxDrop, 1));
  dropItems.slice(0, maxDrop).forEach((d, i) => {
    const y = midY - ((maxDrop - 1) * dSlot) / 2 + i * dSlot;

    ctx.save();
    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = MAG_DROP;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(pillX + pillW, midY);
    ctx.lineTo(rightX - 8, y);
    ctx.stroke();
    ctx.restore();

    if (d.open || d.fiber <= 0) {
      // open / unpatched drop port
      ctx.beginPath();
      ctx.arc(rightX, y, 6, 0, Math.PI * 2);
      ctx.strokeStyle = MAG_DROP;
      ctx.lineWidth = 1.2;
      ctx.setLineDash([2, 2]);
      ctx.stroke();
      ctx.setLineDash([]);
    } else {
      drawFiberChip(ctx, rightX, y, d.fiber, 5);
      ctx.beginPath();
      ctx.arc(rightX, y, 7.5, 0, Math.PI * 2);
      ctx.strokeStyle = MAG_DROP;
      ctx.lineWidth = 1.2;
      ctx.stroke();
    }

    ctx.fillStyle = MAG_TEXT;
    ctx.font = `600 8px system-ui, sans-serif`;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    const portLabel = d.open ? `${d.port} open` : d.port;
    ctx.fillText(portLabel, rightX + 11, y - (fmtLoss(d.loss) ? 5 : 0));

    const dLoss = fmtLoss(d.loss);
    if (dLoss) {
      ctx.fillStyle = MAG_DROP;
      ctx.font = `700 7px system-ui, sans-serif`;
      ctx.fillText(dLoss, rightX + 11, y + 6);
    }
  });

  if (dropItems.length > maxDrop) {
    ctx.fillStyle = MAG_HINT;
    ctx.font = `7px system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.fillText(
      `+${dropItems.length - maxDrop} more`,
      rightX,
      midY + ((maxDrop - 1) * dSlot) / 2 + 14
    );
  }

  // Through splices (cable↔cable fuses that bypass the tap ports)
  if (fuses.length) {
    drawThroughFuses(
      ctx,
      cx,
      pillY + pillH + 6,
      r * 1.55,
      fuses,
      throughH + 8
    );
  } else if (detail.station_id) {
    ctx.fillStyle = MAG_HINT;
    ctx.font = `8px system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillText(detail.station_id, cx, pillY + pillH + 6, r * 1.6);
  }
}

/**
 * Compact row of through-fiber fuse pairs under a tap pill.
 * @param {object[]} fuses links with role fuse
 */
function drawThroughFuses(ctx, cx, top, maxW, fuses, bandH) {
  ctx.fillStyle = MAG_FUSE;
  ctx.font = `700 8px system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.fillText(
    `through ${fuses.length} splice${fuses.length > 1 ? "s" : ""}`,
    cx,
    top
  );

  // Prefer showing unique a-fiber chips when pairs are 1:1 same number
  const pairs = fuses
    .map((l) => ({
      af: l.a.fiber,
      bf: l.b.fiber,
      loss: l.loss_db,
    }))
    .sort((a, b) => a.af - b.af || a.bf - b.bf);

  const chipR = 4;
  const gap = 22;
  const maxShow = Math.min(
    pairs.length,
    Math.max(3, Math.floor(maxW / gap))
  );
  const shown = pairs.slice(0, maxShow);
  const rowW = shown.length * gap;
  const y = top + 16;
  const x0 = cx - rowW / 2 + gap / 2;

  shown.forEach((p, i) => {
    const x = x0 + i * gap;
    drawFiberChip(ctx, x - 5, y, p.af, chipR);
    drawFiberChip(ctx, x + 5, y, p.bf, chipR);
    ctx.strokeStyle = MAG_FUSE;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x - 1.5, y);
    ctx.lineTo(x + 1.5, y);
    ctx.stroke();
    ctx.fillStyle = MAG_FUSE;
    ctx.font = `700 7px system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("×", x, y);
  });

  if (pairs.length > maxShow) {
    ctx.fillStyle = MAG_HINT;
    ctx.font = `7px system-ui, sans-serif`;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(
      `+${pairs.length - maxShow}`,
      x0 + maxShow * gap - gap / 2 + 8,
      y
    );
  }

  // Suppress unused bandH warning path — band reserved by caller
  void bandH;
}

/**
 * Multi-cable fuse schematic (no tap) — visual diagram of splices
 * between cables at the enclosure, with optional light-loss labels.
 */
export function drawSpliceSchematic(ctx, cx, cy, r, detail) {
  const cables = (detail.cables || []).slice();
  const allLinks = detail.links || [];
  const fuseLinks = allLinks.filter((l) => l.role === "fuse" && l.a && l.b);
  const equipLinks = allLinks.filter(
    (l) => (l.role === "equip" || l.role === "ingress" || l.role === "egress" || l.role === "drop") && l.a
  );

  if (cables.length === 0 && !equipLinks.length) {
    ctx.fillStyle = MAG_MUTED;
    ctx.font = `${Math.max(10, r * 0.11)}px system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("No cables at splice", cx, cy);
    return;
  }

  // Prefer mainline first, then drops
  cables.sort((a, b) => (a.is_drop ? 1 : 0) - (b.is_drop ? 1 : 0));

  if (cables.length === 2 && fuseLinks.length) {
    drawTwoCableFuse(ctx, cx, cy, r, cables, fuseLinks, detail);
    return;
  }

  if (cables.length >= 2) {
    drawMultiCableFan(ctx, cx, cy, r, cables, fuseLinks, detail);
    return;
  }

  // Single cable (+ optional equipment ports)
  if (cables.length === 1) {
    drawSingleCableSplice(ctx, cx, cy, r, cables[0], equipLinks, detail);
    return;
  }

  ctx.fillStyle = MAG_MUTED;
  ctx.font = `${Math.max(10, r * 0.11)}px system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.fillText("Empty splicepoint", cx, cy);
}

function drawSingleCableSplice(ctx, cx, cy, r, cable, equipLinks, detail) {
  const isDrop = !!cable.is_drop;
  // Enclosure hex
  const hr = 14;
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 3;
    const x = cx + hr * Math.cos(a);
    const y = cy - 8 + hr * Math.sin(a);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fillStyle = "rgba(30, 42, 68, 0.95)";
  ctx.fill();
  ctx.strokeStyle = MAG_SPLICE;
  ctx.lineWidth = 1.5;
  ctx.stroke();

  ctx.fillStyle = MAG_TEXT;
  ctx.font = `700 9px system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(`${cable.size || "?"}f`, cx, cy - 8);

  // Cable stub left
  ctx.strokeStyle = isDrop ? MAG_DROP : MAG_MAINLINE;
  ctx.lineWidth = 3;
  if (isDrop) ctx.setLineDash([4, 3]);
  ctx.beginPath();
  ctx.moveTo(cx - r * 0.65, cy - 8);
  ctx.lineTo(cx - hr - 2, cy - 8);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.fillStyle = isDrop ? MAG_DROP : MAG_MAINLINE;
  ctx.font = `700 9px system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.fillText(
    `${isDrop ? "Drop" : "Cable"} ${cable.size || "?"}f`,
    cx - r * 0.45,
    cy - 22
  );
  ctx.fillStyle = MAG_HINT;
  ctx.font = `7px ui-monospace, monospace`;
  ctx.fillText(shortGuid(cable.guid), cx - r * 0.45, cy + 10);

  // Equipment / port list on the right
  const ports = equipLinks.slice(0, 8);
  if (ports.length) {
    const slot = Math.min(14, (r * 0.7) / Math.max(ports.length, 1));
    const top = cy - ((ports.length - 1) * slot) / 2 - 4;
    ports.forEach((l, i) => {
      const y = top + i * slot;
      const fn = l.a?.fiber || 0;
      if (fn > 0) drawFiberChip(ctx, cx + r * 0.35, y, fn, 4.5);
      ctx.strokeStyle = MAG_MUTED;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(cx + hr, cy - 8);
      ctx.lineTo(cx + r * 0.35 - 8, y);
      ctx.stroke();
      ctx.fillStyle = MAG_TEXT;
      ctx.font = `600 8px system-ui, sans-serif`;
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      const label = l.port || l.role || "port";
      ctx.fillText(label, cx + r * 0.35 + 10, y - (fmtLoss(l.loss_db) ? 4 : 0));
      const ls = fmtLoss(l.loss_db);
      if (ls) {
        ctx.fillStyle = MAG_MUTED;
        ctx.font = `7px system-ui, sans-serif`;
        ctx.fillText(ls, cx + r * 0.35 + 10, y + 6);
      }
    });
  } else {
    ctx.fillStyle = MAG_HINT;
    ctx.font = `9px system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.fillText("no pairs recorded", cx, cy + r * 0.45);
  }

  if (detail.station_id) {
    ctx.fillStyle = MAG_HINT;
    ctx.font = `8px system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.fillText(detail.station_id, cx, cy + r * 0.7);
  }
}

function drawTwoCableFuse(ctx, cx, cy, r, cables, fuseLinks, detail) {
  const left = cables[0];
  const right = cables[1];
  const lx = cx - r * 0.58;
  const rx = cx + r * 0.58;
  const top = cy - r * 0.38;

  drawCableColumn(ctx, lx, top, left, fuseLinks, "a");
  drawCableColumn(ctx, rx, top, right, fuseLinks, "b");

  // Center fuse marks for each link
  const pairs = fuseLinks
    .map((l) => {
      if (l.a.cable === left.guid && l.b.cable === right.guid) {
        return { lf: l.a.fiber, rf: l.b.fiber, loss: l.loss_db };
      }
      if (l.a.cable === right.guid && l.b.cable === left.guid) {
        return { lf: l.b.fiber, rf: l.a.fiber, loss: l.loss_db };
      }
      return null;
    })
    .filter(Boolean)
    .slice(0, SCHEMATIC_MAX_FIBERS);

  // Map fiber → y for each side
  const leftFibers = uniqueFibersForCable(left.guid, fuseLinks);
  const rightFibers = uniqueFibersForCable(right.guid, fuseLinks);
  const slot = Math.min(13, (r * 0.72) / Math.max(leftFibers.length, rightFibers.length, 1));
  const ly = fiberYs(leftFibers, top + 20, slot);
  const ry = fiberYs(rightFibers, top + 20, slot);

  for (const p of pairs) {
    const y0 = ly.get(p.lf);
    const y1 = ry.get(p.rf);
    if (y0 == null || y1 == null) continue;
    ctx.strokeStyle = MAG_FUSE;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(lx + 14, y0);
    ctx.bezierCurveTo(cx - 10, y0, cx + 10, y1, rx - 14, y1);
    ctx.stroke();
    // mid fuse mark
    const my = (y0 + y1) / 2;
    ctx.fillStyle = MAG_FUSE;
    ctx.font = `10px system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("×", cx, my);
    const ls = fmtLoss(p.loss);
    if (ls && Number(p.loss) !== 0) {
      ctx.fillStyle = MAG_MUTED;
      ctx.font = `6px system-ui, sans-serif`;
      ctx.fillText(ls, cx, my + 9);
    }
  }

  // Summary strip
  ctx.fillStyle = MAG_MUTED;
  ctx.font = `8px system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.fillText(
    `${pairs.length} splice${pairs.length === 1 ? "" : "s"}` +
      (fuseLinks.length > pairs.length
        ? ` · +${fuseLinks.length - pairs.length} more`
        : ""),
    cx,
    cy + r * 0.58
  );

  if (detail.station_id) {
    ctx.fillStyle = MAG_HINT;
    ctx.font = `8px system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.fillText(detail.station_id, cx, cy + r * 0.72);
  }
}

function drawMultiCableFan(ctx, cx, cy, r, cables, fuseLinks, detail) {
  const n = Math.min(cables.length, 6);
  const shown = cables.slice(0, n);
  const radius = r * 0.52;

  // Center enclosure
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 3;
    const x = cx + 12 * Math.cos(a);
    const y = cy + 12 * Math.sin(a);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fillStyle = "rgba(30, 42, 68, 0.9)";
  ctx.fill();
  ctx.strokeStyle = MAG_SPLICE;
  ctx.lineWidth = 1.5;
  ctx.stroke();

  const positions = shown.map((c, i) => {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
    return {
      cable: c,
      x: cx + radius * Math.cos(a),
      y: cy + radius * Math.sin(a),
      a,
    };
  });

  // Draw rails
  for (const p of positions) {
    const isDrop = !!p.cable.is_drop;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 16, 0, Math.PI * 2);
    ctx.fillStyle = isDrop ? MAG_DROP_FILL : "rgba(26, 51, 88, 0.85)";
    ctx.fill();
    ctx.lineWidth = isDrop ? 1.5 : 1.2;
    ctx.strokeStyle = isDrop ? MAG_DROP : MAG_MAINLINE;
    if (isDrop) {
      ctx.setLineDash([3, 2]);
    }
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = MAG_TEXT;
    ctx.font = `700 9px system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(`${p.cable.size || "?"}f`, p.x, p.y - 2);
    ctx.fillStyle = MAG_HINT;
    ctx.font = `7px ui-monospace, monospace`;
    ctx.fillText(shortGuid(p.cable.guid), p.x, p.y + 9);
  }

  // Fuse curves between cable hubs (bundle count)
  const pairCounts = new Map();
  for (const l of fuseLinks) {
    if (!l.a || !l.b) continue;
    const ka = l.a.cable;
    const kb = l.b.cable;
    const key = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
    if (!pairCounts.has(key)) pairCounts.set(key, []);
    pairCounts.get(key).push(l);
  }

  const posByGuid = new Map(positions.map((p) => [p.cable.guid, p]));
  for (const [key, list] of pairCounts) {
    const [ga, gb] = key.split("|");
    const pa = posByGuid.get(ga);
    const pb = posByGuid.get(gb);
    if (!pa || !pb) continue;
    ctx.strokeStyle = "rgba(93, 173, 226, 0.75)";
    ctx.lineWidth = Math.min(4, 1 + list.length * 0.25);
    ctx.beginPath();
    ctx.moveTo(pa.x, pa.y);
    ctx.quadraticCurveTo(cx, cy, pb.x, pb.y);
    ctx.stroke();

    // show a few fiber chips along the arc
    const samples = list.slice(0, 4);
    samples.forEach((l, i) => {
      const t = 0.35 + (i * 0.1);
      const x =
        (1 - t) * (1 - t) * pa.x + 2 * (1 - t) * t * cx + t * t * pb.x;
      const y =
        (1 - t) * (1 - t) * pa.y + 2 * (1 - t) * t * cy + t * t * pb.y;
      drawFiberChip(ctx, x, y, l.a.fiber, 3.5);
    });
    if (list.length > 0) {
      const mx = (pa.x + pb.x) / 2 * 0.5 + cx * 0.5;
      const my = (pa.y + pb.y) / 2 * 0.5 + cy * 0.5;
      ctx.fillStyle = MAG_FUSE;
      ctx.font = `700 8px system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(String(list.length), mx, my);
    }
  }

  // Legend row
  ctx.fillStyle = MAG_MUTED;
  ctx.font = `8px system-ui, sans-serif`;
  ctx.textAlign = "center";
  const nFuse = fuseLinks.length;
  const nDrop = shown.filter((c) => c.is_drop).length;
  const nMain = shown.filter((c) => !c.is_drop).length;
  ctx.fillText(
    `${nMain} main` +
      (nDrop ? ` · ${nDrop} drop` : "") +
      (nFuse ? ` · ${nFuse} splices` : " · no pairs"),
    cx,
    cy + r * 0.78
  );

  // Sample loss if any non-zero fuse loss
  const lossSample = fuseLinks.find(
    (l) => l.loss_db != null && Number(l.loss_db) !== 0
  );
  if (lossSample) {
    ctx.fillStyle = MAG_HINT;
    ctx.font = `7px system-ui, sans-serif`;
    ctx.fillText(`e.g. ${fmtLoss(lossSample.loss_db)}`, cx, cy + r * 0.88);
  }

  if (detail.station_id) {
    ctx.fillStyle = MAG_HINT;
    ctx.font = `8px system-ui, sans-serif`;
    ctx.fillText(detail.station_id, cx, cy + r * 0.96);
  }
}

function drawCableColumn(ctx, x, top, cable, fuseLinks, _side) {
  const isDrop = !!cable.is_drop;
  ctx.fillStyle = isDrop ? MAG_DROP : MAG_MAINLINE;
  ctx.font = `700 9px system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "bottom";
  ctx.fillText(
    `${isDrop ? "Drop" : "Cable"} ${cable.size || "?"}f`,
    x,
    top - 2
  );
  ctx.fillStyle = MAG_HINT;
  ctx.font = `7px ui-monospace, monospace`;
  ctx.textAlign = "center";
  ctx.fillText(shortGuid(cable.guid), x, top + 8);

  const fibers = uniqueFibersForCable(cable.guid, fuseLinks);
  const slot = Math.min(14, 12);
  const ys = fiberYs(fibers, top + 20, slot);
  for (const [fn, y] of ys) {
    drawFiberChip(ctx, x, y, fn, 5);
    ctx.fillStyle = MAG_TEXT;
    ctx.font = `600 8px system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    // number outside
    ctx.fillText(String(fn), x + (isDrop ? 14 : -14), y);
  }
  if (!fibers.length) {
    ctx.fillStyle = MAG_HINT;
    ctx.font = `8px system-ui, sans-serif`;
    ctx.fillText("—", x, top + 28);
  }
}

function uniqueFibersForCable(guid, fuseLinks) {
  const s = new Set();
  for (const l of fuseLinks) {
    if (l.a?.cable === guid) s.add(l.a.fiber);
    if (l.b?.cable === guid) s.add(l.b.fiber);
  }
  return [...s].sort((a, b) => a - b).slice(0, SCHEMATIC_MAX_FIBERS);
}

function fiberYs(fibers, top, slot) {
  const m = new Map();
  fibers.forEach((f, i) => m.set(f, top + i * slot));
  return m;
}

function drawRailHeader(ctx, x, y, label, color, dashed) {
  ctx.fillStyle = color;
  ctx.font = `700 8px system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(label, x, y);
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  if (dashed) ctx.setLineDash([3, 2]);
  ctx.beginPath();
  ctx.moveTo(x - 22, y + 8);
  ctx.lineTo(x + 22, y + 8);
  ctx.stroke();
  ctx.setLineDash([]);
}

export function rgbaToCss(rgba) {
  const r = rgba & 0xff;
  const g = (rgba >> 8) & 0xff;
  const b = (rgba >> 16) & 0xff;
  return `rgb(${r},${g},${b})`;
}

/**
 * Paint full magnifier content for a hit + optional detail.
 * Caller has already drawn the glass rim and clipped to the lens circle.
 */
export function paintMagnifierContent(ctx, cx, cy, rCss, hit, detail) {
  const title = magnifierTitle(hit, detail);
  const footer =
    hit.sp_guid && (hit.kind === "tap" || hit.kind === "splice")
      ? "Click for full diagram"
      : "";
  const { bodyTop, bodyBot } = drawLensChrome(ctx, cx, cy, rCss, title, footer);
  const bodyCy = (bodyTop + bodyBot) / 2;
  const bodyR = Math.max(20, (bodyBot - bodyTop) / 2);

  if (hit.kind === "cable" || hit.kind === "drop") {
    drawLineCallout(ctx, cx, bodyCy, bodyR, hit);
    return;
  }

  if (detail && (detail.cables?.length || detail.links?.length || detail.tap)) {
    if (detail.kind === "tap" || hit.kind === "tap" || detail.tap) {
      drawTapSchematic(ctx, cx, bodyCy, bodyR, detail);
    } else {
      drawSpliceSchematic(ctx, cx, bodyCy, bodyR, detail);
    }
    return;
  }

  // fmap-only fallback (detail undefined = still loading; null = missing)
  if (hit.kind === "tap") drawTapEnlarged(ctx, cx, bodyCy, bodyR, hit);
  else if (hit.kind === "splice") drawSpliceEnlarged(ctx, cx, bodyCy, bodyR, hit);
  else drawLineCallout(ctx, cx, bodyCy, bodyR, hit);

  if (hit.sp_guid && detail === undefined) {
    ctx.fillStyle = MAG_HINT;
    ctx.font = `8px system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.fillText("Loading detail…", cx, bodyBot - 4);
  } else if (hit.sp_guid && detail === null) {
    ctx.fillStyle = MAG_HINT;
    ctx.font = `8px system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.fillText("No local schematic", cx, bodyBot - 4);
  }
}

function magnifierTitle(hit, detail) {
  if (hit.kind === "tap") {
    // Prefer equipment name / tap value (e.g. 2P-14) over generic "Tap · N ports"
    const name = detail?.tap?.name;
    const ports = detail?.tap?.ports ?? hit.ports;
    const st = detail?.station_id;
    const loss = fmtLoss(detail?.tap?.loss_db);
    if (name) {
      // e.g. "2P-08 · −7.65 dB" or "2P-08 · P045035001"
      const bits = [name];
      if (loss) bits.push(loss);
      else if (st) bits.push(st);
      return bits.join(" · ");
    }
    return (
      (ports != null ? `Tap · ${ports} ports` : "Tap") +
      (st ? ` · ${st}` : "")
    );
  }
  if (hit.kind === "splice") {
    const st = detail?.station_id;
    const n = detail?.cables?.length;
    const nFuse = (detail?.links || []).filter((l) => l.role === "fuse").length;
    let t = st ? `Splice · ${st}` : "Splice enclosure";
    if (n != null) t += ` · ${n} cables`;
    if (nFuse) t += ` · ${nFuse}×`;
    return t;
  }
  if (hit.kind === "drop") return "Drop fiber";
  if (hit.kind === "cable") return "Mainline fiber";
  return "Fiber";
}


