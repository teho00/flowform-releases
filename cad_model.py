"""Replay dimensioned CAD operations with Open CASCADE (millimetres)."""

from base64 import b64decode
from binascii import Error as Base64Error
from dataclasses import dataclass, field
from hashlib import sha256
from math import hypot, isfinite, pi
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Lock

try:
    from OCP.Bnd import Bnd_Box
    from OCP.BRep import BRep_Builder, BRep_Tool
    from OCP.BRepAdaptor import BRepAdaptor_Curve, BRepAdaptor_Surface
    from OCP.BRepAlgoAPI import BRepAlgoAPI_Common, BRepAlgoAPI_Cut, BRepAlgoAPI_Fuse
    from OCP.BRepBndLib import BRepBndLib
    from OCP.BRepBuilderAPI import BRepBuilderAPI_Transform
    from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeFace
    from OCP.BRepTools import BRepTools
    from OCP.BRepAlgoAPI import BRepAlgoAPI_Splitter
    from OCP.TopTools import TopTools_ListOfShape
    from OCP.TopAbs import TopAbs_WIRE
    from OCP.BRepCheck import BRepCheck_Analyzer
    from OCP.BRepFilletAPI import BRepFilletAPI_MakeFillet
    from OCP.BRepGProp import BRepGProp
    from OCP.BRepMesh import BRepMesh_IncrementalMesh
    from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox, BRepPrimAPI_MakeCylinder, BRepPrimAPI_MakePrism
    from OCP.GeomAbs import GeomAbs_C0, GeomAbs_Circle, GeomAbs_Cylinder, GeomAbs_Line, GeomAbs_Plane
    from OCP.GProp import GProp_GProps
    from OCP.gp import gp_Ax2, gp_Dir, gp_Pnt, gp_Trsf, gp_Vec
    from OCP.IFSelect import IFSelect_RetDone
    from OCP.Standard import Standard_Failure
    from OCP.STEPControl import STEPControl_AsIs, STEPControl_Reader, STEPControl_Writer
    from OCP.TopAbs import TopAbs_EDGE, TopAbs_FACE, TopAbs_REVERSED, TopAbs_SOLID
    from OCP.TopExp import TopExp, TopExp_Explorer
    from OCP.TopLoc import TopLoc_Location
    from OCP.TopoDS import TopoDS, TopoDS_Compound
    from OCP.TopTools import TopTools_IndexedDataMapOfShapeListOfShape, TopTools_IndexedMapOfShape

    from cad_sketch import MAX_COORDINATE, MIN_DIMENSION, build_sketch, identifier, real_number
except (ImportError, OSError):
    KERNEL_READY = False
else:
    KERNEL_READY = True


MAX_STEP_BYTES = 4 * 1024 * 1024
MAX_OPERATIONS = 64
MIN_VOLUME = 1e-13
MAX_TRIANGLES = 150_000
MAX_EDGE_POINTS = 150_000
MAX_DOCUMENT_ENTITIES = 1_024
# STEP translation uses global configuration in Open CASCADE.
KERNEL_LOCK = Lock()


class CadFeatureReferenceError(ValueError):
    def __init__(self, operation_index, text):
        super().__init__(text)
        self.operation_index = operation_index


@dataclass
class FilletRecord:
    radius: float
    faces: set
    edges: set


@dataclass
class Body:
    id: str
    shape: object
    operations: set
    fillets: dict = field(default_factory=dict)


def status():
    if KERNEL_READY:
        return {"ready": True, "message": "CAD 커널 준비됨", "kernel": "Open CASCADE"}
    return {
        "ready": False,
        "message": "Open CASCADE를 불러올 수 없습니다. README의 CAD 설치 방법을 확인하세요.",
        "kernel": None,
    }


def model(document):
    """Return tessellated, pickable faces and edges for the part and selected cut."""
    require_kernel()
    with KERNEL_LOCK:
        try:
            bodies, domain, sketches, sketch_bodies, deleted_operations, fillet_corners = build(document)
            result = {"part": preview_bodies(bodies), "domain": preview(domain)}
            if any(op.get("type") == "import" for op in document["operations"]):
                caps = opening_caps(bodies)
                result["openings"] = [{"ref": key, "bounds": bounds_of(cap),
                    "edges": [[v for p in curve_points(curve, 1 if curve.GetType() == GeomAbs_Line else 48) for v in p]
                              for _, curve in model_edges(cap)]} for key, cap in caps.items()]
                if document.get("domainPorts") and domain is None:
                    result["domainWarning"] = "형상이 변경되었습니다. 개구부를 다시 선택하세요."
            if bodies:
                result["bodies"] = [
                    {"id": body.id, "bounds": bounds_of(body.shape), "volume": volume_of(body.shape),
                     "operationIndices": sorted(body.operations)} for body in bodies
                ]
            if sketches:
                result["sketches"] = preview_sketches(sketches, sketch_bodies)
            if deleted_operations:
                result["deletedOperationIndices"] = sorted(deleted_operations)
            if fillet_corners:
                result["filletCorners"] = fillet_corners
            return result
        except (RuntimeError, Standard_Failure) as error:
            raise ValueError("CAD 연산에 실패했습니다. 형상과 입력 치수를 확인하세요.") from error


def export_step(document, target):
    """Serialize either exact solid as STEP without using preview triangles."""
    require_kernel()
    if target not in ("part", "domain"):
        raise ValueError("내보낼 대상이 올바르지 않습니다.")
    with KERNEL_LOCK:
        try:
            bodies, domain, _, _, _, _ = build(document)
            shape = combine_shapes(body.shape for body in bodies) if target == "part" else domain
            if shape is None:
                raise ValueError("내보낼 형상이 없습니다.")
            return step_bytes(shape)
        except (RuntimeError, Standard_Failure) as error:
            raise ValueError("STEP 내보내기에 실패했습니다. 형상을 확인하세요.") from error


def step_bytes(shape):
    with TemporaryDirectory(prefix="openfoam-cad-step-") as directory:
        filename = Path(directory) / "model.step"
        writer = STEPControl_Writer()
        if writer.Transfer(shape, STEPControl_AsIs) != IFSelect_RetDone:
            raise ValueError("형상을 STEP으로 변환하지 못했습니다.")
        if writer.Write(str(filename)) != IFSelect_RetDone:
            raise ValueError("STEP 파일을 작성하지 못했습니다.")
        return filename.read_bytes()


