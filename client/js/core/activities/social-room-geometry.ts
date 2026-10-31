/**
 * Tiny self-contained low-poly 3D geometry for the local WebGL room prototype.
 * Each triangle vertex = x,y,z,r,g,b. No external textures, URLs, or scripts.
 * This is intentionally pure and unit-testable without a graphics device.
 */
export const SOCIAL_ROOM_BOUNDS = Object.freeze({ x: 5.6, z: 5.2 });
export type RoomPosition = { x: number; z: number };
export type RoomColor = readonly [number, number, number];

export function moveRoomAvatar(position: RoomPosition, dx: number, dz: number): RoomPosition {
  if (![position.x, position.z, dx, dz].every(Number.isFinite)) return { x: 0, z: 2.5 };
  const clamp = (n: number, bound: number) => Math.max(-bound, Math.min(bound, n));
  return { x: clamp(position.x + dx, SOCIAL_ROOM_BOUNDS.x), z: clamp(position.z + dz, SOCIAL_ROOM_BOUNDS.z) };
}

function box(
  vertices: number[], x: number, y: number, z: number,
  w: number, h: number, d: number, color: RoomColor,
): void {
  const x0 = x - w / 2, x1 = x + w / 2;
  const y0 = y, y1 = y + h;
  const z0 = z - d / 2, z1 = z + d / 2;
  const corners = [
    [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
    [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1],
  ];
  const faces: Array<[number, number, number, number, number]> = [
    [4, 5, 6, 7, 1.0], [1, 0, 3, 2, 0.62], [0, 4, 7, 3, 0.76],
    [5, 1, 2, 6, 0.82], [3, 7, 6, 2, 1.14], [0, 1, 5, 4, 0.55],
  ];
  for (const [a, b, c, d0, light] of faces) {
    for (const i of [a, b, c, a, c, d0]) {
      vertices.push(...corners[i]!, ...color.map(v => Math.min(1, v * light)));
    }
  }
}

export function staticSocialRoomGeometry(): Float32Array {
  const data: number[] = [];
  const navy: RoomColor = [0.13, 0.20, 0.30];
  const cyan: RoomColor = [0.12, 0.83, 0.82];
  const plum: RoomColor = [0.51, 0.33, 0.77];
  const gold: RoomColor = [0.96, 0.68, 0.32];
  box(data, 0, -0.24, 0, 13.5, 0.24, 13.5, navy); // ground
  // Real spatial reference cues: grid floor strips, not a flat sprite.
  for (let i = -6; i <= 6; i += 2) {
    box(data, i, 0.002, 0, 0.025, 0.008, 12.5, [0.20, 0.29, 0.42]);
    box(data, 0, 0.002, i, 12.5, 0.008, 0.025, [0.20, 0.29, 0.42]);
  }
  box(data, 0, 0, -6.55, 13.5, 3.7, 0.20, [0.16, 0.24, 0.39]); // rear wall
  box(data, -6.55, 0, 0, 0.20, 3.7, 13.5, [0.17, 0.22, 0.35]);
  box(data, 6.55, 0, 0, 0.20, 3.7, 13.5, [0.17, 0.22, 0.35]);
  box(data, 0, 0, -4.95, 5.8, 0.32, 2.6, plum); // gathering stage
  box(data, 0, 0.35, -6.34, 5.2, 1.85, 0.09, cyan); // stage panel
  box(data, 0, 0.35, -6.28, 4.7, 1.55, 0.04, [0.06, 0.13, 0.24]);
  box(data, -4.2, 0, -2.6, 1.7, 0.55, 0.7, plum); // sofas
  box(data, -4.2, 0.50, -2.92, 1.7, 0.66, 0.20, plum);
  box(data, 4.2, 0, -2.6, 1.7, 0.55, 0.7, gold);
  box(data, 4.2, 0.50, -2.92, 1.7, 0.66, 0.20, gold);
  box(data, 0, 0, 0, 2.0, 0.46, 1.1, [0.30, 0.45, 0.57]); // central table
  box(data, 0, 0.46, 0, 2.3, 0.10, 1.4, [0.42, 0.62, 0.70]);
  for (const x of [-5.7, 5.7]) {
    box(data, x, 0, 4.6, 0.35, 1.45, 0.35, [0.22, 0.58, 0.57]); // planter
    box(data, x, 1.45, 4.6, 1.2, 1.2, 1.2, cyan); // tree
  }
  return new Float32Array(data);
}

export function socialRoomAvatarGeometry(position: RoomPosition): Float32Array {
  const data: number[] = [];
  box(data, position.x, 0.05, position.z, 0.58, 0.85, 0.4, [0.21, 0.70, 0.90]);
  box(data, position.x, 0.92, position.z, 0.62, 0.62, 0.56, [0.93, 0.77, 0.61]);
  box(data, position.x, 1.56, position.z - 0.09, 0.67, 0.19, 0.62, [0.23, 0.30, 0.51]);
  box(data, position.x - 0.17, 0, position.z + 0.04, 0.22, 0.15, 0.34, [0.18, 0.30, 0.51]);
  box(data, position.x + 0.17, 0, position.z + 0.04, 0.22, 0.15, 0.34, [0.18, 0.30, 0.51]);
  return new Float32Array(data);
}
