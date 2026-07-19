/**
 * Pure JS .wmap v1 decoder (host fallback when ?wasm=1 is off).
 * Shape matches wasm_host.parseWmapViaWasm for tileToGpuLayers.
 */

function u32(dv, o) {
  return dv.getUint32(o, true);
}
function u16(dv, o) {
  return dv.getUint16(o, true);
}

/**
 * @param {ArrayBuffer|ArrayBufferView} buf
 * @returns {{z:number,x:number,y:number,layers:object[]}}
 */
export function parseWmap(buf) {
  const ab =
    buf instanceof ArrayBuffer
      ? buf
      : buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const dv = new DataView(ab);
  if (ab.byteLength < 24) throw new Error("wmap too short");
  const magic = u32(dv, 0);
  if (magic !== 0x50414d57) throw new Error("bad magic");
  const version = u32(dv, 4);
  if (version !== 1) throw new Error("bad version " + version);
  const z = dv.getUint8(8);
  const x = u32(dv, 12);
  const y = u32(dv, 16);
  const nLayers = u32(dv, 20);
  let off = 24;
  const layers = [];
  for (let i = 0; i < nLayers; i++) {
    const kind = dv.getUint8(off++);
    const fclass = dv.getUint8(off++);
    const nlen = u16(dv, off);
    off += 2;
    const name = new TextDecoder().decode(new Uint8Array(ab, off, nlen));
    off += nlen;
    const extent = u32(dv, off);
    off += 4;
    const vc = u32(dv, off);
    off += 4;
    const ic = u32(dv, off);
    off += 4;
    const interleaved = new ArrayBuffer(vc * 12);
    const fview = new DataView(interleaved);
    for (let v = 0; v < vc; v++) {
      const px = dv.getFloat32(off, true);
      off += 4;
      const py = dv.getFloat32(off, true);
      off += 4;
      const c = u32(dv, off);
      off += 4;
      fview.setFloat32(v * 12, px, true);
      fview.setFloat32(v * 12 + 4, py, true);
      fview.setUint32(v * 12 + 8, c, true);
    }
    const indices = new Uint32Array(ic);
    for (let j = 0; j < ic; j++) {
      indices[j] = u32(dv, off);
      off += 4;
    }
    layers.push({ kind, fclass, name, extent, interleaved, indices, vc, ic });
  }
  return { z, x, y, layers };
}

/**
 * Total retained payload bytes for a parsed tile (interleaved + indices).
 * @param {{layers: {interleaved: ArrayBuffer, indices: Uint32Array}[]}} tile
 */
export function tilePayloadBytes(tile) {
  let n = 0;
  for (const L of tile.layers || []) {
    if (L.interleaved) n += L.interleaved.byteLength;
    if (L.indices) n += L.indices.byteLength;
  }
  return n;
}
