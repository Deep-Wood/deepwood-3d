"""Minimal GLB reader: enough to get POSITION (+ optional COLOR_0) as numpy arrays.

Only handles plain (non-Draco) GLBs with float32/u16/u32 accessors, which is what
gltf-transform writes for us.
"""
import struct, json
import numpy as np

CT = {5120: "i1", 5121: "u1", 5122: "i2", 5123: "u2", 5125: "u4", 5126: "f4"}
NC = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}


def read_glb(path):
    b = open(path, "rb").read()
    magic, ver, length = struct.unpack_from("<III", b, 0)
    if magic != 0x46546C67:
        raise ValueError("not a GLB")
    off, js, binc = 12, None, b""
    while off < min(length, len(b)):
        clen, ctype = struct.unpack_from("<II", b, off)
        chunk = b[off + 8: off + 8 + clen]
        off += 8 + clen
        if ctype == 0x4E4F534A:
            js = json.loads(chunk)
        elif ctype == 0x004E4942:
            binc = chunk
    return js, binc


def accessor(j, binc, idx):
    a = j["accessors"][idx]
    bv = j["bufferViews"][a["bufferView"]]
    dt = np.dtype("<" + CT[a["componentType"]])
    n = NC[a["type"]]
    start = bv.get("byteOffset", 0) + a.get("byteOffset", 0)
    stride = bv.get("byteStride") or dt.itemsize * n
    cnt = a["count"]
    if stride == dt.itemsize * n:
        arr = np.frombuffer(binc, dt, count=cnt * n, offset=start).reshape(cnt, n)
    else:
        arr = np.stack([np.frombuffer(binc, dt, count=n, offset=start + i * stride)
                        for i in range(cnt)])
    return arr


def positions(path, prim=0):
    j, b = read_glb(path)
    p = j["meshes"][0]["primitives"][prim]
    pos = accessor(j, b, p["attributes"]["POSITION"]).astype(np.float64)
    idx = accessor(j, b, p["indices"]).ravel().astype(np.int64) if "indices" in p else None
    return pos, idx, j, b


def bbox_norm(pos):
    """Rodin ships the mesh off-origin; report where."""
    return pos.min(axis=0), pos.max(axis=0)


if __name__ == "__main__":
    import sys
    pos, idx, j, b = positions(sys.argv[1])
    mn, mx = bbox_norm(pos)
    print(f"{sys.argv[1]}: verts={len(pos)} tris={len(idx)//3 if idx is not None else 'n/a'}")
    print(f"  min {np.round(mn,4).tolist()}  max {np.round(mx,4).tolist()}  size {np.round(mx-mn,4).tolist()}")
    print(f"  attrs {sorted(j['meshes'][0]['primitives'][0]['attributes'])}  "
          f"mats {len(j.get('materials',[]))}  images {len(j.get('images',[]))}")
