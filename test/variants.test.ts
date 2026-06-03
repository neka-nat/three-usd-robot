import { describe, expect, it } from "vitest";
import { Stage, composeLayer, createMemoryResolver, parseUsda } from "../src/index.js";

const resolver = createMemoryResolver({});

async function stageOf(usda: string): Promise<Stage> {
  return Stage.OpenFromFile(await composeLayer(usda, "/mem.usda", resolver));
}

describe("variants — USDA parsing", () => {
  it("parses variantSet blocks and the selection", () => {
    const file = parseUsda(`#usda 1.0
def Xform "robot" (
    variants = { string geo = "high" }
    prepend variantSets = "geo"
)
{
    variantSet "geo" = {
        "high" { def Mesh "hi" {} }
        "low" { def Mesh "lo" {} }
    }
}`);
    const robot = file.prims[0]!;
    expect(robot.variantSets?.geo?.high?.children[0]?.name).toBe("hi");
    expect(robot.variantSets?.geo?.low?.children[0]?.name).toBe("lo");
    expect(robot.metadata.variants).toEqual({ geo: "high" });
  });
});

describe("variants — composition", () => {
  const usda = (sel: string) => `#usda 1.0
def Xform "robot" (
    variants = { string geo = "${sel}" }
    prepend variantSets = "geo"
)
{
    def Xform "common" {}
    variantSet "geo" = {
        "high" { def Mesh "detailed" {} }
        "low" { def Mesh "simple" {} }
    }
}`;

  it("grafts the selected variant's children", async () => {
    const stage = await stageOf(usda("high"));
    expect(stage.GetPrimAtPath("/robot/detailed")?.GetTypeName()).toBe("Mesh");
    expect(stage.GetPrimAtPath("/robot/simple")).toBeNull();
    expect(stage.GetPrimAtPath("/robot/common")).not.toBeNull(); // non-variant child kept
  });

  it("switches subtree with the selection", async () => {
    const stage = await stageOf(usda("low"));
    expect(stage.GetPrimAtPath("/robot/simple")?.GetTypeName()).toBe("Mesh");
    expect(stage.GetPrimAtPath("/robot/detailed")).toBeNull();
  });

  it("applies no variant when nothing is selected", async () => {
    const stage = await stageOf(`#usda 1.0
def Xform "robot" ( prepend variantSets = "geo" )
{
    variantSet "geo" = { "high" { def Mesh "detailed" {} } }
}`);
    expect(stage.GetPrimAtPath("/robot/detailed")).toBeNull();
  });
});

describe("internal references / instanceable", () => {
  it("expands an instanceable prim from its internal prototype reference", async () => {
    const stage = await stageOf(`#usda 1.0
def Xform "World"
{
    class Xform "_Wheel"
    {
        def Mesh "tire" {}
        def Mesh "rim" {}
    }
    def Xform "frontLeft" ( instanceable = true  prepend references = </World/_Wheel> ) {}
    def Xform "frontRight" ( prepend references = </World/_Wheel> ) {}
}`);
    // Both instances gain the prototype's children.
    expect(stage.GetPrimAtPath("/World/frontLeft/tire")?.GetTypeName()).toBe("Mesh");
    expect(stage.GetPrimAtPath("/World/frontLeft/rim")?.GetTypeName()).toBe("Mesh");
    expect(stage.GetPrimAtPath("/World/frontRight/tire")?.GetTypeName()).toBe("Mesh");
  });

  it("warns and continues on a missing internal reference", async () => {
    const warnings: string[] = [];
    const file = await composeLayer(
      `#usda 1.0\ndef Xform "a" ( prepend references = </Nope> ) {}`,
      "/mem.usda",
      resolver,
      { onWarn: (m) => warnings.push(m) },
    );
    expect(file.prims[0]?.name).toBe("a");
    expect(warnings.some((w) => w.includes("not found"))).toBe(true);
  });
});
