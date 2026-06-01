import { readFileSync } from "node:fs";
import { ThreeUsdRobotLoader } from "../src/index.js";
const path = process.argv[2] ?? "data/torobo2_standard_planar_move.usd";
const bytes = new Uint8Array(readFileSync(path));
const warnings: string[] = [];
const robot = await new ThreeUsdRobotLoader({ onWarn: (m)=>warnings.push(m) }).parseCrate(bytes);
console.log("robot:", robot.robot.name);
console.log("root link:", robot.getKinematicTree().root);
console.log("links:", robot.getLinkNames().length, " joints (articulated):", robot.getJointNames().length);
const types: Record<string,number> = {};
for (const j of robot.getJoints()) types[j.type] = (types[j.type]||0)+1;
console.log("joint types:", types);
console.log("sample joints:", robot.getJointNames().slice(0,8));
// meshes
let meshCount=0; robot.traverse(o=>{ if((o as any).isMesh) meshCount++; });
console.log("meshes attached:", meshCount);
console.log("warnings:", warnings.length, warnings.slice(0,3));
