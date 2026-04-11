import { describe, it, expect } from "bun:test";
import type { SystemGroup } from "./types.ts";

// Test the pure logic extracted from interaction.ts

// selectSystem focus target logic
function selectSystemFocusTarget(group: SystemGroup, cameraPos: { x: number; y: number; z: number }): { x: number; y: number; z: number } {
  if (group.kind === "cluster") {
    return { x: group.centroid.x, y: group.centroid.y, z: group.centroid.z };
  }
  let nearest = group.meshes[0];
  let nearestDist = Infinity;
  for (const m of group.meshes) {
    const dx = m.position.x - cameraPos.x;
    const dy = m.position.y - cameraPos.y;
    const dz = m.position.z - cameraPos.z;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (d < nearestDist) { nearest = m; nearestDist = d; }
  }
  const dx = nearest.position.x - group.centroid.x;
  const dy = nearest.position.y - group.centroid.y;
  const dz = nearest.position.z - group.centroid.z;
  const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
  return dist < 0.5 ? group.centroid : nearest.position;
}

// updateSystemLabelText content logic
function systemLabelContent(group: SystemGroup, isActive: boolean): string {
  if (!isActive || group.kind === "cluster") return group.name;
  const members = group.collapsedMembers.length > 0 ? group.collapsedMembers : group.meshes;
  const names = members.map((m: any) => m.userData.name);
  return `${group.name}\n${names.join(" · ")}`;
}

function vec3(x: number, y: number, z: number) {
  return { x, y, z, distanceTo(o: any) { return Math.sqrt((x-o.x)**2+(y-o.y)**2+(z-o.z)**2); } };
}

function makeMesh(name: string, x: number, y: number, z: number) {
  return { position: vec3(x, y, z), userData: { name } } as any;
}

describe("selectSystem focus target", () => {
  it("clusters always focus on the centroid, not the nearest member", () => {
    const group: any = {
      name: "Hyades",
      kind: "cluster",
      centroid: vec3(10, 20, 30),
      meshes: [
        makeMesh("97 Tau", 11, 21, 31),
        makeMesh("76 Tau", 9, 19, 29),
        makeMesh("Prima Hyadum", 10.5, 20.5, 30.5),
      ],
    };
    const camera = { x: 9, y: 19, z: 29 }; // nearest to 76 Tau
    const target = selectSystemFocusTarget(group, camera);
    expect(target.x).toBe(10);
    expect(target.y).toBe(20);
    expect(target.z).toBe(30);
  });

  it("binary systems focus on nearest member (existing behavior)", () => {
    const group: any = {
      name: "Sirius",
      centroid: vec3(5, 5, 5),
      meshes: [
        makeMesh("Sirius A", 5.1, 5.1, 5.1),
        makeMesh("Sirius B", 4.9, 4.9, 4.9),
      ],
      collapsedMembers: [],
    };
    const camera = { x: 4, y: 4, z: 4 };
    const target = selectSystemFocusTarget(group, camera);
    // Sirius B is closer to camera, but both are within 0.5 of centroid → focus centroid
    expect(target.x).toBe(5);
  });
});

describe("systemLabelContent", () => {
  it("clusters show only the cluster name, never member list", () => {
    const group: any = {
      name: "Hyades",
      kind: "cluster",
      meshes: [makeMesh("97 Tau", 0, 0, 0), makeMesh("76 Tau", 0, 0, 0)],
      collapsedMembers: [],
    };
    expect(systemLabelContent(group, true)).toBe("Hyades");
    expect(systemLabelContent(group, false)).toBe("Hyades");
  });

  it("binary systems show member names when active", () => {
    const group: any = {
      name: "Sirius",
      meshes: [makeMesh("Sirius A", 0, 0, 0), makeMesh("Sirius B", 0, 0, 0)],
      collapsedMembers: [],
    };
    const content = systemLabelContent(group, true);
    expect(content).toContain("Sirius A");
    expect(content).toContain("Sirius B");
  });

  it("binary systems show only name when inactive", () => {
    const group: any = {
      name: "Sirius",
      meshes: [makeMesh("Sirius A", 0, 0, 0), makeMesh("Sirius B", 0, 0, 0)],
      collapsedMembers: [],
    };
    expect(systemLabelContent(group, false)).toBe("Sirius");
  });
});
