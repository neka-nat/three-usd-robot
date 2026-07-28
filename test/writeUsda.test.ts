import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  AssetPath,
  CrateReader,
  Quat,
  Stage,
  UsdMatrix,
  type UsdaFile,
  crateToUsdaFile,
  extractRobotDescription,
  parseUsda,
  serializeUsda,
} from "../src/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Deep-clone an AST value dropping the diagnostic `line` fields. */
function stripLines(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripLines);
  if (v instanceof Map) {
    const m = new Map<unknown, unknown>();
    for (const [k, val] of v) m.set(k, stripLines(val));
    return m;
  }
  if (v && typeof v === "object") {
    if (v instanceof Quat || v instanceof UsdMatrix || v instanceof AssetPath) return v;
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) {
      if (k === "line") continue;
      out[k] = stripLines(val);
    }
    return out;
  }
  return v;
}

/**
 * parse → serialize → parse must be an AST fixed point (line numbers aside),
 * and serializing the re-parse must reproduce the text exactly (idempotence).
 */
function roundTrip(text: string): string {
  const file = parseUsda(text);
  const out = serializeUsda(file);
  let re: UsdaFile;
  try {
    re = parseUsda(out);
  } catch (err) {
    throw new Error(`serialized USDA failed to re-parse: ${err}\n--- output ---\n${out}`);
  }
  expect(stripLines(re)).toEqual(stripLines(file));
  expect(serializeUsda(re)).toBe(out);
  return out;
}

// ---------------------------------------------------------------------------
// Fixture round-trips
// ---------------------------------------------------------------------------

const TWO_LINK = new URL("../test-assets/two_link_arm.usda", import.meta.url);

describe("serializeUsda round-trip (test-assets)", () => {
  it("round-trips two_link_arm.usda", () => {
    roundTrip(readFileSync(TWO_LINK, "utf8"));
  });

  it("preserves the extracted robot IR across a round-trip", () => {
    const src = readFileSync(TWO_LINK, "utf8");
    const a = extractRobotDescription(Stage.OpenFromString(src));
    const b = extractRobotDescription(Stage.OpenFromString(serializeUsda(parseUsda(src))));
    expect(b).toEqual(a);
  });

  it("Stage.ExportToString serializes the backing layer", () => {
    const src = readFileSync(TWO_LINK, "utf8");
    const stage = Stage.OpenFromString(src);
    const re = parseUsda(stage.ExportToString());
    expect(stripLines(re)).toEqual(stripLines(parseUsda(src)));
  });
});

// ---------------------------------------------------------------------------
// Value / property / metadata coverage
// ---------------------------------------------------------------------------