def revision(document):
    import json
    inputs = {k:document.get(k) for k in ("operations","domainCut","domainPorts")}
    return sha256(json.dumps(inputs,sort_keys=True,separators=(",",":")).encode()).hexdigest()[:12]


def flow_domain(document, boundary_refs=None):
    """Return pickable fluid geometry, or one STEP snapshot with verified boundary faces."""
    require_kernel()
    with KERNEL_LOCK:
        try:
            _, domain, *_ = build(document)
            if domain is None:
                raise ValueError("CAD에서 절삭을 유체 체적으로 지정하세요.")
            if len(solids_of(domain)) != 1:
                raise ValueError("유동해석에는 서로 연결된 하나의 유체 체적이 필요합니다.")

            boundaries, rectangles = {}, {}
            for face in model_faces(domain):
                if BRepAdaptor_Surface(face).GetType() != GeomAbs_Plane:
                    continue
                reference = face_reference(face)
                props = GProp_GProps()
                BRepGProp.SurfaceProperties_s(face, props)
                center = coordinates(props.CentreOfMass())
                curves = [curve for _,curve in model_edges(face)]
                if len(curves)==4 and all(c.GetType()==GeomAbs_Line for c in curves):
                    lengths=sorted(c.LastParameter()-c.FirstParameter() for c in curves)
                    if abs(lengths[0]*lengths[3]-props.Mass())<max(1e-8,1e-5*props.Mass()):
                        rectangles[reference]=[lengths[3],lengths[0]]
                boundaries.setdefault(reference, []).append({
                    "ref": reference, "center_mm": center, "area_mm2": props.Mass(),
                    "bounds_mm": bounds_of(face), "normal": outward_normal(face, center),
                })
            unique_faces = {ref: faces[0] for ref, faces in boundaries.items() if len(faces) == 1}
            if boundary_refs is None:
                geometry = preview(domain)
                for face in geometry["faces"]:
                    face.update(unique_faces.get(face["ref"], {}))
                    if face["ref"] in rectangles: face["rectangle_mm"]=rectangles[face["ref"]]
                return {"domain": geometry,"revision":revision(document)}
            if boundary_refs[0] == boundary_refs[1] or any(ref not in unique_faces for ref in boundary_refs):
                raise ValueError("입구와 출구에 서로 다른 유체 체적의 평면을 선택하세요.")
            if shapes_of(domain, TopAbs_FACE).Extent() < 3:
                raise ValueError("입구와 출구 외에 벽으로 사용할 면이 필요합니다.")
            return step_bytes(domain), [unique_faces[ref] for ref in boundary_refs]
        except (RuntimeError, Standard_Failure) as error:
            raise ValueError("유체 체적을 처리하지 못했습니다. CAD 형상을 확인하세요.") from error


def require_kernel():
    if not KERNEL_READY:
        raise ValueError(status()["message"])


def number(operation, field, label, *, default=None, dimension=False):
    value = real_number(operation.get(field, default), label)
    if dimension and value < MIN_DIMENSION:
        raise ValueError(f"{label}은 {MIN_DIMENSION:g} mm 이상이어야 합니다.")
    return value


def solids_of(shape):
    solids = []
    explorer = TopExp_Explorer(shape, TopAbs_SOLID)
    while explorer.More():
        solids.append(TopoDS.Solid_s(explorer.Current()))
        explorer.Next()
    return solids


def combine_shapes(shapes):
    shapes = tuple(shapes)
    if len(shapes) <= 1:
        return shapes[0] if shapes else None
    assembly = TopoDS_Compound()
    builder = BRep_Builder()
    builder.MakeCompound(assembly)
    for shape in shapes:
        builder.Add(assembly, shape)
    return assembly


def bounds_of(shape):
    box = Bnd_Box()
    BRepBndLib.AddOptimal_s(shape, box, False, False)
    if box.IsVoid() or box.IsOpen():
        raise ValueError("형상의 3D 범위를 계산할 수 없습니다.")
    bounds = box.Get()
    if any(not isfinite(coordinate) or abs(coordinate) > MAX_COORDINATE for coordinate in bounds):
        raise ValueError("형상이 작업 범위 ±1,000,000 mm를 벗어났습니다.")
    return bounds


def volume_of(shape):
    properties = GProp_GProps()
    BRepGProp.VolumeProperties_s(shape, properties)
    return abs(properties.Mass())


def require_solid(shape, message):
    if shape.IsNull() or not solids_of(shape) or not BRepCheck_Analyzer(shape).IsValid():
        raise ValueError(message)
    volume = volume_of(shape)
    if not isfinite(volume) or volume <= MIN_VOLUME:
        raise ValueError(message)
    bounds_of(shape)


