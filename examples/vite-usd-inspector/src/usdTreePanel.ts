/**
 * USD structure sidebar: a lazily-expanded prim tree plus an attribute
 * inspector for the selected prim. Pure DOM — no UI library.
 */

import type { Prim, Stage } from "three-usd-robot/core";

export type UsdTreePanel = {
  /**
   * Reveal + highlight the prim at `path` (expanding ancestors) and show its
   * attributes. `null` clears the selection. Does not fire `onSelect`.
   */
  select(path: string | null): void;
  dispose(): void;
};

export type UsdTreePanelOptions = {
  /** Fired when the user clicks a prim row. */
  onSelect?: (prim: Prim) => void;
};

type Entry = {
  prim: Prim;
  /** Wrapper holding the row and (lazily) the children container. */
  node: HTMLElement;
  row: HTMLElement;
  toggle: HTMLElement | null;
  childrenEl: HTMLElement | null;
  depth: number;
};

export function createUsdTreePanel(
  treeEl: HTMLElement,
  inspectorEl: HTMLElement,
  stage: Stage,
  options: UsdTreePanelOptions = {},
): UsdTreePanel {
  const entries = new Map<string, Entry>();
  let selectedRow: HTMLElement | null = null;

  treeEl.textContent = "";
  inspectorEl.textContent = "";
  placeholder(inspectorEl, "select a prim to inspect it");

  const roots = stage.GetPseudoRoot().GetChildren();
  if (roots.length === 0) placeholder(treeEl, "empty stage");
  for (const prim of roots) {
    treeEl.appendChild(buildNode(prim, 0));
    setExpanded(entries.get(prim.GetPath())!, true); // reveal the first level
  }

  function buildNode(prim: Prim, depth: number): HTMLElement {
    const node = document.createElement("div");
    const row = document.createElement("div");
    row.className = "tree-row";
    row.style.paddingLeft = `${4 + depth * 13}px`;

    let toggle: HTMLElement | null = null;
    if (prim.GetChildren().length > 0) {
      toggle = document.createElement("span");
      toggle.className = "tree-toggle";
      toggle.textContent = "▶";
      toggle.addEventListener("click", (e) => {
        e.stopPropagation();
        const entry = entries.get(prim.GetPath())!;
        setExpanded(entry, entry.childrenEl?.style.display !== "block");
      });
      row.appendChild(toggle);
    } else {
      const spacer = document.createElement("span");
      spacer.className = "tree-toggle";
      row.appendChild(spacer);
    }

    const name = document.createElement("span");
    name.className = "tree-name";
    name.textContent = prim.GetName();
    row.appendChild(name);

    const typeName = prim.GetTypeName();
    if (typeName) {
      const type = document.createElement("span");
      type.className = `tree-type ${typeClass(typeName)}`;
      type.textContent = typeName;
      row.appendChild(type);
    }

    row.addEventListener("click", () => {
      highlight(prim.GetPath());
      renderInspector(inspectorEl, prim);
      options.onSelect?.(prim);
    });

    node.appendChild(row);
    entries.set(prim.GetPath(), { prim, node, row, toggle, childrenEl: null, depth });
    return node;
  }

  function setExpanded(entry: Entry, open: boolean): void {
    if (!entry.toggle) return; // leaf
    if (open && !entry.childrenEl) {
      entry.childrenEl = document.createElement("div");
      for (const child of entry.prim.GetChildren()) {
        entry.childrenEl.appendChild(buildNode(child, entry.depth + 1));
      }
      entry.node.appendChild(entry.childrenEl);
    }
    if (entry.childrenEl) entry.childrenEl.style.display = open ? "block" : "none";
    entry.toggle.classList.toggle("open", open);
  }

  function highlight(path: string | null): void {
    selectedRow?.classList.remove("selected");
    selectedRow = path ? (entries.get(path)?.row ?? null) : null;
    selectedRow?.classList.add("selected");
  }

  return {
    select(path: string | null): void {
      if (path === null) {
        highlight(null);
        inspectorEl.textContent = "";
        placeholder(inspectorEl, "select a prim to inspect it");
        return;
      }
      // Expand ancestors (creating their rows on demand) so the row exists.
      const segments = path.split("/").filter(Boolean);
      for (let i = 1; i < segments.length; i++) {
        const ancestor = entries.get(`/${segments.slice(0, i).join("/")}`);
        if (ancestor) setExpanded(ancestor, true);
      }
      const entry = entries.get(path);
      highlight(entry ? path : null);
      if (!entry) return;
      entry.row.scrollIntoView({ block: "nearest" });
      renderInspector(inspectorEl, entry.prim);
    },
    dispose(): void {
      entries.clear();
      selectedRow = null;
      treeEl.textContent = "";
      inspectorEl.textContent = "";
      placeholder(inspectorEl, "select a prim to inspect it");
    },
  };
}

// -- inspector ---------------------------------------------------------------

