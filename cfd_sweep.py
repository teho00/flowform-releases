"""Structured linear hexahedra along paired straight/circular rails of a planar duct."""
import csv
import math
import numpy as np

def generate(gmsh, setup, surfaces, volume, inlet, outlet, size, limit):
    model = gmsh.model
    def boundary(dim, tag):
        return [j for _, j in model.getBoundary([(dim, tag)], oriented=False)]
    def xyz(vertex):
        return np.array(model.getValue(0, vertex, []))
    edges = {s: set(boundary(2, s)) for s in surfaces}
    ends = {e: boundary(1, e) for e in set.union(*edges.values())}
    message = "육면체 스윕은 동일 직사각 단면의 평면 직선·원호 유로를 지원합니다."
    if any(len(edges[p]) != 4 for p in (inlet,outlet)):
        raise ValueError(message)
    candidates = []
    for s in surfaces:
        first, last = edges[s] & edges[inlet], edges[s] & edges[outlet]
        if model.getType(2,s) != "Plane" or len(first)!=1 or len(last)!=1:
            continue
        start, finish = next(iter(first)), next(iter(last))
        if len(ends[start]) != 2 or len(ends[finish]) != 2:
            continue
        # Prefer the wider rail separation, leaving the thin dimension for layering.
        candidates.append((model.occ.getMass(1,start),s,start,finish))
    if not candidates:
        raise ValueError(message)
    _, floor, start, finish = max(candidates)
    rails = edges[floor] - {start,finish}
    def walk(vertex):
        result = []
        while vertex not in ends[finish]:
            options = [e for e in rails if vertex in ends[e] and e not in [x[0] for x in result]]
            if len(options)!=1: raise ValueError(message)
            e = options[0]
            if len(ends[e])!=2: raise ValueError(message)
            result.append((e,vertex))
            vertex = next(v for v in ends[e] if v!=vertex)
        return result
    left,right = map(walk, ends[start])
    if not left or len(left)!=len(right) or len(left)*2!=len(rails):
        raise ValueError(message)
    heights = []
    for v in ends[start]:
        side = next(e for e in edges[inlet]-{start} if v in ends[e])
        heights.append(xyz(next(k for k in ends[side] if k!=v))-xyz(v))
    if not np.allclose(*heights, atol=1e-6): raise ValueError(message)
    height = heights[0]
    width = np.linalg.norm(xyz(ends[start][0])-xyz(ends[start][1]))
    nw = max(2,math.ceil(round(width/size,8)))
    nh = max(2,math.ceil(round(np.linalg.norm(height)/size,8)))
    nw, nh = setup.get("width_cells", nw), setup.get("height_cells", nh)
    def sample(edge, vertex, n):
        if model.getType(1,edge) not in ("Line","Circle"): raise ValueError(message)
        lo,hi = (float(x[0]) for x in model.getParametrizationBounds(1,edge))
        pts = np.array(model.getValue(1,edge,np.linspace(lo,hi,n+1))).reshape(-1,3)
        return pts if np.linalg.norm(pts[0]-xyz(vertex))<1e-6 else pts[::-1]
    strips = []
    count = 0
    for (e,v),(f,w) in zip(left,right):
        if model.getType(1,e)!=model.getType(1,f): raise ValueError(message)
        n = max(1, math.ceil(max(model.occ.getMass(1,k) for k in (e,f))/size))
        count += n
        if count*nw*nh>limit: raise ValueError("예상 육면체 수가 너무 큽니다. 목표 길이를 키우세요.")
        a,b = sample(e,v,n),sample(f,w,n)
        if not np.allclose(np.linalg.norm(b-a,axis=1),width,rtol=1e-5,atol=1e-6): raise ValueError(message)
        row = a[:,None,:]+(b-a)[:,None,:]*np.linspace(0,1,nw+1)[None,:,None]
        strips.append(row if len(strips)==0 else row[1:])
    plane = np.concatenate(strips)
    if np.dot(np.cross(plane[1,0]-plane[0,0],plane[0,1]-plane[0,0]),height)<0:
        plane = plane[:,::-1,:]
    grid = plane[:,:,None,:]+np.linspace(0,1,nh+1)[None,None,:,None]*height
    pts = grid.reshape(-1,3)
    ids = np.arange(len(pts)).reshape(grid.shape[:-1])
    cells = np.stack([ids[:-1,:-1,:-1],ids[1:,:-1,:-1],ids[1:,1:,:-1],ids[:-1,1:,:-1],
                      ids[:-1,:-1,1:],ids[1:,:-1,1:],ids[1:,1:,1:],ids[:-1,1:,1:]],axis=-1)
    xyz8 = pts[cells]
    centres = xyz8.mean(axis=-2)
    quality = np.ones(centres.shape[:-1])
    volumes = np.zeros_like(quality)
    patches = [[],[],[]]
    for axis,(minus,plus) in enumerate([([0,4,7,3],[1,2,6,5]),([0,1,5,4],[3,7,6,2]),([0,3,2,1],[4,5,6,7])]):
        for sign,face in [(-1,minus),(1,plus)]:
            q = xyz8[...,face,:]
            normal = np.cross(q[...,2,:]-q[...,0,:],q[...,3,:]-q[...,1,:])/2
            delta = q.mean(axis=-2)-centres
            product = (normal*delta).sum(axis=-1)
            volumes += product/3
            lengths = np.linalg.norm(normal,axis=-1)
            quality = np.minimum(quality,product/(lengths*np.linalg.norm(delta,axis=-1)))
            index = [slice(None)]*3
            index[axis] = 0 if sign<0 else -1
            patches[(0 if sign<0 else 1) if axis==0 else 2].extend(cells[tuple(index)][...,face].reshape(-1,4))
            if sign>0:
                mid = [slice(None)]*3
                mid[axis]=slice(None,-1)
                d = np.diff(centres,axis=axis)
                align=(normal[tuple(mid)]*d).sum(axis=-1)/(lengths[tuple(mid)]*np.linalg.norm(d,axis=-1))
                quality[tuple(mid)]=np.minimum(quality[tuple(mid)],align)
                mid[axis]=slice(1,None)
                quality[tuple(mid)]=np.minimum(quality[tuple(mid)],align)
    if not np.all(np.isfinite(quality)) or quality.min()<=0 or np.any(volumes<=0):
        raise ValueError("스윕 격자에 뒤집힌 셀이 있습니다.")
    exact=model.occ.getMass(3,volume)
    if abs(volumes.sum()-exact)>0.03*exact: raise ValueError("스윕 격자와 CAD 체적이 일치하지 않습니다. 형상 또는 격자 크기를 확인하세요.")
    # Check all swept layer endpoints against the opposite CAD surface.
    test_points = grid[::max(1,count//40),::max(1,nw//4),-1,:].reshape(-1,3)
    roof = [s for s in surfaces if s!=floor and model.getType(2,s)=="Plane" and edges[s]&edges[inlet] and edges[s]&edges[outlet]]
    if len(surfaces) != len(rails)+4 or any(model.getType(2,s) not in ("Plane","Cylinder") for s in surfaces):
        raise ValueError(message)
    if not any(all(np.linalg.norm(np.asarray(model.getClosestPoint(2,s,p)[0])-p)<1e-5 for p in test_points) for s in roof): raise ValueError(message)
    mixed = setup.get("mesh_method") == "hex-dominant"
    hexes = cells.reshape(-1, 8)
    prisms = []
    if mixed:
        # Split a continuous corner column across the section diagonal.
        # Every interface to the remaining hexahedra stays quadrilateral.
        column = cells[:, 0, 0, :]
        prisms = np.concatenate((column[:, [0, 3, 7, 1, 2, 6]], column[:, [0, 7, 4, 1, 6, 5]]))
        hexes = cells.reshape(count, nw * nh, 8)[:, 1:, :].reshape(-1, 8)
        for faces in patches[:2]:
            quad = faces.pop(0)
            faces[:0] = [quad[[0, 1, 2]], quad[[0, 2, 3]]]
    number=0
    with open("domain.msh","w",encoding="ascii") as out:
        out.write('$MeshFormat\n2.2 0 8\n$EndMeshFormat\n$PhysicalNames\n4\n2 1 "inlet"\n2 2 "outlet"\n2 3 "walls"\n3 4 "fluid"\n$EndPhysicalNames\n')
        out.write(f'$Nodes\n{len(pts)}\n')
        for j,(x,y,z) in enumerate(pts*0.001,1): out.write(f'{j} {x:.15g} {y:.15g} {z:.15g}\n')
        out.write(f'$EndNodes\n$Elements\n{sum(map(len,patches))+len(hexes)+len(prisms)}\n')
        for patch,faces in enumerate(patches,1):
            for nodes in faces:
                number+=1
                out.write(f'{number} {2 if len(nodes)==3 else 3} 2 {patch} {patch} '+ ' '.join(map(str,nodes+1))+'\n')
        if mixed:
            for kind, group in ((5, hexes), (6, prisms)):
                for nodes in group:
                    number += 1
                    out.write(f'{number} {kind} 2 4 4 ' + ' '.join(map(str, nodes + 1)) + '\n')
            out.write('$EndElements\n')
            return dict(method="hex-dominant", mesh_mm=size, cells=len(hexes)+len(prisms), nodes=len(pts),
                        divisions=dict(length=count,width=nw,thickness=nh),
                        cell_types=dict(hexahedra=len(hexes),prisms=len(prisms)),
                        patch_faces=dict(zip(("inlet","outlet","walls"),map(len,patches))),
                        inlet_area_mm2=model.occ.getMass(2,inlet),outlet_area_mm2=model.occ.getMass(2,outlet),
                        volume_mm3=float(volumes.sum()))
        with open("orthogonal-quality.csv","w",newline="",encoding="ascii") as csvfile:
            writer=csv.writer(csvfile)
            writer.writerow(["gmsh_cell_id","x_mm","y_mm","z_mm","orthogonal_quality","volume_mm3"])
            for nodes,centre,score,vol in zip(cells.reshape(-1,8),centres.reshape(-1,3),quality.flat,volumes.flat):
                number+=1
                out.write(f'{number} 5 2 4 4 '+ ' '.join(map(str,nodes+1))+'\n')
                writer.writerow([number,*centre,score,vol])
        out.write('$EndElements\n')
    return dict(method="hex-sweep",mesh_mm=size,cells=quality.size,nodes=len(pts),
                divisions=dict(length=count,width=nw,thickness=nh),
                patch_faces=dict(zip(("inlet","outlet","walls"),map(len,patches))),
                inlet_area_mm2=model.occ.getMass(2,inlet),outlet_area_mm2=model.occ.getMass(2,outlet),
                volume_mm3=float(volumes.sum()),orthogonal_quality=dict(min=float(quality.min()),average=float(quality.mean()),
                max=float(quality.max()),target_min=0.9,below_target=int((quality<0.9).sum())))
