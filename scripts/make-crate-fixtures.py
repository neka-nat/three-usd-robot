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

Also generates test-assets/mdl_materials.{usdc,usda} — the M20 MDL-material
fixture: OmniGlass / OmniPBR_ClearCoat shaders with authored inputs, plus a
wrapper-only material (`./materials/CratePaint.mdl`, zero USD inputs) whose
look must come from the parsed `.mdl` declaration.

And test-assets/mtlx_materials.{usdc,usda} — the M21 MaterialX fixture:
natively-authored ND_* networks (standard_surface constants, a tiledimage
base_color, and the ND_UsdPreviewSurface compatibility shader).

Requires pxr (pip install usd-core). Run from the repo root:
    python3 scripts/make-crate-fixtures.py
"""

from pxr import Gf, Sdf, Usd, UsdGeom, UsdPhysics, UsdShade, Vt

OUT_USDC = "test-assets/anim_arm.usdc"
OUT_USDA = "test-assets/anim_arm.usda"
OUT_MDL_USDC = "test-assets/mdl_materials.usdc"
OUT_MDL_USDA = "test-assets/mdl_materials.usda"
OUT_MTLX_USDC = "test-assets/mtlx_materials.usdc"
OUT_MTLX_USDA = "test-assets/mtlx_materials.usda"


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


def build_mdl(stage: Usd.Stage) -> None:
    """M20: MDL shaders (info:mdl:sourceAsset + subIdentifier) in crate form."""
    UsdGeom.SetStageUpAxis(stage, UsdGeom.Tokens.z)
    UsdGeom.SetStageMetersPerUnit(stage, 1.0)
    world = UsdGeom.Xform.Define(stage, "/World")
    stage.SetDefaultPrim(world.GetPrim())
    UsdGeom.Scope.Define(stage, "/World/Looks")

    def mdl_material(name, module, sub, inputs):
        mat = UsdShade.Material.Define(stage, f"/World/Looks/{name}")
        shader = UsdShade.Shader.Define(stage, f"/World/Looks/{name}/Shader")
        shader.SetSourceAsset(module, "mdl")
        shader.SetSourceAssetSubIdentifier(sub, "mdl")
        shader.CreateOutput("out", Sdf.ValueTypeNames.Token)
        for input_name, input_type, value in inputs:
            shader.CreateInput(input_name, input_type).Set(value)
        mat.CreateSurfaceOutput("mdl").ConnectToSource(shader.ConnectableAPI(), "out")
        return mat

    glass = mdl_material(
        "Glass",
        "OmniGlass.mdl",
        "OmniGlass",
        [
            ("glass_color", Sdf.ValueTypeNames.Color3f, Gf.Vec3f(0.2, 0.7, 0.9)),
            ("glass_ior", Sdf.ValueTypeNames.Float, 1.2),
            ("frosting_roughness", Sdf.ValueTypeNames.Float, 0.25),
            ("depth", Sdf.ValueTypeNames.Float, 0.01),
        ],
    )
    coated = mdl_material(
        "Coated",
        "OmniPBR_ClearCoat.mdl",
        "OmniPBR_ClearCoat",
        [
            ("diffuse_color_constant", Sdf.ValueTypeNames.Color3f, Gf.Vec3f(0.5, 0.1, 0.1)),
            ("metallic_constant", Sdf.ValueTypeNames.Float, 0.9),
            ("clearcoat_reflection_roughness", Sdf.ValueTypeNames.Float, 0.15),
        ],
    )
    # Wrapper-only: the look lives entirely in ./materials/CratePaint.mdl.
    painted = mdl_material("Painted", "./materials/CratePaint.mdl", "CratePaint", [])

    for name, mat in (("glass", glass), ("coated", coated), ("painted", painted)):
        cube = UsdGeom.Cube.Define(stage, f"/World/{name}")
        cube.CreateSizeAttr(0.1)
        UsdShade.MaterialBindingAPI.Apply(cube.GetPrim()).Bind(mat)


def build_mtlx(stage: Usd.Stage) -> None:
    """M21: natively-authored MaterialX (ND_*) shader networks in crate form."""
    UsdGeom.SetStageUpAxis(stage, UsdGeom.Tokens.z)
    UsdGeom.SetStageMetersPerUnit(stage, 1.0)
    world = UsdGeom.Xform.Define(stage, "/World")
    stage.SetDefaultPrim(world.GetPrim())
    UsdGeom.Scope.Define(stage, "/World/Looks")

    def mtlx_material(name, shader_id, inputs):
        mat = UsdShade.Material.Define(stage, f"/World/Looks/{name}")
        shader = UsdShade.Shader.Define(stage, f"/World/Looks/{name}/Surface")
        shader.CreateIdAttr(shader_id)
        for input_name, input_type, value in inputs:
            shader.CreateInput(input_name, input_type).Set(value)
        shader.CreateOutput("out", Sdf.ValueTypeNames.Token)
        mat.CreateSurfaceOutput("mtlx").ConnectToSource(shader.ConnectableAPI(), "out")
        return mat, shader

    steel, _ = mtlx_material(
        "Steel",
        "ND_standard_surface_surfaceshader",
        [
            ("base", Sdf.ValueTypeNames.Float, 1.0),
            ("base_color", Sdf.ValueTypeNames.Color3f, Gf.Vec3f(0.2, 0.3, 0.4)),
            ("metalness", Sdf.ValueTypeNames.Float, 0.9),
            ("specular_roughness", Sdf.ValueTypeNames.Float, 0.35),
            ("coat", Sdf.ValueTypeNames.Float, 1.0),
            ("coat_roughness", Sdf.ValueTypeNames.Float, 0.15),
            ("specular_IOR", Sdf.ValueTypeNames.Float, 1.6),
        ],
    )
    textured, surface = mtlx_material("Textured", "ND_standard_surface_surfaceshader", [])
    image = UsdShade.Shader.Define(stage, "/World/Looks/Textured/Image")
    image.CreateIdAttr("ND_tiledimage_color3")
    image.CreateInput("file", Sdf.ValueTypeNames.Asset).Set("./crate.png")
    image.CreateInput("uvtiling", Sdf.ValueTypeNames.Float2).Set(Gf.Vec2f(2.0, 2.0))
    image.CreateOutput("out", Sdf.ValueTypeNames.Color3f)
    surface.CreateInput("base_color", Sdf.ValueTypeNames.Color3f).ConnectToSource(
        image.ConnectableAPI(), "out"
    )
    preview, _ = mtlx_material(
        "Preview",
        "ND_UsdPreviewSurface_surfaceshader",
        [
            ("diffuseColor", Sdf.ValueTypeNames.Color3f, Gf.Vec3f(0.8, 0.1, 0.1)),
            ("roughness", Sdf.ValueTypeNames.Float, 0.5),
        ],
    )

    for name, mat in (("steel", steel), ("textured", textured), ("preview", preview)):
        cube = UsdGeom.Cube.Define(stage, f"/World/{name}")
        cube.CreateSizeAttr(0.1)
        UsdShade.MaterialBindingAPI.Apply(cube.GetPrim()).Bind(mat)


def main() -> None:
    for builder, paths in (
        (build, (OUT_USDC, OUT_USDA)),
        (build_mdl, (OUT_MDL_USDC, OUT_MDL_USDA)),
        (build_mtlx, (OUT_MTLX_USDC, OUT_MTLX_USDA)),
    ):
        stage = Usd.Stage.CreateInMemory()
        builder(stage)
        layer = stage.GetRootLayer()
        for path in paths:
            if not layer.Export(path):
                raise SystemExit(f"failed to export {path}")
            print(f"wrote {path}")


if __name__ == "__main__":
    main()
