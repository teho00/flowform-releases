import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

import flow_setup
from flow_contours import clip_height
from mesh_quality import inspect


class ReviewTests(unittest.TestCase):
    def test_section_clipping(self):
        inside = clip_height([(0.,0.), (2.,0.), (2.,3.), (0.,3.)], 1., True)
        self.assertEqual({(0.,1.),(2.,1.),(2.,3.),(0.,3.)},set(inside))

    def test_invalid_schedule(self):
        body=dict(mode="transient",fluid="air",rho=1,mu=1e-5,inlet_speed_m_s=1,outlet_pressure_pa=0,
                  end_time_s=1,time_step_s=0.01)
        with self.assertRaises(ValueError):
            flow_setup.parse_conditions({**body,"flow_schedule":[{"time_s":1,"ml_min":10}]})
        with self.assertRaises(ValueError):
            flow_setup.parse_conditions({**body,"save_interval_s":0.001})
        parsed=flow_setup.parse_conditions({**body,"save_interval_s":0.1,"flow_schedule":[{"time_s":0.2,"ml_min":12}]})
        self.assertTrue(parsed["live"])
        self.assertNotIn("flow_schedule",flow_setup.apply_conditions(parsed,{"mode":"steady"}))

    def test_regular_tetrahedron(self):
        with TemporaryDirectory() as tmp:
            path=Path(tmp)
            (path/"domain.msh").write_text("""$MeshFormat
2.2 0 8
$EndMeshFormat
$PhysicalNames
4
2 1 "inlet"
2 2 "outlet"
2 3 "walls"
3 4 "fluid"
$EndPhysicalNames
$Nodes
4
1 1 1 1
2 -1 -1 1
3 1 -1 -1
4 -1 1 -1
$EndNodes
$Elements
1
1 4 2 4 4 1 2 3 4
$EndElements
""")
            report=inspect(path)
            self.assertAlmostEqual(report["minimum"],1)
            self.assertEqual(report["below"],0)
            self.assertEqual(sum(report["counts"]),1)
