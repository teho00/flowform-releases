import base64, math, unittest
import cad_model as cad

@unittest.skipUnless(cad.KERNEL_READY, "Open CASCADE required")
class ImportedCavityTest(unittest.TestCase):
    def test_native_through_cut_exposes_ports_without_step_round_trip(self):
        block = {"type": "extrude", "profile": "rectangle", "x": 0, "y": 0, "z": 0,
                 "width": 10, "length": 10, "height": 10}
        cut = {"type": "cut", "profile": "circle", "x": 5, "y": 5, "z": 10, "radius": 1, "height": 10}
        doc = {"version": 1, "operations": [block]}
        self.assertFalse(cad.model(doc)["openings"])
        doc["operations"].append(cut)
        ports = [cap["ref"] for cap in cad.model(doc)["openings"]]
        self.assertEqual(len(ports), 2)
        result = cad.flow_domain({**doc, "domainPorts": ports})
        self.assertAlmostEqual(result["domain"]["volume"], 10 * math.pi, places=5)
        self.assertTrue(set(ports).issubset({face["ref"] for face in result["domain"]["faces"]}))

    def test_straight_and_branched_imports(self):
        block = cad.BRepPrimAPI_MakeBox(10, 10, 10).Shape()
        def prism(origin, direction, length):
            axis = cad.gp_Ax2(cad.gp_Pnt(*origin), cad.gp_Dir(*direction))
            return cad.BRepPrimAPI_MakeCylinder(axis, 1, length).Shape()
        straight = prism((5,5,-1),(0,0,1),12)
        branch = prism((5,5,5),(1,0,0),6)
        for tool, n in ((straight,2),(cad.BRepAlgoAPI_Fuse(straight,branch).Shape(),3)):
            shape = cad.BRepAlgoAPI_Cut(block,tool).Shape()
            self.check_cavity(shape, n, 1000-cad.volume_of(shape))

    def test_u_bend_import(self):
        block = cad.BRepPrimAPI_MakeBox(12,10,5).Shape()
        outer = cad.BRepPrimAPI_MakeCylinder(cad.gp_Ax2(cad.gp_Pnt(6,5,2),cad.gp_Dir(0,0,1)),3,1).Shape()
        inner = cad.BRepPrimAPI_MakeCylinder(cad.gp_Ax2(cad.gp_Pnt(6,5,1),cad.gp_Dir(0,0,1)),2,3).Shape()
        half = cad.BRepPrimAPI_MakeBox(cad.gp_Pnt(6,0,0),cad.gp_Pnt(12,10,5)).Shape()
        turn = cad.BRepAlgoAPI_Common(cad.BRepAlgoAPI_Cut(outer,inner).Shape(),half).Shape()
        for y in (2,7):
            leg = cad.BRepPrimAPI_MakeBox(cad.gp_Pnt(-1,y,2),cad.gp_Pnt(6,y+1,3)).Shape()
            turn = cad.BRepAlgoAPI_Fuse(turn,leg).Shape()
        shape = cad.BRepAlgoAPI_Cut(block,turn).Shape()
        self.check_cavity(shape,2,12+2.5*math.pi)

    def check_cavity(self, shape, count, expected):
        doc = {"version":1,"operations":[{"type":"import","name":"pipe.step","step":base64.b64encode(cad.step_bytes(shape)).decode()}]}
        ports = [cap["ref"] for cap in cad.model(doc)["openings"]]
        self.assertEqual(len(ports),count)
        with self.assertRaises(ValueError):
            cad.model({**doc,"domainPorts":ports[:-1]})
        doc["domainPorts"] = ports
        result = cad.flow_domain(doc)
        self.assertAlmostEqual(result["domain"]["volume"],expected,places=5)
        self.assertTrue(set(ports).issubset({f["ref"] for f in result["domain"]["faces"]}))