describe("serializeUsda round-trip (inline cases)", () => {
  it("covers scalar, tuple, matrix, array, and inf values", () => {
    roundTrip(`#usda 1.0

def Xform "Root"
{
    float3 xformOp:translate = (0, 0, 0.4)
    quatf xformOp:orient = (0.707, 0, 0.707, 0)
    matrix4d xformOp:transform = ( (1, 0, 0, 0), (0, 1, 0, 0), (0, 0, 1, 0), (5, 6, 7, 1) )
    uniform token[] xformOpOrder = ["xformOp:transform"]
    custom double myValue = -1.25e-3
    custom bool myFlag = false
    int[] faceVertexCounts = [3, 3]
    int[] emptyArray = []
    point3f[] points = [(0, 0, 0), (1, 0, 0), (0.5, 1, 0)]
    float physics:lowerLimit = -inf
    float physics:upperLimit = inf
    float noValueDecl
    token emptyToken = ""
    string weird = "multi\\nline \\"x\\" with \\\\ backslash"
    asset inputs:file = @./tex/color.png@ (
        colorSpace = "sRGB"
    )
    asset[] assetList = [@a.png@, @b.png@]
}
`);
  });

  it("covers time samples, connections, and split attribute statements", () => {
    roundTrip(`#usda 1.0

def Xform "Root"
{
    color3f inputs:diffuseColor = (0.1, 0.2, 0.3) (
        doc = "with metadata"
    )
    color3f inputs:diffuseColor.connect = </Root/Mat/Tex.outputs:rgb>
    float anim.timeSamples = {
        0: 0,
        24: 90.5,
        48: -inf,
    }
    point3f[] deform.timeSamples = {
        0: [(0, 0, 0), (1, 1, 1)],
        10: [(0, 0, 1), (1, 1, 2)],
    }
}
`);
  });

  it("covers relationships (bare, single, list, list-op, custom)", () => {
    roundTrip(`#usda 1.0

def PhysicsRevoluteJoint "j1"
{
    rel material:binding = </Root/Mat>
    prepend rel physics:body0 = [</Root/a>, </Root/b>]
    custom rel emptyRel
    delete rel toRemove = </Root/c>
}
`);
  });

  it("covers layer metadata, docs, dictionaries, and sublayers", () => {
    roundTrip(`#usda 1.0
(
    "escape check: \\"quote\\" and\\nnewline"
    defaultPrim = "Root"
    metersPerUnit = 0.01
    upAxis = "Y"
    timeCodesPerSecond = 60
    customLayerData = {
        string note = "hi"
        int count = 3
        double ratio = 1.5
        bool flag = true
        int[] ids = [1, 2, 3]
        string[] names = ["a", "b"]
        dictionary nested = {
            double x = -0.25
        }
    }
    subLayers = [@./a.usda@, @./b.usda@]
)

def Xform "Root"
{
}
`);
  });

  it("covers prim metadata (apiSchemas, references, kind, customData)", () => {
    roundTrip(`#usda 1.0

def Xform "Root" (
    kind = "component"
    prepend apiSchemas = ["PhysicsArticulationRootAPI", "PhysicsRigidBodyAPI"]
    references = @./dep.usda@</Dep>
    payload = @./heavy.usdc@
    inherits = </_class_Robot>
    active = true
    instanceable = false
    customData = {
        string author = "test"
    }
)
{
}
`);
  });

  it("covers variant sets and variant selections", () => {
    roundTrip(`#usda 1.0

def Xform "Robot" (
    variants = {
        string gripper = "closed"
    }
    prepend variantSets = "gripper"
)
{
    variantSet "gripper" = {
        "open" {
            float grip = 0

            def Xform "Fingers"
            {
                float3 xformOp:translate = (0, 0, 1)
            }
        }
        "closed" {
            float grip = 1
        }
    }

    def Xform "Child"
    {
    }
}
`);
  });

  it("covers specifiers (def/over/class) and typeless prims", () => {
    roundTrip(`#usda 1.0

over "Overrides"
{
    over Xform "a"
    {
    }
}

class "template"
{
}

def "Typeless"
{
}
`);
  });
});

// ---------------------------------------------------------------------------
// Binary crate → USDA (integration; skipped when the asset is absent)
// ---------------------------------------------------------------------------

const TOROBO = new URL("../data/torobo2_standard_planar_move.usd", import.meta.url);
const toroboPresent = existsSync(TOROBO);

describe.skipIf(!toroboPresent)("usdc → usda conversion (data/torobo2)", () => {
  it("serializes the crate-built AST to USDA with an equivalent robot IR", () => {
    const bytes = new Uint8Array(readFileSync(TOROBO));
    const file = crateToUsdaFile(new CrateReader(bytes));
    const text = serializeUsda(file);

    const re = parseUsda(text);
    const a = extractRobotDescription(Stage.OpenFromFile(file));
    const b = extractRobotDescription(Stage.OpenFromFile(re));
    expect(b).toEqual(a);

    // Once through the parser, serialization is a fixed point.
    expect(serializeUsda(parseUsda(serializeUsda(re)))).toBe(serializeUsda(re));
  });
});