def step_body(operation):
    encoded = operation.get("step")
    if not isinstance(encoded, str) or len(encoded) > 4 * ((MAX_STEP_BYTES + 2) // 3):
        raise ValueError("STEP 파일은 최대 4 MiB까지 불러올 수 있습니다.")
    try:
        data = b64decode(encoded, validate=True)
    except (ValueError, Base64Error) as error:
        raise ValueError("STEP 파일의 데이터를 읽지 못했습니다.") from error
    if len(data) > MAX_STEP_BYTES:
        raise ValueError("STEP 파일은 최대 4 MiB까지 불러올 수 있습니다.")
    if not data.removeprefix(b"\xef\xbb\xbf").lstrip().startswith(b"ISO-10303-21;"):
        raise ValueError("STEP 형식의 .step 또는 .stp 파일을 선택하세요.")

    with TemporaryDirectory(prefix="openfoam-cad-step-") as directory:
        filename = Path(directory) / "model.step"
        filename.write_bytes(data)
        reader = STEPControl_Reader()
        if reader.ReadFile(str(filename)) != IFSelect_RetDone or reader.TransferRoots() == 0:
            raise ValueError("STEP 파일에서 형상을 불러오지 못했습니다.")
        shape = reader.OneShape()
    solids = solids_of(shape)
    if not solids:
        raise ValueError("STEP 파일에 닫힌 솔리드가 없습니다.")
    return combine_shapes(solids)


def profile_body(operation, kind):
    x = number(operation, "x", "X 위치", default=0)
    y = number(operation, "y", "Y 위치", default=0)
    z = number(operation, "z", "시작 Z", default=0)
    height = number(operation, "height", "높이 또는 절삭 깊이", dimension=True)
    base_z = z - height if kind == "cut" else z
    origin = gp_Pnt(x, y, base_z)
    profile = operation.get("profile")
    if profile == "rectangle":
        width = number(operation, "width", "폭", dimension=True)
        length = number(operation, "length", "길이", dimension=True)
        return BRepPrimAPI_MakeBox(origin, width, length, height).Shape()
    if profile == "circle":
        radius = number(operation, "radius", "반지름", dimension=True)
        axis = gp_Ax2(origin, gp_Dir(0, 0, 1))
        return BRepPrimAPI_MakeCylinder(axis, radius, height).Shape()
    raise ValueError("직사각형 또는 원 스케치를 선택하세요.")


def boolean_shape(algorithm, part, tool, message):
    operation = algorithm(part, tool)
    if not operation.IsDone():
        raise ValueError(message)
    operation.SimplifyResult()
    return operation.Shape()


def cut_body(part, tool, save_domain):
    domain = None
    if save_domain:
        domain = boolean_shape(BRepAlgoAPI_Common, part, tool, "유체 체적을 추출하지 못했습니다.")
        require_solid(domain, "지정한 절삭에서 닫힌 체적을 추출할 수 없습니다.")
    original_volume = volume_of(part)
    result = boolean_shape(BRepAlgoAPI_Cut, part, tool, "부품을 절삭하지 못했습니다.")
    if original_volume - volume_of(result) <= max(MIN_VOLUME, original_volume * 1e-12):
        raise ValueError("절삭 범위가 부품 내부와 겹치지 않습니다.")
    return result, domain


def pull_tool(operation, sketches, index):
    sketch_id = identifier(operation.get("sketch"), "스케치")
    region_id = identifier(operation.get("region"), "스케치 영역")
    sketch = sketches.get(sketch_id)
    region = sketch.region(region_id) if sketch is not None else None
    if region is None:
        raise CadFeatureReferenceError(index, "돌출 또는 절삭이 참조하는 닫힌 영역이 사라졌습니다. "
                                       "표시된 피처를 삭제한 뒤 새 영역을 끌어 다시 만들 수 있습니다.")
    distance = number(operation, "distance", "드래그 거리")
    if abs(distance) < MIN_DIMENSION:
        raise ValueError(f"드래그 거리의 크기는 {MIN_DIMENSION:g} mm 이상이어야 합니다.")
    displacement = gp_Vec(*(distance * axis for axis in sketch.plane.normal))
    return BRepPrimAPI_MakePrism(region.face, displacement, True).Shape(), distance


def fuse_pull(part, tool):
    return boolean_shape(BRepAlgoAPI_Fuse, part, tool, "돌출 형상을 결합하지 못했습니다.")


def connected_pull_bodies(bodies, tool):
    tool_bounds = bounds_of(tool)
    connected = []
    for body in bodies:
        bounds = bounds_of(body.shape)
        if any(max(bounds[i], tool_bounds[i]) - min(bounds[i + 3], tool_bounds[i + 3]) > 1e-6
               for i in range(3)):
            continue
        if len(solids_of(fuse_pull(body.shape, tool))) == 1:
            connected.append(body)
    return connected


def pull_body(operation, sketches, bodies, target, save_domain, index):
    tool, distance = pull_tool(operation, sketches, index)
    mode = operation.get("mode", "auto")
    if mode == "auto":
        affected = [target] if target else bodies
        cutting = distance < 0 and bool(affected)
    elif mode == "join":
        affected = connected_pull_bodies(bodies, tool)
        cutting = False
    elif mode == "cut":
        affected = [body for body in bodies if overlapping_volume(body.shape, tool) > MIN_VOLUME]
        if not affected:
            raise ValueError("절삭 범위가 부품 내부와 겹치지 않습니다.")
        cutting = True
    else:
        raise ValueError("자동, 결합, 절삭 중 하나의 당기기 방식을 선택하세요.")
    if save_domain and not cutting:
        raise ValueError("유체 체적으로 저장할 절삭 작업을 선택하세요.")
    if target is not None and any(body.id == target.id for body in affected):
        affected = [target, *(body for body in affected if body.id != target.id)]
    part = combine_shapes(body.shape for body in affected)
    if cutting:
        part, domain = cut_body(part, tool, save_domain)
        return part, domain, affected
    return (tool if part is None else fuse_pull(part, tool)), None, affected


def fillet_body(part, edge, radius):
    maker = BRepFilletAPI_MakeFillet(part)
    try:
        maker.Add(radius, edge)
        maker.Build()
        if maker.IsDone():
            result = maker.Shape()
            require_solid(result, "필렛으로 형상이 유효하지 않게 되었습니다. 반지름을 줄여 다시 시도하세요.")
            faces = [TopoDS.Face_s(shape) for shape in maker.Generated(edge)
                     if shape.ShapeType() == TopAbs_FACE]
            face_refs = {face_reference(face) for face in faces}
            edge_refs = {edge_reference(curve) for face in faces for _, curve in model_edges(face)}
            return result, FilletRecord(radius, face_refs, edge_refs)
    except (RuntimeError, Standard_Failure) as error:
        raise ValueError("필렛을 적용하지 못했습니다. 반지름을 줄이거나 다른 모서리를 선택하세요.") from error
    raise ValueError("필렛을 적용하지 못했습니다. 반지름을 줄이거나 다른 모서리를 선택하세요.")


def cylinder_shape(surface, radius, first, last):
    axis, origin = surface["axis"], surface["origin"]
    cylinder_origin = gp_Pnt(*(point + first * direction for point, direction in zip(origin, axis)))
    return BRepPrimAPI_MakeCylinder(gp_Ax2(cylinder_origin, gp_Dir(*axis)), radius, last - first).Shape()


def cylinder_edit_tool(surface, distance):
    radius = surface["radius"]
    new_radius = radius + surface["sense"] * distance
    if new_radius < MIN_DIMENSION:
        raise ValueError("수정한 원통 반지름이 너무 작습니다.")
    if new_radius > MAX_COORDINATE:
        raise ValueError("수정한 원통 반지름이 작업 범위를 벗어났습니다.")
    if not surface["editable"]:
        raise ValueError("반지름 편집에는 양 끝이 원형으로 닫힌 원통 면을 선택하세요.")
    first, last = surface["span"]
    outer = cylinder_shape(surface, max(radius, new_radius), first, last)
    inner = cylinder_shape(surface, min(radius, new_radius), first, last)
    return boolean_shape(BRepAlgoAPI_Cut, outer, inner, "원통 반지름을 변경할 형상을 만들 수 없습니다.")


def target_face(operation, body):
    reference = identifier(operation.get("face"), "면")
    matching = [face for face in model_faces(body.shape) if face_reference(face) == reference]
    if len(matching) != 1:
        raise ValueError("형상이 바뀌었거나 면을 구별할 수 없습니다. 면을 다시 선택하세요.")
    return matching[0]


def edit_face(operation, body):
    distance = number(operation, "distance", "면 이동 거리")
    if abs(distance) < MIN_DIMENSION:
        raise ValueError(f"면 이동 거리의 크기는 {MIN_DIMENSION:g} mm 이상이어야 합니다.")
    face = target_face(operation, body)
    surface = face_surface(face)
    if surface and surface["kind"] == "plane":
        normal = outward_normal(face, [0, 0, 0])
        displacement = gp_Vec(*(distance * axis for axis in normal))
        tool = BRepPrimAPI_MakePrism(face, displacement, True).Shape()
    elif surface and surface["kind"] == "cylinder":
        tool = cylinder_edit_tool(surface, distance)
    else:
        raise ValueError("수정할 평면이나 직선 원통 면을 선택하세요.")
    if distance < 0:
        result, _ = cut_body(body.shape, tool, False)
        return result
    result = boolean_shape(BRepAlgoAPI_Fuse, body.shape, tool, "면을 당겨 부품을 늘리지 못했습니다.")
    if volume_of(result) - volume_of(body.shape) <= MIN_VOLUME:
        raise ValueError("면 이동으로 추가할 체적이 없습니다.")
    return result


def edit_cylinder(operation, body):
    face = target_face(operation, body)
    cylinder = closed_cylinder_cap(face, list(model_faces(body.shape)), edge_ancestors(body.shape))
    if cylinder is None:
        raise ValueError("높이와 반지름을 수정하려면 닫힌 직선 원통의 끝 면을 선택하세요.")
    surface, first_cap = cylinder
    radius = number(operation, "radius", "원통 반지름", dimension=True)
    height = number(operation, "height", "원통 높이", dimension=True)
    first, last = surface["span"]
    if abs(radius - surface["radius"]) < 1e-9 and abs(height - (last - first)) < 1e-9:
        return body.shape
    if first_cap:
        first = last - height
    else:
        last = first + height
    return cylinder_shape(surface, radius, first, last)


def overlapping_volume(first, second):
    a, b = bounds_of(first), bounds_of(second)
    if any(max(a[i], b[i]) >= min(a[i + 3], b[i + 3]) for i in range(3)):
        return 0.0
    common = BRepAlgoAPI_Common(first, second)
    if not common.IsDone():
        raise ValueError("수정 전후의 파트를 구별하지 못했습니다.")
    return volume_of(common.Shape())


def part_order(body):
    return tuple(int(field) for field in body.id.split("-")[1:])


def reconcile_bodies(previous, shape, index, related=(), fillet=None):
    candidates = sorted(solids_of(shape), key=bounds_of)
    result, used = [], set()
    new_number = 0
    for candidate in candidates:
        exact = next((body for body in previous if body.shape.IsSame(candidate)), None)
        if exact:
            result.append(exact)
            used.add(exact.id)
            continue
        matched = [body for body in previous if overlapping_volume(body.shape, candidate) > MIN_VOLUME]
        original = next((body for body in matched if body.id not in used), None)
        if original:
            body_id = original.id
        else:
            new_number += 1
            body_id = f"body-{index + 1}-{new_number}"
        used.add(body_id)
        operations = {index, *related}
        fillets = {}
        for body in matched:
            operations.update(body.operations)
            fillets.update(body.fillets)
        if fillet:
            fillets[index] = fillet
        result.append(Body(body_id, candidate, operations, fillets))
    return sorted(result, key=part_order)


def move_body(body, transform, index):
    mover = BRepBuilderAPI_Transform(body.shape, transform, True)
    shape = mover.Shape()
    require_solid(shape, "부품을 작업 범위 안에서 이동하세요.")
    if not body.fillets:
        return Body(body.id, shape, body.operations | {index})
    face_remap = {face_reference(face): face_reference(TopoDS.Face_s(mover.ModifiedShape(face)))
                  for face in model_faces(body.shape)}
    edge_remap = {edge_reference(curve): edge_reference(BRepAdaptor_Curve(TopoDS.Edge_s(mover.ModifiedShape(edge))))
                  for edge, curve in model_edges(body.shape)}
    fillets = {step: FilletRecord(record.radius,
                                 {face_remap[key] for key in record.faces if key in face_remap},
                                 {edge_remap[key] for key in record.edges if key in edge_remap})
               for step, record in body.fillets.items()}
    return Body(body.id, shape, body.operations | {index}, fillets)


def build(document):
    if not isinstance(document, dict) or type(document.get("version")) is not int or document["version"] != 1:
        raise ValueError("지원하는 CAD 문서 형식은 버전 1입니다.")
    operations = document.get("operations")
    if not isinstance(operations, list) or len(operations) > MAX_OPERATIONS:
        raise ValueError(f"작업 내역은 최대 {MAX_OPERATIONS}개까지 저장할 수 있습니다.")
    if any(not isinstance(operation, dict) for operation in operations):
        raise ValueError("잘못된 CAD 작업이 있습니다.")
    domain_index = document.get("domainCut")
    if domain_index is not None and (
        type(domain_index) is not int or not 0 <= domain_index < len(operations)
        or operations[domain_index].get("type") not in ("cut", "pull")
    ):
        raise ValueError("유체 체적으로 저장할 절삭 작업을 선택하세요.")

    bodies, domain, domain_owners = [], None, set()
    sketches, sketch_indices, sketch_bodies = {}, {}, {}
    deleted_operations = set()
    fillet_corners = {}
    entity_count = 0
    for index, operation in enumerate(operations):
        kind = operation.get("type")
        body_id = operation.get("body")
        target = next((body for body in bodies if body.id == body_id), None)
        if body_id is not None and target is None:
            raise ValueError("편집할 파트를 다시 선택하세요.")
        if kind == "sketch":
            sketch = build_sketch(operation)
            if sketch.id in sketches:
                raise ValueError("스케치 식별자가 중복됩니다.")
            entity_count += len(sketch.entities)
            if entity_count > MAX_DOCUMENT_ENTITIES:
                raise ValueError(f"문서에 최대 {MAX_DOCUMENT_ENTITIES}개의 스케치 요소를 저장할 수 있습니다.")
            sketches[sketch.id] = sketch
            sketch_indices[sketch.id] = index
            if target:
                sketch_bodies[sketch.id] = target.id
                target.operations.add(index)
            continue
        if kind == "delete_body":
            if target is None:
                raise ValueError("삭제할 파트를 선택하세요.")
            deleted_operations.update(target.operations)
            deleted_operations.add(index)
            bodies = [body for body in bodies if body.id != target.id]
            sketch_bodies = {key: owner for key, owner in sketch_bodies.items() if owner != target.id}
            if target.id in domain_owners or not bodies:
                domain, domain_owners = None, set()
            continue
        if kind == "pull" and not target:
            sketch_id = identifier(operation.get("sketch"), "스케치")
            target = next((body for body in bodies if body.id == sketch_bodies.get(sketch_id)), None)
        if kind == "fillet":
            if not bodies:
                raise ValueError("필렛을 적용할 3D 부품을 먼저 만드세요.")
            radius = number(operation, "radius", "필렛 반지름")
            if radius < 0 or 0 < radius < MIN_DIMENSION:
                raise ValueError(f"필렛 반지름은 0 또는 {MIN_DIMENSION:g} mm 이상이어야 합니다.")
            reference = identifier(operation.get("edge"), "모서리")
            if radius == 0 and target:
                target.operations.add(index)
                continue
            matching = [(body, edge) for body in ([target] if target else bodies)
                        for edge, curve in model_edges(body.shape) if edge_reference(curve) == reference]
            if radius == 0 and not matching and len(bodies) == 1:
                bodies[0].operations.add(index)
                continue
            hint = operation.get("edgeCorner")
            valid_hint = (isinstance(hint, list) and len(hint) == 3 and hint.count(0) == 1
                          and all(type(side) is int and -1 <= side <= 1 for side in hint))
            if not matching and valid_hint and (target or len(bodies) == 1):
                candidate_body = target or bodies[0]
                bounds = bounds_of(candidate_body.shape)
                matching = [(candidate_body, edge) for edge, curve in model_edges(candidate_body.shape)
                            if bounding_edge_corner(curve, bounds) == hint]
            if len(matching) != 1:
                raise CadFeatureReferenceError(index, "필렛 모서리를 다시 찾을 수 없습니다. 표시된 필렛의 반지름을 0으로 바꾼 뒤 "
                                               "스케치를 수정하고 원하는 모서리에 필렛을 다시 적용하세요.")
            target, edge = matching[0]
            corner = bounding_edge_corner(BRepAdaptor_Curve(edge), bounds_of(target.shape))
            if corner:
                fillet_corners[index] = corner
            if radius == 0:
                target.operations.add(index)
                continue
        affected = [target] if target else bodies
        part = combine_shapes(body.shape for body in affected)
        related, fillet, cut_domain = (), None, None
        if kind == "pull":
            part, cut_domain, affected = pull_body(operation, sketches, bodies, target, index == domain_index, index)
            related = (sketch_indices[operation["sketch"]],)
        elif kind == "fillet":
            part, fillet = fillet_body(part, edge, radius)
        elif kind == "face_edit":
            if not target:
                raise ValueError("움직일 면의 파트를 선택하세요.")
            part = edit_face(operation, target)
        elif kind == "cylinder_edit":
            if not target:
                raise ValueError("수정할 원통의 파트를 선택하세요.")
            part = edit_cylinder(operation, target)
        elif kind == "import":
            if index != 0:
                raise ValueError("STEP 가져오기는 문서의 첫 작업이어야 합니다.")
            part = step_body(operation)
        elif kind == "extrude":
            tool = profile_body(operation, kind)
            part = tool if part is None else boolean_shape(
                BRepAlgoAPI_Fuse, part, tool, "돌출 형상을 결합하지 못했습니다."
            )
        elif kind == "cut":
            if part is None:
                raise ValueError("절삭할 부품을 먼저 만드세요.")
            tool = profile_body(operation, kind)
            part, cut_domain = cut_body(part, tool, index == domain_index)
        elif kind == "move":
            if part is None:
                raise ValueError("이동할 부품을 먼저 만드세요.")
            delta = [number(operation, "d" + axis, axis.upper() + " 이동량", default=0) for axis in "xyz"]
            transform = gp_Trsf()
            transform.SetTranslation(gp_Vec(*delta))
            bodies = [move_body(body, transform, index) if target is None or body.id == target.id else body
                      for body in bodies]
            if domain is not None and (target is None or domain_owners == {target.id}):
                domain = BRepBuilderAPI_Transform(domain, transform, True).Shape()
                bounds_of(domain)
            continue
        else:
            raise ValueError("지원하지 않는 CAD 작업입니다.")
        require_solid(part, "유효한 솔리드가 남지 않았습니다. 절삭 깊이와 범위를 확인하세요.")
        after = reconcile_bodies(affected, part, index, related, fillet)
        affected_ids = {body.id for body in affected}
        remaining_ids = {body.id for body in after}
        bodies = sorted([*(body for body in bodies if body.id not in affected_ids), *after], key=part_order)
        removed = affected_ids - remaining_ids
        for body in affected:
            if body.id not in removed:
                continue
            replacements = [new.id for new in after if overlapping_volume(body.shape, new.shape) > MIN_VOLUME]
            for sketch_id, owner in list(sketch_bodies.items()):
                if owner == body.id:
                    if replacements:
                        sketch_bodies[sketch_id] = replacements[0]
                    else:
                        del sketch_bodies[sketch_id]
            if body.id in domain_owners:
                domain_owners.remove(body.id)
                domain_owners.update(replacements)
        if cut_domain is not None:
            domain = cut_domain
            domain_owners = {body.id for body in after if index in body.operations}
    ports = document.get("domainPorts")
    if ports and domain_index is None:
        if not isinstance(ports, list) or len(ports) > 64 or not all(isinstance(ref, str) for ref in ports):
            raise ValueError("개구부 선택이 올바르지 않습니다.")
        caps = opening_caps(bodies)
        if all(ref in caps for ref in ports):
            domain = enclosed_domain(bodies, [caps[ref] for ref in dict.fromkeys(ports)])
    live_operations = set(sketch_indices.values())
    for body in bodies:
        live_operations.update(body.operations)
    return bodies, domain, sketches, sketch_bodies, deleted_operations - live_operations, fillet_corners


def opening_caps(bodies):
    caps = {}
    for body in bodies:
        for face in model_faces(body.shape):
            if BRepAdaptor_Surface(face).GetType() != GeomAbs_Plane:
                continue
            outer = BRepTools.OuterWire_s(face)
            explorer = TopExp_Explorer(face, TopAbs_WIRE)
            while explorer.More():
                wire = TopoDS.Wire_s(explorer.Current())
                explorer.Next()
                if wire.IsSame(outer):
                    continue
                builder = BRepBuilderAPI_MakeFace(wire, True)
                if builder.IsDone():
                    cap = builder.Face()
                    caps[face_reference(cap)] = cap
    return caps


def enclosed_domain(bodies, caps):
    part = combine_shapes(body.shape for body in bodies)
    bounds = bounds_of(part)
    margin = max(bounds[i+3] - bounds[i] for i in range(3)) * 0.25
    box = BRepPrimAPI_MakeBox(gp_Pnt(*(v-margin for v in bounds[:3])),
                              gp_Pnt(*(v+margin for v in bounds[3:]))).Shape()
    free = BRepAlgoAPI_Cut(box, part)
    free.Build()
    if not free.IsDone():
        raise ValueError("부품 주변 공간을 분리하지 못했습니다.")
    args, tools = TopTools_ListOfShape(), TopTools_ListOfShape()
    args.Append(free.Shape())
    for cap in caps:
        tools.Append(cap)
    splitter = BRepAlgoAPI_Splitter()
    splitter.SetArguments(args)
    splitter.SetTools(tools)
    splitter.Build()
    if not splitter.IsDone():
        raise ValueError("개구부를 막을 수 없습니다. 포트 선택을 확인하세요.")
    wanted = {face_reference(cap) for cap in caps}
    for solid in solids_of(splitter.Shape()):
        limits = bounds_of(solid)
        if any(limits[i] < bounds[i] - margin/2 or limits[i+3] > bounds[i+3] + margin/2 for i in range(3)):
            continue
        if wanted.issubset({face_reference(face) for face in model_faces(solid)}):
            require_solid(solid, "추출한 내부 공간이 유효한 솔리드가 아닙니다.")
            return solid
    raise ValueError("선택한 개구부들이 하나의 닫힌 유로를 만들지 못했습니다. 같은 유로의 열린 포트를 모두 선택하세요.")


def coordinates(point):
    return [point.X(), point.Y(), point.Z()]


def shapes_of(shape, kind):
    indexed = TopTools_IndexedMapOfShape()
    TopExp.MapShapes_s(shape, kind, indexed)
    return indexed


def model_faces(shape):
    face_map = shapes_of(shape, TopAbs_FACE)
    for index in range(1, face_map.Extent() + 1):
        yield TopoDS.Face_s(face_map.FindKey(index))


def face_positions(face):
    location = TopLoc_Location()
    mesh = BRep_Tool.Triangulation_s(face, location)
    if mesh is None or mesh.NbTriangles() == 0:
        return []
    transform = location.Transformation()
    vertices = [coordinates(mesh.Node(i).Transformed(transform)) for i in range(1, mesh.NbNodes() + 1)]
    positions = []
    reversed_face = face.Orientation() == TopAbs_REVERSED
    for i in range(1, mesh.NbTriangles() + 1):
        a, b, c = mesh.Triangle(i).Get()
        if reversed_face:
            b, c = c, b
        for vertex in (a, b, c):
            positions.extend(vertices[vertex - 1])
    return positions


def face_plane(face):
    surface = BRepAdaptor_Surface(face)
    if surface.GetType() != GeomAbs_Plane:
        return None, None
    plane = surface.Plane()
    normal = plane.Axis().Direction()
    if parameter_sense(face, plane.Position()) < 0:
        normal = normal.Reversed()
    x_axis = plane.XAxis().Direction()
    origin = coordinates(plane.Location())
    plane_z = origin[2] if abs(normal.Z()) >= 1 - 1e-10 else None
    return {"origin": origin, "x": coordinates(x_axis), "y": coordinates(normal.Crossed(x_axis))}, plane_z


def direction_dot(a, b):
    return sum(x * y for x, y in zip(a, b))


def unit_vector(vector):
    magnitude = hypot(*vector)
    return [value / magnitude for value in vector] if magnitude > 1e-12 else None


def relative_axis(point, origin, axis):
    relative = [value - offset for value, offset in zip(point, origin)]
    along = direction_dot(relative, axis)
    return along, [value - along * direction for value, direction in zip(relative, axis)]


def parameter_sense(face, position):
    # A prism can have a valid outward face on an indirectly parameterized surface.
    reversed_face = face.Orientation() == TopAbs_REVERSED
    return -1 if reversed_face == position.Direct() else 1


def cylinder_end_spans(face, surface):
    first, last = surface.FirstVParameter(), surface.LastVParameter()
    if (not isfinite(first) or not isfinite(last) or last - first < MIN_DIMENSION
            or surface.LastUParameter() - surface.FirstUParameter() < 2 * pi - 1e-7):
        return None
    cylinder = surface.Cylinder()
    origin, axis = coordinates(cylinder.Location()), coordinates(cylinder.Axis().Direction())
    tolerance = 1e-6
    ends = set()
    for edge, curve in model_edges(face):
        if BRep_Tool.IsClosed_s(edge, face):
            continue  # A seam joins the end rings along the same surface.
        if curve.GetType() != GeomAbs_Circle:
            return None
        circle = curve.Circle()
        offset, radial = relative_axis(coordinates(circle.Location()), origin, axis)
        if (abs(circle.Radius() - cylinder.Radius()) > tolerance or hypot(*radial) > tolerance
                or abs(direction_dot(coordinates(circle.Axis().Direction()), axis)) < 1 - 1e-8):
            return None
        if abs(offset - first) <= tolerance:
            ends.add(0)
        elif abs(offset - last) <= tolerance:
            ends.add(1)
        else:
            return None
    return (first, last) if len(ends) == 2 else None


def face_surface(face):
    surface = BRepAdaptor_Surface(face)
    kind = surface.GetType()
    if kind == GeomAbs_Plane:
        return {"kind": "plane", "editable": True}
    if kind == GeomAbs_Cylinder:
        cylinder = surface.Cylinder()
        span = cylinder_end_spans(face, surface)
        return {"kind": "cylinder", "origin": coordinates(cylinder.Location()),
                "axis": coordinates(cylinder.Axis().Direction()), "radius": cylinder.Radius(),
                "sense": parameter_sense(face, cylinder.Position()),
                "editable": span is not None, "span": span}
    return None


def outward_normal(face, point):
    surface = BRepAdaptor_Surface(face)
    if surface.GetType() == GeomAbs_Plane:
        plane = surface.Plane()
        normal = coordinates(plane.Axis().Direction())
        sense = parameter_sense(face, plane.Position())
    elif surface.GetType() == GeomAbs_Cylinder:
        cylinder = surface.Cylinder()
        origin = coordinates(cylinder.Location())
        axis = coordinates(cylinder.Axis().Direction())
        _, radial = relative_axis(point, origin, axis)
        normal = unit_vector(radial)
        sense = parameter_sense(face, cylinder.Position())
    else:
        return None
    if normal and sense < 0:
        return [-component for component in normal]
    return normal


def model_edges(shape):
    edge_map = shapes_of(shape, TopAbs_EDGE)
    for index in range(1, edge_map.Extent() + 1):
        edge = TopoDS.Edge_s(edge_map.FindKey(index))
        if BRep_Tool.Degenerated_s(edge):
            continue
        curve = BRepAdaptor_Curve(edge)
        if isfinite(curve.FirstParameter()) and isfinite(curve.LastParameter()):
            yield edge, curve


def curve_points(curve, divisions):
    start, end = curve.FirstParameter(), curve.LastParameter()
    return [coordinates(curve.Value(start + (end - start) * i / divisions)) for i in range(divisions + 1)]


def bounding_edge_corner(curve, bounds):
    """Identify a full, axis-aligned bounding-box edge by its two fixed sides."""
    if curve.GetType() != GeomAbs_Line or min(bounds[i + 3] - bounds[i] for i in range(3)) <= MIN_DIMENSION:
        return None
    start, end = curve_points(curve, 1)
    tolerance = 1e-7
    sides = []
    for axis in range(3):
        low, high = bounds[axis], bounds[axis + 3]
        first, last = sorted((start[axis], end[axis]))
        if abs(first - low) <= tolerance and abs(last - high) <= tolerance:
            sides.append(0)
        elif abs(first - low) <= tolerance and abs(last - low) <= tolerance:
            sides.append(-1)
        elif abs(first - high) <= tolerance and abs(last - high) <= tolerance:
            sides.append(1)
        else:
            return None
    return sides if sides.count(0) == 1 else None


def projectable_curve(curve):
    kind = curve.GetType()
    if kind == GeomAbs_Line:
        start, end = curve_points(curve, 1)
        return {"kind": "line", "start": start, "end": end}
    if kind == GeomAbs_Circle:
        circle = curve.Circle()
        first, middle, last = curve_points(curve, 2)
        span = curve.LastParameter() - curve.FirstParameter()
        return {"kind": "circle" if span >= 2 * pi - 1e-8 else "arc",
                "center": coordinates(circle.Location()), "normal": coordinates(circle.Axis().Direction()),
                "radius": circle.Radius(), "start": first, "middle": middle, "end": last}
    return None


def edge_reference(curve):
    divisions = 1 if curve.GetType() == GeomAbs_Line else 8
    samples = tuple(tuple(round(value * 1e6) for value in point) for point in curve_points(curve, divisions))
    signature = min(samples, samples[::-1])
    return sha256(repr(signature).encode("ascii")).hexdigest()[:24]


def face_reference(face):
    # Boundary curves anchor the ID without relying on triangulation or BRep order.
    edge_refs = sorted(edge_reference(curve) for _, curve in model_edges(face))
    surface = BRepAdaptor_Surface(face)
    center = tuple(round(value * 1e6) for value in bounds_of(face))
    signature = (str(surface.GetType()), center, edge_refs)
    return sha256(repr(signature).encode("ascii")).hexdigest()[:24]


def edge_inward(curve, faces, center):
    midway = (curve.FirstParameter() + curve.LastParameter()) / 2
    point = coordinates(curve.Value(midway))
    normals = [normal for face in faces if (normal := outward_normal(TopoDS.Face_s(face), point)) is not None]
    direction = unit_vector([-sum(values) for values in zip(*normals)]) if normals else None
    return direction or unit_vector([coordinate - value for coordinate, value in zip(center, point)]) or [0, 0, 0]


def adjoining_faces(edge, ancestors):
    faces = []
    if ancestors.Contains(edge):
        for candidate in ancestors.FindFromKey(edge):
            if not any(face.IsSame(candidate) for face in faces):
                faces.append(TopoDS.Face_s(candidate))
    return faces


def edge_ancestors(shape):
    ancestors = TopTools_IndexedDataMapOfShapeListOfShape()
    TopExp.MapShapesAndAncestors_s(shape, TopAbs_EDGE, TopAbs_FACE, ancestors)
    return ancestors


def closed_cylinder_cap(face, faces, ancestors):
    if len(faces) != 3 or BRepAdaptor_Surface(face).GetType() != GeomAbs_Plane:
        return None
    edges = list(model_edges(face))
    if len(edges) != 1:
        return None
    edge, curve = edges[0]
    if curve.GetType() != GeomAbs_Circle or abs(curve.LastParameter() - curve.FirstParameter() - 2 * pi) > 1e-7:
        return None
    neighbors = [other for other in adjoining_faces(edge, ancestors) if not other.IsSame(face)]
    if len(neighbors) != 1:
        return None
    surface = face_surface(neighbors[0])
    if not surface or surface["kind"] != "cylinder" or not surface["editable"] or surface["sense"] != 1:
        return None
    first, last = surface["span"]
    offset, _ = relative_axis(coordinates(curve.Circle().Location()), surface["origin"], surface["axis"])
    if abs(offset - first) <= 1e-6:
        return surface, True
    if abs(offset - last) <= 1e-6:
        return surface, False
    return None


def fillet_enabled(edge, faces):
    # Periodic seams have one adjoining face, even when OCCT lists it twice.
    if len(faces) != 2 or any(BRep_Tool.IsClosed_s(edge, face) for face in faces):
        return False
    first, second = faces
    return not BRep_Tool.HasContinuity_s(edge, first, second) or BRep_Tool.Continuity_s(edge, first, second) == GeomAbs_C0


def mesh_shape(shape):
    bounds = bounds_of(shape)
    extent = max(bounds[axis + 3] - bounds[axis] for axis in range(3))
    mesher = BRepMesh_IncrementalMesh(shape, max(0.0005, extent * 0.001), False, 0.18, False)
    if not mesher.IsDone():
        raise ValueError("3D 미리보기의 표면을 생성하지 못했습니다.")
    return bounds


def sketch_face_positions(face):
    mesh_shape(face)
    positions = face_positions(face)
    if not positions:
        raise ValueError("스케치 영역을 화면에 표시할 수 없습니다.")
    return positions


def preview_sketches(sketches, owners):
    result = []
    triangle_count, profile_triangle_count, edge_point_count = 0, 0, 0
    for sketch in sketches.values():
        regions = {}
        for region in sketch.regions.values():
            positions = sketch_face_positions(region.face)
            triangle_count += len(positions) // 9
            if triangle_count > MAX_TRIANGLES:
                raise ValueError("스케치 영역이 미리보기 한도를 넘었습니다.")
            region_data = {"id": region.id, "entityIds": region.entity_ids, "positions": positions}
            if region.merged or region.segmented:
                outlines = []
                for _, curve in model_edges(region.face):
                    divisions = 1 if curve.GetType() == GeomAbs_Line else 64
                    edge_point_count += divisions + 1
                    if edge_point_count > MAX_EDGE_POINTS:
                        raise ValueError("스케치 윤곽이 미리보기 한도를 넘었습니다.")
                    outlines.append([coordinate for point in curve_points(curve, divisions) for coordinate in point])
                region_data["outlines"] = outlines
            regions[region.id] = region_data

        profiles = []
        for contour in sketch.contours:
            region = sketch.regions.get(contour.id)
            if region is not None and region.face is contour.face:
                positions = regions[contour.id]["positions"]
            else:
                positions = sketch_face_positions(contour.face)
            profile_triangle_count += len(positions) // 9
            if profile_triangle_count > MAX_TRIANGLES:
                raise ValueError("스케치 윤곽이 미리보기 한도를 넘었습니다.")
            profiles.append({"id": contour.id, "entityIds": contour.entity_ids, "positions": positions})

        result.append({"id": sketch.id, "plane": sketch.plane.data(), "entities": sketch.entities,
                       "profiles": profiles, "regions": list(regions.values()), "body_id": owners.get(sketch.id),
                       "overlapGroups": sketch.overlap_groups,
                       "hiddenEntityIds": sketch.hidden_entity_ids,
                       "segments": sketch.segments, "openPoints": sketch.open_points})
    return result


def preview(shape, body=None):
    if shape is None:
        return None
    bounds = mesh_shape(shape)

    faces = []
    triangle_count = 0
    shape_faces = list(model_faces(shape))
    ancestors = edge_ancestors(shape)
    fillets = body.fillets if body else {}
    face_features = {reference: (index, record.radius) for index, record in fillets.items() for reference in record.faces}
    edge_features = {reference: (index, record.radius) for index, record in fillets.items() for reference in record.edges}
    for index, face in enumerate(shape_faces):
        positions = face_positions(face)
        if not positions:
            continue
        triangle_count += len(positions) // 9
        if triangle_count > MAX_TRIANGLES:
            raise ValueError("모델이 3D 미리보기 한도를 넘었습니다. 더 단순한 부품을 불러오세요.")
        plane, plane_z = face_plane(face)
        reference = face_reference(face)
        fillet_index, fillet_radius = face_features.get(reference, (None, None))
        face_data = {"id": index, "positions": positions, "plane_z": plane_z, "plane": plane,
                     "ref": reference, "body_id": body.id if body else None, "surface": face_surface(face),
                     "fillet_index": fillet_index, "fillet_radius": fillet_radius}
        cylinder = closed_cylinder_cap(face, shape_faces, ancestors)
        if cylinder:
            surface, _ = cylinder
            first, last = surface["span"]
            face_data["cylinder"] = {"radius": surface["radius"], "height": last - first}
        faces.append(face_data)

    if not faces:
        raise ValueError("미리보기에 표시할 솔리드 면이 없습니다.")
    edges, edge_refs, edge_meta = [], [], []
    center = [(bounds[i] + bounds[i + 3]) / 2 for i in range(3)]
    point_count = 0
    for edge, curve in model_edges(shape):
        divisions = 1 if curve.GetType() == GeomAbs_Line else 64
        point_count += divisions + 1
        if point_count > MAX_EDGE_POINTS:
            raise ValueError("모델이 3D 미리보기 한도를 넘었습니다. 더 단순한 부품을 불러오세요.")
        edges.append([coordinate for point in curve_points(curve, divisions) for coordinate in point])
        reference = edge_reference(curve)
        edge_refs.append(reference)
        fillet_index, fillet_radius = edge_features.get(reference, (None, None))
        adjoining = adjoining_faces(edge, ancestors)
        edge_meta.append({"body_id": body.id if body else None, "inward": edge_inward(curve, adjoining, center),
                          "fillet_index": fillet_index, "radius": fillet_radius,
                          "fillet_enabled": fillet_index is not None or fillet_enabled(edge, adjoining),
                          "curve": projectable_curve(curve)})
    return {"faces": faces, "edges": edges, "edge_refs": edge_refs, "edge_meta": edge_meta,
            "bounds": bounds, "volume": volume_of(shape), "solids": len(solids_of(shape))}


def preview_bodies(bodies):
    if not bodies:
        return None
    if len(bodies) == 1:
        return preview(bodies[0].shape, bodies[0])
    pieces = [preview(body.shape, body) for body in bodies]
    merged = {key: [item for piece in pieces for item in piece[key]]
              for key in ("faces", "edges", "edge_refs", "edge_meta")}
    if sum(len(face["positions"]) // 9 for face in merged["faces"]) > MAX_TRIANGLES:
        raise ValueError("모델이 3D 미리보기 한도를 넘었습니다. 더 단순한 부품을 불러오세요.")
    if sum(len(points) // 3 for points in merged["edges"]) > MAX_EDGE_POINTS:
        raise ValueError("모델이 3D 미리보기 한도를 넘었습니다. 더 단순한 부품을 불러오세요.")
    for index, face in enumerate(merged["faces"]):
        face["id"] = index
    merged["bounds"] = [min(piece["bounds"][i] for piece in pieces) if i < 3 else max(piece["bounds"][i] for piece in pieces)
                        for i in range(6)]
    merged["volume"] = sum(piece["volume"] for piece in pieces)
    merged["solids"] = len(bodies)
    return merged
