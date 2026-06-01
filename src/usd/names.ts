/** Split a (possibly namespaced) property name into namespace and base name. */
export function splitName(name: string): { namespace: string; baseName: string } {
  const idx = name.lastIndexOf(":");
  if (idx === -1) return { namespace: "", baseName: name };
  return { namespace: name.slice(0, idx), baseName: name.slice(idx + 1) };
}
