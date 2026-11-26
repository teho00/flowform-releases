"""Report cell orthogonality from the saved mesh in millimetres."""
from functools import lru_cache
import numpy as np
from mesh_preview import expect, read_groups, read_points, read_count, MAX_CELLS


def tetra_quality(path):
    with path.open(encoding="ascii") as stream:
        expect(stream, "$MeshFormat")
        stream.readline()
        expect(stream, "$EndMeshFormat")
        read_groups(stream)
        points, _ = read_points(stream)
        expect(stream, "$Elements")
        nodes = []
        for _ in range(read_count(stream, 5 * MAX_CELLS)):
            row = stream.readline().split()
            if row[1] == "4":
                nodes.append([int(x) for x in row[-4:]])
    if not nodes:
        raise ValueError("사면체 격자가 없습니다.")
    ids = np.array(nodes)
    coordinates = np.array([[points[i] for i in cell] for cell in nodes])
    centres = coordinates.mean(axis=1)
    quality = np.ones(len(nodes))
    keys, normals = [], []
    for corners in ((0,1,2),(0,2,3),(0,3,1),(1,3,2)):
        vertices = coordinates[:,corners,:]
        normal = np.cross(vertices[:,1]-vertices[:,0], vertices[:,2]-vertices[:,0])
        normal /= np.maximum(np.linalg.norm(normal,axis=1)[:,None], 1e-30)
        delta = vertices.mean(axis=1) - centres
        alignment = abs((normal*delta).sum(axis=1))/np.maximum(np.linalg.norm(delta,axis=1),1e-30)
        quality = np.minimum(quality,alignment)
        keys.append(np.sort(ids[:,corners],axis=1))
        normals.append(normal)
    keys, normals = np.concatenate(keys), np.concatenate(normals)
    order = np.lexsort(keys.T)
    shared = (keys[order[1:]] == keys[order[:-1]]).all(axis=1)
    faces = order[:-1][shared]
    owner, neighbour = faces % len(nodes), order[1:][shared] % len(nodes)
    delta = centres[neighbour] - centres[owner]
    score = abs((normals[faces]*delta).sum(axis=1))/np.maximum(np.linalg.norm(delta,axis=1),1e-30)
    np.minimum.at(quality,owner,score)
    np.minimum.at(quality,neighbour,score)
    return quality, centres



FACES = {
    4: ((0,1,2),(0,2,3),(0,3,1),(1,3,2)),
    5: ((0,1,2,3),(4,5,6,7),(0,1,5,4),(1,2,6,5),(2,3,7,6),(3,0,4,7)),
    6: ((0,1,2),(3,4,5),(0,1,4,3),(1,2,5,4),(2,0,3,5)),
}
ORTHOGONAL_BANDS = [0, 0.25, 0.5, 0.75, 0.9, 1]
SKEW_BANDS = [0, 0.25, 0.5, 0.75, 0.9, 1]


def quality_fields(path):
    groups = {kind: [] for kind in FACES}
    with path.open(encoding="ascii") as stream:
        expect(stream, "$MeshFormat")
        stream.readline()
        expect(stream, "$EndMeshFormat")
        read_groups(stream)
        points, _ = read_points(stream)
        expect(stream, "$Elements")
        for _ in range(read_count(stream, 5 * MAX_CELLS)):
            row = stream.readline().split()
            kind = int(row[1])
            if kind in groups:
                groups[kind].append(tuple(map(int, row[3 + int(row[2]):])))
    if not any(groups.values()):
        raise ValueError("품질을 계산할 셀이 없습니다.")

    all_centres, all_quality, all_skew = [], [], []
    face_groups = {3: [], 4: []}
    offset = 0
    for kind, nodes in groups.items():
        if not nodes:
            continue
        ids = np.array(nodes)
        xyz = np.array([[points[i] for i in cell] for cell in nodes])
        centres = xyz.mean(axis=1)
        quality = np.ones(len(nodes))
        skew = np.zeros(len(nodes))
        owners = np.arange(offset, offset + len(nodes))
        offset += len(nodes)
        for corners in FACES[kind]:
            vertices = xyz[:, corners]
            n = len(corners)
            if n == 3:
                normal = np.cross(vertices[:, 1] - vertices[:, 0], vertices[:, 2] - vertices[:, 0])
            else:
                normal = np.cross(vertices[:, 2] - vertices[:, 0], vertices[:, 3] - vertices[:, 1])
            normal /= np.maximum(np.linalg.norm(normal, axis=1)[:, None], 1e-30)
            delta = vertices.mean(axis=1) - centres
            alignment = abs((normal * delta).sum(axis=1)) / np.maximum(np.linalg.norm(delta, axis=1), 1e-30)
            quality = np.minimum(quality, alignment)
            face_groups[n].append((np.sort(ids[:, corners], axis=1), normal, owners))

            a = np.roll(vertices, -1, axis=1) - vertices
            b = np.roll(vertices, 1, axis=1) - vertices
            denom = np.linalg.norm(a, axis=2) * np.linalg.norm(b, axis=2)
            angles = np.degrees(np.arccos(np.clip((a * b).sum(axis=2) / np.maximum(denom, 1e-30), -1, 1)))
            ideal = 60 if n == 3 else 90
            face_skew = np.maximum((angles.max(axis=1)-ideal)/(180-ideal), (ideal-angles.min(axis=1))/ideal)
            skew = np.maximum(skew, np.where((denom <= 1e-30).any(axis=1), 1, face_skew))
        all_centres.append(centres)
        all_quality.append(quality)
        all_skew.append(skew)

    centres = np.concatenate(all_centres)
    quality = np.concatenate(all_quality)
    for group in face_groups.values():
        if not group:
            continue
        keys, normals, owners = (np.concatenate(parts) for parts in zip(*group))
        order = np.lexsort(keys.T)
        shared = (keys[order[1:]] == keys[order[:-1]]).all(axis=1)
        faces = order[:-1][shared]
        owner, neighbour = owners[faces], owners[order[1:][shared]]
        delta = centres[neighbour] - centres[owner]
        score = abs((normals[faces] * delta).sum(axis=1)) / np.maximum(np.linalg.norm(delta, axis=1), 1e-30)
        np.minimum.at(quality, owner, score)
        np.minimum.at(quality, neighbour, score)
    return np.clip(quality, 0, 1), np.clip(np.concatenate(all_skew), 0, 1), centres


def spectrum(values, bands):
    return dict(min=float(values.min()), mean=float(values.mean()), max=float(values.max()),
                bands=bands, counts=np.histogram(values, bins=bands)[0].tolist())


@lru_cache(maxsize=6)
def inspect(case):
    quality, skew, centres = quality_fields(case / "domain.msh")
    bad = np.flatnonzero(quality < 0.9)
    sample = bad[np.linspace(0, len(bad)-1, min(2000, len(bad)), dtype=int)] if len(bad) else []
    legacy_counts = np.histogram(quality, bins=[0, 0.5, 0.75, 0.9, 0.99, 1])[0].tolist()
    return dict(minimum=float(quality.min()), counts=legacy_counts, below=len(bad), points=centres[sample].tolist(),
                orthogonality=spectrum(quality, ORTHOGONAL_BANDS), skewness=spectrum(skew, SKEW_BANDS))