function renderInspector(el: HTMLElement, prim: Prim): void {
  el.textContent = "";

  const name = document.createElement("div");
  name.className = "prim-name";
  name.textContent = prim.GetName();
  const typeName = prim.GetTypeName();
  if (typeName) {
    const type = document.createElement("span");
    type.className = `tree-type ${typeClass(typeName)}`;
    type.textContent = ` ${typeName}`;
    name.appendChild(type);
  }
  el.appendChild(name);

  const path = document.createElement("div");
  path.className = "prim-path";
  path.textContent = prim.GetPath();
  el.appendChild(path);

  const specifier = prim.GetSpecifier();
  if (specifier && specifier !== "def") addChip(el, specifier);
  for (const schema of prim.GetAppliedSchemas()) addChip(el, schema);

  const attributes = prim.GetAttributes();
  if (attributes.length > 0) {
    addHeading(el, "Attributes");
    const table = document.createElement("table");
    for (const attr of attributes) {
      const value = attr.Get();
      const samples = attr.GetTimeSamples();
      const connections = attr.GetConnections();
      let text =
        value === undefined && samples.size > 0
          ? `{${samples.size} timeSamples}`
          : formatValue(value);
      if (value !== undefined && samples.size > 0) text += ` (+${samples.size} samples)`;
      if (connections.length > 0) text = `→ ${connections.join(", ")}`;
      addRow(table, attr.GetName(), attr.GetTypeName(), text);
    }
    el.appendChild(table);
  }

  const relationships = prim.GetRelationships();
  if (relationships.length > 0) {
    addHeading(el, "Relationships");
    const table = document.createElement("table");
    for (const rel of relationships) {
      addRow(table, rel.GetName(), "rel", rel.GetTargets().join(", ") || "—");
    }
    el.appendChild(table);
  }

  const metadata = Object.entries(prim.GetAllMetadata()).filter(([k]) => k !== "apiSchemas");
  if (metadata.length > 0) {
    addHeading(el, "Metadata");
    const table = document.createElement("table");
    for (const [key, value] of metadata) addRow(table, key, "", formatValue(value));
    el.appendChild(table);
  }
}

function addChip(el: HTMLElement, text: string): void {
  const chip = document.createElement("span");
  chip.className = "chip";
  chip.textContent = text;
  el.appendChild(chip);
}

function addHeading(el: HTMLElement, text: string): void {
  const h = document.createElement("h4");
  h.textContent = text;
  el.appendChild(h);
}

function addRow(table: HTMLElement, name: string, type: string, value: string): void {
  const tr = document.createElement("tr");
  for (const [className, text] of [
    ["attr-name", name],
    ["attr-type", type],
    ["attr-value", value],
  ] as const) {
    const td = document.createElement("td");
    td.className = className;
    td.textContent = text;
    td.title = className === "attr-name" ? name : "";
    tr.appendChild(td);
  }
  table.appendChild(tr);
}

function placeholder(el: HTMLElement, text: string): void {
  const div = document.createElement("div");
  div.className = "empty";
  div.textContent = text;
  el.appendChild(div);
}

// -- formatting --------------------------------------------------------------

function typeClass(typeName: string): string {
  if (typeName.includes("Joint")) return "type-joint";
  if (/^(Mesh|Cube|Sphere|Cylinder|Capsule|Cone|Plane|Points|BasisCurves)$/.test(typeName)) {
    return "type-gprim";
  }
  if (/Material|Shader/.test(typeName)) return "type-material";
  if (/Physics|Collision|Articulation/.test(typeName)) return "type-physics";
  if (/Camera|Light/.test(typeName)) return "type-camera";
  if (typeName === "Xform" || typeName === "Scope") return "type-xform";
  return "";
}

function formatNumber(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Number(n.toPrecision(5)));
}

/** Compact one-line rendering of a UsdValue; long arrays/dicts are elided. */
function formatValue(value: unknown, depth = 0): string {
  if (value === undefined) return "—";
  if (value === null) return "null";
  if (typeof value === "number") return formatNumber(value);
  if (typeof value === "boolean") return String(value);
  if (typeof value === "string") {
    return value.length > 60 ? `"${value.slice(0, 57)}…"` : `"${value}"`;
  }
  if (Array.isArray(value)) {
    const max = depth === 0 ? 6 : 3;
    const items = value.slice(0, max).map((v) => formatValue(v, depth + 1));
    const elided = value.length > max ? `, …×${value.length}` : "";
    return `[${items.join(", ")}${elided}]`;
  }
  if (typeof value === "object") {
    const keys = Object.keys(value);
    const shown = keys
      .slice(0, 3)
      .map((k) => `${k}: ${formatValue((value as Record<string, unknown>)[k], depth + 1)}`);
    return `{${shown.join(", ")}${keys.length > 3 ? ", …" : ""}}`;
  }
  return String(value);
}
