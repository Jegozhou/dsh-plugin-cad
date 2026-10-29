"""Mesh encoding for GLB and STL artifacts.

The B-rep is tessellated once per build (see :func:`cad_runtime.geometry.tessellate`);
this module turns the welded mesh into bytes.

GLB: glTF 2.0 requires **Y-up**, the CAD kernel is **Z-up**, so vertices are
mapped ``(x, y, z)_CAD -> (x, z, -y)_glTF``. That mapping has determinant +1 (it is
a proper rotation), so triangle winding and outward normals are preserved and the
mesh stays watertight/closed in the viewer.

STL: binary STL has no axis convention; it keeps CAD coordinates (Z-up, mm) so
downstream CAM tools see the model as modelled.
"""

from __future__ import annotations

import json
import struct
from typing import Any

import numpy as np

from .errors import export_failed
from .geometry import MeshData


def _validated_arrays(mesh: MeshData) -> tuple[np.ndarray, np.ndarray]:
    vertices = np.asarray(mesh.vertices, dtype=np.float64)
    faces = np.asarray(mesh.faces, dtype=np.int64)
    if vertices.ndim != 2 or vertices.shape[1] != 3 or len(vertices) < 3:
        raise export_failed("mesh has no usable vertices", vertices=0 if vertices.size == 0 else vertices.shape)
    if faces.ndim != 2 or faces.shape[1] != 3 or len(faces) == 0:
        raise export_failed("mesh has no usable triangles", triangles=0 if faces.size == 0 else faces.shape)
    return vertices, faces


def cad_to_gltf(vertices: np.ndarray) -> np.ndarray:
    """Convert CAD (Z-up, mm) vertices to glTF (Y-up, mm)."""
    out = np.empty_like(vertices)
    out[:, 0] = vertices[:, 0]
    out[:, 1] = vertices[:, 2]
    out[:, 2] = -vertices[:, 1]
    return out


def _vertex_normals(vertices: np.ndarray, faces: np.ndarray) -> np.ndarray:
    """Area-weighted smooth vertex normals for a welded triangle mesh."""
    triangles = vertices[faces]
    face_normals = np.cross(triangles[:, 1] - triangles[:, 0], triangles[:, 2] - triangles[:, 0])
    normals = np.zeros_like(vertices, dtype=np.float64)
    for corner in range(3):
        np.add.at(normals, faces[:, corner], face_normals)
    lengths = np.linalg.norm(normals, axis=1)
    lengths[lengths == 0] = 1.0
    return normals / lengths[:, None]


def _align4(buffer: bytearray, fill: bytes = b"\x00") -> tuple[int, int]:
    offset = len(buffer)
    buffer.extend(fill * ((-len(buffer)) % 4))
    return offset, 0


def glb_bytes(mesh: MeshData) -> bytes:
    """Encode the welded mesh as a glTF 2.0 binary (.glb) in Y-up.

    The container is written explicitly (header + JSON chunk + BIN chunk) rather
    than delegated to a library: the file is small, the format is simple and this
    guarantees the exact accessors the viewer needs (POSITION, NORMAL, uint32
    indices, single mesh/scene/node) and a correct Y-up transform.
    """
    vertices, faces = _validated_arrays(mesh)
    y_up = cad_to_gltf(vertices)
    normals = _vertex_normals(y_up, faces)
    indices = faces.reshape(-1).astype(np.uint32)

    position_bytes = y_up.astype(np.float32).tobytes()
    normal_bytes = normals.astype(np.float32).tobytes()
    index_bytes = indices.tobytes()

    binary = bytearray()
    position_offset = len(binary)
    binary.extend(position_bytes)
    binary.extend(b"\x00" * ((-len(binary)) % 4))
    normal_offset = len(binary)
    binary.extend(normal_bytes)
    binary.extend(b"\x00" * ((-len(binary)) % 4))
    index_offset = len(binary)
    binary.extend(index_bytes)
    binary.extend(b"\x00" * ((-len(binary)) % 4))
    binary_length = len(binary)

    position_min = np.round(y_up.min(axis=0), 6).tolist()
    position_max = np.round(y_up.max(axis=0), 6).tolist()
    document = {
        "asset": {"version": "2.0", "generator": "dsh-plugin-cad 0.1.0", "extras": {"units": "mm"}},
        "scene": 0,
        "scenes": [{"name": "model", "nodes": [0]}],
        "nodes": [{"name": "model", "mesh": 0}],
        "meshes": [
            {
                "name": "model",
                "primitives": [
                    {
                        "attributes": {"POSITION": 0, "NORMAL": 1},
                        "indices": 2,
                        "mode": 4,  # TRIANGLES
                        "material": 0,
                    }
                ],
            }
        ],
        "materials": [
            {
                "name": "cad",
                "pbrMetallicRoughness": {
                    "baseColorFactor": [0.62, 0.66, 0.72, 1.0],
                    "metallicFactor": 0.15,
                    "roughnessFactor": 0.65,
                },
                "doubleSided": True,
            }
        ],
        "accessors": [
            {
                "bufferView": 0,
                "componentType": 5126,  # FLOAT
                "count": int(len(y_up)),
                "type": "VEC3",
                "min": [float(value) for value in position_min],
                "max": [float(value) for value in position_max],
            },
            {"bufferView": 1, "componentType": 5126, "count": int(len(normals)), "type": "VEC3"},
            {"bufferView": 2, "componentType": 5125, "count": int(len(indices)), "type": "SCALAR"},  # UNSIGNED_INT
        ],
        "bufferViews": [
            {"buffer": 0, "byteOffset": position_offset, "byteLength": len(position_bytes), "target": 34962},
            {"buffer": 0, "byteOffset": normal_offset, "byteLength": len(normal_bytes), "target": 34962},
            {"buffer": 0, "byteOffset": index_offset, "byteLength": len(index_bytes), "target": 34963},
        ],
        "buffers": [{"byteLength": binary_length}],
    }

    json_bytes = json.dumps(document, separators=(",", ":"), allow_nan=False).encode("utf-8")
    json_padding = (-len(json_bytes)) % 4
    json_bytes += b" " * json_padding

    total_length = 12 + 8 + len(json_bytes) + 8 + binary_length
    out = bytearray()
    out.extend(b"glTF")
    out.extend(struct.pack("<I", 2))
    out.extend(struct.pack("<I", total_length))
    out.extend(struct.pack("<I", len(json_bytes)))
    out.extend(struct.pack("<I", 0x4E4F534A))  # 'JSON'
    out.extend(json_bytes)
    out.extend(struct.pack("<I", binary_length))
    out.extend(struct.pack("<I", 0x004E4942))  # 'BIN\0'
    out.extend(binary)
    if len(out) != total_length:  # pragma: no cover - defensive
        raise export_failed("internal error: GLB length mismatch")
    return bytes(out)


def stl_bytes(mesh: MeshData) -> bytes:
    """Encode the welded mesh as a binary STL in CAD coordinates (Z-up, mm)."""
    import trimesh  # noqa: PLC0415 - lazy

    vertices, faces = _validated_arrays(mesh)
    scene_mesh = trimesh.Trimesh(vertices=vertices, faces=faces, process=True)
    scene_mesh.merge_vertices()
    data = scene_mesh.export(file_type="stl")
    if not isinstance(data, (bytes, bytearray)) or len(data) < 84:
        raise export_failed("STL encoder returned no data")
    return bytes(data)


def mesh_summary(mesh: MeshData) -> dict[str, Any]:
    return mesh.stats()
