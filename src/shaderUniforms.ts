import * as THREE from "three";

// Shared GPU uniforms referenced by multiple shader materials. Kept in
// this dependency-free module so scene, starfield, and billboard can all
// read and update the same values without introducing import cycles.

// Half the viewport height in CSS pixels. Drives physical-pixel sizing in
// the star shader. Updated on resize from scene.handleResize.
//
// The bloom pass temporarily widens both the camera fov and the composer
// render target by the same overscan factor, so this value can stay
// anchored to the visible viewport — the widening cancels exactly.
export const halfViewportPxUniform: THREE.IUniform<number> = {
  value: typeof window !== "undefined" ? window.innerHeight / 2 : 540,
};

// Camera orbit offset uniform shared by all star/NS shaders. The orbit
// offset is always small (it's the displacement from the orbit focus),
// so Float32 represents it with full precision at any zoom level.
// The other half of the decomposition — the orbit focus relative to each
// tile's origin — is computed per-tile on the CPU in Float64 and passed
// as a per-tile uLocalTarget uniform. See starfield.ts rebaseTile().
export const starCameraOffsetUniform: THREE.IUniform<THREE.Vector3> = {
  value: new THREE.Vector3(0, 0, 0),
};
export const starViewRotationUniform: THREE.IUniform<THREE.Matrix3> = {
  value: new THREE.Matrix3(),
};
