/**
 * Parse .fmap feature tiles (data only; ADR-015).
 * Normative layout: docs/formats/fmap.md
 * Writer: tools/fiber2features/ (libwebmap)
 */

const FMAP_MAGIC = 0x50414d46; /* 'FMAP' LE */

function u32(dv, o) {
  return dv.getUint32(o, true);
}
function u16(dv, o) {
  return dv.getUint16(o, true);
}

/** 16-byte UUID → standard 8-4-4-4-12 string. */
export function guidBytesToString(bytes) {
  if (!bytes || bytes.length < 16) return "";
  const h = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return (
    h.slice(0, 8) +
    "-" +
    h.slice(8, 12) +
    "-" +
    h.slice(12, 16) +
    "-" +
    h.slice(16, 20) +
    "-" +
    h.slice(20, 32)
  );
}

const NIL_GUID = "00000000-0000-0000-0000-000000000000";

/**
 * @returns {{
 *   version:number,z:number,x:number,y:number,extent:number,
 *   cables: Array<{n_pts:number,size:number,rgba:number,cable_guid:string,xy:Float32Array}>,
 *   drops: Array<{n_pts:number,size:number,rgba:number,cable_guid:string,xy:Float32Array}>,
 *   taps: Array<{x:number,y:number,ports:number,strand_rgba:number,tube_rgba:number,sp_guid:string}>,
 *   splices: Array<{x:number,y:number,rgba:number,sp_guid:string}>
 * }}
 */
export function parseFmap(buf) {
  const dv = new DataView(buf);
  if (buf.byteLength < 36) throw new Error("fmap too short");
  if (u32(dv, 0) !== FMAP_MAGIC) throw new Error("bad fmap magic");
  const version = u32(dv, 4);
  if (version !== 1 && version !== 2 && version !== 3)
    throw new Error("bad fmap version " + version);
  const z = dv.getUint8(8);
  const x = u32(dv, 12);
  const y = u32(dv, 16);
  const extent = u32(dv, 20);
  const nCables = u32(dv, 24);
  const nDrops = u32(dv, 28);
  const nTaps = u32(dv, 32);
  let nSplices = 0;
  let off = 36;
  if (version >= 2) {
    if (buf.byteLength < 40) throw new Error("fmap v2+ header short");
    nSplices = u32(dv, 36);
    off = 40;
  }

  function readLines(count) {
    const out = [];
    for (let i = 0; i < count; i++) {
      if (off + 8 > buf.byteLength) throw new Error("fmap truncated lines");
      const n_pts = u16(dv, off);
      const size = u16(dv, off + 2);
      const rgba = u32(dv, off + 4);
      off += 8;
      let cable_guid = "";
      if (version >= 3) {
        if (off + 16 > buf.byteLength) throw new Error("fmap truncated guid");
        cable_guid = guidBytesToString(new Uint8Array(buf, off, 16));
        if (cable_guid === NIL_GUID) cable_guid = "";
        off += 16;
      }
      if (off + n_pts * 8 > buf.byteLength) throw new Error("fmap truncated pts");
      const xy = new Float32Array(n_pts * 2);
      for (let k = 0; k < n_pts; k++) {
        xy[k * 2] = dv.getFloat32(off, true);
        xy[k * 2 + 1] = dv.getFloat32(off + 4, true);
        off += 8;
      }
      out.push({ n_pts, size, rgba, cable_guid, xy });
    }
    return out;
  }

  const cables = readLines(nCables);
  const drops = readLines(nDrops);
  const taps = [];
  for (let i = 0; i < nTaps; i++) {
    const rec = version >= 2 ? 36 : 20;
    if (off + rec > buf.byteLength) throw new Error("fmap truncated taps");
    const tx = dv.getFloat32(off, true);
    const ty = dv.getFloat32(off + 4, true);
    const ports = dv.getUint8(off + 8);
    const strand_rgba = u32(dv, off + 12);
    const tube_rgba = u32(dv, off + 16);
    let sp_guid = "";
    if (version >= 2) {
      sp_guid = guidBytesToString(new Uint8Array(buf, off + 20, 16));
      if (sp_guid === NIL_GUID) sp_guid = "";
    }
    off += rec;
    taps.push({ x: tx, y: ty, ports, strand_rgba, tube_rgba, sp_guid });
  }

  const splices = [];
  for (let i = 0; i < nSplices; i++) {
    /* 28 bytes: float x,y · rgba u32 · guid[16] */
    if (off + 28 > buf.byteLength) throw new Error("fmap truncated splices");
    const sx = dv.getFloat32(off, true);
    const sy = dv.getFloat32(off + 4, true);
    const rgba = u32(dv, off + 8);
    let sp_guid = guidBytesToString(new Uint8Array(buf, off + 12, 16));
    if (sp_guid === NIL_GUID) sp_guid = "";
    off += 28;
    splices.push({ x: sx, y: sy, rgba, sp_guid });
  }

  return { version, z, x, y, extent, cables, drops, taps, splices };
}
