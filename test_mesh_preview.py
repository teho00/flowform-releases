"""Check physical patches and true tetrahedron intersections in stored MSH files."""

import pathlib
import tempfile
import unittest
from unittest.mock import patch

from mesh_preview import preview


def mesh_text(points_mm, polygons, cells):
    return "\n".join((
        "$MeshFormat", "2.2 0 8", "$EndMeshFormat",
        "$PhysicalNames", "4", '2 1 "inlet"', '2 2 "outlet"', '2 3 "walls"', '3 4 "fluid"', "$EndPhysicalNames",
        "$Nodes", str(len(points_mm)),
        *(f"{i} " + " ".join(str(value / 1000) for value in point) for i, point in enumerate(points_mm, 1)),
        "$EndNodes", "$Elements", str(len(polygons) + len(cells)),
        *(f"{i} {len(nodes)-1} 2 {tag} 1 " + " ".join(map(str, nodes))
          for i, (tag, *nodes) in enumerate(polygons, 1)),
        *(f"{i} {4 if len(nodes) == 4 else 5} 2 4 1 " + " ".join(map(str, nodes))
          for i, nodes in enumerate(cells, len(polygons) + 1)),
        "$EndElements", "",
    ))


QUAD_TET = mesh_text(
    ((0, 0, 0), (0, 2, 0), (2, 0, 0), (2, 0, 2)),
    ((1, 1, 2, 3), (2, 2, 3, 4), (3, 1, 3, 4), (3, 1, 2, 4)),
    ((1, 2, 3, 4),),
)


class MeshPreviewTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.path = pathlib.Path(temporary.name) / "domain.msh"

    def test_surface_preserves_physical_patches_and_converts_to_mm(self):
        self.path.write_text(QUAD_TET, encoding="ascii")
        result = preview(self.path)
        self.assertEqual(result["bounds_mm"], [0, 0, 0, 2, 2, 2])
        self.assertEqual(result["patch_counts"], {"inlet": 1, "outlet": 1, "walls": 2})
        self.assertEqual(result["section"], [])
        self.assertEqual(
            [result["points_mm"][index] for index in result["patches"]["outlet"][0]],
            [(0, 2, 0), (2, 0, 0), (2, 0, 2)],
        )

    def test_center_plane_intersects_tetrahedron_with_a_quadrilateral(self):
        self.path.write_text(QUAD_TET, encoding="ascii")
        result = preview(self.path, "x", 0.5)
        self.assertEqual(result["section_position_mm"], 1)
        self.assertEqual(result["section_cells"], 1)
        self.assertEqual(len(result["section"]), 2)
        self.assertEqual(len(result["section_edges"]), 4)
        self.assertEqual({tuple(point) for point in result["points_mm"]}, {
            (1, 0, 0), (1, 0, 1), (1, 1, 0), (1, 1, 1),
        })
        self.assertTrue(all(not triangles for triangles in result["patches"].values()))

    def test_hexahedron_keeps_quad_boundary_and_four_section_edges(self):
        cube = mesh_text(
            ((0, 0, 0), (1, 0, 0), (1, 1, 0), (0, 1, 0), (0, 0, 1), (1, 0, 1), (1, 1, 1), (0, 1, 1)),
            ((1, 1, 5, 8, 4), (2, 2, 3, 7, 6), (3, 1, 2, 6, 5), (3, 4, 8, 7, 3),
             (3, 1, 4, 3, 2), (3, 5, 6, 7, 8)),
            ((1, 2, 3, 4, 5, 6, 7, 8),),
        )
        self.path.write_text(cube, encoding="ascii")
        result = preview(self.path)
        self.assertEqual(result["cell_counts"], {"tetrahedra": 0, "hexahedra": 1})
        self.assertEqual(len(result["patches"]["inlet"][0]), 4)
        section = preview(self.path, "z")
        self.assertEqual(section["section_cells"], 1)
        self.assertEqual((len(section["section"]), len(section["section_edges"])), (2, 4))
        self.assertTrue(all(point[2] == 0.5 for point in section["points_mm"]))

    def test_coplanar_shared_face_only_appears_once(self):
        source = mesh_text(
            ((1, 0, 0), (1, 2, 0), (1, 0, 2), (0, 0.5, 0.5), (2, 0.5, 0.5)),
            ((1, 1, 2, 4), (2, 1, 2, 5), (3, 1, 3, 4), (3, 2, 3, 4), (3, 1, 3, 5), (3, 2, 3, 5)),
            ((1, 2, 3, 4), (1, 3, 2, 5)),
        )
        self.path.write_text(source, encoding="ascii")
        result = preview(self.path, "x")
        self.assertEqual((len(result["section"]), len(result["section_edges"])), (1, 3))
        self.assertEqual(result["section_cells"], 1)

    def test_preview_cap_preserves_reported_full_patch_counts(self):
        self.path.write_text(QUAD_TET, encoding="ascii")
        with patch.dict("mesh_preview.PATCH_LIMITS", walls=1):
            result = preview(self.path)
        self.assertTrue(result["truncated"])
        self.assertEqual(len(result["patches"]["walls"]), 1)
        self.assertEqual(result["patch_counts"]["walls"], 2)
        self.assertEqual(len(result["patches"]["inlet"]), 1)
        self.assertEqual(len(result["patches"]["outlet"]), 1)

    def test_invalid_location_and_corrupted_element_raise_value_error(self):
        self.path.write_text(QUAD_TET.replace("1 2 3 4\n$EndElements", "1 2 3 99\n$EndElements"), encoding="ascii")
        with self.assertRaisesRegex(ValueError, "단면 위치"):
            preview(self.path, "z", float("nan"))
        with self.assertRaisesRegex(ValueError, "Gmsh 격자 파일"):
            preview(self.path)
