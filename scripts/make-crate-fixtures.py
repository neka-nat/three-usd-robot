"""Generate test-assets/anim_arm.{usdc,usda} — the M17 crate fixtures.

One stage, authored in memory and exported twice, so the binary and ASCII
fixtures are guaranteed equivalent. The stage packs everything the M17 crate
work must decode:

- a revolute joint with a time-sampled drive target (crate `TimeSamples` reps
  holding inlined floats)
- a custom `double` attribute with samples that are NOT float32-representable
  (non-inlined `Double` sample reps)
- `matrix4d` xformOp samples (one inlined identity, one full scalar matrix)
- an inlined `Vec3d` (all components int8-representable)
- a `uchar[]` array
- float arrays hitting both compressed encodings: all-integral (code 'i')
  and few-distinct-values lookup table (code 't')
- `customLayerData` (a crate `Dictionary`)

Requires pxr (pip install usd-core). Run from the repo root:
    python3 scripts/make-crate-fixtures.py
"""

from pxr import Gf, Sdf, Usd, UsdGeom, UsdPhysics, UsdShade, Vt

OUT_USDC = "test-assets/anim_arm.usdc"
OUT_USDA = "test-assets/anim_arm.usda"


def build(stage: Usd.Stage) -> None:
    UsdGeom.SetStageUpAxis(stage, UsdGeom.Tokens.z)
    UsdGeom.SetStageMetersPerUnit(stage, 1.0)
    stage.SetStartTimeCode(0)
    stage.SetEndTimeCode(96)
    stage.SetTimeCodesPerSecond(24)
    stage.GetRootLayer().customLayerData = {
        "generator": "make-crate-fixtures",
        "revision": 3,
        "scale": 0.5,
    }

    world = UsdGeom.Xform.Define(stage, "/World")
    stage.SetDefaultPrim(world.GetPrim())
    UsdPhysics.ArticulationRootAPI.Apply(world.GetPrim())

    base = UsdGeom.Xform.Define(stage, "/World/base")
    UsdPhysics.RigidBodyAPI.Apply(base.GetPrim())
    UsdGeom.Cube.Define(stage, "/World/base/geom").CreateSizeAttr(0.2)

    arm = UsdGeom.Xform.Define(stage, "/World/arm")
    UsdPhysics.RigidBodyAPI.Apply(arm.GetPrim())
    # (1, 2, 3): every component fits an int8, so crate inlines the Vec3d.
    arm.AddTranslateOp().Set(Gf.Vec3d(1, 2, 3))
    UsdGeom.Cube.Define(stage, "/World/arm/geom").CreateSizeAttr(0.2)

    joint = UsdPhysics.RevoluteJoint.Define(stage, "/World/j1")
    joint.CreateBody0Rel().SetTargets(["/World/base"])
    joint.CreateBody1Rel().SetTargets(["/World/arm"])
    joint.CreateAxisAttr("Z")
    joint.CreateLowerLimitAttr(-180.0)
    joint.CreateUpperLimitAttr(180.0)
    drive = UsdPhysics.DriveAPI.Apply(joint.GetPrim(), "angular")
    target = drive.CreateTargetPositionAttr()
    for time, value in ((0, 0.0), (48, 90.5), (96, -30.25)):
        target.Set(value, time)

    prim = base.GetPrim()
    prim.CreateAttribute("test:uchars", Sdf.ValueTypeNames.UCharArray).Set(
        Vt.UCharArray([0, 1, 127, 255])
    )
    # 20 integral floats (>= pxr MinCompressedArraySize of 16) → code 'i'.
    prim.CreateAttribute("test:intFloats", Sdf.ValueTypeNames.FloatArray).Set(
        Vt.FloatArray([float(i) for i in range(20)])
    )
    # 20 floats over 2 distinct non-integral values → lookup table, code 't'.
    prim.CreateAttribute("test:lutFloats", Sdf.ValueTypeNames.FloatArray).Set(
        Vt.FloatArray([0.5, 1.5] * 10)
    )
    # 0.1 / 0.2 are not exactly float32-representable → non-inlined samples.
    dbl = prim.CreateAttribute("test:dbl", Sdf.ValueTypeNames.Double)
    dbl.Set(0.1, 0)
    dbl.Set(0.2, 96)

    # matrix4d samples: identity inlines (int8 diagonal), the translated one
    # is a full 128-byte scalar rep.
    panel = UsdGeom.Xform.Define(stage, "/World/panel")
    op = panel.AddTransformOp()
    op.Set(Gf.Matrix4d(1.0), 0)
    op.Set(Gf.Matrix4d(1.0).SetTranslate(Gf.Vec3d(0.5, 0.0, 0.25)), 96)

    # M19: a UsdPreviewSurface network (crate `connectionPaths`) driving a quad
    # whose `st` primvar is faceVarying (crate `interpolation` field).
    UsdGeom.Scope.Define(stage, "/World/Looks")
    mat = UsdShade.Material.Define(stage, "/World/Looks/Mat")
    surf = UsdShade.Shader.Define(stage, "/World/Looks/Mat/Surface")
    surf.CreateIdAttr("UsdPreviewSurface")
    tex = UsdShade.Shader.Define(stage, "/World/Looks/Mat/Tex")
    tex.CreateIdAttr("UsdUVTexture")
    tex.CreateInput("file", Sdf.ValueTypeNames.Asset).Set("./checker.png")
    surf.CreateInput("diffuseColor", Sdf.ValueTypeNames.Color3f).ConnectToSource(
        tex.ConnectableAPI(), "rgb"
    )
    mat.CreateSurfaceOutput().ConnectToSource(surf.ConnectableAPI(), "surface")

    quad = UsdGeom.Mesh.Define(stage, "/World/base/skin")
    quad.CreatePointsAttr([(0, 0, 0), (1, 0, 0), (1, 1, 0), (0, 1, 0)])
    quad.CreateFaceVertexCountsAttr([4])
    quad.CreateFaceVertexIndicesAttr([0, 1, 2, 3])
    st = UsdGeom.PrimvarsAPI(quad).CreatePrimvar(
        "st", Sdf.ValueTypeNames.TexCoord2fArray, UsdGeom.Tokens.faceVarying
    )
    st.Set([(0, 0), (1, 0), (1, 1), (0, 1)])
    UsdShade.MaterialBindingAPI.Apply(quad.GetPrim()).Bind(mat)


def main() -> None:
    stage = Usd.Stage.CreateInMemory()
    build(stage)
    layer = stage.GetRootLayer()
    for path in (OUT_USDC, OUT_USDA):
        if not layer.Export(path):
            raise SystemExit(f"failed to export {path}")
        print(f"wrote {path}")


if __name__ == "__main__":
    main()
